# Architecture

Internal reference for developers and maintainers of the Linear agent plugin.

---

## System Topology

```mermaid
flowchart TD
    L["Linear App<br/>(OAuth App Webhook)"] -->|HTTPS POST| CF["Cloudflare Tunnel<br/>(cloudflared)"]
    CF -->|"linear.yourdomain.com"| GW["OpenClaw Gateway<br/>:18789"]
    GW --> R1["/linear/webhook<br/>(primary route)"]
    GW --> R2["/linear/oauth/callback"]
    GW --> R3["/hooks/linear<br/>(back-compat)"]
    R1 --> WR["Webhook Router<br/>(webhook.ts)"]
    WR --> E1["AgentSessionEvent<br/>(pipeline)"]
    WR --> E2["Comment.create<br/>(@mention routing)"]
    WR --> E3["Issue.update<br/>(assign/delegate)"]
    WR --> E4["Issue.create<br/>(auto-triage)"]
    WR --> E5["AppUserNotification"]
```

## Webhook Event Types

All events arrive via POST. The router dispatches by `payload.type`:

| Event | Trigger | Handler |
|-------|---------|---------|
| `AgentSessionEvent.created` | Agent session opened in Linear UI | Full dispatch pipeline |
| `AgentSessionEvent.prompted` | User follow-up in existing session | Resume with streaming |
| `Comment.create` | `@mention` in a comment | Route to role-based agent |
| `Issue.create` | New issue created | Auto-triage (estimate, labels, priority) |
| `Issue.update` | Issue assigned/delegated to agent | Dispatch pipeline |
| `AppUserNotification` | Agent mentioned/assigned via OAuth app | Direct response |

All handlers respond `200 OK` within 5 seconds (Linear requirement), then process asynchronously.

**Payload structure differences:**
- Workspace events: `type=Comment action=create`, data at `payload.data`
- OAuth events: `type=AgentSessionEvent action=created`, session at `payload.agentSession`
- Important: `AgentSessionEvent`/`created`, NOT `AgentSession`/`create`

---

## Pipeline Stages

```mermaid
flowchart TD
    A["Issue Assigned (webhook)"] --> B["DISPATCH<br/>transitionDispatch(dispatched → working)<br/>Tier assessment, worktree setup"]
    B --> C["WORKER<br/>(runAgent)"]
    C -->|"watchdog kill 2x"| S["STUCK<br/>(escalate)"]
    C -->|"watchdog kill 1x<br/>retry once"| C2["WORKER<br/>(retry, attempt 2)"]
    C --> D
    C2 --> D["AUDIT<br/>triggerAudit()<br/>Independent auditor"]
    D --> E["VERDICT<br/>processVerdict()"]
    E -->|PASS| F[DONE]
    E -->|FAIL| G{"attempt ≤ max?"}
    G -->|Yes| C
    G -->|No| S
```

### Worker Phase (`spawnWorker`)

1. Transitions `dispatched -> working` (CAS)
2. Fetches issue details from Linear GraphQL API
3. Builds task prompt from `prompts.yaml` templates
4. Registers session mapping for `agent_end` hook
5. Calls `runAgent()` with streaming callbacks
6. Saves output to `.claw/worker-{N}.md`
7. Appends structured log to `.claw/log.jsonl`
8. If `watchdogKilled`: logs artifact, transitions to `stuck`, sends notification
9. Otherwise: triggers `triggerAudit()`

### Audit Phase (`triggerAudit`)

1. Dedup via `markEventProcessed()`
2. Transitions `working -> auditing` (CAS)
3. Builds audit prompt from `prompts.yaml`
4. Spawns independent auditor via `runAgent()`
5. Passes result to `processVerdict()`

### Verdict Phase (`processVerdict`)

1. Parses JSON verdict: `{"pass": true/false, "criteria": [...], "gaps": [...], "testResults": "..."}`
2. **Pass**: transition to `done`, write summary to `.claw/`, post approval comment
3. **Fail (retries left)**: transition back to `working`, increment attempt, re-spawn worker with gaps
4. **Fail (max reached)**: transition to `stuck`, post escalation comment, notify

---

## Agent Execution (`agent.ts`)

### Embedded Runner (primary)

Uses OpenClaw's `extensionAPI.runEmbeddedPiAgent()` for in-process execution with real-time streaming.

