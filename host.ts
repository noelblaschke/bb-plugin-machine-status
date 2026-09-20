import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract, type Battery, type MachineStatus, type Usage } from "./contract.js";

const execFileAsync = promisify(execFile);

function unavailable(): Battery {
  return { available: false, percentage: null, powerSource: null, condition: null, remaining: null };
}

function unavailableUsage(): Usage {
  return { available: false, totalBytes: null, usedBytes: null, usedPercentage: null };
}

function clampPercentage(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function usage(totalBytes: number, usedBytes: number): Usage {
  const total = Math.max(0, Math.round(totalBytes));
  const used = Math.max(0, Math.min(total, Math.round(usedBytes)));
  if (!total) return unavailableUsage();
  return { available: true, totalBytes: total, usedBytes: used, usedPercentage: clampPercentage((used / total) * 100) };
}

function numberFromFile(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function readOptional(path: string): Promise<string | null> {
  return readFile(path, "utf8").then((value) => value.trim()).catch(() => null);
}

async function readBattery(): Promise<Battery> {
  switch (process.platform) {
    case "darwin": return readMacBattery();
    case "linux": return readLinuxBattery();
    case "win32": return readWindowsBattery();
    default: return unavailable();
  }
}

async function readMemory(): Promise<Usage> {
  switch (process.platform) {
    case "darwin": return readMacMemory();
    case "linux": return readLinuxMemory();
    case "win32": return readWindowsMemory();
    default: return unavailableUsage();
  }
}

async function readStorage(): Promise<Usage> {
  switch (process.platform) {
    case "darwin": return readMacStorage();
    case "linux": return readPosixStorage("/");
    case "win32": return readWindowsStorage();
    default: return unavailableUsage();
  }
}

async function readMacStorage(): Promise<Usage> {
  // On modern macOS, / is the sealed system volume; user data lives here.
  return readPosixStorage("/System/Volumes/Data").catch(() => readPosixStorage("/"));
}

async function readMacMemory(): Promise<Usage> {
  const [{ stdout: totalOutput }, { stdout: pageSizeOutput }, { stdout: vmStatOutput }] = await Promise.all([
    execFileAsync("/usr/sbin/sysctl", ["-n", "hw.memsize"], { timeout: 5_000 }),
    execFileAsync("/usr/bin/pagesize", [], { timeout: 5_000 }),
    execFileAsync("/usr/bin/vm_stat", [], { timeout: 5_000 }),
  ]);
  const total = Number(totalOutput.trim());
  const pageSize = Number(pageSizeOutput.trim());
  const pages = ["Pages free", "Pages inactive", "Pages speculative"].reduce((sum, label) => {
    const match = new RegExp(`${label}:\\s+(\\d+)\\.`).exec(vmStatOutput);
    return sum + Number(match?.[1] ?? 0);
  }, 0);
  if (!Number.isFinite(total) || !Number.isFinite(pageSize)) return unavailableUsage();
  return usage(total, total - pages * pageSize);
}

async function readLinuxMemory(): Promise<Usage> {
  const memory = await readFile("/proc/meminfo", "utf8");
  const values = new Map(Array.from(memory.matchAll(/^(MemTotal|MemAvailable):\s+(\d+)\s+kB$/gm), ([, key, value]) => [key, Number(value) * 1024]));
  const total = values.get("MemTotal");
  const available = values.get("MemAvailable");
  if (total === undefined || available === undefined) return unavailableUsage();

  const [limit, current] = await Promise.all([readOptional("/sys/fs/cgroup/memory.max"), readOptional("/sys/fs/cgroup/memory.current")]);
  const cgroupLimit = limit === null || limit === "max" ? null : Number(limit);
  const cgroupCurrent = current === null ? null : Number(current);
  if (cgroupLimit !== null && cgroupCurrent !== null && Number.isFinite(cgroupLimit) && Number.isFinite(cgroupCurrent)) {
    return usage(cgroupLimit, cgroupCurrent);
  }
  return usage(total, total - available);
}

async function readWindowsMemory(): Promise<Usage> {
  const command = "Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory | ConvertTo-Json -Compress";
  const payload = await runPowerShell(command);
  if (!isRecord(payload) || typeof payload.TotalVisibleMemorySize !== "number" || typeof payload.FreePhysicalMemory !== "number") return unavailableUsage();
  const total = payload.TotalVisibleMemorySize * 1024;
  return usage(total, total - payload.FreePhysicalMemory * 1024);
}

async function readPosixStorage(path: string): Promise<Usage> {
  const { stdout } = await execFileAsync("/bin/df", ["-kP", path], { timeout: 5_000 });
  const fields = stdout.trim().split("\n").at(-1)?.trim().split(/\s+/) ?? [];
  const total = Number(fields[1]) * 1024;
  const used = Number(fields[2]) * 1024;
  return Number.isFinite(total) && Number.isFinite(used) ? usage(total, used) : unavailableUsage();
}

async function readWindowsStorage(): Promise<Usage> {
  const command = "$drive = $env:SystemDrive; Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='$drive'\" | Select-Object Size,FreeSpace | ConvertTo-Json -Compress";
  const payload = await runPowerShell(command);
  if (!isRecord(payload) || typeof payload.Size !== "number" || typeof payload.FreeSpace !== "number") return unavailableUsage();
  return usage(payload.Size, payload.Size - payload.FreeSpace);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function runPowerShell(command: string): Promise<unknown> {
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { stdout } = await execFileAsync(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], { timeout: 10_000, windowsHide: true });
  return stdout.trim() ? JSON.parse(stdout) : null;
}

async function readMacBattery(): Promise<Battery> {
  const { stdout } = await execFileAsync("/usr/bin/pmset", ["-g", "batt"], { timeout: 5_000 });
  const batteryLine = stdout.split("\n").find((line) => /-InternalBattery/.test(line));
  const percentage = batteryLine && /(\d{1,3})%;/.exec(batteryLine)?.[1];
  if (!percentage || !batteryLine) return unavailable();

  const fields = batteryLine.split("\t").at(-1)?.split(";").map((field) => field.trim()) ?? [];
  return {
    available: true,
    percentage: clampPercentage(Number(percentage)),
    powerSource: /Now drawing from '([^']+)'/.exec(stdout)?.[1] ?? null,
    condition: fields[1] ?? null,
    remaining: /(\d+:\d+)\s+remaining/.exec(batteryLine)?.[1] ?? null,
  };
}

