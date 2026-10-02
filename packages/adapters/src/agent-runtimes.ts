import type { AgentRuntime } from "@rakazo/adapter-kit";
import { AgentRuntimeRegistry } from "@rakazo/adapter-kit";
import { loadExternalAgentRuntimes } from "./external-agent-runtimes.js";
import { PiAgentRuntime } from "./pi-runtime.js";
import { ScriptedAgentRuntime } from "./scripted-runtime.js";

/** Shared composition for API and worker; unknown defaults fail at startup. */
export function createAgentRuntimes(options: {
  defaultRuntimeId: string;
  sessionRoot?: string;
  additional?: AgentRuntime[];
  externalRuntimeConfig?: string;
}) {
  const pi = new PiAgentRuntime({ sessionRoot: options.sessionRoot });
  const scripted = new ScriptedAgentRuntime();
  const runtimes = new AgentRuntimeRegistry(options.defaultRuntimeId)
    .register(pi)
    .register(scripted);
  for (const runtime of [
    ...loadExternalAgentRuntimes(options.externalRuntimeConfig),
    ...(options.additional ?? []),
  ]) {
    runtimes.register(runtime);
  }
  runtimes.resolve();
  // Auxiliary model jobs retain their existing Pi/scripted path.
  const runtime = options.defaultRuntimeId === "scripted" ? scripted : pi;
  return { runtime, runtimes };
}