```mermaid
flowchart TD
    A[runAgent] --> B[runAgentOnce]
    B -->|"streaming available?"| C[runEmbedded]
    C --> D["AbortController + InactivityWatchdog"]
    D --> E["onReasoningStream → watchdog.tick() + emit thought"]
    D --> F["onToolResult → watchdog.tick() + emit action"]
    D --> G["onAgentEvent → watchdog.tick() + emit action"]
    D --> H["onPartialReply → watchdog.tick()"]
    D --> I{"watchdog.wasKilled?"}
    I -->|Yes| J["{ success: false, watchdogKilled: true }"]
    B -->|"no streaming"| K["runSubprocess<br/>(fallback: openclaw agent --json)"]
```

### Retry Wrapper

`runAgent()` wraps `runAgentOnce()` with retry-on-watchdog-kill:

1. First attempt runs normally
2. If `watchdogKilled: true`: log warning, emit Linear activity, retry once
3. Second failure: return as-is (caller handles escalation)
4. Non-watchdog failures: no retry

---

## Inactivity Watchdog (`watchdog.ts`)

### InactivityWatchdog Class

- `start()` -- begin watching (idempotent)
- `tick()` -- reset countdown (`lastActivityAt = Date.now()`)
- `stop()` -- clean shutdown
- `wasKilled` / `silenceMs` -- query state after completion

Timer uses dynamic rescheduling: calculates remaining time from last tick, not fixed polling. Minimum check interval: 1 second.

### Kill Flow

```mermaid
flowchart TD
    A[Timer fires] --> B["silence = now - lastActivityAt"]
    B --> C{"silence ≥ threshold?"}
    C -->|Yes| D["killed = true, call onKill()"]
    C -->|No| E["Reschedule for remaining time"]
```

**onKill callback by context:**
- Embedded runner: `controller.abort()` + `ext.abortEmbeddedPiRun(sessionId)`
- CLI tools: `child.kill("SIGTERM")` + 5s `child.kill("SIGKILL")`

### Config Resolution

```mermaid
flowchart TD
    A["~/.openclaw/agent-profiles.json<br/>agents.{agentId}.watchdog"] -->|not found| B["pluginConfig<br/>inactivitySec / maxTotalSec / toolTimeoutSec"]
    B -->|not found| C["Hardcoded defaults<br/>120s / 7200s / 600s"]
```

All config values are in **seconds**. The resolver converts to ms internally.

---

## Dispatch State (`dispatch-state.ts`)

File-backed persistent state at `~/.openclaw/linear-dispatch-state.json`:

```json
{
  "dispatches": {
    "active": { "API-123": { "status": "working", "attempt": 0, ... } },
    "completed": [ { "identifier": "API-122", "status": "done", ... } ]
  },
  "sessionMap": { "linear-worker-API-123-0": { "dispatchId": "API-123", "phase": "worker" } },
  "processedEvents": ["worker-end:...", "audit-end:..."]
}
```

### Atomic Operations

- **File locking**: exclusive lock before read-modify-write (30s stale threshold)
- **CAS transitions**: `transitionDispatch(id, expectedStatus, newStatus)` throws `TransitionError` on mismatch
- **Session mapping**: maps worker/audit session keys to dispatch context for `agent_end` hook lookup
- **Event dedup**: `markEventProcessed()` -- trimmed to last 200 entries

### Background Monitor (`dispatch-service.ts`)

Runs on 5-minute tick (zero LLM tokens):
1. **Stale detection**: marks dispatches inactive >2h as `stuck`
2. **Recovery**: finds dispatches with worker complete but audit missing
3. **Pruning**: removes completed entries older than 7 days

---

## Artifact System (`artifacts.ts`)

Per-worktree `.claw/` directory (gitignored):

| File | Content |
|------|---------|
| `manifest.json` | Issue metadata, tier, model, timestamps, status |
| `plan.md` | Implementation plan |
| `worker-{N}.md` | Worker output per attempt (truncated to 8KB) |
| `audit-{N}.json` | Audit verdict per attempt |
| `log.jsonl` | Append-only structured log (all phases including watchdog) |
| `summary.md` | Agent-curated final summary |

Summaries are also written to the orchestrator's `memory/` directory for long-term indexing.

---

## @Mention Routing

