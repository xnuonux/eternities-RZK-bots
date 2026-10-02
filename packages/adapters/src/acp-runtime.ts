import path from "node:path";
import type {
  AdapterContext, AgentRunRequest, AgentRuntime, AgentRuntimeEvent,
} from "@rakazo/adapter-kit";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import type { AcpConnection, AcpHandlers } from "./acp-stdio.js";
import { isToolPauseResult } from "./approval-effect.js";

export const ACP_HOST_TOOLS = "rakazo.dev/host-tools";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid ACP object");
  }
  return value as Record<string, unknown>;
}

export interface AcpRuntimeOptions {
  id: string;
  /** Working directory inside the operator's chosen containment boundary. */
  cwd: string;
  connect(handlers: AcpHandlers): AcpConnection;
  cancelTimeoutMs?: number;
  /** Distinct delegated calls per turn; repeated call IDs reuse the prior result. */
  maxToolCalls?: number;
}

/** ACP v1 text subset with explicit host tool delegation; no native tool authority. */
export class AcpAgentRuntime implements AgentRuntime {
  private readonly active = new Map<string, {
    controller: AbortController; settled: Promise<void>;
  }>();

  constructor(private readonly options: AcpRuntimeOptions) {
    if (!options.id.trim() || options.id !== options.id.trim()) throw new Error("ACP runtime id is required");
    if (!path.isAbsolute(options.cwd)) throw new Error("ACP working directory must be absolute");
    if (options.maxToolCalls !== undefined && (!Number.isInteger(options.maxToolCalls) ||
        options.maxToolCalls < 1 || options.maxToolCalls > 1_000)) {
      throw new Error("ACP tool call limit must be between 1 and 1000");
    }
  }

  describe() {
    return {
      id: this.options.id, contractVersion: "1", adapterVersion: "0.1.0",
      capabilities: {
        streaming: true, compaction: false, tools: true, scripted: false,
        modelAuth: "runtime" as const,
      },
    };
  }

  async abort(runId: string): Promise<void> {
    const active = this.active.get(runId);
    active?.controller.abort();
    await active?.settled;
  }

  run(request: AgentRunRequest, context?: Partial<AdapterContext>): AsyncIterableIterator<AgentRuntimeEvent> {
    const controller = new AbortController();
    const signal = context?.signal ? AbortSignal.any([controller.signal, context.signal]) : controller.signal;
    const iterator = this.stream(request, { ...context, signal })[Symbol.asyncIterator]();
    return {
      [Symbol.asyncIterator]() { return this; },
      next: (...args) => iterator.next(...args),
      return: async (value) => { controller.abort(); return await iterator.return!(value); },
      throw: async (error) => { controller.abort(); return await iterator.throw!(error); },
    };
  }

