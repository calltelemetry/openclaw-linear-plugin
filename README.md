# @calltelemetry/openclaw-linear

An OpenClaw plugin that connects your Linear workspace to AI agents. Issues get triaged automatically, agents respond to @mentions, and a worker-audit pipeline runs when you assign work to the agent.

## Features

- **Auto-triage** -- New issues get story point estimates, labels, and priority automatically
- **@mention routing** -- `@qa`, `@infra`, `@docs` in comments route to specialized agents
- **Worker-audit pipeline** -- Assign an issue and a worker implements it, then an independent auditor verifies the work against the issue's definition of done
- **Hard-enforced audit** -- The audit triggers automatically in plugin code, not as an LLM decision. Workers cannot self-certify completion.
- **Branded replies** -- Each agent posts with its own name and avatar in Linear
- **Real-time progress** -- Agent activity (thinking, acting, responding) shows in Linear's UI
- **Unified `code_run` tool** -- One tool, three coding CLI backends (Codex, Claude Code, Gemini CLI), configurable per agent
- **Issue management via `linearis`** -- Agents use the `linearis` CLI to update status, close issues, add comments, and more
- **Customizable prompts** -- Worker, audit, and rework prompts live in `prompts.yaml`, editable without rebuilding
- **Discord notifications** -- Optional dispatch lifecycle notifications to a Discord channel

## Architecture

### Dispatch Pipeline (v2)

When an issue is assigned to the agent, the plugin runs a multi-stage pipeline with hard-enforced audit:

```
  Issue Assigned
       |
       v
  +-----------------+
  |  DISPATCH       |  Tier assessment, worktree creation,
  |                 |  dispatch state registration
  +-----------------+
       |
       v
  +-----------------+
  |  WORKER         |  Plans approach, implements solution,
  |  (sub-agent)    |  posts summary comment on the issue.
  |                 |  CANNOT mark issue as Done.
  +-----------------+
       |
       | (plugin code -- automatic, not LLM-mediated)
       v
  +-----------------+
  |  AUDIT          |  Independent auditor reads issue body
  |  (sub-agent)    |  (source of truth), verifies criteria,
  |                 |  runs tests, returns JSON verdict.
  +-----------------+
       |
       v
  +-----------------+
  |  VERDICT        |  Plugin code processes the verdict:
  |  (plugin code)  |  PASS --> done + notify
  |                 |  FAIL <= max --> rework (attempt++)
  |                 |  FAIL > max  --> stuck + escalate
  +-----------------+
```

**What's hard-enforced vs. LLM-mediated:**

| Layer | Mechanism | Can be skipped? |
|-------|-----------|-----------------|
| Worker spawn | Plugin code (`runAgent`) | No |
| Audit trigger | Plugin code (fires after worker completes) | No |
| Verdict processing | Plugin code (pass/fail/escalate) | No |
| Worker implementation | LLM-mediated (the agent decides how to code) | N/A |
| Audit evaluation | LLM-mediated (the agent decides if criteria are met) | N/A |

### State Machine

```
DISPATCHED --> WORKING --> AUDITING --> DONE
                 ^            |
                 |    FAIL ---+  (attempt++ if <= max)
                 +------------+  (re-enter WORKING)
                              |
               (attempt > max) --> STUCK
```

All state transitions use compare-and-swap (CAS) to prevent races from duplicate webhooks or concurrent events. `dispatch-state.json` is the canonical source of truth; Linear labels are derived side effects.

### Webhook Flow

```
  Linear                  OpenClaw Gateway              AI Agents
    |                           |                          |
    |  Webhook (issue created)  |                          |
    |  -----------------------> |                          |
    |                           |  Dispatch triage agent   |
    |                           |  ----------------------> |
    |                           |                          |
    |                           |  Estimate + labels       |
    |                           |  <---------------------- |
    |  Update issue             |                          |
    |  <----------------------- |                          |
    |  Post assessment comment  |                          |
    |  <----------------------- |                          |
```

```
  Linear                  OpenClaw Gateway              AI Agents
    |                           |                          |
    |  "@qa check this"         |                          |
    |  -----------------------> |                          |
    |                           |  Route to QA agent       |
    |                           |  ----------------------> |
    |                           |                          |
    |                           |  Response                |
    |                           |  <---------------------- |
    |  Comment from "QA"        |                          |
    |  <----------------------- |                          |
```

### Two Webhook Systems

Linear delivers events through two separate webhook paths:

1. **Workspace webhook** (Settings > API > Webhooks) -- handles Comment, Issue, and User events
2. **OAuth app webhook** (Settings > API > Applications > your app) -- handles `AgentSessionEvent` (created/prompted)

Both must point to the same URL: `https://<your-domain>/linear/webhook`

### Source Layout

