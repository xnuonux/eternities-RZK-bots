import type { AgentRuntime, AgentRuntimeResolver } from "./interfaces.js";
import type { AdapterDescriptor, AgentRuntimeCapabilities } from "./types.js";

export class AgentRuntimeRegistry implements AgentRuntimeResolver {
  private readonly runtimes = new Map<string, AgentRuntime>();

  constructor(private readonly defaultRuntimeId: string) {
    if (!defaultRuntimeId.trim()) throw new Error("defaultRuntimeId is required");
  }

  register(runtime: AgentRuntime): this {
    const id = runtime.describe().id.trim();
    if (!id) throw new Error("Agent runtime id is required");
    if (this.runtimes.has(id)) throw new Error(`Agent runtime "${id}" is already registered`);
    this.runtimes.set(id, runtime);
    return this;
  }

  has(runtimeId: string): boolean {
    return this.runtimes.has(runtimeId);
  }

  list(): AdapterDescriptor<AgentRuntimeCapabilities>[] {
    return [...this.runtimes.values()].map((runtime) => runtime.describe());
  }

  resolve(runtimeId?: string | null): AgentRuntime {
    const id = runtimeId?.trim() || this.defaultRuntimeId;
    const runtime = this.runtimes.get(id);
    if (runtime) return runtime;
    const available = [...this.runtimes.keys()].sort().join(", ") || "(none)";
    throw new Error(`Unknown agent runtime "${id}". Available runtimes: ${available}`);
  }
}
