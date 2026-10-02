import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { cdp, launchDisposableBrowser } from "./fixtures/disposable-browser.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
function argument(name) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
const browserCommand = argument("--browser-command"); const pythonCommand = argument("--python-command"); const output = argument("--output");
if (![browserCommand, pythonCommand, output].every((value) => value && path.isAbsolute(value))) throw new Error("Provide absolute installed browser, Python, and fresh output paths");
await fs.mkdir(output); // Existing output is an uncertain prior run; never overwrite or relaunch it.
const results = []; const browsers = []; const hosts = []; const receipts = []; let browser;
const server = http.createServer((request, response) => {
  if (request.method === "POST" && request.url === "/receipt") {
    let body = ""; request.on("data", (chunk) => { body += chunk; if (body.length > 1_024) request.destroy(); });
    request.on("end", () => { try { receipts.push(JSON.parse(body)); response.writeHead(204).end(); } catch { response.writeHead(400).end(); } });
  } else if (request.method === "GET" && request.url === "/outcome") {
    response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(receipts));
  } else if (request.method === "GET" && ["/", "/legacy"].includes(request.url)) {
    const arm = request.url === "/legacy" ? "args-key-null" : "original-operation";
    const count = receipts.filter((receipt) => receipt.arm === arm).length;
    response.setHeader("Content-Type", "text/html"); response.end(`<!doctype html><html><head><title>${count ? "Completed once" : "Disposable task"}</title></head>
      <body><h1>Disposable task</h1><label for="task">Task label</label><input id="task" aria-label="Task label"><button id="complete">Complete task</button><p id="result">${count} completions.</p>
      <script>document.querySelector('#complete').onclick=()=>{document.title='Completed once';fetch('/receipt',{method:'POST',body:JSON.stringify({arm:${JSON.stringify(arm)},label:document.querySelector('#task').value})});document.querySelector('#result').textContent='Completed.'};</script></body></html>`);
  } else response.writeHead(404).end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const operation = { id: "operation-opaque-1", actionDigest: createHash("sha256").update("owned-task:complete-once").digest("hex") };
const unknownOperation = { id: "operation-opaque-2", actionDigest: createHash("sha256").update("owned-task:claim-only").digest("hex") };
async function host(phase, overrides = {}) {
  const input = path.join(output, phase + ".input.json");
  await fs.writeFile(input, JSON.stringify({ phase, cdpPort: browser.port, pythonCommand, url, operation,
    effectPath: path.join(output, "effects.fixture.json"), ...overrides }));
  const child = spawn(process.execPath, ["--experimental-transform-types", path.join(root, "scripts/fixtures/operation-browser-host.mjs"), input], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { TEMP: process.env.TEMP ?? output, TMP: process.env.TMP ?? output, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
  });
  const lifecycle = { pid: child.pid, phase, exited: false, exitCode: null }; hosts.push(lifecycle);
  let stdout = ""; let stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), 30_000);
  try {
    await new Promise((resolve, reject) => {
      child.on("error", reject); child.on("exit", (code) => { lifecycle.exited = true; lifecycle.exitCode = code; code === 0 ? resolve() : reject(new Error("Owned host process failed")); });
    });
    await fs.writeFile(path.join(output, phase + ".stdout.json"), stdout); await fs.writeFile(path.join(output, phase + ".stderr.txt"), stderr);
    const result = JSON.parse(stdout); results.push(result); return result;
  } finally { clearTimeout(timer); }
}
async function restartBrowser() {
  if (browser) await browser.close(); browser = await launchDisposableBrowser(browserCommand, output); browsers.push(browser.receipt);
}
try {
  await restartBrowser(); const applied = await host("apply");
  assert.equal(applied.failure, undefined); assert.equal(applied.batches, 1); assert.equal(applied.done, true);
  for (let attempt = 0; attempt < 30 && receipts.length !== 1; attempt++) await delay(25);
  assert.equal(receipts.length, 1);
  await restartBrowser(); const observer = await host("observe");
  const freshRefs = observer.observed.elements.filter((element) => ["textbox", "button"].includes(element.role)).map((element) => element.ref);
  assert.equal(freshRefs.length, 2); assert.notDeepEqual(freshRefs, applied.actionRefs);
  const resumed = await host("resume"); assert.notEqual(resumed.hostPid, applied.hostPid);
  assert.equal(resumed.batches, 0); assert.equal(resumed.done, true); assert.deepEqual(resumed.calls, ["browser_act:reconcile"]);
  const cutpoint = await host("claim-only", { operation: unknownOperation });
  assert.equal(cutpoint.batches, 0); assert.equal(cutpoint.done, false); assert.match(cutpoint.failure, /unknown/);
  const claimed = await host("resume-claimed", { operation: unknownOperation });
  assert.equal(claimed.batches, 0); assert.equal(claimed.done, false); assert.deepEqual(claimed.calls, ["browser_act:reconcile"]);
  assert.match(claimed.failure, /outcome_unknown/);
  const rebound = await host("changed-runtime", { runtimeId: "acp:other-fixture" });
  assert.equal(rebound.batches, 0); assert.equal(rebound.done, false); assert.match(rebound.failure, /binding_changed/);
  const lost = await host("lost-authority", { authority: false });
  assert.equal(lost.batches, 0); assert.equal(lost.done, false); assert.match(lost.failure, /authority_unavailable/);
  const outcome = await (await fetch(url + "outcome")).json(); assert.deepEqual(outcome, [{ arm: "original-operation", label: "disposable task" }]);
  const pages = await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json();
  const page = pages.find((entry) => entry.type === "page" && entry.url === url);
  const screenshot = await cdp(page.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png" });
  await fs.writeFile(path.join(output, "operation-browser.png"), Buffer.from(screenshot.data, "base64"));
  await restartBrowser(); const nullFirst = await host("legacy-apply", { url: url + "legacy", effectPath: path.join(output, "legacy-effects.fixture.json") });
  assert.equal(nullFirst.batches, 1); assert.equal(nullFirst.done, true); assert.equal(nullFirst.failure, undefined);
  await restartBrowser(); const nullSecond = await host("legacy-resume", { url: url + "legacy", effectPath: path.join(output, "legacy-effects.fixture.json") });
  assert.equal(nullSecond.batches, 1); assert.equal(nullSecond.done, true); assert.equal(nullSecond.failure, undefined);
  assert.notDeepEqual(nullFirst.actionRefs, nullSecond.actionRefs);
  for (let attempt = 0; attempt < 30 && receipts.length !== 3; attempt++) await delay(25);
  const allOutcomes = await (await fetch(url + "outcome")).json();
  assert.equal(allOutcomes.filter((receipt) => receipt.arm === "original-operation").length, 1);
  assert.equal(allOutcomes.filter((receipt) => receipt.arm === "args-key-null").length, 2);
  const receipt = { evidence: "production ACP, configured engine, operation helper and browser provider across distinct host and Chrome processes",
    fixtures: ["queue database", "JSON-backed ExternalEffect", "allow policy and current authority", "immutable-action digest", "ACP peer", "claimed cutpoint"],
    fullExecutorExecuted: false, postgresExecuted: false, nativeCognitionExecuted: false,
    physicalBatches: results.filter((result) => !result.phase.startsWith("legacy-")).reduce((sum, result) => sum + result.batches, 0), serverReceipts: outcome,
    nullArm: { physicalBatches: nullFirst.batches + nullSecond.batches, receipts: allOutcomes.filter((receipt) => receipt.arm === "args-key-null"),
      evidence: "Actual generic args-key fixture reissues the action after changed refs; this is not a native-operation or full worker duplicate observation" },
    changedRefs: { original: applied.actionRefs, fresh: freshRefs }, results,
  };
  await fs.writeFile(path.join(output, "operation-browser.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ physicalBatches: receipt.physicalBatches, receiptCount: outcome.length, nullPhysicalBatches: receipt.nullArm.physicalBatches, hostProcesses: hosts.length, freshRefsChanged: true, fullExecutorExecuted: false }));
} finally {
  if (browser) await browser.close(); await new Promise((resolve) => server.close(resolve));
  await fs.writeFile(path.join(output, "cleanup.json"), JSON.stringify({ browsers, hosts, serverClosed: !server.listening }, null, 2));
}
