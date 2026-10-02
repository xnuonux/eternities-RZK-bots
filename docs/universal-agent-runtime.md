# Universal agent runtime

A Bot's durable identity is separate from the engine that executes its turns.
The computer provider is a second, independent boundary: choosing an external
engine does not change the Bot's computer, workspace, approvals or execution lease.

## Queue and execution ownership

`Bot.runtimeId` is an engine preference; null selects the deployment default.
`createQueuedRun` resolves that preference and writes a concrete `Run.runtimeId`
inside the producer's existing transaction, before publishing its queue wake.
Changing a Bot or deployment default later affects future runs. It cannot retarget
already queued work. Unknown engines fail before the Run is created. Legacy rows
without a runtime are bound under the executor's existing lease fence.

The API and worker configure the same `AgentRuntimeRegistry`. User turns, routines,
taught skills, webhooks, messaging, child Bots, Bot messages, handoffs and cloud
agent returns reuse their existing Task/Run producers through the shared factory.
Spawned Bots inherit their parent's preference; duplicates preserve it. There is
no external-engine queue, second Bot identity or separate effect journal.

Auxiliary model jobs retain their Pi/scripted path. Engine discovery and a UI
picker are not included in this slice; the existing Bot creation contract accepts
`runtimeId` and the deployment default is selected with `AGENT_RUNTIME`.

## Configure an external engine

The API and worker both read the optional `AGENT_RUNTIME_CONFIG` absolute file
path. Supply the same configuration and stable runtime ids to both processes.
Reading the file registers engines; it does not start them. Each selected Run
starts and closes its own stdio peer. Keep the file outside source control and
restrict its permissions because an explicit environment can contain credentials.

```json
{
  "version": 1,
  "runtimes": [
    {
      "id": "acp:local-engine",
      "transport": "acp-stdio",
      "command": "/opt/engine/bin/engine",
      "args": ["--acp"],
      "cwd": "/opt/engine/workspace",
      "env": {},
      "timeoutMs": 30000,
      "cancelTimeoutMs": 3000,
      "maxMessageBytes": 1048576,
      "maxToolCalls": 64
    }
  ]
}
```

These are illustrative paths, not an installed engine. On Windows use absolute
Windows paths to an existing executable and directory. Set `AGENT_RUNTIME` to a
configured id to select the default, or pass that id when creating a Bot.

The file is limited to 64 KiB and 16 runtimes. Ids are unique and cannot replace
`pi` or `scripted`. Unknown fields, unsupported transports, relative executable or
working-directory paths, malformed environments and invalid bounds fail at startup
without echoing configuration contents. Arguments are passed without a shell.
Only the configured environment is supplied: no inherited `PATH`, home, tokens or
provider secrets. Supply required variables explicitly.

External ACP engines declare `modelAuth: "runtime"`: the engine owns its model and
authentication. Main turns do not select or refresh a Rakazo hosted-model
credential. The existing Run model fields record provider `external` and the
runtime id as execution identity, not as a verified inference-model name. This
bridge does not report measured inference usage or cost. Host-owned engines keep
their existing model selection and authentication behavior.

## Bounded action and outcome contract

This bridge implements the ACP v1 text subset with a required host-tool extension,
`rakazo.dev/host-tools`, version 1. A peer must negotiate it in `initialize`.
Unmodified ACP engines that use native filesystem/terminal calls or require a
different permission protocol are not compatible merely because they speak ACP.
No specific hosted provider or coding CLI is certified by these fixtures.

`session/new` receives the existing `botId`, `threadId` and `runId`, the runtime
model identity, a tool catalog containing names/descriptions/input schemas, and
`limits.maxToolCalls`. It receives no host credential, OAuth object or connector
route. The text prompt contains the supplied instructions, history and task.
Images and native checkpoint resume fail explicitly in this text-only slice.

Only the following peer request invokes host tools:

```json
{
  "jsonrpc": "2.0",
  "id": "peer-request-1",
  "method": "_rakazo/tool",
  "params": {
    "sessionId": "the-active-session",
    "toolCallId": "action-1",
    "name": "browser_snapshot",
    "args": {}
  }
}
```

The response is `{ "result": <host result> }` inside the JSON-RPC `result`.
The bridge invokes the executor's existing `executeTool` callback and
`onToolCompleted` audit with execution id `<runId>:acp:<toolCallId>`. The executor
keeps approval, connector validation, leases, effect idempotency and durable
outcome authority. A tool notification is progress only. Native fs/terminal and
permission requests are denied; a tool outside the offered catalog stops the turn.

Repeated call ids with identical input share one result and consume one budget
slot. Reusing an id with changed input stops the turn. Distinct calls are ordered
and limited to 64 by default; configuration permits 1 through 1000. Completed or
uncertain effects on a resumed Run remain governed by the existing durable effect
gate even when the peer changes its call ids.

An approval pause preserves the host's paused result and emits no `done`. An
uncertain tool outcome stops the turn without automatic redispatch. Successful
`end_turn` emits `done` only after host work has settled. Cancellation stops new
host calls, waits for outstanding host work, and closes the peer. Missing cancel
acknowledgment or unconfirmed process termination remains an error/unknown outcome.

## Computer and process containment

ACP stdio is an operator-trusted process interface. It does not restrict the peer's
filesystem, network, OS privileges, resource use or descendants. Refusing native
ACP commands limits the protocol; it cannot prevent a trusted executable from
using its own host permissions. `child.kill()` plus an exit wait does not certify
descendant termination. Put untrusted engines behind an independently qualified
OS/container boundary before use.

The existing [computer runtime](computer-runtime.md) owns sandbox provisioning,
browser profiles, screen leases and computer tools. A Docker computer remains a
separate container boundary. Running an external engine or a disposable host
browser does not demonstrate that Docker boundary.

## Local qualification without inference

With the repository's supported Node version, run:

```text
node --experimental-transform-types scripts/runtime-conformance.mjs
```

This source-only suite uses real stdio peer processes and the bounded production
source graph. Queue database, approvals and durable effect storage are deterministic
fixtures. It covers queue binding, credential exclusion, duplicate calls, call
limits, malformed peers, native command denial, approval pause, unknown outcomes,
cancellation and external engine configuration. It does not replace a full package
typecheck, PostgreSQL executor integration, or the broader provider suite.

For a real local browser action, pass absolute paths to an already installed
Chromium browser and Python 3 interpreter:

```text
node --experimental-transform-types scripts/runtime-browser-demo.mjs --browser-command <absolute-browser-executable> --python-command <absolute-python-executable>
```

The demo starts its own loopback fixture, fresh headless browser profile and stdlib
CDP helpers. It loads an external engine through the same configuration loader as
the API and worker, binds its queue identity, changes the subsequent Bot preference,
pauses for approval, then fills and clicks once despite a duplicate peer request.
A separate server-outcome read and browser snapshot confirm the action, and a PNG
captures the visible result. `browser-demo.json` names fixtures and evidence limits;
`cleanup.json` records owned browser/helper PIDs, server closure and profile removal.
Output defaults to ignored `.tmp/runtime-browser-demo`; `--output` can select a
private receipt directory. No existing browser profile, account or model is used.

This demonstration qualifies the configured runtime/browser contract. It does not
demonstrate a Docker computer, persistent production database, actual model
inference, generic CLI compatibility or integration into an external cognition
system. Those require their own acceptance evidence.
