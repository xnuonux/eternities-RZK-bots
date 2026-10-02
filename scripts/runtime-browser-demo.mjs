import "./runtime-source-loader.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const { AgentRuntimeRegistry } = await import("../packages/adapter-kit/src/agent-runtime-registry.ts");
const { configureRunCreation, createQueuedRun } = await import("../packages/db/src/queued-runs.ts");
const { loadExternalAgentRuntimes } = await import("../packages/adapters/src/external-agent-runtimes.ts");
const { selectRuntimeModel } = await import("../packages/adapters/src/runtime-model-selection.ts");
const { ComputerBrowserProvider } = await import("../packages/adapters/src/computer-browser.ts");
const { approvalPausedToolResult, resolveDuplicateEffectGate } = await import("../packages/adapters/src/approval-effect.ts");
const { toolEffectIdempotencyKey } = await import("../packages/core/src/approval-effect-key.ts");

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}
const browserCommand = argument("--browser-command");
const pythonCommand = argument("--python-command");
if (!browserCommand || !pythonCommand || !path.isAbsolute(browserCommand) || !path.isAbsolute(pythonCommand)) {
  throw new Error("Provide absolute --browser-command and --python-command paths to existing installed tools.");
}
const output = path.resolve(argument("--output", ".tmp/runtime-browser-demo"));
await fs.mkdir(output, { recursive: true });
const profile = await fs.mkdtemp(path.join(output, "browser-"));
let physicalBatches = 0;
let approvalPauses = 0;
let clickReceipts = 0;
let granted = false;
const effects = new Map();
const audits = [];
const helpers = [];
const serverOutcomes = [];
const html = `<!doctype html><html><head><title>Disposable task</title>
<style>body{font:20px system-ui;max-width:650px;margin:80px auto;color:#202020;background:#fafafa}
input,button{font:inherit;padding:12px;margin:12px 0}button{cursor:pointer}label{display:block}</style>
</head><body><h1>Disposable browser task</h1>
<label for="task">Task label</label><input id="task" aria-label="Task label">
<button id="complete">Complete task</button><p id="result">Waiting.</p>
<script>let clicks=0;document.querySelector("#complete").onclick=()=>{
clicks++;document.title=clicks===1?"Completed once":"Duplicate action";
document.querySelector("#result").textContent=document.querySelector("#task").value+" completed "+clicks+" time.";
fetch("/receipt",{method:"POST",body:JSON.stringify({clicks,label:document.querySelector("#task").value})});};</script></body></html>`;
const server = http.createServer((req, res) => {
  if (req.url === "/receipt" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 1_024) req.destroy(); });
    req.on("end", () => {
      try {
        const result = JSON.parse(body);
        assert.equal(result.clicks, 1);
        assert.equal(result.label, "disposable task");
        serverOutcomes.push(result); clickReceipts++; res.writeHead(204).end();
      } catch { res.writeHead(400).end(); }
    });
  } else if (req.url === "/outcome" && req.method === "GET") {
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(serverOutcomes));
  } else if (req.url === "/" && req.method === "GET") {
    res.setHeader("Content-Type", "text/html"); res.end(html);
  } else { res.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const localUrl = "http://127.0.0.1:" + server.address().port + "/";
const child = spawn(browserCommand, [
  "--headless", "--disable-gpu", "--no-first-run", "--disable-background-networking",
  "--disable-extensions", "--disable-component-update", "--disable-sync", "--metrics-recording-only",
  "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
  "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
  "--user-data-dir=" + profile, "about:blank",
], {
  windowsHide: true, stdio: "ignore",
  env: {
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
    TEMP: output, TMP: output, TMPDIR: output,
  },
});
let exited = false;
let launchError;
const browserExited = new Promise((resolve) => {
  child.on("error", () => { launchError = new Error("Disposable browser could not start"); exited = true; resolve(); });
  child.on("exit", () => { exited = true; resolve(); });
});
let cdpPort;
let browserWs;

async function cdp(url, method, params = {}) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP connection failed")), { once: true });
  });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP read timeout")), 5_000);
      socket.addEventListener("message", (message) => {
        const result = JSON.parse(String(message.data));
        if (result.id !== 1) return;
        clearTimeout(timer);
        if (result.error) reject(new Error("CDP command failed")); else resolve(result.result);
      });
      socket.send(JSON.stringify({ id: 1, method, params }));
    });
  } finally { socket.close(); }
}

