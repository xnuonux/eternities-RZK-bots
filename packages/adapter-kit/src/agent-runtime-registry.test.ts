import { describe, expect, it } from "vitest";
import type { AgentRuntime } from "./interfaces.js";
import { AgentRuntimeRegistry } from "./agent-runtime-registry.js";

function fakeRuntime(id: string): AgentRuntime {
  return {
    describe: () => ({
      id,
      contractVersion: "1",
      adapterVersion: "test",
      capabilities: { streaming: true, compaction: false, tools: true, scripted: false },
    }),
    async *run() {
      yield { type: "done" as const };
    },
    async abort() {},
  };
}

describe("AgentRuntimeRegistry", () => {
  it("uses the configured default without a Bot override", () => {
    const registry = new AgentRuntimeRegistry("pi").register(fakeRuntime("pi"));
    expect(registry.resolve().describe().id).toBe("pi");
    expect(registry.resolve(null).describe().id).toBe("pi");
  });

  it("resolves an explicit Bot runtime", () => {
    const registry = new AgentRuntimeRegistry("pi")
      .register(fakeRuntime("pi"))
      .register(fakeRuntime("acp:claude"));
    expect(registry.resolve("acp:claude").describe().id).toBe("acp:claude");
  });

  it("fails closed for duplicate and unknown runtime ids", () => {
    const registry = new AgentRuntimeRegistry("pi").register(fakeRuntime("pi"));
    expect(() => registry.register(fakeRuntime("pi"))).toThrow(/already registered/);
    expect(() => registry.resolve("missing")).toThrow(/Available runtimes: pi/);
  });
});
