import "./runtime-source-loader.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const { AgentRuntimeRegistry } = await import("../packages/adapter-kit/src/agent-runtime-registry.ts");
const { configureRunCreation, createQueuedRun } = await import("../packages/db/src/queued-runs.ts");
const { AcpAgentRuntime } = await import("../packages/adapters/src/acp-runtime.ts");
const { connectAcpStdio } = await import("../packages/adapters/src/acp-stdio.ts");
const { withRuntimeCleanup } = await import("../packages/adapters/src/runtime-stream.ts");
const { resolveDuplicateEffectGate, approvalPausedToolResult } = await import("../packages/adapters/src/approval-effect.ts");
const { toolEffectIdempotencyKey } = await import("../packages/core/src/approval-effect-key.ts");

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}
function engine(id) {
  return { describe: () => ({ id, capabilities: {} }), async *run() { yield { type: "done" }; }, async abort() {} };
}
function fixtureDb(runtimeId = null) {
  const db = { bot: { runtimeId }, runs: [], tasks: [] };
  const tx = {
    bot: { findUniqueOrThrow: async () => ({ runtimeId: db.bot.runtimeId }) },
    run: { create: async ({ data, select }) => {
      const run = { id: "run-" + db.runs.length, ...data };
      db.runs.push(run);
      return select ? Object.fromEntries(Object.keys(select).map((key) => [key, run[key]])) : run;
    } },
  };
  db.tx = tx;
  db.transaction = async (action) => {
    const oldRuns = [...db.runs]; const oldTasks = [...db.tasks];
    try { return await action(tx); }
    catch (error) { db.runs = oldRuns; db.tasks = oldTasks; throw error; }
  };
  return db;
}
const data = { botId: "bot", userId: "user", spaceId: "space", threadId: "thread", taskId: "task", status: "queued", trigger: "user" };
const request = {
  botId: "bot", threadId: "thread", runId: "run", prompt: "local task",
  instructions: "Use the supplied host tools.", history: [], tools: [
    { name: "mutate", description: "fixture effect", inputSchema: { type: "object" } },
  ],
  model: { provider: "local", id: "fixture", apiKey: "synthetic-private-sentinel" },
};
async function collect(iterable) { const result = []; for await (const event of iterable) result.push(event); return result; }
function peer(mode, hooks = {}) {
  const ready = deferred();
  const runtime = new AcpAgentRuntime({
    id: "acp:fixture", cwd: root, cancelTimeoutMs: 200, ...hooks.options,
    connect: (handlers) => {
      const connection = connectAcpStdio({
        command: process.execPath, args: [path.join(root, "scripts/fixtures/acp-peer.mjs"), mode],
        cwd: root, timeoutMs: 2_000,
      }, handlers);
      return {
        ...connection,
        request: (method, params) => {
          hooks.outbound?.(method, params);
          const result = connection.request(method, params);
          if (method === "session/prompt") ready.resolve();
          return result;
        },
        close: async () => { await connection.close(); hooks.closed?.(); },
      };
    },
  });
  return { runtime, ready: ready.promise };
}

test("queue selection stays bound after Bot and deployment default change", async () => {
  const db = fixtureDb("engine-a");
  const registry = new AgentRuntimeRegistry("engine-a").register(engine("engine-a")).register(engine("engine-b"));
  configureRunCreation(db, registry);
  const run = await createQueuedRun(db, db.tx, { data });
  db.bot.runtimeId = "engine-b";
  configureRunCreation(db, new AgentRuntimeRegistry("engine-b").register(engine("engine-b")));
  assert.equal(run.runtimeId, "engine-a");
  assert.equal(registry.resolve(run.runtimeId).describe().id, "engine-a");
  assert.equal((await createQueuedRun(db, db.tx, { data })).runtimeId, "engine-b");
});

test("null preference binds a concrete default and owners stay isolated", async () => {
  const a = fixtureDb(); const b = fixtureDb();
  configureRunCreation(a, new AgentRuntimeRegistry("a").register(engine("a")));
  configureRunCreation(b, new AgentRuntimeRegistry("b").register(engine("b")));
  const results = await Promise.all([createQueuedRun(a, a.tx, { data }), createQueuedRun(b, b.tx, { data, select: { id: true } })]);
  assert.equal(results[0].runtimeId, "a");
  assert.deepEqual(results[1], { id: "run-0" });
  assert.equal(b.runs[0].runtimeId, "b");
});