  private async *stream(request: AgentRunRequest, context?: Partial<AdapterContext>): AsyncGenerator<AgentRuntimeEvent> {
    if (this.active.has(request.runId)) throw new Error("ACP run already active");
    if (request.resumeFromCheckpoint) throw new Error("ACP checkpoint resume is not supported");
    if (request.currentTurnImages?.length || request.history.some((turn) => turn.images?.length)) {
      throw new Error("ACP text runtime cannot accept images");
    }
    const controller = new AbortController();
    const signal = context?.signal ? AbortSignal.any([controller.signal, context.signal]) : controller.signal;
    signal.throwIfAborted();
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    this.active.set(request.runId, { controller, settled });
    let connection: AcpConnection | undefined;
    let sessionId: string | undefined;
    let acceptingTools = false;
    let paused = false;
    let finished = false;
    let failure: unknown;
    let wake: (() => void) | undefined;
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    const events: AgentRuntimeEvent[] = [];
    const calls = new Map<string, { fingerprint: string; result: Promise<unknown> }>();
    let hostWork: Promise<unknown> = Promise.resolve();

    function push(event: AgentRuntimeEvent) { events.push(event); wake?.(); }
    function fail(error: unknown) { failure ??= error; finished = true; acceptingTools = false; wake?.(); }
    function cancelPeer() {
      if (sessionId && connection) {
        try { connection.notify("session/cancel", { sessionId }); }
        catch (error) { fail(error); }
      }
    }
    const onAbort = () => {
      acceptingTools = false;
      cancelPeer();
      cancelTimer ??= setTimeout(() => fail(new Error("ACP cancellation outcome unknown")), this.options.cancelTimeoutMs ?? 3_000);
      wake?.();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const handlers: AcpHandlers = {
      request: async (method, params) => {
        try {
          if (method !== "_rakazo/tool" || !acceptingTools || params.sessionId !== sessionId) {
            throw new Error("ACP client request denied");
          }
          const id = params.toolCallId;
          if (typeof id !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(id)) throw new Error("Invalid ACP tool call id");
          const name = params.name;
          if (typeof name !== "string") throw new Error("Invalid ACP tool name");
          const args = record(params.args);
          const matches = request.tools.filter((tool) => tool.name === name);
          if (matches.length !== 1 || !request.executeTool) throw new Error("ACP tool is not in the host catalog");
          const tool = matches[0]!;
          const fingerprint = stableJsonValue({ name, args });
          const previous = calls.get(id);
          if (previous) {
            if (previous.fingerprint !== fingerprint) throw new Error("ACP tool call id reused with different input");
            return { result: await previous.result };
          }
          if (calls.size >= (this.options.maxToolCalls ?? 64)) {
            throw new Error("ACP tool call limit reached; further host actions stopped");
          }
          const executionId = request.runId + ":acp:" + id;
          const result = hostWork.then(async () => {
            signal.throwIfAborted();
            if (paused || failure) throw new Error("ACP host tool execution stopped");
            push({ type: "tool", name, args, executionId });
            const started = Date.now();
            let output: unknown;
            try { output = await request.executeTool!(name, args, executionId, tool.route); }
            catch (error) {
              await request.onToolCompleted?.({ name, executionId, durationMs: Date.now() - started, error });
              throw error;
            }
            await request.onToolCompleted?.({
              name, executionId, durationMs: Date.now() - started,
              result: output, ...(isToolPauseResult(output) ? { paused: true } : {}),
            });
            if (output && typeof output === "object" && "uncertain" in output && output.uncertain === true) {
              throw new Error("ACP host tool outcome unknown; automatic replay stopped");
            }
            if (isToolPauseResult(output)) {
              paused = true;
              acceptingTools = false;
              cancelPeer();
              finished = true;
              wake?.();
            }
            return output;
          });
          calls.set(id, { fingerprint, result });
          hostWork = result.catch((error) => { fail(error); cancelPeer(); });
          return { result: await result };
        } catch (error) { fail(error); cancelPeer(); throw error; }
      },
      notification: (method, params) => {
        if (method !== "session/update" || params.sessionId !== sessionId || finished || signal.aborted) return;
        const update = record(params.update);
        if (update.sessionUpdate === "agent_message_chunk") {
          const content = record(update.content);
          if (content.type !== "text" || typeof content.text !== "string") throw new Error("Unsupported ACP content");
          push({ type: "text", text: content.text });
        } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
          // Reporting is not execution. Only _rakazo/tool can invoke a host callback.
          push({ type: "progress", text: "working…", activity: true });
        }
      },
    };

    async function setupRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
      signal.throwIfAborted();
      let onSetupAbort!: () => void;
      const aborted = new Promise<never>((_, reject) => {
        onSetupAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onSetupAbort, { once: true });
      });
      try { return await Promise.race([connection!.request(method, params), aborted]); }
      finally { signal.removeEventListener("abort", onSetupAbort); }
    }

    try {
      connection = this.options.connect(handlers);
      signal.throwIfAborted();
      const initialized = record(await setupRequest("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "rakazo", version: "0.1.0" },
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false }, terminal: false,
          _meta: { [ACP_HOST_TOOLS]: { version: 1 } },
        },
      }));
      if (initialized.protocolVersion !== 1 ||
          record(record(initialized.agentCapabilities)._meta)[ACP_HOST_TOOLS] !== 1) {
        throw new Error("ACP peer does not support the required host tool contract");
      }
      const session = record(await setupRequest("session/new", {
        cwd: this.options.cwd, mcpServers: [],
        _meta: { [ACP_HOST_TOOLS]: {
          botId: request.botId, threadId: request.threadId, runId: request.runId,
          model: { provider: request.model.provider, id: request.model.id, thinkingLevel: request.model.thinkingLevel },
          tools: request.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
          limits: { maxToolCalls: this.options.maxToolCalls ?? 64 },
        } },
      }));
      if (typeof session.sessionId !== "string" || !session.sessionId) throw new Error("ACP session id missing");
      sessionId = session.sessionId;
      signal.throwIfAborted();
      acceptingTools = true;
      const prompt = connection.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: JSON.stringify({
          instructions: request.instructions, history: request.history.map(({ role, content }) => ({ role, content })),
          prompt: request.prompt,
        }) }],
      });
      void prompt.then(async (value) => {
        acceptingTools = false;
        await hostWork;
        if (paused || failure) return;
        const response = record(value);
        if (response.stopReason === "cancelled" && signal.aborted) {
          fail(new DOMException("ACP run cancelled", "AbortError"));
        } else if (signal.aborted || response.stopReason !== "end_turn") {
          fail(new Error("ACP prompt did not finish successfully"));
        } else {
          push({ type: "done" });
          finished = true;
          wake?.();
        }
      }).catch(fail);
      while (true) {
        if (failure) throw failure;
        const event = events.shift();
        if (event) { yield event; continue; }
        if (finished) return;
        await new Promise<void>((resolve) => { wake = resolve; });
        wake = undefined;
      }
    } finally {
      acceptingTools = false;
      controller.abort();
      clearTimeout(cancelTimer);
      signal.removeEventListener("abort", onAbort);
      // The host owns the effects and lease. Never release before its work settles.
      await hostWork;
      try { await connection?.close(); }
      finally { this.active.delete(request.runId); resolveSettled(); }
    }
  }
}
