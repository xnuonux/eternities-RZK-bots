import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";

interface HostModelSelection {
  provider: string | null | undefined;
  id: string | null | undefined;
  credential: unknown;
  thinkingLevel: AgentRunRequest["model"]["thinkingLevel"];
}

/** An external engine owns its model/account; host model credentials are not its authority. */
export function selectRuntimeModel<T extends HostModelSelection>(runtime: AgentRuntime, host: () => T) {
  const descriptor = runtime.describe();
  if (descriptor.capabilities.modelAuth === "runtime") {
    return { provider: "external", id: descriptor.id, credential: null, thinkingLevel: null };
  }
  return host();
}
