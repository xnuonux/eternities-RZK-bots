import readline from "node:readline";

// Offline protocol peer. It never executes commands, reads files, or uses a model.
const mode = process.argv[2] ?? "complete";
const sessionId = "fixture-session";
const pending = new Map();
let seq = 0;
let promptId;
let identity;
const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const response = (id, result) => write({ id, result });
const text = (value) => write({
  method: "session/update",
  params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } } },
});
function host(method, params) {
  const id = "peer-" + seq++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    write({ id, method, params: { sessionId, ...params } });
  });
}
const tool = (name, args, toolCallId = "call", operation) => host("_rakazo/tool", { name, args, toolCallId, ...(operation ? { operation } : {}) });

async function turn(params) {
  if (mode === "death") { process.exit(0); }
  if (mode === "malformed") { process.stdout.write("invalid-json\n"); return; }
  if (mode === "oversize") { process.stdout.write("x".repeat(2_000_000)); return; }
  if (mode === "quiet" || mode === "cancel-unknown") return;
  if (mode === "native") await host("fs/read_text_file", { path: "/denied" });
  else if (mode.startsWith("operation-")) {
    const envelope = JSON.parse(params.prompt[0].text);
    const task = JSON.parse(envelope.prompt);
    const operation = task.operation ?? { id: "operation-opaque-1", actionDigest: "a".repeat(64) };
    if (mode === "operation-omitted") await tool("browser_act", { actions: [] });
    else if (mode === "operation-changed-call") {
      await tool("browser_act", { actions: [] }, "call", operation);
      await tool("browser_act", { actions: [] }, "call", { ...operation, actionDigest: "b".repeat(64) });
    } else {
      const reconciled = (await host("_rakazo/reconcile-tool-operation", {
        name: "browser_act", operation, toolCallId: "original-reconcile",
      })).result;
      if (reconciled.status === "missing") {
        const nav = (await tool("browser_navigate", { url: task.url }, "navigate")).result;
        if (nav.error || nav.fallback) throw new Error("navigation unconfirmed");
        const snapshot = (await tool("browser_snapshot", {}, "snapshot")).result;
        const input = snapshot.elements.find((element) => element.role === "textbox");
        const button = snapshot.elements.find((element) => element.role === "button");
        if (!input || !button) throw new Error("fixture controls missing");
        const args = { actions: [
          { kind: "fill", ref: input.ref, text: "disposable task" },
          { kind: "click", ref: button.ref },
        ] };
        const result = await tool("browser_act", args, "complete-task", operation);
        if (result.result.ok !== true || result.result.completed !== 2) throw new Error("actions unconfirmed");
        await tool("browser_act", args, "complete-task-retry", operation);
      } else if (reconciled.status !== "completed") throw new Error("operation held");
      text("Original operation receipt reconciled.");
    }
  }
  else if (mode === "permission") await host("session/request_permission", { options: [] });
  else if (mode === "tool-limit") {
    await tool("mutate", { value: 1 }, "first");
    await tool("mutate", { value: 2 }, "second");
  }
  else if (mode === "environment") {
    text(JSON.stringify({
      parent: process.env.RZK_TEST_PARENT_SECRET ?? null,
      approved: process.env.RZK_TEST_APPROVED_VALUE ?? null,
    }));
  }
  else if (mode === "duplicate") {
    await Promise.all([tool("mutate", { value: 1 }), tool("mutate", { value: 1 })]);
  } else if (mode === "changed") {
    await Promise.all([tool("mutate", { value: 1 }), tool("mutate", { value: 2 })]);
  } else if (["unknown", "approval", "blocked", "replay-a", "replay-b"].includes(mode)) {
    await tool("mutate", { value: 1 }, mode.startsWith("replay-") ? mode : "call");
  } else if (mode === "unlisted") {
    await tool("unlisted", {});
  } else if (mode === "notification") {
    write({ method: "session/update", params: { sessionId, update: {
      sessionUpdate: "tool_call", toolCallId: "call", name: "mutate", title: "reported only", rawInput: { value: 1 },
    } } });
  } else if (mode === "browser") {
    const envelope = JSON.parse(params.prompt[0].text);
    const task = JSON.parse(envelope.prompt);
    const nav = (await tool("browser_navigate", { url: task.url }, "navigate")).result;
    if (nav.fallback || nav.error) throw new Error("navigation unconfirmed");
    const snapshot = (await tool("browser_snapshot", {}, "snapshot")).result;
    const input = snapshot.elements.find((element) => element.role === "textbox");
    const button = snapshot.elements.find((element) => element.role === "button");
    if (!input || !button) throw new Error("fixture controls missing");
    const args = { actions: [
      { kind: "fill", ref: input.ref, text: "disposable task" },
      { kind: "click", ref: button.ref },
    ] };
    // A retried request must reuse the result, never click again.
    const result = await tool("browser_act", args, "complete-task");
    await tool("browser_act", args, "complete-task");
    if (result.result.ok !== true || result.result.completed !== 2) throw new Error("actions unconfirmed");
    const final = (await tool("browser_snapshot", {}, "final")).result;
    if (final.title !== "Completed once") throw new Error("task completion not observed");
    text("Completed the disposable browser task once.");
  }
  if (mode !== "browser") text("Completed local protocol turn.");
  if (promptId !== undefined) {
    response(promptId, { stopReason: mode === "non-success" ? "max_turn_requests" : "end_turn" });
    promptId = undefined;
  }
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (pending.has(message.id)) {
    const call = pending.get(message.id); pending.delete(message.id);
    if (message.error) call.reject(new Error("host denied")); else call.resolve(message.result);
    return;
  }
  if (message.method === "initialize") {
    if (mode === "quiet-initialize") return;
    response(message.id, {
      protocolVersion: mode === "protocol" ? 99 : 1,
      agentCapabilities: { _meta: mode === "no-extension" ? {} : { "rakazo.dev/host-tools": 1 } },
      authMethods: [],
    });
  } else if (message.method === "session/new") {
    if (mode === "quiet-new") return;
    identity = message.params._meta["rakazo.dev/host-tools"];
    response(message.id, { sessionId });
  } else if (message.method === "session/prompt") {
    promptId = message.id;
    void turn(message.params).catch(() => {
      if (mode !== "approval") response(promptId, { stopReason: "refusal" });
    });
  } else if (message.method === "session/cancel" && mode !== "cancel-unknown" && promptId !== undefined) {
    response(promptId, { stopReason: "cancelled" });
    promptId = undefined;
  }
});
