import type { AgentRuntime } from "@rakazo/adapter-kit";
import { AgentRuntimeRegistry } from "../../adapter-kit/src/agent-runtime-registry.js";
import type { PrismaClient } from "./client.js";
import { configureRunCreation } from "./queued-runs.js";

/** Configure an owner and its transaction double without replacing the real factory. */
export function configureQueuedRunTestDb<T extends object>(db: object, tx: T): T {
  const runtime: AgentRuntime = {
    describe: () => ({
      id: "pi", contractVersion: "1", adapterVersion: "test",
      capabilities: { streaming: true, compaction: false, tools: true, scripted: false },
    }),
    async *run() { yield { type: "done" }; },
    async abort() {},
  };
  configureRunCreation(db as PrismaClient, new AgentRuntimeRegistry("pi").register(runtime));
  const client = tx as { bot?: { findUniqueOrThrow?: unknown } };
  client.bot ??= {};
  client.bot.findUniqueOrThrow ??= async () => ({ runtimeId: null });
  return tx;
}
