# Universal agent runtime

Eternities RZK Bots makes a durable Bot independent from the model/runtime that executes it.

## Slice 1

- `Bot.runtimeId` is the durable engine preference. Null means deployment default.
- `Run.runtimeId` records the concrete engine used by the run.
- `AgentRuntimeRegistry` maps stable ids to process-local runtime implementations.
- Spawned Bots inherit their parent's runtime; duplicates preserve it.
- Main Bot turns route through the selected runtime.
- Unknown runtime ids fail closed.
- Auxiliary model work remains on Rakazo's Pi path for now.

This first slice binds an unbound Run when execution starts. The next backend slice centralizes Run creation and pins runtime identity at queue time across user turns, routines, skills, bot messages, messaging, webhooks and spawned work.

## Next

1. Shared queue-time Run factory.
2. Runtime catalog API + Engine picker.
3. ACP runtime bridge.
4. Claude Code, Codex, Grok and Gemini engine adapters.
5. Capability negotiation and approval mapping.