async function drive(_computer, command, context) {
  context.signal.throwIfAborted();
  const helper = spawn(pythonCommand, [
    path.join(root, "infra/sandboxes/computer/rakazo-page-browser"), command.command,
  ], {
    cwd: root, windowsHide: true,
    env: { RAKAZO_CDP_PORT: String(cdpPort), RAKAZO_BROWSER_ARGS_STDIN: "1", RAKAZO_BROWSER_WATCH_STDIN: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lifecycle = { kind: "page-browser-helper", pid: helper.pid, exited: false, exitCode: null };
  helpers.push(lifecycle);
  helper.on("exit", (code) => { lifecycle.exited = true; lifecycle.exitCode = code; });
  helper.on("error", () => { lifecycle.exited = true; });
  let stdout = "";
  helper.stdout.setEncoding("utf8");
  helper.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.length > 1_048_576) helper.kill(); });
  helper.stderr.resume();
  const stop = () => helper.stdin.end();
  context.signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, 15_000);
  try {
    helper.stdin.write(JSON.stringify(command) + "\n");
    await new Promise((resolve, reject) => {
      helper.on("error", () => reject(new Error("Browser helper failed")));
      helper.on("exit", (code) => code === 0 ? resolve() : reject(new Error("Browser helper cancelled or failed")));
    });
    context.signal.throwIfAborted();
    return JSON.parse(stdout);
  } finally { clearTimeout(timer); context.signal.removeEventListener("abort", stop); }
}

