import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract, machineStatusSchema, type MachineStatus } from "./contract.js";

const POLL_INTERVAL_MS = 60_000;

const machineStatusSchemaWithHost = z.object({
  hostId: z.string(),
  name: z.string(),
  status: machineStatusSchema,
}).strict();

const statusSchema = z.object({ machines: z.array(machineStatusSchemaWithHost) }).strict();

export const rpcContract = defineRpcContract({
  status: { input: z.null(), output: statusSchema },
});

type MachineStatusWithHost = z.infer<typeof machineStatusSchemaWithHost>;
export type MachineStatusSnapshot = z.infer<typeof statusSchema>;

function sameStatus(previous: MachineStatus | undefined, next: MachineStatus): boolean {
  return previous?.battery.percentage === next.battery.percentage
    && previous?.memory.usedPercentage === next.memory.usedPercentage
    && previous?.storage.usedPercentage === next.storage.usedPercentage;
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish);
  });
}

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    hideUnavailableMachines: {
      type: "boolean",
      label: "Hide machines without selected status",
      description: "Exclude machines when none of the selected metrics is available.",
      default: true,
    },
    lowBatteryThreshold: {
      type: "number",
      label: "Low-battery threshold",
      description: "Highlight a machine's battery status when it is at or below this percentage.",
      experimental_schema: z.number().int().min(0).max(100),
      default: 20,
    },
    highMemoryThreshold: {
      type: "number",
      label: "High-memory threshold",
      description: "Highlight a machine's memory status when used memory is at or above this percentage.",
      experimental_schema: z.number().int().min(0).max(100),
      default: 90,
    },
    highStorageThreshold: {
      type: "number",
      label: "High-storage threshold",
      description: "Highlight a machine's storage status when used storage is at or above this percentage.",
      experimental_schema: z.number().int().min(0).max(100),
      default: 90,
    },
    showBattery: { type: "boolean", label: "Show battery", default: true },
    showMemory: { type: "boolean", label: "Show memory", default: true },
    showStorage: { type: "boolean", label: "Show storage", default: true },
  });
  settings.onChange((next, previous) => {
    if (next.showBattery || next.showMemory || next.showStorage) return;
    const restore = previous.showBattery
      ? settings.experimental_set({ showBattery: true })
      : previous.showMemory
        ? settings.experimental_set({ showMemory: true })
        : settings.experimental_set({ showStorage: true });
    void restore.catch((error) => {
      bb.log.warn(`At least one visible metric is required: ${error instanceof Error ? error.message : String(error)}`);
    });
  });

  const host = bb.hosts.experimental_client({ contract: hostContract });
  const statuses = new Map<string, MachineStatusWithHost>();
  const failures = new Map<string, number>();
  let markInitialPollComplete: (() => void) | null = null;
  const initialPollComplete = new Promise<void>((resolve) => { markInitialPollComplete = resolve; });

  const snapshot = () => ({ machines: [...statuses.values()].sort((a, b) => a.name.localeCompare(b.name)) });

  async function poll(): Promise<void> {
    const machines = await bb.sdk.hosts.list();
    const connectedMachines = machines.filter((machine) => machine.status === "connected");
    const connectedIds = new Set(connectedMachines.map((machine) => machine.id));
    let changed = false;

    for (const hostId of statuses.keys()) {
      if (!connectedIds.has(hostId)) {
        statuses.delete(hostId);
        failures.delete(hostId);
        changed = true;
      }
    }

    await Promise.all(connectedMachines.map(async (machine) => {
      try {
        const status = await host.call("readStatus", null, { hostId: machine.id });
        const previous = statuses.get(machine.id);
        const next = { hostId: machine.id, name: machine.name, status };
        statuses.set(machine.id, next);
        failures.delete(machine.id);
        if (!sameStatus(previous?.status, status) || previous?.name !== machine.name) changed = true;
      } catch (error) {
        const failureCount = (failures.get(machine.id) ?? 0) + 1;
        failures.set(machine.id, failureCount);
        if (failureCount >= 3 && statuses.delete(machine.id)) changed = true;
        bb.log.warn(`Could not read machine status for ${machine.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
    if (changed) bb.realtime.publish("machineStatus.changed", snapshot());
  }

  bb.rpc.register(rpcContract, {
    async status() {
      await initialPollComplete;
      return snapshot();
    },
  });
  bb.background.service("machine-status-poll", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          await poll();
        } catch (error) {
          bb.log.warn(`Could not poll machine status: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          markInitialPollComplete?.();
          markInitialPollComplete = null;
        }
        await sleep(POLL_INTERVAL_MS, signal);
      }
    },
  });
}
