import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const batterySchema = z.object({
  available: z.boolean(),
  condition: z.string().nullable(),
  percentage: z.number().int().min(0).max(100).nullable(),
  powerSource: z.string().nullable(),
  remaining: z.string().nullable(),
}).strict();

export type Battery = z.infer<typeof batterySchema>;

export const usageSchema = z.object({
  available: z.boolean(),
  totalBytes: z.number().int().nonnegative().nullable(),
  usedBytes: z.number().int().nonnegative().nullable(),
  usedPercentage: z.number().int().min(0).max(100).nullable(),
}).strict();

export type Usage = z.infer<typeof usageSchema>;

export const machineStatusSchema = z.object({
  battery: batterySchema,
  memory: usageSchema,
  storage: usageSchema,
}).strict();

export type MachineStatus = z.infer<typeof machineStatusSchema>;

export const hostContract = defineRpcContract({
  readStatus: {
    input: z.null(),
    output: machineStatusSchema,
  },
});