try {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (exited) throw new Error("Disposable browser exited during startup");
    try {
      cdpPort = Number((await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]);
      if (cdpPort > 0) break;
    } catch {}
    await delay(50);
  }
  if (!cdpPort) throw new Error("Disposable browser startup not confirmed");
  browserWs = (await (await fetch("http://127.0.0.1:" + cdpPort + "/json/version")).json()).webSocketDebuggerUrl;
  const browser = new ComputerBrowserProvider({ liveDriver: drive });
  const configFile = path.join(profile, "runtime-config.json");
  await fs.writeFile(configFile, JSON.stringify({ version: 1, runtimes: [{
    id: "acp:fixture", transport: "acp-stdio", command: process.execPath,
    args: [path.join(root, "scripts/fixtures/acp-peer.mjs"), "browser"], cwd: root,
    maxToolCalls: 8, timeoutMs: 30_000,
  }] }));
  const [runtime] = loadExternalAgentRuntimes(configFile);
  const other = { describe: () => ({ id: "other" }), async *run() {}, async abort() {} };
  const registry = new AgentRuntimeRegistry("acp:fixture").register(runtime).register(other);
  // Queue database and approval store are deterministic fixtures, not PostgreSQL.
  const owner = {};
  let botRuntime = "acp:fixture";
  const tx = {
    bot: { findUniqueOrThrow: async () => ({ runtimeId: botRuntime }) },
    run: { create: async ({ data }) => ({ id: "fixture-run", ...data }) },
  };
  configureRunCreation(owner, registry);
  const run = await createQueuedRun(owner, tx, { data: {
    botId: "fixture-bot", userId: "fixture-user", spaceId: "fixture-space",
    threadId: "fixture-thread", taskId: "fixture-task", trigger: "user", status: "queued",
  } });
  botRuntime = "other";
  const selected = registry.resolve(run.runtimeId);
  assert.equal(selected, runtime);
  const controller = new AbortController();
  const context = {
    operationId: run.id, traceId: run.id, botId: run.botId, runId: run.id,
    spaceId: run.spaceId, userId: run.userId, signal: controller.signal, screenLeaseId: "fixture-run:1",
  };
  const computer = { id: "fixture-computer", botId: run.botId, kind: "desktop", providerRef: "fixture-computer" };
  const tools = ["browser_navigate", "browser_snapshot", "browser_act"].map((name) => ({
    name, description: "Disposable local browser " + name, inputSchema: { type: "object" },
  }));
  const executeTool = async (name, args) => {
    context.signal.throwIfAborted();
    if (name === "browser_navigate") {
      if (args.url !== localUrl) throw new Error("Demo permits only its disposable local page");
      return browser.navigate(computer, args, context);
    }
    if (name === "browser_snapshot") return browser.snapshot(computer, args, context);
    if (name !== "browser_act" || args.actions?.length !== 2 ||
        args.actions[0].kind !== "fill" || args.actions[0].text !== "disposable task" ||
        args.actions[1].kind !== "click") throw new Error("Demo action outside approved task");
    const key = toolEffectIdempotencyKey(run.id, name, args, 0);
    const stored = effects.get(key);
    if (stored) {
      const gate = resolveDuplicateEffectGate(stored, name);
      if (gate.action === "return") return gate.result;
      if (gate.action === "uncertain") return { uncertain: true };
    }
    if (!granted) {
      approvalPauses++; effects.set(key, { status: "intended" });
      return approvalPausedToolResult();
    }
    effects.set(key, { status: "executing" });
    physicalBatches++;
    const result = await browser.act(computer, args, context);
    effects.set(key, { status: result.uncertain ? "uncertain" : "completed", result });
    return result;
  };
  const request = {
    botId: run.botId, threadId: run.threadId, runId: run.id,
    prompt: JSON.stringify({ url: localUrl }), instructions: "Complete only this disposable local task.",
    history: [], tools, model: selectRuntimeModel(runtime, () => {
      throw new Error("Disposable external engine must not require host model credentials");
    }), executeTool,
    onToolCompleted: ({ name, executionId }) => audits.push({ name, executionId }),
  };
  async function turn() { const events = []; for await (const event of selected.run(request, context)) events.push(event); return events; }
  const paused = await turn();
  assert.equal(physicalBatches, 0);
  assert.ok(!paused.some((event) => event.type === "done"));
  granted = true;
  for (const effect of effects.values()) if (effect.status === "intended") effect.status = "approved";
  const completed = await turn();
  assert.equal(completed.at(-1).type, "done");
  assert.equal(physicalBatches, 1);
  const observed = await browser.snapshot(computer, {}, context);
  assert.equal(observed.title, "Completed once");
  for (let attempt = 0; attempt < 20 && clickReceipts !== 1; attempt++) await delay(25);
  assert.equal(clickReceipts, 1);
  const independentOutcome = await (await fetch(localUrl + "outcome")).json();
  assert.deepEqual(independentOutcome, [{ clicks: 1, label: "disposable task" }]);
  const pages = await (await fetch("http://127.0.0.1:" + cdpPort + "/json/list")).json();
  const page = pages.find((entry) => entry.type === "page" && entry.url === localUrl);
  const screenshot = await cdp(page.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png" });
  await fs.writeFile(path.join(output, "browser-demo.png"), Buffer.from(screenshot.data, "base64"));
  const receipt = {
    evidence: "real disposable Chromium via existing ComputerBrowserProvider and stdlib CDP helper",
    fixtures: ["queue database", "approval/effect store", "ACP peer and model"],
    botId: run.botId, runId: run.id, queuedRuntimeId: run.runtimeId, laterBotRuntimeId: botRuntime,
    approvalPauses, physicalActionBatches: physicalBatches, browserClickReceipts: clickReceipts,
    finalTitle: observed.title, callbackAudits: audits.length,
    independentOutcome, configuredRuntime: true, hostedModelCredentialsRequired: false,
    containment: "disposable host browser; no OS container demonstrated",
    runnerPid: process.pid, browserPid: child.pid,
    externalProvidersUsed: 0, realAccountsUsed: 0,
  };
  await fs.writeFile(path.join(output, "browser-demo.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  if (!exited && browserWs) {
    try { await cdp(browserWs, "Browser.close"); } catch {}
  }
  if (!exited) await Promise.race([browserExited, delay(3_000)]);
  if (!exited) { child.kill(); await Promise.race([browserExited, delay(3_000)]); }
  await new Promise((resolve) => server.close(resolve));
  if (!exited) throw new Error("Disposable browser termination unconfirmed; profile retained");
  const relative = path.relative(output, profile);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Invalid disposable profile boundary");
  await fs.rm(profile, { recursive: true, force: true });
  assert.ok(helpers.every((helper) => helper.exited));
  await fs.writeFile(path.join(output, "cleanup.json"), JSON.stringify({
    browserPid: child.pid, browserExited: exited, profileRemoved: true,
    fixtureServerClosed: !server.listening, helpers,
  }, null, 2) + "\n");
}
