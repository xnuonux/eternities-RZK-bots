import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function cdp(url, method, params = {}) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP connection failed")), { once: true });
  });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP command timeout")), 5_000);
      socket.addEventListener("message", (message) => {
        const result = JSON.parse(String(message.data)); if (result.id !== 1) return;
        clearTimeout(timer);
        if (result.error) reject(new Error("CDP command failed")); else resolve(result.result);
      });
      socket.send(JSON.stringify({ id: 1, method, params }));
    });
  } finally { socket.close(); }
}

export async function launchDisposableBrowser(command, output) {
  const profile = await fs.mkdtemp(path.join(output, "browser-"));
  const child = spawn(command, [
    "--headless", "--disable-gpu", "--no-first-run", "--disable-background-networking",
    "--disable-extensions", "--disable-component-update", "--disable-sync", "--metrics-recording-only",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
    "--user-data-dir=" + profile, "about:blank",
  ], { windowsHide: true, stdio: "ignore", env: {
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
    TEMP: process.env.TEMP ?? output, TMP: process.env.TMP ?? output, TMPDIR: process.env.TEMP ?? output,
  } });
  const receipt = { pid: child.pid, exited: false, exitCode: null, profileRemoved: false };
  let error; let browserWs;
  const exited = new Promise((resolve) => {
    child.on("error", () => { error = new Error("Disposable browser failed to launch"); receipt.exited = true; resolve(); });
    child.on("exit", (code) => { receipt.exited = true; receipt.exitCode = code; resolve(); });
  });
  async function close() {
    if (!receipt.exited && browserWs) { try { await cdp(browserWs, "Browser.close"); } catch {} }
    if (!receipt.exited) await Promise.race([exited, delay(3_000)]);
    if (!receipt.exited) { child.kill(); await Promise.race([exited, delay(3_000)]); }
    if (!receipt.exited) throw new Error("Owned browser exit unconfirmed; profile retained");
    const relative = path.relative(output, profile);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(profile, { recursive: true, force: true }); receipt.profileRemoved = true;
  }
  try {
    const deadline = Date.now() + 10_000; let port;
    while (Date.now() < deadline) {
      if (error) throw error; if (receipt.exited) throw new Error("Disposable browser exited during startup");
      try { port = Number((await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); if (port > 0) break; } catch {}
      await delay(50);
    }
    if (!port) throw new Error("Disposable browser startup unconfirmed");
    browserWs = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
    return { port, receipt, close };
  } catch (failure) { await close(); throw failure; }
}

export function pageBrowserDriver(root, pythonCommand, port, helpers) {
  return async (_computer, command, context) => {
    context.signal.throwIfAborted();
    const helper = spawn(pythonCommand, [path.join(root, "infra/sandboxes/computer/rakazo-page-browser"), command.command], {
      cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { RAKAZO_CDP_PORT: String(port), RAKAZO_BROWSER_ARGS_STDIN: "1", RAKAZO_BROWSER_WATCH_STDIN: "1",
        ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}), ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
      },
    });
    const receipt = { pid: helper.pid, exited: false, exitCode: null }; helpers.push(receipt);
    let stdout = ""; helper.stdout.setEncoding("utf8");
    helper.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.length > 1_048_576) helper.kill(); }); helper.stderr.resume();
    const stop = () => helper.stdin.end(); context.signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, 15_000);
    try {
      helper.stdin.write(JSON.stringify(command) + "\n");
      await new Promise((resolve, reject) => {
        helper.on("error", () => { receipt.exited = true; reject(new Error("Owned browser helper failed")); });
        helper.on("exit", (code) => { receipt.exited = true; receipt.exitCode = code; code === 0 ? resolve() : reject(new Error("Owned browser helper exited unsuccessfully")); });
      });
      context.signal.throwIfAborted(); return JSON.parse(stdout);
    } finally { clearTimeout(timer); context.signal.removeEventListener("abort", stop); }
  };
}