async function readLinuxBattery(): Promise<Battery> {
  const root = "/sys/class/power_supply";
  let supplies;
  try {
    supplies = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return unavailable();
    throw error;
  }
  const details = await Promise.all(supplies.map(async ({ name }) => {
    const directory = join(root, name);
    const [type, scope] = await Promise.all([readOptional(join(directory, "type")), readOptional(join(directory, "scope"))]);
    return { directory, name, scope, type };
  }));
  const batteryDirectories = details.filter((supply) => supply.type === "Battery" && supply.scope !== "Device");
  if (!batteryDirectories.length) return unavailable();

  const batteryReadings = await Promise.all(batteryDirectories.map(async ({ directory }) => {
    const [capacity, condition, energyNow, energyFull] = await Promise.all([
      readOptional(join(directory, "capacity")),
      readOptional(join(directory, "status")),
      readOptional(join(directory, "energy_now")),
      readOptional(join(directory, "energy_full")),
    ]);
    const percentage = numberFromFile(capacity);
    return percentage === null ? null : {
      condition: condition ?? "Unknown",
      energyFull: numberFromFile(energyFull),
      energyNow: numberFromFile(energyNow),
      percentage,
    };
  }));
  const batteries = batteryReadings.filter((battery): battery is NonNullable<typeof battery> => battery !== null);
  if (!batteries.length) return unavailable();
  const energyBatteries = batteries.filter((battery) => battery.energyNow !== null && battery.energyFull !== null && battery.energyFull > 0);
  const percentage = energyBatteries.length === batteries.length
    ? energyBatteries.reduce((sum, battery) => sum + battery.energyNow!, 0) / energyBatteries.reduce((sum, battery) => sum + battery.energyFull!, 0) * 100
    : batteries.reduce((sum, battery) => sum + battery.percentage, 0) / batteries.length;
  const onExternalPower = await Promise.all(details.map(async ({ directory, type }) => {
    if (!/^(Mains|USB|USB_C|Wireless)$/i.test(type ?? "")) return false;
    return (await readOptional(join(directory, "online"))) === "1";
  }));

  return {
    available: true,
    percentage: clampPercentage(percentage),
    powerSource: onExternalPower.some(Boolean) ? "AC Power" : "Battery Power",
    condition: batteries.map((battery) => battery.condition).join(", "),
    remaining: null,
  };
}

async function readWindowsBattery(): Promise<Battery> {
  const command = "Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json -Compress";
  const payload = await runPowerShell(command);
  const batteries = (Array.isArray(payload) ? payload : [payload]).filter((battery): battery is Record<string, unknown> =>
    typeof battery === "object" && battery !== null,
  );
  const percentages = batteries.flatMap((battery) => typeof battery.EstimatedChargeRemaining === "number" ? [battery.EstimatedChargeRemaining] : []);
  if (!percentages.length) return unavailable();

  const statuses = batteries.map((battery) => Number(battery.BatteryStatus));
  const condition = statuses.some((status) => status >= 6 && status <= 9) ? "Charging"
    : statuses.some((status) => status === 3) ? "Charged"
      : statuses.some((status) => status === 2) ? "AC power"
        : "Discharging";
  return {
    available: true,
    percentage: clampPercentage(percentages.reduce((sum, value) => sum + value, 0) / percentages.length),
    powerSource: statuses.some((status) => status === 2 || status === 3 || (status >= 6 && status <= 9)) ? "AC Power" : "Battery Power",
    condition,
    remaining: null,
  };
}

async function readStatus(): Promise<MachineStatus> {
  const [battery, memory, storage] = await Promise.all([
    readBattery().catch(() => unavailable()),
    readMemory().catch(() => unavailableUsage()),
    readStorage().catch(() => unavailableUsage()),
  ]);
  return { battery, memory, storage };
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: { readStatus },
});
