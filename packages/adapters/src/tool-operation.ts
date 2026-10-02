import { createHash } from "node:crypto";
import type { AgentToolOperation, AgentToolOperationReconciliation } from "@rakazo/adapter-kit";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";

const OPERATION_REQUEST_TAG = "tool-operation-v1";

type OperationRunIdentity = {
  id: string; runtimeId: string | null; taskId: string; botId: string; spaceId: string;
};

/** Lease renewal alone cannot detect a Run retargeted under the same id and fence. */
export function toolOperationRunIdentityMatches(
  current: OperationRunIdentity | null,
  expected: OperationRunIdentity,
): boolean {
  return Boolean(current && current.runtimeId && current.id === expected.id &&
    current.runtimeId === expected.runtimeId && current.taskId === expected.taskId &&
    current.botId === expected.botId && current.spaceId === expected.spaceId);
}

export interface ToolOperationEffect {
  id: string;
  runId: string;
  kind: string;
  status: string;
  request: unknown;
  result?: unknown;
}

type OperationStore<Effect extends ToolOperationEffect> = {
  externalEffect: {
    findUnique(args: { where: { idempotencyKey: string } }): Promise<Effect | null>;
    create(args: {
      data: { runId: string; spaceId: string; kind: string; idempotencyKey: string; status: string; request: never };
    }): Promise<Effect>;
  };
};

type OperationInput<Effect extends ToolOperationEffect> = {
  store: OperationStore<Effect>;
  run: { id: string; spaceId: string };
  operation: AgentToolOperation;
  /** Host-owned runtime/provider/resource binding; never supplied by a remote peer. */
  binding: Record<string, unknown> & { toolName: string };
  assertAuthority(): Promise<boolean>;
};

export function validateToolOperation(value: unknown): AgentToolOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid original tool operation");
  const operation = value as AgentToolOperation;
  if (Object.keys(operation).sort().join(",") !== "actionDigest,id" ||
      typeof operation.id !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(operation.id) ||
      typeof operation.actionDigest !== "string" || !/^[a-f0-9]{64}$/.test(operation.actionDigest)) {
    throw new Error("Invalid original tool operation");
  }
  return { id: operation.id, actionDigest: operation.actionDigest };
}

export function toolOperationRequestDetails(request: unknown): {
  operation: AgentToolOperation; binding: Record<string, unknown>; request: unknown;
} | undefined {
  if (!Array.isArray(request) || request.length !== 4 || request[0] !== OPERATION_REQUEST_TAG) return undefined;
  try {
    const operation = validateToolOperation(request[1]);
    if (!request[2] || typeof request[2] !== "object" || Array.isArray(request[2])) return undefined;
    stableJsonValue(request);
    return { operation, binding: request[2], request: request[3] };
  } catch { return undefined; }
}

function identity<Effect extends ToolOperationEffect>(input: OperationInput<Effect>) {
  const operation = validateToolOperation(input.operation);
  const binding = JSON.parse(stableJsonValue(input.binding)) as OperationInput<Effect>["binding"];
  const digest = createHash("sha256").update(operation.id).digest("hex");
  // Tool/action/runtime changes must find and reject the original row, never open another key.
  return { operation, binding, key: `${input.run.id}:operation:${digest}` };
}

function matches(effect: ToolOperationEffect, runId: string, bound: ReturnType<typeof identity>): boolean {
  const stored = toolOperationRequestDetails(effect.request);
  return Boolean(stored && effect.runId === runId && effect.kind === bound.binding.toolName &&
    stableJsonValue(stored.operation) === stableJsonValue(bound.operation) &&
    stableJsonValue(stored.binding) === stableJsonValue(bound.binding));
}

/** Reads the existing effect authority only. It never creates, claims or redispatches an effect. */
export async function reconcileToolOperation<Effect extends ToolOperationEffect>(
  input: OperationInput<Effect>,
): Promise<AgentToolOperationReconciliation> {
  const bound = identity(input);
  if (!(await input.assertAuthority())) return { status: "held", reason: "authority_unavailable" };
  const effect = await input.store.externalEffect.findUnique({ where: { idempotencyKey: bound.key } });
  if (!(await input.assertAuthority())) return { status: "held", reason: "authority_unavailable" };
  if (!effect) return { status: "missing" };
  if (!matches(effect, input.run.id, bound)) return { status: "held", reason: "binding_changed" };
  if (effect.result && typeof effect.result === "object" &&
      "uncertain" in effect.result && effect.result.uncertain === true) {
    return { status: "held", reason: "outcome_unknown" };
  }
  if (effect.status === "completed" && effect.result !== undefined && effect.result !== null) {
    return { status: "completed", result: effect.result };
  }
  if (effect.status === "intended" || effect.status === "approved") return { status: "held", reason: "pending_approval" };
  if (effect.status === "executing" || effect.status === "uncertain") return { status: "held", reason: "outcome_unknown" };
  if (effect.status === "denied") return { status: "held", reason: "denied" };
  return { status: "held", reason: "incomplete_receipt" };
}

/** Registers identity in ExternalEffect; ordinary executor approval/claim/settlement still owns dispatch. */
export async function recordToolOperationEffect<Effect extends ToolOperationEffect>(
  input: OperationInput<Effect> & { request: unknown },
): Promise<{ duplicate: boolean; effect: Effect }> {
  const bound = identity(input);
  const request = JSON.parse(stableJsonValue(input.request)) as unknown;
  if (!(await input.assertAuthority())) throw new Error("Original tool operation authority unavailable");
  let effect = await input.store.externalEffect.findUnique({ where: { idempotencyKey: bound.key } });
  let duplicate = true;
  if (!effect) {
    try {
      effect = await input.store.externalEffect.create({ data: {
        runId: input.run.id, spaceId: input.run.spaceId, kind: bound.binding.toolName,
        idempotencyKey: bound.key, status: "intended",
        request: [OPERATION_REQUEST_TAG, bound.operation, bound.binding, request] as never,
      } });
      duplicate = false;
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "P2002") throw error;
      effect = await input.store.externalEffect.findUnique({ where: { idempotencyKey: bound.key } });
      if (!effect) throw new Error("Original tool operation conflict has no receipt");
    }
  }
  if (!(await input.assertAuthority())) throw new Error("Original tool operation authority unavailable");
  if (!matches(effect, input.run.id, bound)) throw new Error("Original tool operation binding changed");
  // Approval is for the stored transport request. Ref renewal cannot trade it for new arguments.
  if ((effect.status === "intended" || effect.status === "approved") &&
      stableJsonValue(toolOperationRequestDetails(effect.request)!.request) !== stableJsonValue(request)) {
    throw new Error("Original tool operation approval arguments changed");
  }
  return { duplicate, effect };
}
