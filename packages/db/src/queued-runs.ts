import type { AgentRuntimeResolver } from "@rakazo/adapter-kit";
import type { Prisma, PrismaClient } from "./client.js";

const resolvers = new WeakMap<PrismaClient, AgentRuntimeResolver>();

/** Composition roots install the same runtime catalog used by their executor. */
export function configureRunCreation(db: PrismaClient, runtimes: AgentRuntimeResolver): void {
  runtimes.resolve();
  resolvers.set(db, runtimes);
}

/** Bind an engine before the run or its queue wake becomes visible. */
export async function createQueuedRun<T extends Prisma.RunCreateArgs>(
  db: PrismaClient,
  tx: Pick<Prisma.TransactionClient, "bot" | "run">,
  args: Prisma.SelectSubset<T, Prisma.RunCreateArgs>,
): Promise<Prisma.RunGetPayload<T>> {
  const runtimes = resolvers.get(db);
  if (!runtimes) throw new Error("Run creation requires a configured runtime resolver");
  const data = args.data;
  if (!("botId" in data) || !data.botId) {
    throw new Error("Queued run requires botId");
  }
  const bot = await tx.bot.findUniqueOrThrow({
    where: { id: data.botId },
    select: { runtimeId: true },
  });
  const runtimeId = runtimes.resolve(bot.runtimeId).describe().id;
  if (data.runtimeId != null && data.runtimeId !== runtimeId) {
    throw new Error("New run runtime must match its queue-time Bot selection");
  }
  return tx.run.create({ ...args, data: { ...data, runtimeId } } as Prisma.SelectSubset<
    T,
    Prisma.RunCreateArgs
  >);
}