```
index.ts                  Plugin entry point, agent_end hook, notifier setup
prompts.yaml              Externalized worker/audit/rework prompt templates
src/
  webhook.ts              Webhook handler -- routes events to agents, dispatches pipeline
  pipeline.ts             v2 pipeline: spawnWorker, triggerAudit, processVerdict
  dispatch-state.ts       File-backed state with CAS transitions, session map, idempotency
  dispatch-service.ts     Background service -- stale detection, recovery, cleanup
  notify.ts               Notification provider (Discord + noop fallback)
  agent.ts                Agent execution wrapper (embedded runner + subprocess fallback)
  active-session.ts       In-process session registry (issueId -> session)
  tier-assess.ts          Issue complexity assessment (junior/medior/senior)

  code-tool.ts            Unified code_run tool -- dispatches to configured backend
  cli-shared.ts           Shared helpers for CLI tools (buildLinearApi, resolveSession)
  codex-tool.ts           Codex CLI runner (JSONL stream -> Linear activities)
  claude-tool.ts          Claude Code CLI runner (JSONL stream -> Linear activities)
  gemini-tool.ts          Gemini CLI runner (JSONL stream -> Linear activities)
  coding-tools.json       Backend config (default tool, per-agent overrides, aliases)

  tools.ts                Tool registration (code_run + orchestration)
  orchestration-tools.ts  spawn_agent / ask_agent for multi-agent delegation
  linear-api.ts           Linear GraphQL API client, token resolution, activity streaming
  auth.ts                 OAuth token management and profile storage
  oauth-callback.ts       OAuth callback handler
  cli.ts                  CLI subcommands (auth, status, worktrees, prompts)
  codex-worktree.ts       Git worktree management for isolated runs
```

## Getting Started

### Prerequisites

- **OpenClaw** gateway running (v2026.2+)
- **Linear** workspace with API access
- **Public URL** for webhook delivery (Cloudflare Tunnel recommended)
- **Coding CLIs** (at least one): `codex`, `claude`, `gemini` -- installed in PATH
- **linearis** CLI -- for issue management

### 1. Install the Plugin

```bash
openclaw plugins install @calltelemetry/openclaw-linear
```

### 2. Create a Linear OAuth App

Go to **Linear Settings > API > Applications** and create a new application:

- **Webhook URL:** `https://<your-domain>/linear/webhook`
- **Redirect URI:** `https://<your-domain>/linear/oauth/callback`
- Enable webhook events: **Agent Sessions**, **Comments**, **Issues**

Save the **Client ID** and **Client Secret**.

### 3. Set Credentials

Add to your gateway's environment (systemd service or shell):

```bash
export LINEAR_CLIENT_ID="your_client_id"
export LINEAR_CLIENT_SECRET="your_client_secret"
```

For systemd:

```ini
[Service]
Environment=LINEAR_CLIENT_ID=your_client_id
Environment=LINEAR_CLIENT_SECRET=your_client_secret
```

Then reload: `systemctl --user daemon-reload && systemctl --user restart openclaw-gateway`

### 4. Expose the Gateway

Linear needs to reach your gateway over HTTPS to deliver webhooks. A [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) is the recommended approach -- no open ports, no TLS certificates to manage.

```bash
# Install cloudflared (RHEL/Rocky/Alma)
sudo dnf install -y cloudflared

# Authenticate and create tunnel
cloudflared tunnel login
cloudflared tunnel create openclaw
cloudflared tunnel route dns openclaw linear.yourdomain.com
```

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL_ID>
credentials-file: ~/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: linear.yourdomain.com
    service: http://localhost:18789
  - service: http_status:404
```

Start the tunnel:

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

Verify:

```bash
curl -s https://linear.yourdomain.com/linear/webhook \
  -X POST -H "Content-Type: application/json" \
  -d '{"type":"test","action":"ping"}'
# Should return: "ok"
```

### 5. Authorize with Linear

```bash
openclaw openclaw-linear auth
```

This opens your browser to authorize the agent. After authorization, restart the gateway:

```bash
systemctl --user restart openclaw-gateway
```

Verify it's working:

```bash
openclaw openclaw-linear status
```

### 6. Configure Agents

Create `~/.openclaw/agent-profiles.json` to define your agent team:

```json
{
  "agents": {
    "coder": {
      "label": "Coder",
      "mission": "Full-stack engineer. Plans, implements, and ships code.",
      "isDefault": true,
      "mentionAliases": ["coder"],
      "avatarUrl": "https://example.com/coder.png"
    },
    "qa": {
      "label": "QA",
      "mission": "Test engineer. Quality guardian, test strategy.",
      "mentionAliases": ["qa", "tester"]
    }
  }
}
```

Each agent name must match an agent definition in your `~/.openclaw/openclaw.json`.

One agent must be marked `isDefault: true` -- this is the agent that handles issue assignments and the dispatch pipeline.

### 7. Configure Coding Tools

Create `coding-tools.json` in the plugin root:

```json
{
  "codingTool": "codex",
  "agentCodingTools": {},
  "backends": {
    "claude": { "aliases": ["claude", "claude code", "anthropic"] },
    "codex": { "aliases": ["codex", "openai"] },
    "gemini": { "aliases": ["gemini", "google"] }
  }
}
```

### 8. Install linearis

```bash
npm install -g linearis
npx clawhub install linearis
echo "lin_api_YOUR_KEY" > ~/.linear_api_token
```

### 9. Verify

```bash
systemctl --user restart openclaw-gateway
```

Check the logs for a clean startup:

```
[plugins] Linear agent extension registered (agent: default, token: profile,
  codex: codex-cli 0.101.0, claude: 2.1.45, gemini: 0.28.2, orchestration: enabled)