test("unknown or unconfigured selection writes no Run and transaction rolls back Task", async () => {
  const db = fixtureDb("missing");
  await assert.rejects(createQueuedRun(db, db.tx, { data }), /configured runtime/);
  configureRunCreation(db, new AgentRuntimeRegistry("a").register(engine("a")));
  await assert.rejects(db.transaction(async (tx) => {
    db.tasks.push("task");
    await createQueuedRun(db, tx, { data });
  }), /Unknown agent runtime/);
  assert.equal(db.runs.length, 0); assert.equal(db.tasks.length, 0);
  db.bot.runtimeId = "a";
  await assert.rejects(createQueuedRun(db, db.tx, { data: { ...data, runtimeId: "b" } }), /queue-time/);
});

test("production creation inventory uses one factory and both roots configure it", async () => {
  const producers = [
    "apps/api/src/router.ts", "apps/api/src/thread-target.ts", "apps/api/src/taught-skills.ts",
    "packages/db/src/events.ts", "packages/adapters/src/executor.ts",
    "packages/adapters/src/child-bots.ts", "packages/adapters/src/bot-messages.ts",
    "packages/adapters/src/group-handoff.ts", "packages/adapters/src/agent-connections.ts",
    "packages/adapters/src/cloud-agent-poll.ts",
  ];
  let count = 0;
  for (const producer of producers) {
    const source = await fs.readFile(path.join(root, producer), "utf8");
    assert.doesNotMatch(source, /\.run\.create\(/);
    count += (source.match(/createQueuedRun\([^\n]+/g) ?? []).length;
  }
  assert.equal(count, 15);
  for (const file of ["apps/api/src/app.ts", "apps/worker/src/index.ts"]) {
    const source = await fs.readFile(path.join(root, file), "utf8");
    assert.match(source, /configureRunCreation\(prisma, runtimes\)/);
    assert.match(source, /createAgentRuntimes\(/);
  }
});

test("real stdio peer negotiates identity/model without copying credentials or routes", async () => {
  const sent = [];
  const { runtime } = peer("complete", { outbound: (method, params) => sent.push(JSON.parse(JSON.stringify({ method, params }))) });
  const result = await collect(runtime.run(request));
  assert.equal(result.at(-1).type, "done");
  const wire = JSON.stringify(sent);
  assert.ok(!wire.includes(request.model.apiKey));
  const identity = sent.find((call) => call.method === "session/new").params._meta["rakazo.dev/host-tools"];
  assert.equal(identity.botId, request.botId); assert.equal(identity.runId, request.runId);
  assert.deepEqual(identity.model, { provider: "local", id: "fixture" });
  assert.equal(identity.tools[0].route, undefined);
});

test("concurrent duplicate external call IDs invoke the host exactly once", async () => {
  let count = 0;
  const { runtime } = peer("duplicate");
  const result = await collect(runtime.run({ ...request, executeTool: async () => { count++; return { ok: true }; } }));
  assert.equal(count, 1);
  assert.equal(result.filter((event) => event.type === "tool").length, 1);
});

test("call ID reuse with changed input fails instead of applying a second effect", async () => {
  let count = 0;
  const { runtime } = peer("changed");
  await assert.rejects(collect(runtime.run({ ...request, executeTool: async () => { count++; return {}; } })), /different input/);
  assert.ok(count <= 1);
});

for (const mode of ["protocol", "no-extension", "death", "malformed", "oversize", "native", "permission", "unlisted", "non-success"]) {
  test("fails closed for " + mode, async () => {
    let count = 0;
    const { runtime } = peer(mode);
    await assert.rejects(collect(runtime.run({ ...request, executeTool: async () => { count++; return {}; } })));
    assert.equal(count, 0);
  });
}

test("ACP reporting-only tool notification never invokes the host", async () => {
  let count = 0;
  const { runtime } = peer("notification");
  await collect(runtime.run({ ...request, executeTool: async () => { count++; return {}; } }));
  assert.equal(count, 0);
});

test("host uncertainty fails the turn without automatic redispatch", async () => {
  let count = 0;
  let audits = 0;
  const { runtime } = peer("unknown");
  await assert.rejects(collect(runtime.run({ ...request, executeTool: async () => {
    count++; return { uncertain: true };
  }, onToolCompleted: () => { audits++; } })), /outcome unknown/);
  assert.equal(count, 1);
  assert.equal(audits, 1);
});

test("a throwing audit hook is invoked once", async () => {
  let audits = 0;
  const { runtime } = peer("unknown");
  await assert.rejects(collect(runtime.run({ ...request, executeTool: async () => ({ ok: true }),
    onToolCompleted: () => { audits++; throw new Error("fixture audit failure"); },
  })), /fixture audit failure/);
  assert.equal(audits, 1);
});

test("return cancels a quiet pending next without a separate abort", async () => {
  const { runtime, ready } = peer("quiet");
  const iterator = runtime.run(request)[Symbol.asyncIterator]();
  const next = iterator.next();
  const rejected = assert.rejects(next, /cancelled/);
  await ready;
  await iterator.return();
  await rejected;
});

for (const stage of ["initialize", "session/new"]) {
  test("abort during " + stage + " closes setup and cannot issue another setup request", async () => {
    const entered = deferred(); const sent = [];
    let closed = false;
    const { runtime } = peer(stage === "initialize" ? "quiet-initialize" : "quiet-new", {
      outbound: (method) => { sent.push(method); if (method === stage) entered.resolve(); },
      closed: () => { closed = true; },
    });
    const completion = collect(runtime.run(request));
    const rejected = assert.rejects(completion, /abort/i);
    await entered.promise; await runtime.abort(request.runId); await rejected;
    assert.equal(closed, true);
    assert.ok(!sent.includes(stage === "initialize" ? "session/new" : "session/prompt"));
  });
}

test("approval pause preserves the host pause without emitting completion", async () => {
  const { runtime } = peer("approval");
  const result = await collect(runtime.run({ ...request, executeTool: async () => approvalPausedToolResult() }));
  assert.ok(!result.some((event) => event.type === "done"));
});

test("restart with changed external IDs uses the existing durable effect gate", async () => {
  let mutations = 0;
  const effects = new Map();
  const executeTool = async (name, args) => {
    const key = toolEffectIdempotencyKey(request.runId, name, args, 0);
    const old = effects.get(key);
    if (old) {
      const gate = resolveDuplicateEffectGate(old, name);
      if (gate.action === "return") return gate.result;
      throw new Error("unknown prior effect");
    }
    mutations++;
    const result = { ok: true };
    effects.set(key, { status: "completed", result });
    return result;
  };
  for (const mode of ["replay-a", "replay-b"]) await collect(peer(mode).runtime.run({ ...request, executeTool }));
  assert.equal(mutations, 1);
  const unknownKey = toolEffectIdempotencyKey(request.runId, "mutate", { value: 1 }, 0);
  effects.set(unknownKey, { status: "executing" });
  await assert.rejects(collect(peer("replay-b").runtime.run({ ...request, executeTool })), /unknown prior effect/);
  assert.equal(mutations, 1);
});

test("quiet prompt abort waits for cancellation response and closes the peer", async () => {
  let closed = false;
  const { runtime, ready } = peer("quiet", { closed: () => { closed = true; } });
  const completion = collect(runtime.run(request));
  const rejected = assert.rejects(completion, /cancelled/);
  await ready; await runtime.abort(request.runId); await rejected;
  assert.equal(closed, true);
});

test("missing cancellation acknowledgment remains unknown", async () => {
  const { runtime, ready } = peer("cancel-unknown");
  const completion = collect(runtime.run(request));
  const rejected = assert.rejects(completion, /cancellation outcome unknown/);
  await ready; await runtime.abort(request.runId); await rejected;
});

test("iterator return and abort cannot close the peer before host work settles", async () => {
  const started = deferred(); const sawAbort = deferred(); const release = deferred();
  const controller = new AbortController();
  let closed = false; let returned = false;
  const { runtime } = peer("blocked", { closed: () => { closed = true; } });
  const completion = (async () => {
    for await (const event of withRuntimeCleanup(runtime.run({
      ...request, executeTool: async () => {
        started.resolve();
        controller.signal.addEventListener("abort", () => sawAbort.resolve(), { once: true });
        await release.promise;
        return { ok: true };
      },
    }, { signal: controller.signal }), controller)) {
      if (event.type === "tool") break;
    }
    returned = true;
  })();
  await started.promise; await sawAbort.promise;
  assert.equal(closed, false); assert.equal(returned, false);
  const aborted = runtime.abort(request.runId);
  release.resolve();
  await Promise.all([completion, aborted]);
  assert.equal(closed, true); assert.equal(returned, true);
});

test("external host-call budget stops a second effect and never reports success", async () => {
  let count = 0;
  const { runtime } = peer("tool-limit", { options: { maxToolCalls: 1 } });
  await assert.rejects(collect(runtime.run({ ...request, executeTool: async () => {
    count++; return { ok: true };
  } })), /tool call limit/);
  assert.equal(count, 1);
});

test("duplicate call IDs consume one host-call slot", async () => {
  let count = 0;
  const { runtime } = peer("duplicate", { options: { maxToolCalls: 1 } });
  const events = await collect(runtime.run({ ...request, executeTool: async () => {
    count++; return { ok: true };
  } }));
  assert.equal(count, 1);
  assert.equal(events.at(-1).type, "done");
});

async function withConfig(contents, action) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-config-"));
  const file = path.join(directory, "config.json");
  try {
    await fs.writeFile(file, typeof contents === "string" ? contents : JSON.stringify(contents));
    return await action(file);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

function externalConfig(overrides = {}) {
  return { version: 1, runtimes: [{
    id: "acp:configured", transport: "acp-stdio", command: process.execPath,
    args: [path.join(root, "scripts/fixtures/acp-peer.mjs"), "duplicate"], cwd: root,
    maxToolCalls: 1, ...overrides,
  }] };
}

test("operator configuration creates a selectable real stdio engine", async () => {
  const { loadExternalAgentRuntimes } = await import("../packages/adapters/src/external-agent-runtimes.ts");
  await withConfig(externalConfig(), async (file) => {
    const runtimes = loadExternalAgentRuntimes(file);
    const registry = new AgentRuntimeRegistry("acp:configured");
    for (const runtime of runtimes) registry.register(runtime);
    let count = 0;
    const events = await collect(registry.resolve().run({ ...request, executeTool: async () => {
      count++; return { ok: true };
    } }));
    assert.equal(count, 1);
    assert.equal(events.at(-1).type, "done");
    assert.deepEqual(loadExternalAgentRuntimes(undefined), []);
  });
});

test("operator configuration rejects unsupported authority and malformed limits before launch", async () => {
  const { loadExternalAgentRuntimes } = await import("../packages/adapters/src/external-agent-runtimes.ts");
  for (const overrides of [
    { transport: "shell" }, { command: "node" }, { cwd: "." }, { id: "pi" },
    { command: process.execPath + "\0" }, { cwd: root + "\0" },
    { args: [null] }, { env: { KEY: 3 } }, { env: { "invalid=key": "value" } },
    { maxToolCalls: 0 }, { maxToolCalls: 1001 }, { timeoutMs: -1 },
    { maxMessageBytes: 100 }, { extraAuthority: true },
  ]) await withConfig(externalConfig(overrides), (file) => {
    assert.throws(() => loadExternalAgentRuntimes(file), /Invalid external runtime configuration/);
  });
  for (const contents of ["not-json", { version: 2, runtimes: [] },
    { version: 1, runtimes: [externalConfig().runtimes[0], externalConfig().runtimes[0]] },
    " ".repeat(65_537)]) await withConfig(contents, (file) => {
    assert.throws(() => loadExternalAgentRuntimes(file), /Invalid external runtime configuration/);
  });
  assert.throws(() => loadExternalAgentRuntimes("relative.json"), /absolute/);
});

test("external engine selection never consults hosted model credentials", async () => {
  const { selectRuntimeModel } = await import("../packages/adapters/src/runtime-model-selection.ts");
  const { runtime } = peer("complete");
  const selected = selectRuntimeModel(runtime, () => { throw new Error("hosted credential selection must not run"); });
  assert.deepEqual(selected, {
    provider: "external", id: "acp:fixture", credential: null, thinkingLevel: null,
  });
  const events = await collect(runtime.run({ ...request, model: {
    provider: selected.provider, id: selected.id,
  } }));
  assert.equal(events.at(-1).type, "done");
  const hostSelected = { provider: "local", id: "connected", credential: { id: "existing" }, thinkingLevel: null };
  assert.equal(selectRuntimeModel(engine("host"), () => hostSelected), hostSelected);
});

test("configured peers receive only their explicit environment", async () => {
  const { loadExternalAgentRuntimes } = await import("../packages/adapters/src/external-agent-runtimes.ts");
  const before = process.env.RZK_TEST_PARENT_SECRET;
  process.env.RZK_TEST_PARENT_SECRET = "synthetic-parent-only-sentinel";
  try {
    await withConfig(externalConfig({
      args: [path.join(root, "scripts/fixtures/acp-peer.mjs"), "environment"],
      env: { RZK_TEST_APPROVED_VALUE: "fixture-allowed" },
    }), async (file) => {
      const [runtime] = loadExternalAgentRuntimes(file);
      const events = await collect(runtime.run(request));
      const texts = events.filter((event) => event.type === "text").map((event) => event.text);
      assert.deepEqual(JSON.parse(texts[0]), { parent: null, approved: "fixture-allowed" });
    });
  } finally {
    if (before === undefined) delete process.env.RZK_TEST_PARENT_SECRET;
    else process.env.RZK_TEST_PARENT_SECRET = before;
  }
});
