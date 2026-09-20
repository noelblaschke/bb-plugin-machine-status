import { definePluginApp, useRealtime, useRealtimeConnectionState, useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MachineStatusSnapshot, rpcContract } from "./server.js";

type Machine = MachineStatusSnapshot["machines"][number];

let cachedStatus: MachineStatusSnapshot | null = null;
let statusRequest: Promise<MachineStatusSnapshot> | null = null;

function useMachines(): { error: boolean; loading: boolean; machines: Machine[] } {
  const rpc = useRpc<typeof rpcContract>();
  const connectionState = useRealtimeConnectionState();
  const [status, setStatus] = useState<MachineStatusSnapshot | null>(() => cachedStatus);
  const [error, setError] = useState(false);
  const hasConnected = useRef(false);
  const lastLoadFailed = useRef(false);
  const snapshotVersion = useRef(0);

  const load = useCallback(async () => {
    const loadVersion = snapshotVersion.current;
    try {
      statusRequest ??= rpc.call("status").finally(() => { statusRequest = null; });
      const next = await statusRequest;
      if (loadVersion !== snapshotVersion.current) return;
      cachedStatus = next;
      setStatus(next);
      setError(false);
      lastLoadFailed.current = false;
    } catch {
      if (loadVersion !== snapshotVersion.current) return;
      setError(true);
      lastLoadFailed.current = true;
    }
  }, [rpc]);

  useEffect(() => {
    if (cachedStatus === null) void load();
  }, [load]);
  useEffect(() => {
    if (connectionState !== "connected") return;
    if (hasConnected.current || lastLoadFailed.current) void load();
    hasConnected.current = true;
  }, [connectionState, load]);

  useRealtime("machineStatus.changed", (next) => {
    snapshotVersion.current += 1;
    cachedStatus = next as MachineStatusSnapshot;
    setStatus(cachedStatus);
    setError(false);
  });

  return {
    error,
    loading: status === null && !error,
    machines: status?.machines ?? [],
  };
}

function isLowBattery(machine: Machine, threshold: number): boolean {
  return machine.status.battery.available && machine.status.battery.percentage !== null && machine.status.battery.percentage <= threshold;
}

function isHighUsage(usedPercentage: number | null, threshold: number): boolean {
  return usedPercentage !== null && usedPercentage >= threshold;
}

function BatteryGlyph({ percentage, lowBattery, className }: { percentage: number | null; lowBattery: boolean; className?: string }) {
  const fillWidth = percentage === null ? 0 : Math.max(1, Math.round((percentage / 100) * 14));
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="2" y="7" width="18" height="10" rx="2" />
      <path d="M22 11v2" />
      <rect x="4" y="9" width={fillWidth} height="6" rx="0.5" fill={lowBattery ? "#ef4444" : "currentColor"} stroke="none" />
    </svg>
  );
}

function MemoryGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <path d="M9 1v5M15 1v5M9 18v5M15 18v5M1 9h5M1 15h5M18 9h5M18 15h5" />
      <rect x="10" y="10" width="4" height="4" rx="0.5" />
    </svg>
  );
}

function StorageGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <ellipse cx="12" cy="5" rx="7" ry="3" />
      <path d="M5 5v7c0 1.7 3.1 3 7 3s7-1.3 7-3V5M5 12v7c0 1.7 3.1 3 7 3s7-1.3 7-3v-7" />
    </svg>
  );
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function SidebarMachineStatus() {
  const { error, loading, machines } = useMachines();
  const { values } = useSettings();
  const hideUnavailableMachines = values?.hideUnavailableMachines !== false;
  const lowBatteryThreshold = typeof values?.lowBatteryThreshold === "number" ? values.lowBatteryThreshold : 20;
  const highMemoryThreshold = typeof values?.highMemoryThreshold === "number" ? values.highMemoryThreshold : 90;
  const highStorageThreshold = typeof values?.highStorageThreshold === "number" ? values.highStorageThreshold : 90;
  const selectedMetrics = typeof values?.visibleMetrics === "string" ? values.visibleMetrics.split(",") : ["battery", "memory", "storage"];
  const showBattery = selectedMetrics.includes("battery");
  const showMemory = selectedMetrics.includes("memory");
  const showStorage = selectedMetrics.includes("storage");
  const metricLabel = selectedMetrics.length === 1 ? selectedMetrics[0] : "machine";
  const loadingLabel = `Loading ${metricLabel} status…`;
  const visibleMachines = hideUnavailableMachines ? machines.filter((machine) =>
    (showBattery && machine.status.battery.available) || (showMemory && machine.status.memory.available) || (showStorage && machine.status.storage.available),
  ) : machines;

  if (loading) return <div role="status" className="px-3 py-2 text-xs text-muted-foreground">{loadingLabel}</div>;
  if (error && !visibleMachines.length) return <div role="status" className="px-3 py-2 text-xs text-muted-foreground">{`${metricLabel[0].toUpperCase()}${metricLabel.slice(1)} status is unavailable`}</div>;
  if (!visibleMachines.length) return <div role="status" className="px-3 py-2 text-xs text-muted-foreground">{`No ${metricLabel} status found`}</div>;

  return (
    <ul aria-label="Machine status" className="flex flex-col gap-2 px-3 py-2 text-xs">
      {visibleMachines.map((machine) => (
        <li key={machine.hostId} className="flex flex-col gap-1">
          <span className="truncate font-medium">{machine.name}</span>
          {showBattery && machine.status.battery.available && (
            <span className={`flex items-center gap-2${isLowBattery(machine, lowBatteryThreshold) ? " text-red-500" : " text-muted-foreground"}`}>
              <BatteryGlyph percentage={machine.status.battery.percentage} lowBattery={isLowBattery(machine, lowBatteryThreshold)} className="size-4 shrink-0" />
              <span>Battery</span><span className="ml-auto tabular-nums font-medium">{machine.status.battery.percentage}%</span>
            </span>
          )}
          {showMemory && machine.status.memory.available && machine.status.memory.totalBytes !== null && machine.status.memory.usedBytes !== null && (
            <span className={`flex items-center gap-2${isHighUsage(machine.status.memory.usedPercentage, highMemoryThreshold) ? " text-red-500" : " text-muted-foreground"}`}><MemoryGlyph className="size-4 shrink-0" /><span>Memory</span><span className="ml-auto tabular-nums">{formatBytes(machine.status.memory.usedBytes)} / {formatBytes(machine.status.memory.totalBytes)}</span></span>
          )}
          {showStorage && machine.status.storage.available && machine.status.storage.totalBytes !== null && machine.status.storage.usedBytes !== null && (
            <span className={`flex items-center gap-2${isHighUsage(machine.status.storage.usedPercentage, highStorageThreshold) ? " text-red-500" : " text-muted-foreground"}`}><StorageGlyph className="size-4 shrink-0" /><span>Storage</span><span className="ml-auto tabular-nums">{formatBytes(machine.status.storage.usedBytes)} / {formatBytes(machine.status.storage.totalBytes)}</span></span>
          )}
        </li>
      ))}
    </ul>
  );
}

export default definePluginApp((app) => {
  app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "machine-status",
    label: "Machine status",
    icon: "machine-status/battery",
    component: SidebarMachineStatus,
  });
});
