import "../runtime-source-loader.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pageBrowserDriver } from "./disposable-browser.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url));
const { ComputerBrowserProvider } = await import("../../packages/adapters/src/computer-browser.ts");
const { loadExternalAgentRuntimes } = await import("../../packages/adapters/src/external-agent-runtimes.ts");
const { AgentRuntimeRegistry } = await import("../../packages/adapter-kit/src/agent-runtime-registry.ts");
const { configureRunCreation, createQueuedRun } = await import("../../packages/db/src/queued-runs.ts");
const { reconcileToolOperation, recordToolOperationEffect } = await import("../../packages/adapters/src/tool-operation.ts");
const { claimIntendedEffect, completeExternalEffect, resolveDuplicateEffectGate } = await import("../../packages/adapters/src/approval-effect.ts");
const { toolEffectIdempotencyKey } = await import("../../packages/core/src/approval-effect-key.ts");
const input = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
const legacy = input.phase.startsWith("legacy-");
const helpers = []; const calls = []; let batches = 0; let actionRefs;
const browser = new ComputerBrowserProvider({ liveDriver: pageBrowserDriver(root, input.pythonCommand, input.cdpPort, helpers) });
const context = { operationId: "run-opaque", runId: "run-opaque", botId: "bot-opaque", traceId: "run-opaque",
  spaceId: "space-opaque", userId: "user-opaque", signal: new AbortController().signal };
const computer = { id: "computer-opaque", botId: "bot-opaque", kind: "desktop", providerRef: "computer-opaque" };
const config = path.join(path.dirname(process.argv[2]), "runtime-" + input.phase + ".json");
await fs.writeFile(config, JSON.stringify({ version: 1, runtimes: [{
  id: input.runtimeId ?? "acp:operation-fixture", transport: "acp-stdio", command: process.execPath,
  args: [path.join(root, "scripts/fixtures/acp-peer.mjs"), legacy ? "browser" : "operation-browser"], cwd: root,
  requireToolOperations: !legacy, maxToolCalls: 8,
}] }));
const [runtime] = loadExternalAgentRuntimes(config);
const registry = new AgentRuntimeRegistry(runtime.describe().id).register(runtime);
const owner = {}; configureRunCreation(owner, registry);
const run = await createQueuedRun(owner, {
  bot: { findUniqueOrThrow: async () => ({ runtimeId: runtime.describe().id }) },
  run: { create: async ({ data }) => ({ id: "run-opaque", ...data }) },
}, { data: { botId: "bot-opaque", threadId: "thread-opaque", taskId: "task-opaque", userId: "user-opaque", spaceId: "space-opaque", status: "queued", trigger: "user" } });
async function rows() { try { return JSON.parse(await fs.readFile(input.effectPath, "utf8")); } catch (error) { if (error.code === "ENOENT") return []; throw error; } }
async function save(values) {
  const temporary = input.effectPath + ".pending"; await fs.writeFile(temporary, JSON.stringify(values)); await fs.rename(temporary, input.effectPath);
}
const store = { externalEffect: {
  async findUnique({ where }) { return (await rows()).find((row) => where.id ? row.id === where.id : row.idempotencyKey === where.idempotencyKey) ?? null; },
  async create({ data }) {
    const values = await rows(); assert.ok(!values.some((row) => row.idempotencyKey === data.idempotencyKey));
    const effect = { id: "effect-" + values.length, ...data }; values.push(effect); await save(values); return effect;
  },
  async updateMany({ where, data }) {
    const values = await rows(); const effect = values.find((row) => row.id === where.id && row.status === where.status);
    if (!effect) return { count: 0 }; Object.assign(effect, data); await save(values); return { count: 1 };
  },
} };
const descriptor = ({ id, contractVersion, adapterVersion }) => ({ id, contractVersion, adapterVersion });
const bound = (name, operation) => ({ store, run, operation, assertAuthority: async () => input.authority !== false,
  binding: { runtimeId: run.runtimeId, runtime: descriptor(runtime.describe()), taskId: run.taskId, botId: run.botId,
    toolName: name, provider: descriptor(browser.describe()),
    sandbox: { id: "owned-fixture", contractVersion: "1", adapterVersion: "1" },
    computer: { ...computer, mode: "dedicated" },
  },
});
let observed; let events = []; let failure;
try {
  if (input.phase === "observe") {
    await browser.navigate(computer, { url: input.url }, context); observed = await browser.snapshot(computer, {}, context);
  } else {
    const request = { botId: run.botId, threadId: run.threadId, runId: run.id, history: [], instructions: "Only the owned disposable task.",
      prompt: JSON.stringify({ url: input.url, operation: input.operation }), model: { provider: "external", id: run.runtimeId },
      tools: ["browser_navigate", "browser_snapshot", "browser_act"].map((name) => ({ name, inputSchema: {} })),
      reconcileToolOperation: async (name, operation) => { calls.push(name + ":reconcile"); return reconcileToolOperation(bound(name, operation)); },
      executeTool: async (name, args, _executionId, _route, operation) => {
        calls.push(name);
        if (name === "browser_navigate") { assert.equal(args.url, input.url); return browser.navigate(computer, args, context); }
        if (name === "browser_snapshot") return browser.snapshot(computer, {}, context);
        assert.equal(name, "browser_act"); if (!legacy) assert.ok(operation);
        assert.equal(args.actions.length, 2); assert.equal(args.actions[0].kind, "fill");
        assert.equal(args.actions[0].text, "disposable task"); assert.equal(args.actions[1].kind, "click");
        let applied;
        if (legacy) {
          const key = toolEffectIdempotencyKey(run.id, name, args);
          const effect = await store.externalEffect.findUnique({ where: { idempotencyKey: key } });
          applied = effect ? { duplicate: true, effect } : { duplicate: false, effect: await store.externalEffect.create({ data: {
            runId: run.id, spaceId: run.spaceId, kind: name, idempotencyKey: key, status: "intended", request: args,
          } }) };
        } else applied = await recordToolOperationEffect({ ...bound(name, operation), request: args });
        if (applied.duplicate) {
          const gate = resolveDuplicateEffectGate(applied.effect, name);
          if (gate.action === "return") return gate.result;
          throw new Error("Original fixture action is held");
        }
        assert.ok(await claimIntendedEffect(store, applied.effect.id));
        actionRefs = args.actions.map((action) => action.ref);
        if (input.phase === "claim-only") return { uncertain: true, error: "Owned cutpoint before dispatch" };
        batches++; const result = await browser.act(computer, args, context);
        assert.ok(await completeExternalEffect(store, applied.effect.id, "executing", result)); return result;
      },
    };
    for await (const event of registry.resolve(run.runtimeId).run(request, context)) events.push(event);
  }
} catch (error) { failure = error.message; }
assert.ok(helpers.every((helper) => helper.exited));
console.log(JSON.stringify({ phase: input.phase, hostPid: process.pid, queuedRuntimeId: run.runtimeId, calls, batches, actionRefs,
  observed, done: events.some((event) => event.type === "done"), failure, helpers,
  fixtureBoundaries: ["queue transaction", "JSON-backed ExternalEffect store", "current authority and exact allow policy", "ACP peer"],
}));