```

Test the webhook:

```bash
curl -s -X POST https://your-domain.com/linear/webhook \
  -H "Content-Type: application/json" \
  -d '{"type":"test","action":"ping"}'
# Should return: "ok"
```

## Usage

Once set up, the plugin responds to Linear events automatically:

| What you do in Linear | What happens |
|---|---|
| Create a new issue | Agent triages it (estimate, labels, priority) and posts an assessment |
| Assign an issue to the agent | Worker-audit pipeline runs: implement, then independent audit |
| Trigger an agent session | Agent responds directly in the session |
| Comment `@qa check the tests` | QA agent responds with its expertise |
| Ask "close this issue" | Agent runs `linearis issues update API-123 --status Done` |
| Ask "use gemini to review" | Agent calls `code_run` with `backend: "gemini"` |

### Pipeline Behavior

When an issue is assigned:

1. **Tier assessment** -- The plugin evaluates issue complexity (junior/medior/senior) and selects an appropriate model
2. **Worktree creation** -- A git worktree is created for isolated work
3. **Worker runs** -- The worker agent plans and implements the solution, posts a summary comment
4. **Audit runs** -- An independent audit agent reads the issue body (source of truth), verifies acceptance criteria, runs tests, and returns a JSON verdict
5. **Verdict** -- If the audit passes, the issue is marked done. If it fails, the worker is re-spawned with the audit gaps (up to `maxReworkAttempts` times). If it fails too many times, the issue is marked stuck and an escalation notification is sent.

Workers **cannot** mark issues as done or modify issue status -- that's handled entirely by the plugin's verdict processing code.

## Prompt Customization

Worker, audit, and rework prompts are externalized in `prompts.yaml`. Edit them to customize agent behavior without rebuilding the plugin.

### Managing Prompts

```bash
openclaw openclaw-linear prompts show       # Print current prompts.yaml
openclaw openclaw-linear prompts path       # Print resolved file path
openclaw openclaw-linear prompts validate   # Validate structure and template variables
```

### Template Variables

| Variable | Description |
|---|---|
| `{{identifier}}` | Issue identifier (e.g., `API-123`) |
| `{{title}}` | Issue title |
| `{{description}}` | Full issue body |
| `{{worktreePath}}` | Path to the git worktree |
| `{{tier}}` | Assessed complexity tier |
| `{{attempt}}` | Current attempt number (0-based) |
| `{{gaps}}` | Audit gaps from previous failed attempt (rework only) |

### Override Path

Set `promptsPath` in plugin config to load prompts from a custom location:

```json
{
  "plugins": {
    "entries": {
      "openclaw-linear": {
        "config": {
          "promptsPath": "/path/to/my/prompts.yaml"
        }
      }
    }
  }
}
```

## Notifications

The plugin can post dispatch lifecycle events to a Discord channel. Configure `flowDiscordChannel` in plugin config with the channel ID.

Events posted:

| Event | Message |
|---|---|
| Dispatch | `**API-123** dispatched -- Fix auth bug` |
| Worker started | `**API-123** worker started (attempt 0)` |
| Audit in progress | `**API-123** audit in progress` |
| Audit passed | `**API-123** passed audit. PR ready.` |
| Audit failed | `**API-123** failed audit (attempt 1). Gaps: missing test coverage` |
| Escalation | `**API-123** needs human review -- audit failed 3x` |

## Coding Tool (`code_run`)

The plugin provides a single `code_run` tool that dispatches to one of three coding CLI backends. Agents call `code_run` without needing to know which backend is active.

### Supported Backends

| Backend | CLI | Stream Format | Key Flags |
|---|---|---|---|
| **Codex** (OpenAI) | `codex` | JSONL | `--full-auto`, `-q` |
| **Claude Code** (Anthropic) | `claude` | JSONL (`stream-json`) | `--print`, `--dangerously-skip-permissions`, `--verbose` |
| **Gemini CLI** (Google) | `gemini` | JSONL (`stream-json`) | `--yolo`, `-o stream-json` |

### Backend Resolution Priority

1. **Explicit `backend` parameter** -- Agent passes `backend: "gemini"` (or any alias)
2. **Per-agent override** -- `agentCodingTools` in `coding-tools.json`
3. **Global default** -- `codingTool` in `coding-tools.json`
4. **Hardcoded fallback** -- `"claude"`

## Linear Issue Management (`linearis` Skill)

Issue management is handled by the **`linearis`** CLI, installed as an OpenClaw skill. Agents use `linearis` via exec.

```bash
linearis issues list -l 20               # List recent issues
linearis issues search "auth bug"         # Full-text search
linearis issues read API-123              # Get issue details
linearis issues update API-123 --status "Done"
linearis issues update API-123 --labels "Bug" --label-by adding
linearis comments create API-123 --body "Fixed in PR #456"
linearis usage                            # Full command reference
```

## Configuration Reference

### Plugin Config

Set in `openclaw.json` under the plugin entry:

| Key | Type | Default | Description |
|---|---|---|---|
| `defaultAgentId` | string | `"default"` | Agent ID for pipeline workers and audit |
| `enableAudit` | boolean | `true` | Run the auditor stage after implementation |
| `enableOrchestration` | boolean | `true` | Allow agents to use `spawn_agent`/`ask_agent` |
| `codexBaseRepo` | string | `"/home/claw/ai-workspace"` | Git repo path for worktrees |
| `codexModel` | string | -- | Default Codex model |
| `codexTimeoutMs` | number | `600000` | Default timeout for coding CLIs (ms) |
| `worktreeBaseDir` | string | `"~/.openclaw/worktrees"` | Base directory for persistent git worktrees |
| `dispatchStatePath` | string | `"~/.openclaw/linear-dispatch-state.json"` | Path to dispatch state file |
| `flowDiscordChannel` | string | -- | Discord channel ID for lifecycle notifications |
| `promptsPath` | string | -- | Override path for `prompts.yaml` |
| `maxReworkAttempts` | number | `2` | Max audit failures before escalation |

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `LINEAR_CLIENT_ID` | Yes | OAuth app client ID |
| `LINEAR_CLIENT_SECRET` | Yes | OAuth app client secret |
| `LINEAR_API_KEY` | No | Personal API key (fallback if no OAuth) |
| `LINEAR_REDIRECT_URI` | No | Override the OAuth callback URL |
| `OPENCLAW_GATEWAY_PORT` | No | Gateway port (default: 18789) |

### Agent Profile Fields

| Field | Required | Description |
|---|---|---|
| `label` | Yes | Display name shown on comments in Linear |
| `mission` | Yes | Role description (injected as context) |
| `isDefault` | One agent | Handles issue triage and the dispatch pipeline |
| `mentionAliases` | Yes | `@mention` triggers (e.g., `["qa", "tester"]`) |
| `avatarUrl` | No | Avatar for branded comments |

### CLI

```bash
openclaw openclaw-linear auth              # Run OAuth authorization
openclaw openclaw-linear status            # Check connection and token status
openclaw openclaw-linear worktrees         # List active worktrees
openclaw openclaw-linear worktrees --prune <path>  # Remove a worktree
openclaw openclaw-linear prompts show      # Print current prompts
openclaw openclaw-linear prompts path      # Print resolved prompts file path
openclaw openclaw-linear prompts validate  # Validate prompt structure
```

## Troubleshooting

Quick checks:

```bash
systemctl --user status openclaw-gateway        # Is the gateway running?
openclaw openclaw-linear status                  # Is the token valid?
journalctl --user -u openclaw-gateway -f         # Watch live logs
linearis issues list -l 1                        # Is linearis authenticated?
openclaw openclaw-linear prompts validate        # Are prompts valid?
```

### Common Issues

| Problem | Cause | Fix |
|---|---|---|
| Agent says "closing" but doesn't | No issue management tool | Install `linearis`: `npx clawhub install linearis` |
| `code_run` uses wrong backend | Config mismatch | Check `coding-tools.json` |
| Claude Code "nested session" error | `CLAUDECODE` env var set | Plugin handles this automatically |
| Gateway rejects plugin config keys | Strict validator | Custom config goes in `coding-tools.json` |
| Webhook events not arriving | Wrong URL | Both webhooks must point to `/linear/webhook` |
| OAuth token expired | Tokens expire ~24h | Auto-refreshes; restart gateway if stuck |
| Audit always fails | Bad prompt template | Run `openclaw openclaw-linear prompts validate` |
| Dispatch stuck | Worker timed out or crashed | Check `dispatch-state.json`, re-assign issue |

## License

MIT
