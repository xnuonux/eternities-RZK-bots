import "./runtime-source-loader.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

const module = await import("../packages/adapters/src/tool-operation.ts");
const operation = { id: "operation-opaque-1", actionDigest: "a".repeat(64) };
const binding = {
  runtimeId: "runtime-a", taskId: "task-opaque", botId: "bot-opaque",
  toolName: "browser_act", provider: { id: "computer", contractVersion: "1", adapterVersion: "1" },
  sandbox: { id: "local", contractVersion: "1", adapterVersion: "1" },
  computer: { id: "computer-opaque", kind: "desktop", providerRef: "computer-opaque", mode: "dedicated" },
};
const args = { actions: [{ kind: "click", ref: "snapshot-old:button" }] };
function fixture() {
  const rows = [];
  const store = { externalEffect: {
    async findUnique({ where }) { return rows.find((row) => row.idempotencyKey === where.idempotencyKey) ?? null; },
    async create({ data }) {
      if (rows.some((row) => row.idempotencyKey === data.idempotencyKey)) throw Object.assign(new Error("conflict"), { code: "P2002" });
      const row = { id: "effect-" + rows.length, ...data }; rows.push(row); return row;
    },
  } };
  const input = { store, run: { id: "run-opaque", spaceId: "space-opaque" }, operation, binding, assertAuthority: async () => true };
  return { rows, input };
}
test("original operation reconciliation is an executable host boundary", () => {
  assert.equal(typeof module.reconcileToolOperation, "function");
  assert.equal(typeof module.recordToolOperationEffect, "function");
});
test("completed original operation reuses its receipt despite fresh browser references", async () => {
  const { rows, input } = fixture();
  assert.deepEqual(await module.reconcileToolOperation(input), { status: "missing" });
  const first = await module.recordToolOperationEffect({ ...input, request: args });
  assert.equal(first.duplicate, false);
  rows[0].status = "completed"; rows[0].result = { ok: true, completed: 1 };
  const fresh = { actions: [{ kind: "click", ref: "snapshot-new:button" }] };
  const replay = await module.recordToolOperationEffect({ ...input, request: fresh });
  assert.equal(replay.duplicate, true); assert.equal(rows.length, 1);
  assert.deepEqual(await module.reconcileToolOperation(input), { status: "completed", result: { ok: true, completed: 1 } });
});
test("claimed, unknown, denied and incomplete receipts never become a new effect permit", async () => {
  for (const status of ["executing", "uncertain", "denied", "unexpected", "completed"]) {
    const { rows, input } = fixture();
    await module.recordToolOperationEffect({ ...input, request: args }); rows[0].status = status;
    const gate = await module.reconcileToolOperation(input);
    assert.equal(gate.status, "held"); assert.equal(rows.length, 1);
  }
});
test("a completed row containing an uncertain tool result is still unknown", async () => {
  const { rows, input } = fixture();
  await module.recordToolOperationEffect({ ...input, request: args });
  rows[0].status = "completed"; rows[0].result = { uncertain: true, error: "partial action outcome unknown" };
  assert.deepEqual(await module.reconcileToolOperation(input), { status: "held", reason: "outcome_unknown" });
});
test("runtime, provider, computer, tool and action changes reject the same operation", async () => {
  const { rows, input } = fixture();
  await module.recordToolOperationEffect({ ...input, request: args });
  rows[0].status = "completed"; rows[0].result = { ok: true };
  for (const change of [
    { binding: { ...binding, runtimeId: "runtime-b" } },
    { binding: { ...binding, provider: { ...binding.provider, id: "other" } } },
    { binding: { ...binding, computer: { ...binding.computer, mode: "shared" } } },
    { binding: { ...binding, toolName: "computer_act" } },
    { operation: { ...operation, actionDigest: "b".repeat(64) } },
  ]) {
    assert.equal((await module.reconcileToolOperation({ ...input, ...change })).reason, "binding_changed");
    await assert.rejects(module.recordToolOperationEffect({ ...input, ...change, request: args }), /binding/);
  }
  assert.equal(rows.length, 1);
});
test("approval replay cannot trade its stored transport arguments for fresh references", async () => {
  const { rows, input } = fixture();
  await module.recordToolOperationEffect({ ...input, request: args });
  for (const status of ["intended", "approved"]) {
    rows[0].status = status;
    assert.equal((await module.reconcileToolOperation(input)).reason, "pending_approval");
    await assert.rejects(module.recordToolOperationEffect({ ...input, request: { actions: [{ kind: "click", ref: "snapshot-new:button" }] } }), /arguments/);
  }
});
test("lost current authority prevents reconciliation and row creation", async () => {
  const { rows, input } = fixture(); const lost = { ...input, assertAuthority: async () => false };
  assert.equal((await module.reconcileToolOperation(lost)).reason, "authority_unavailable");
  await assert.rejects(module.recordToolOperationEffect({ ...lost, request: args }), /authority/);
  assert.equal(rows.length, 0);
});
test("retargeting a live Run's runtime, task, bot or space holds before receipt lookup or creation", async () => {
  const expected = { id: "run-opaque", runtimeId: "runtime-a", taskId: "task-opaque", botId: "bot-opaque", spaceId: "space-opaque" };
  assert.equal(module.toolOperationRunIdentityMatches(expected, expected), true);
  for (const field of ["id", "runtimeId", "taskId", "botId", "spaceId"]) {
    const { rows, input } = fixture();
    const live = { ...expected, [field]: "retargeted-opaque" };
    const changed = { ...input, assertAuthority: async () => module.toolOperationRunIdentityMatches(live, expected) };
    assert.deepEqual(await module.reconcileToolOperation(changed), { status: "held", reason: "authority_unavailable" });
    await assert.rejects(module.recordToolOperationEffect({ ...changed, request: args }), /authority/);
    assert.equal(rows.length, 0);
  }
});
test("simultaneous original-operation registration shares one durable row", async () => {
  const { rows, input } = fixture();
  const result = await Promise.all([module.recordToolOperationEffect({ ...input, request: args }), module.recordToolOperationEffect({ ...input, request: args })]);
  assert.equal(rows.length, 1); assert.equal(result.filter((item) => !item.duplicate).length, 1);
});
