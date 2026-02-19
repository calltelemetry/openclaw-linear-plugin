# @calltelemetry/openclaw-linear

[![OpenClaw](https://img.shields.io/badge/OpenClaw-v2026.2+-blue)](https://github.com/calltelemetry/openclaw)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

Connect Linear to AI agents. Issues get triaged, implemented, and audited — automatically.

---

## What It Does

- **New issue?** Agent estimates story points, adds labels, sets priority.
- **Assign to agent?** A worker implements it, an independent auditor verifies it, done.
- **Comment `@qa review this`?** The QA agent responds with its expertise.
- **Say "plan this project"?** A planner interviews you and builds your full issue hierarchy.
- **Agent goes silent?** A watchdog kills it and retries automatically.
- **Want updates?** Get notified on Discord, Slack, Telegram, or Signal.

---

## Quick Start

### 1. Install the plugin

```bash
openclaw plugins install @calltelemetry/openclaw-linear
```

### 2. Create a Linear OAuth app

Go to **Linear Settings > API > Applications** and create an app:

- Set **Webhook URL** to `https://your-domain.com/linear/webhook`
- Set **Redirect URI** to `https://your-domain.com/linear/oauth/callback`
- Enable events: **Agent Sessions**, **Comments**, **Issues**
- Save your **Client ID** and **Client Secret**

> You also need a **workspace webhook** (Settings > API > Webhooks) pointing to the same URL with Comment + Issue + User events enabled. Both webhooks are required.

### 3. Set credentials

```bash
export LINEAR_CLIENT_ID="your_client_id"
export LINEAR_CLIENT_SECRET="your_client_secret"
```

For systemd services, add these to your unit file:

```ini
[Service]
Environment=LINEAR_CLIENT_ID=your_client_id
Environment=LINEAR_CLIENT_SECRET=your_client_secret
```

Then reload: `systemctl --user daemon-reload && systemctl --user restart openclaw-gateway`

### 4. Authorize

```bash
openclaw openclaw-linear auth
```

This opens your browser. Approve the authorization, then restart:

```bash
systemctl --user restart openclaw-gateway
```

### 5. Verify

```bash
openclaw openclaw-linear status
```

You should see a valid token and connected status. Check the gateway logs for a clean startup:

```
Linear agent extension registered (agent: default, token: profile, orchestration: enabled)
```

Test the webhook endpoint:

```bash
curl -s -X POST https://your-domain.com/linear/webhook \
  -H "Content-Type: application/json" \
  -d '{"type":"test","action":"ping"}'
# Returns: "ok"
```

That's it. Create an issue in Linear and watch the agent respond.

---

## Day-to-Day Usage

| What you do in Linear | What happens |
|---|---|
| Create a new issue | Agent triages it — adds estimate, labels, priority, posts assessment |
| Assign an issue to the agent | Worker-audit pipeline runs automatically |
| Comment `@qa check the tests` | QA agent responds |
| Comment `@ctclaw plan this project` | Planner enters interview mode, builds issue hierarchy |
| Reply during planning | Planner creates/updates issues, asks follow-up questions |
| Comment "finalize plan" | Validates the plan (cycles, missing fields, orphans) |
| Comment "close this issue" | Agent closes it via Linear API |
| `/dispatch list` | Shows all active dispatches |
| `/dispatch retry CT-123` | Re-runs a stuck dispatch |
| Add `<!-- repos: api, frontend -->` to issue body | Multi-repo dispatch across both repos |

### How the Pipeline Works

When you assign an issue to the agent:

1. **Assess** — Evaluates complexity (junior / medior / senior)
2. **Worktree** — Creates an isolated git worktree
3. **Worker** — Agent plans and implements the solution
4. **Audit** — An independent auditor verifies the work (automatic, not optional)
5. **Verdict** — Pass? Issue marked done. Fail? Worker retries with feedback. Too many failures? Escalated to you.

The worker **cannot** mark issues as done — only the plugin's verdict logic can. The audit is triggered by plugin code, not by the LLM. This is intentional.

---

## Configuration

Add settings under the plugin entry in `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "openclaw-linear": {
        "config": {
          "defaultAgentId": "coder",
          "maxReworkAttempts": 2,
          "enableAudit": true
        }
      }
    }
  }
}
```

### Plugin Settings

| Key | Type | Default | What it does |
|---|---|---|---|
| `defaultAgentId` | string | `"default"` | Which agent runs the pipeline |
| `enableAudit` | boolean | `true` | Run auditor after implementation |
| `enableOrchestration` | boolean | `true` | Allow `spawn_agent` / `ask_agent` tools |
| `maxReworkAttempts` | number | `2` | Max audit failures before escalation |
| `codexBaseRepo` | string | `"/home/claw/ai-workspace"` | Git repo for worktrees |
| `worktreeBaseDir` | string | `"~/.openclaw/worktrees"` | Where worktrees are created |
| `repos` | object | — | Multi-repo map (see [Multi-Repo](#multi-repo)) |
| `dispatchStatePath` | string | `"~/.openclaw/linear-dispatch-state.json"` | Dispatch state file |
| `promptsPath` | string | — | Custom prompts file path |
| `notifications` | object | — | Notification targets (see [Notifications](#notifications)) |
| `inactivitySec` | number | `120` | Kill agent if silent this long |
| `maxTotalSec` | number | `7200` | Max total agent session time |
| `toolTimeoutSec` | number | `600` | Max single `code_run` time |

### Environment Variables

| Variable | Required | What it does |
|---|---|---|
| `LINEAR_CLIENT_ID` | Yes | OAuth app client ID |
| `LINEAR_CLIENT_SECRET` | Yes | OAuth app client secret |
| `LINEAR_API_KEY` | No | Personal API key (fallback) |

### Agent Profiles

Define your agents in `~/.openclaw/agent-profiles.json`:

```json
{
  "agents": {
    "coder": {
      "label": "Coder",
      "mission": "Full-stack engineer. Plans, implements, ships.",
      "isDefault": true,
      "mentionAliases": ["coder"],
      "avatarUrl": "https://example.com/coder.png",
      "watchdog": {
        "inactivitySec": 180,
        "maxTotalSec": 7200,
        "toolTimeoutSec": 900
      }
    },
    "qa": {
      "label": "QA",
      "mission": "Test engineer. Reviews code, writes tests.",
      "mentionAliases": ["qa", "tester"]
    }
  }
}
```

One agent must have `"isDefault": true` — that's the one that handles triage and the dispatch pipeline.

### Coding Tools

Create `coding-tools.json` in the plugin root to configure which CLI backend agents use:

```json
{
  "codingTool": "claude",
  "agentCodingTools": {},
  "backends": {
    "claude": { "aliases": ["claude", "claude code", "anthropic"] },
    "codex": { "aliases": ["codex", "openai"] },
    "gemini": { "aliases": ["gemini", "google"] }
  }
}
```

The agent calls `code_run` without knowing which backend is active. Resolution order: explicit `backend` parameter > per-agent override > global default > `"claude"`.

---

## Notifications

Get notified when dispatches start, pass audit, fail, or get stuck.

### Setup

```json
{
  "notifications": {
    "targets": [
      { "channel": "discord", "target": "1471743433566715974" },
      { "channel": "telegram", "target": "-1003884997363" },
      { "channel": "slack", "target": "C0123456789", "accountId": "my-acct" }
    ],
    "events": {
      "auditing": false
    },
    "richFormat": true
  }
}
```

- **`targets`** — Where to send notifications (channel name + ID)
- **`events`** — Toggle specific events off (all on by default)
- **`richFormat`** — Set to `true` for Discord embeds with colors and Telegram HTML formatting

### Events

| Event | When it fires |
|---|---|
| `dispatch` | Issue dispatched to pipeline |
| `working` | Worker started |
| `auditing` | Audit in progress |
| `audit_pass` | Audit passed, issue done |
| `audit_fail` | Audit failed, worker retrying |
| `escalation` | Too many failures, needs human |
| `stuck` | Dispatch stale for 2+ hours |
| `watchdog_kill` | Agent killed for inactivity |

### Test It

```bash
openclaw openclaw-linear notify test              # Test all targets
openclaw openclaw-linear notify test --channel discord  # Test one channel
openclaw openclaw-linear notify status             # Show config
```

---

## Prompt Customization

Worker, audit, and rework prompts live in `prompts.yaml`. You can customize them without rebuilding.

### Three Layers

Prompts merge in this order (later layers override earlier ones):

1. **Built-in defaults** — Ship with the plugin, always available
2. **Your global file** — Set `promptsPath` in config to point to your custom YAML
3. **Per-project file** — Drop a `prompts.yaml` in the worktree's `.claw/` folder

Each layer only overrides the specific sections you define. Everything else keeps its default.

### Example Custom Prompts

```yaml
worker:
  system: "You are a senior engineer. Write clean, tested code."
  task: |
    Issue: {{identifier}} — {{title}}

    {{description}}

    Workspace: {{worktreePath}}

    Implement this issue. Write tests. Commit your work.

audit:
  system: "You are a strict code auditor."

rework:
  addendum: |
    PREVIOUS AUDIT FAILED. Fix these gaps:
    {{gaps}}
```

### Template Variables

| Variable | What it contains |
|---|---|
| `{{identifier}}` | Issue ID (e.g., `API-123`) |
| `{{title}}` | Issue title |
| `{{description}}` | Full issue body |
| `{{worktreePath}}` | Path to the git worktree |
| `{{tier}}` | Complexity tier (junior/medior/senior) |
| `{{attempt}}` | Current attempt number |
| `{{gaps}}` | Audit gaps from previous attempt |

### CLI

```bash
openclaw openclaw-linear prompts show       # View current prompts
openclaw openclaw-linear prompts path       # Show file path
openclaw openclaw-linear prompts validate   # Check for errors
```

---

## Multi-Repo

Work across multiple repositories in a single dispatch. The plugin creates parallel worktrees — one per repo — and gives the agent all of them.

### How to Enable

**Option 1: Issue body marker** (per-issue)

Add this anywhere in your issue description:

```
<!-- repos: api, frontend -->
```

**Option 2: Linear labels** (per-issue)

Add labels like `repo:api` and `repo:frontend` to the issue.

**Option 3: Config default** (all issues)

```json
{
  "repos": {
    "api": "/home/claw/api",
    "frontend": "/home/claw/frontend",
    "shared": "/home/claw/shared-libs"
  }
}
```

The repo names in issue markers and labels must match the keys in your `repos` config.

If no multi-repo markers are found, the plugin falls back to a single worktree from `codexBaseRepo`.

---

## Dispatch Management

### Slash Commands

Type these in any agent session — they run instantly, no AI involved:

| Command | What it does |
|---|---|
| `/dispatch list` | Show all active dispatches with age, tier, status |
| `/dispatch status CT-123` | Detailed info for one dispatch |
| `/dispatch retry CT-123` | Re-run a stuck dispatch |
| `/dispatch escalate CT-123 "needs review"` | Force a dispatch to stuck status |

### Gateway API

For programmatic access, the plugin registers these RPC methods:

| Method | What it does |
|---|---|
| `dispatch.list` | List dispatches (filterable by status, tier) |
| `dispatch.get` | Get full dispatch details |
| `dispatch.retry` | Re-dispatch a stuck issue |
| `dispatch.escalate` | Force-stuck with a reason |
| `dispatch.cancel` | Remove an active dispatch |
| `dispatch.stats` | Counts by status and tier |

---

## Watchdog

If an agent goes silent — LLM provider timeout, API hang, CLI lockup — the watchdog detects it and acts:

1. No output for `inactivitySec` → **kill the session**
2. Retry once automatically
3. Second silence → **escalate to stuck** (you get notified)

### Timeouts

| Setting | Default | What it controls |
|---|---|---|
| `inactivitySec` | 120s (2 min) | Kill if no output for this long |
| `maxTotalSec` | 7200s (2 hrs) | Hard ceiling on total session time |
| `toolTimeoutSec` | 600s (10 min) | Max time for a single `code_run` call |

Configure per-agent in `agent-profiles.json` or globally in plugin config.

---

## CLI Reference

```bash
# Auth & status
openclaw openclaw-linear auth                      # Run OAuth flow
openclaw openclaw-linear status                    # Check connection

# Worktrees
openclaw openclaw-linear worktrees                 # List active worktrees
openclaw openclaw-linear worktrees --prune <path>  # Remove a worktree

# Prompts
openclaw openclaw-linear prompts show              # View current prompts
openclaw openclaw-linear prompts path              # Show file path
openclaw openclaw-linear prompts validate          # Check for errors

# Notifications
openclaw openclaw-linear notify status             # Show targets & events
openclaw openclaw-linear notify test               # Test all targets
openclaw openclaw-linear notify test --channel discord  # Test one channel
openclaw openclaw-linear notify setup              # Interactive setup

# Dispatch
/dispatch list                                     # Active dispatches
/dispatch status <identifier>                      # Dispatch details
/dispatch retry <identifier>                       # Re-run stuck dispatch
/dispatch escalate <identifier> [reason]           # Force to stuck

# Health
openclaw openclaw-linear doctor                    # Run health checks
openclaw openclaw-linear doctor --fix              # Auto-fix issues
openclaw openclaw-linear doctor --json             # JSON output
```

---

## Troubleshooting

Quick checks:

```bash
systemctl --user status openclaw-gateway        # Is the gateway running?
openclaw openclaw-linear status                  # Is the token valid?
journalctl --user -u openclaw-gateway -f         # Watch live logs
```

### Common Issues

| Problem | Fix |
|---|---|
| Agent goes silent | Watchdog auto-kills after `inactivitySec` and retries. Check logs for `Watchdog KILL`. |
| Dispatch stuck after watchdog | Both retries failed. Check `.claw/log.jsonl`. Re-assign issue to restart. |
| `code_run` uses wrong backend | Check `coding-tools.json` — explicit backend > per-agent > global default. |
| Webhook events not arriving | Both webhooks must point to `/linear/webhook`. Check tunnel is running. |
| OAuth token expired | Auto-refreshes. If stuck, re-run `openclaw openclaw-linear auth` and restart. |
| Audit always fails | Run `openclaw openclaw-linear prompts validate` to check prompt syntax. |
| Multi-repo not detected | Markers must be `<!-- repos: name1, name2 -->`. Names must match `repos` config keys. |
| `/dispatch` not responding | Restart gateway. Check plugin loaded with `openclaw doctor`. |
| Rich notifications are plain text | Set `"richFormat": true` in notifications config. |
| Gateway rejects config keys | Strict validator. Run `openclaw doctor --fix`. |

For detailed diagnostics, see [docs/troubleshooting.md](docs/troubleshooting.md).

---

## Further Reading

- [Architecture](docs/architecture.md) — Internal design, state machines, diagrams
- [Troubleshooting](docs/troubleshooting.md) — Diagnostic commands, curl examples, log analysis

---

## License

MIT