```mermaid
flowchart LR
    A["Linear comment<br/>'@qa review this test plan'"] --> B["Plugin matches 'qa'<br/>in mentionAliases"]
    B --> C["Looks up agent-profiles.json<br/>finds 'qa' profile"]
    C --> D["Dispatches: openclaw agent<br/>--agent qa --message '...'"]
    D --> E["Response posted as<br/>branded comment"]
```

---

## Coding Tool Backends

The unified `code_run` tool dispatches to a configured CLI backend:

```mermaid
flowchart TD
    A["Agent calls code_run(prompt, ...)"] --> B["Resolve backend<br/>(explicit > per-agent > global > 'claude')"]
    B --> C["spawn: {cli} {args}<br/>(JSONL streaming)"]
    C --> D["InactivityWatchdog monitors stdout/stderr"]
    C --> E["JSONL events mapped to Linear activities"]
    C --> F["On close: distinguish inactivity_timeout<br/>vs wall-clock timeout"]
    C --> G["Return { success, output, error? }"]
```

Backend-specific error types:
- `"timeout"` -- wall-clock timeout reached
- `"inactivity_timeout"` -- watchdog killed (no I/O)
- `"exit N"` -- CLI exited with non-zero code

---

## Agent Orchestration

| Tool | Behavior | Use Case |
|------|----------|----------|
| `spawn_agent` | Fire-and-forget | Parallel sub-tasks |
| `ask_agent` | Synchronous wait | Blocking questions |

Both use `runAgent()` under the hood.

---

## Token Resolution

```mermaid
flowchart TD
    A["pluginConfig.accessToken<br/>(static)"] -->|not found| B["~/.openclaw/auth-profiles.json<br/>'linear:default' (OAuth — preferred)"]
    B -->|not found| C["LINEAR_ACCESS_TOKEN or<br/>LINEAR_API_KEY env var (fallback)"]
    C -->|not found| D["No token → warning,<br/>webhooks fail gracefully"]
```

OAuth tokens auto-refresh 60s before expiry. On 401, forces refresh and retries once.

**Auth header:** OAuth tokens use `Bearer` prefix; personal API keys do not.

---

## File Structure

```
linear/
|-- index.ts                  Entry point -- routes, tools, CLI, hooks, narration guard
|-- openclaw.plugin.json      Plugin metadata and config schema
|-- package.json
|-- prompts.yaml              Externalized prompt templates
|-- coding-tools.json         Backend configuration
|-- README.md
|-- docs/
|   |-- architecture.md       This file
|   +-- troubleshooting.md    Diagnostic commands and common issues
+-- src/
    |-- pipeline/              Core dispatch lifecycle
    |   |-- webhook.ts             Event router (6 handlers, dedup, dispatch)
    |   |-- pipeline.ts            v2 pipeline: spawnWorker, triggerAudit, processVerdict
    |   |-- dispatch-state.ts      File-backed state, CAS, session map, idempotency
    |   |-- dispatch-service.ts    Background monitor (stale, recovery, prune)
    |   |-- active-session.ts      In-memory session registry
    |   |-- tier-assess.ts         Complexity assessment (junior/medior/senior)
    |   +-- artifacts.ts           .claw/ directory artifacts + memory integration
    |
    |-- agent/                 Agent execution & monitoring
    |   |-- agent.ts               Embedded runner + subprocess, watchdog + retry
    |   +-- watchdog.ts            InactivityWatchdog class + config resolver
    |
    |-- tools/                 Tool registration & CLI backends
    |   |-- tools.ts               Tool registration (code_run + orchestration)
    |   |-- code-tool.ts           Unified code_run dispatcher
    |   |-- cli-shared.ts          Shared CLI helpers and defaults
    |   |-- claude-tool.ts         Claude Code runner (JSONL + watchdog)
    |   |-- codex-tool.ts          Codex runner (JSONL + watchdog)
    |   |-- gemini-tool.ts         Gemini runner (JSONL + watchdog)
    |   +-- orchestration-tools.ts spawn_agent / ask_agent
    |
    |-- api/                   Linear API & auth
    |   |-- linear-api.ts          GraphQL client, token resolution, auto-refresh
    |   |-- auth.ts                OAuth provider registration
    |   +-- oauth-callback.ts      OAuth callback handler
    |
    +-- infra/                 Infrastructure utilities
        |-- cli.ts                 CLI subcommands
        |-- codex-worktree.ts      Git worktree management
        +-- notify.ts              Discord notifier (+ noop fallback)
```
