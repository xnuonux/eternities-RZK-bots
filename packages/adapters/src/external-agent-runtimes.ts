import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { AgentRuntime } from "@rakazo/adapter-kit";
import { AcpAgentRuntime } from "./acp-runtime.js";
import type { AcpStdioOptions } from "./acp-stdio.js";
import { connectAcpStdio } from "./acp-stdio.js";

interface ExternalRuntimeConfig extends AcpStdioOptions {
  id: string;
  transport: "acp-stdio";
  maxToolCalls?: number;
  cancelTimeoutMs?: number;
}

function invalid(): never {
  // Configuration may contain secrets or private paths. Never echo its values.
  throw new Error("Invalid external runtime configuration");
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function integer(value: unknown, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    invalid();
  }
  return value;
}

function parseConfig(value: unknown): ExternalRuntimeConfig[] {
  const config = object(value);
  if (
    Object.keys(config).some((key) => !["version", "runtimes"].includes(key)) ||
    config.version !== 1 || !Array.isArray(config.runtimes) || config.runtimes.length > 16
  ) invalid();
  const ids = new Set<string>(["pi", "scripted"]);
  return config.runtimes.map((value) => {
    const runtime = object(value);
    const fields = [
      "id", "transport", "command", "args", "cwd", "env", "timeoutMs",
      "maxMessageBytes", "maxToolCalls", "cancelTimeoutMs",
    ];
    if (Object.keys(runtime).some((key) => !fields.includes(key))) invalid();
    if (
      typeof runtime.id !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(runtime.id) ||
      ids.has(runtime.id)
    ) invalid();
    ids.add(runtime.id);
    if (
      runtime.transport !== "acp-stdio" || typeof runtime.command !== "string" ||
      !path.isAbsolute(runtime.command) || runtime.command.includes("\0") ||
      typeof runtime.cwd !== "string" || !path.isAbsolute(runtime.cwd) || runtime.cwd.includes("\0")
    ) invalid();
    if (
      runtime.args !== undefined && (
        !Array.isArray(runtime.args) || runtime.args.length > 128 ||
        runtime.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))
      )
    ) invalid();
    let env: Record<string, string> | undefined;
    if (runtime.env !== undefined) {
      const entries = Object.entries(object(runtime.env));
      if (
        entries.length > 64 || entries.some(([key, value]) =>
          !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) ||
          typeof value !== "string" || value.includes("\0"),
        )
      ) invalid();
      env = Object.fromEntries(entries) as Record<string, string>;
    }
    return {
      id: runtime.id,
      transport: "acp-stdio",
      command: runtime.command,
      cwd: runtime.cwd,
      args: runtime.args as string[] | undefined,
      env,
      timeoutMs: integer(runtime.timeoutMs, 1, 3_600_000),
      maxMessageBytes: integer(runtime.maxMessageBytes, 4_096, 4_194_304),
      maxToolCalls: integer(runtime.maxToolCalls, 1, 1_000),
      cancelTimeoutMs: integer(runtime.cancelTimeoutMs, 1, 30_000),
    };
  });
}

/** Operator-owned deployment config, never accepted from a Bot or RPC payload. */
export function loadExternalAgentRuntimes(configFile?: string): AgentRuntime[] {
  if (!configFile) return [];
  if (!path.isAbsolute(configFile)) throw new Error("External runtime configuration path must be absolute");
  let runtimes: ExternalRuntimeConfig[];
  try {
    const stat = statSync(configFile);
    if (!stat.isFile() || stat.size > 65_536) invalid();
    const contents = readFileSync(configFile, "utf8");
    if (Buffer.byteLength(contents) > 65_536) invalid();
    runtimes = parseConfig(JSON.parse(contents));
  } catch {
    invalid();
  }
  // Reading config does not start a process. Each selected Run owns its peer.
  return runtimes.map(({ id, maxToolCalls, cancelTimeoutMs, ...connection }) =>
    new AcpAgentRuntime({
      id,
      cwd: connection.cwd,
      maxToolCalls,
      cancelTimeoutMs,
      connect: (handlers) => connectAcpStdio(connection, handlers),
    }),
  );
}
