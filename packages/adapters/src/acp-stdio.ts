import { spawn } from "node:child_process";
import path from "node:path";

export interface AcpHandlers {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  notification(method: string, params: Record<string, unknown>): void;
}

export interface AcpConnection {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  notify(method: string, params: Record<string, unknown>): void;
  close(): Promise<void>;
}

export interface AcpStdioOptions {
  /** Operator-owned executable, never supplied by a Bot or RPC payload. */
  command: string;
  args?: string[];
  cwd: string;
  /** Explicit allowlist; the parent's environment is never copied. */
  env?: Record<string, string>;
  timeoutMs?: number;
  maxMessageBytes?: number;
}

/** One trusted process per run. This transport is not an OS sandbox. */
export function connectAcpStdio(options: AcpStdioOptions, handlers: AcpHandlers): AcpConnection {
  if (!path.isAbsolute(options.command) || !path.isAbsolute(options.cwd)) {
    throw new Error("ACP command and working directory must be absolute");
  }
  const child = spawn(options.command, options.args ?? [], {
    cwd: options.cwd,
    env: options.env ?? {},
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxBytes = options.maxMessageBytes ?? 1_048_576;
  const pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  let nextId = 0;
  let failure: Error | undefined;
  let closing = false;
  let buffer = "";
  let exitResolve!: () => void;
  const exited = new Promise<void>((resolve) => { exitResolve = resolve; });

  function fail(error: Error) {
    failure ??= error;
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(failure);
    }
    pending.clear();
    child.kill();
  }

  function send(message: Record<string, unknown>) {
    if (failure) throw failure;
    if (closing) throw new Error("ACP connection closed");
    const line = JSON.stringify(message);
    if (Buffer.byteLength(line) > maxBytes) throw new Error("ACP message exceeds size limit");
    child.stdin.write(line + "\n", (error) => {
      if (error) fail(new Error("ACP write failed"));
    });
  }

  function receive(line: string) {
    let value: unknown;
    try { value = JSON.parse(line); }
    catch { fail(new Error("Malformed ACP JSON")); return; }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail(new Error("Invalid ACP message")); return;
    }
    const message = value as Record<string, unknown>;
    if (message.jsonrpc !== "2.0") { fail(new Error("Invalid ACP envelope")); return; }
    if (typeof message.method === "string") {
      if (!message.params || typeof message.params !== "object" || Array.isArray(message.params)) {
        fail(new Error("Invalid ACP parameters")); return;
      }
      const params = message.params as Record<string, unknown>;
      if (message.id === undefined) {
        try { handlers.notification(message.method, params); }
        catch { fail(new Error("Invalid ACP notification")); }
      } else if (typeof message.id === "number" || typeof message.id === "string") {
        const id = message.id;
        void handlers.request(message.method, params).then(
          (result) => {
            if (!failure && !closing) send({ jsonrpc: "2.0", id, result: result ?? null });
          },
          () => {
            if (!failure && !closing) send({
              jsonrpc: "2.0", id,
              error: { code: -32601, message: "Request denied by host" },
            });
          },
        ).catch(() => fail(new Error("ACP response failed")));
      } else { fail(new Error("Invalid ACP request id")); }
      return;
    }
    if (typeof message.id !== "number" || !pending.has(message.id)) {
      fail(new Error("Unexpected ACP response")); return;
    }
    const call = pending.get(message.id)!;
    pending.delete(message.id);
    clearTimeout(call.timer);
    if (("result" in message) === ("error" in message)) {
      call.reject(new Error("Invalid ACP response")); fail(new Error("Invalid ACP response"));
    } else if ("error" in message) {
      // Peer text is not used as an error message or persisted host diagnostic.
      call.reject(new Error("ACP peer rejected request"));
    } else { call.resolve(message.result); }
  }

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      if (Buffer.byteLength(line) > maxBytes) { fail(new Error("ACP message exceeds size limit")); return; }
      if (line.trim()) receive(line);
    }
    if (Buffer.byteLength(buffer) > maxBytes) fail(new Error("ACP message exceeds size limit"));
  });
  // Drain without surfacing peer stderr (it can contain credentials or private paths).
  child.stderr.resume();
  child.stdin.on("error", () => fail(new Error("ACP input closed")));
  child.on("error", () => { fail(new Error("ACP process failed")); exitResolve(); });
  child.on("exit", () => {
    if (!closing) fail(new Error("ACP process exited before host closed the session"));
    exitResolve();
  });
  child.stdout.on("end", () => {
    if (!closing) fail(new Error("ACP output ended before terminal response"));
  });

  return {
    request(method, params) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => fail(new Error("ACP request outcome unknown after timeout")), timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try { send({ jsonrpc: "2.0", id, method, params }); }
        catch (error) { fail(error instanceof Error ? error : new Error("ACP send failed")); }
      });
    },
    notify(method, params) { send({ jsonrpc: "2.0", method, params }); },
    async close() {
      if (closing) { await exited; return; }
      closing = true;
      for (const call of pending.values()) {
        clearTimeout(call.timer);
        call.reject(new Error("ACP connection closed"));
      }
      pending.clear();
      child.stdin.end();
      child.kill();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          exited,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("ACP process termination unconfirmed")), 3_000);
          }),
        ]);
      } finally { clearTimeout(timer); }
    },
  };
}
