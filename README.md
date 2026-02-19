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

## How It Works — Step by Step

Every issue moves through a clear pipeline. Here's exactly what happens at each stage and what you'll see in Linear.

```
 ┌─────────┐    ┌──────────┐    ┌────────┐    ┌───────┐    ┌──────────┐
 │ Triage  │───▶│ Dispatch │───▶│ Worker │───▶│ Audit │───▶│  Done ✔  │
 │(auto)   │    │(you      │    │(auto)  │    │(auto) │    │          │
 │         │    │ assign)  │    │        │    │       │    └──────────┘
 └─────────┘    └──────────┘    └────────┘    └───┬───┘
                                                  │
                                    ┌─────────────┤
                                    ▼             ▼
                              ┌──────────┐  ┌───────────────┐
                              │ Rework   │  │ Needs Your    │
                              │ (auto    │  │ Help ⚠        │
                              │  retry)  │  │ (escalated)   │
                              └────┬─────┘  └───────────────┘
                                   │
                                   └──▶ back to Worker
```

### Stage 1: Triage (automatic)

**Trigger:** You create a new issue.

The agent reads your issue, estimates story points, adds labels, sets priority, and posts an assessment comment — all within seconds.

**What you'll see in Linear:**

> **[Mal]** This looks like a medium complexity change — the search API integration touches both the backend GraphQL schema and the frontend query layer. I've estimated 3 points and tagged it `backend` + `frontend`.

The estimate, labels, and priority are applied silently to the issue fields. You don't need to do anything.

### Stage 2: Dispatch (you assign the issue)

**Trigger:** You assign the issue to the agent (or it gets auto-assigned after planning).

The agent assesses complexity, picks an appropriate model, creates an isolated git worktree, and starts working.

**What you'll see in Linear:**

> **Dispatched** as **senior** (anthropic/claude-opus-4-6)
> > Complex multi-service refactor with migration concerns
>
> Worktree: `/home/claw/worktrees/ENG-100` (fresh)
> Branch: `codex/ENG-100`
>
> **Status:** Worker is starting now. An independent audit runs automatically after implementation.
>
> **While you wait:**
> - Check progress: `/dispatch status ENG-100`
> - Cancel: `/dispatch escalate ENG-100 "reason"`
> - All dispatches: `/dispatch list`

**Complexity tiers:**

| Tier | Model | When |
|---|---|---|
| Junior | claude-haiku-4-5 | Simple config changes, typos, one-file fixes |
| Medior | claude-sonnet-4-6 | Standard features, multi-file changes |
| Senior | claude-opus-4-6 | Complex refactors, architecture changes |

### Stage 3: Implementation (automatic)

The worker agent reads the issue, plans its approach, writes code, and runs tests — all in the isolated worktree. You don't need to do anything during this stage.

If this is a **retry** after a failed audit, the worker gets the previous audit feedback as context so it knows exactly what to fix.

**Notifications you'll receive:**
> `ENG-100 working on it (attempt 1)`

### Stage 4: Audit (automatic)

After the worker finishes, a separate auditor agent independently verifies the work. The auditor checks the issue requirements against what was actually implemented.

This is **not optional** — the worker cannot mark its own work as done. The audit is triggered by the plugin, not by the AI.

**Notifications you'll receive:**
> `ENG-100 checking the work...`

### Stage 5: Verdict

The audit produces one of three outcomes:

#### Pass — Issue is done

The issue is marked done automatically. A summary is posted.

**What you'll see in Linear:**

> ## Done
>
> This issue has been implemented and verified.
>
> **What was checked:**
> - API endpoint returns correct response format
> - Tests pass for edge cases
> - Error handling covers timeout scenarios
>
> **Test results:** 14 tests passed, 0 failed
>
> ---
> *Completed on attempt 1. Artifacts: `/home/claw/worktrees/ENG-100/.claw/`*

**Notification:** `✅ ENG-100 done! Ready for review.`

#### Fail (retries left) — Automatic rework

The worker gets the audit feedback and tries again. You don't need to do anything.

**What you'll see in Linear:**

> ## Needs More Work
>
> The implementation was checked and some things need to be addressed. Retrying automatically.
>
> **Attempt 1 of 3**
>
> **What needs fixing:**
> - Missing input validation on the search endpoint
> - No test for empty query string
>
> **Test results:** 12 passed, 2 failed

**Notification:** `ENG-100 needs more work (attempt 1). Issues: missing validation, no empty query test`

#### Fail (no retries left) — Needs your help

After all retries are exhausted (default: 3 attempts), the issue is escalated to you.

**What you'll see in Linear:**

> ## Needs Your Help
>
> The automatic retries didn't fix these issues:
>
> **What went wrong:**
> - Search pagination still returns duplicate results
> - Integration test flaky on CI
>
> **Test results:** 10 passed, 4 failed
>
> ---
> *Please review and either:*
> - *Update the issue description with clearer requirements, then re-assign*
> - *Fix the issues manually in the worktree at `/home/claw/worktrees/ENG-100`*

**Notification:** `🚨 ENG-100 needs your help — couldn't fix it after 3 tries`

**What you can do:**
1. **Clarify the issue** — Add more detail to the description, then re-assign to try again
2. **Fix it yourself** — The agent's work is in the worktree, ready to edit
3. **Force retry** — `/dispatch retry ENG-100`
4. **Check logs** — Worker output in `.claw/worker-*.md`, audit verdicts in `.claw/audit-*.json`

### Stage 6: Timeout (if the agent goes silent)

If the agent produces no output for 2 minutes (configurable), the watchdog kills it and retries once. If the retry also times out, the issue is escalated.

**What you'll see in Linear:**

> ## Agent Timed Out
>
> The agent stopped responding for over 120s and was automatically restarted, but the retry also failed.
>
> **What to do:** Re-assign this issue to try again. If it keeps timing out, the issue might be too complex — try breaking it into smaller issues.

**Notification:** `⚡ ENG-100 timed out (no activity for 120s). Will retry.`

### What's in the worktree

Every dispatch creates a `.claw/` folder inside the worktree with everything the agent did:

```
/home/claw/worktrees/ENG-100/
├── .claw/
│   ├── manifest.json       # Issue metadata, tier, status, attempt count
│   ├── worker-0.md         # What the worker did on attempt 1
│   ├── worker-1.md         # What the worker did on attempt 2 (if retried)
│   ├── audit-0.json        # Audit verdict for attempt 1
│   ├── audit-1.json        # Audit verdict for attempt 2
│   ├── log.jsonl           # Timeline of every phase with timing
│   └── summary.md          # Final summary (written on done or stuck)
├── src/                    # ← your code, modified by the agent
├── tests/
└── ...
```

If something went wrong, start with `log.jsonl` — it shows every phase, how long it took, and a preview of the output.

---

## Planning a Project

For larger work, the planner helps you break a project into issues with dependencies, then dispatches them automatically.

### Start planning

Comment on any issue that belongs to a Linear project:

> `@ctclaw plan this project`

The planner enters **interview mode** and asks you questions:

> Entering planning mode for **Search Feature**. What are the main feature areas you'd like to build?

### Build the plan

Reply with your ideas. The planner creates issues, sets dependencies, and asks follow-up questions:

> I've created 3 issues:
> - **PROJ-2:** Build search API endpoint (3 pts, blocks PROJ-3)
> - **PROJ-3:** Search results page (2 pts, blocked by PROJ-2)
> - **PROJ-4:** Autocomplete suggestions (1 pt, independent)
>
> Should the autocomplete call a separate endpoint or share the search API?

Keep replying until the plan looks right. The planner updates issues in real time.

### Finalize

When you're happy with the plan, comment:

> `finalize plan`

The planner runs a validation check:
- Every issue has a description (50+ characters)
- Every issue has an estimate
- Every issue has a priority
- No circular dependencies

**If validation passes:**

> ## Plan Approved
>
> The plan for **Search Feature** passed all checks.
> **3 issues** created with valid dependency graph.

The project enters **DAG dispatch mode** — issues are assigned to the agent automatically, respecting dependency order. Up to 3 issues run in parallel. As each completes, newly unblocked issues start.

**If validation fails:**

> ## Plan Audit Failed
>
> **Problems:**
> - PROJ-2: description too short (< 50 chars)
> - PROJ-3: missing estimate
>
> Please address these issues, then say "finalize plan" again.

Fix the issues and try again. You can also say `abandon planning` to exit without dispatching.

### DAG dispatch progress

As issues complete, you'll get progress notifications:

> `📊 Search Feature: 2/3 complete`

When everything is done:

> `✅ Search Feature: complete (3/3 issues)`

If an issue gets stuck (all retries failed), dependent issues are blocked and you'll be notified.

---

## Quick Reference

| What you do in Linear | What happens |
|---|---|
| Create a new issue | Agent triages — adds estimate, labels, priority |
| Assign an issue to the agent | Worker → Audit → Done (or retry, or escalate) |
| Comment `@qa check the tests` | QA agent responds |
| Comment `@ctclaw plan this project` | Planning interview starts |
| Reply during planning | Issues created/updated, follow-up questions |
| Comment `finalize plan` | Validates, then auto-dispatches |
| Comment `abandon planning` | Exits planning mode |
| `/dispatch list` | Shows all active dispatches |
| `/dispatch retry CT-123` | Re-runs a stuck dispatch |
| `/dispatch status CT-123` | Detailed dispatch info |
| Add `<!-- repos: api, frontend -->` to issue body | Multi-repo dispatch |

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

Sometimes a feature touches more than one repo — your API and your frontend, for example. Multi-repo lets the agent work on both at the same time, in separate worktrees.

### Step 1: Tell the plugin where your repos live

Add a `repos` map to your plugin config in `openclaw.json`. The **key** is a short name you pick, the **value** is the absolute path to that repo on disk:

```json
{
  "plugins": {
    "entries": {
      "openclaw-linear": {
        "config": {
          "repos": {
            "api": "/home/claw/repos/api",
            "frontend": "/home/claw/repos/frontend",
            "shared": "/home/claw/repos/shared-libs"
          }
        }
      }
    }
  }
}
```

Restart the gateway after saving: `systemctl --user restart openclaw-gateway`

### Step 1.5: Sync labels to Linear (optional)

If you plan to use labels (Method B below) to tag issues, run this to create the `repo:xxx` labels automatically:

```bash
openclaw openclaw-linear repos sync
```

This reads your `repos` config and creates matching labels (`repo:api`, `repo:frontend`, etc.) in every Linear team. To preview without creating anything:

```bash
openclaw openclaw-linear repos check
```

The check command also validates your repo paths — it'll warn you if a path doesn't exist, isn't a git repo, or is a **submodule** (which won't work with multi-repo dispatch).

### Step 2: Tag the issue

When you write an issue in Linear that needs multiple repos, tell the plugin which ones. Pick **one** of these methods:

#### Method A: HTML comment in the issue body (recommended)

Put this line anywhere in the issue description — it's invisible in Linear's UI:

```
<!-- repos: api, frontend -->
```

Full example of what an issue body might look like:

```
The search endpoint needs to be added to the API, and the frontend
needs a new search page that calls it.

<!-- repos: api, frontend -->

Acceptance criteria:
- GET /api/search?q=term returns results
- /search page renders results with pagination
```

#### Method B: Linear labels

Create labels in Linear called `repo:api` and `repo:frontend`, then add them to the issue. The part after `repo:` must match the key in your config.

#### Method C: Do nothing (config default)

If you don't tag the issue at all, the plugin uses your `codexBaseRepo` setting (a single repo). This is how it worked before multi-repo existed — nothing changes for single-repo issues.

### What happens when you dispatch

When the agent picks up a multi-repo issue, the dispatch comment tells you:

> **Dispatched** as **senior** (anthropic/claude-opus-4-6)
>
> Worktrees:
> - `api` → `/home/claw/worktrees/ENG-100/api`
> - `frontend` → `/home/claw/worktrees/ENG-100/frontend`
>
> Branch: `codex/ENG-100`

The agent gets access to all the worktrees and can edit files across repos in one session. Each repo gets its own git branch.

### Priority order

If an issue has both a body marker and labels, the body marker wins. Full order:

1. `<!-- repos: ... -->` in the issue body
2. `repo:xxx` labels on the issue
3. `codexBaseRepo` from config (single repo fallback)

### Common mistakes

| Problem | Fix |
|---|---|
| Agent only sees one repo | The name in `<!-- repos: api -->` must exactly match a key in your `repos` config. Check spelling. |
| "Could not create worktree" error | The path in your `repos` config doesn't exist, or it's not a git repo. Run `ls /home/claw/repos/api/.git` to check. |
| Comment marker not detected | Must be `<!-- repos: name1, name2 -->` with the exact format. No extra spaces around `<!--` or `-->`. |
| Labels not picked up | Labels must be formatted `repo:name` (lowercase, no spaces). The `name` part must match a `repos` config key. |

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

If an agent goes silent (LLM timeout, API hang, CLI lockup), the watchdog handles it automatically:

1. No output for `inactivitySec` → kill and retry once
2. Second silence → escalate to stuck (you get notified, see [Stage 6](#stage-6-timeout-if-the-agent-goes-silent) above)

| Setting | Default | What it controls |
|---|---|---|
| `inactivitySec` | 120s | Kill if no output for this long |
| `maxTotalSec` | 7200s (2 hrs) | Hard ceiling on total session time |
| `toolTimeoutSec` | 600s (10 min) | Max time for a single `code_run` call |

Configure per-agent in `agent-profiles.json` or globally in plugin config.

---

## Testing & Verification

### Health check

Run the doctor to verify your setup. It checks auth, config, prompts, connectivity, and dispatch health — and tells you exactly how to fix anything that's wrong:

```bash
openclaw openclaw-linear doctor
```

Example output:

```
┌──────────────────────────────────────────────┐
│            Linear Plugin Doctor              │
└──────────────────────────────────────────────┘

  Authentication & Tokens
  ✔ Access token found (source: profile)
  ✔ Token not expired (23h remaining)
  ✔ API reachable — logged in as Test (TestOrg)

  Agent Configuration
  ✔ agent-profiles.json loaded (2 agents)
  ✔ Default agent: coder

  Coding Tools
  ✔ coding-tools.json loaded (default: claude)
  ✔ claude: found at /usr/local/bin/claude

  Files & Directories
  ✔ Dispatch state: 1 active, 5 completed
  ✔ Prompts valid (5/5 sections, 4/4 variables)

  Connectivity
  ✔ Linear API reachable
  ✔ Webhook gateway responding

  Dispatch Health
  ✔ No stale dispatches
  ⚠ 2 completed dispatches older than 7 days
    → Run: openclaw openclaw-linear doctor --fix to clean up

  Summary: 11 passed, 1 warning, 0 errors
```

Every warning and error includes a `→` line telling you what to do. Run `doctor --fix` to auto-repair what it can.

### Unit tests

422 tests covering the full pipeline — triage, dispatch, audit, planning, notifications, and infrastructure:

```bash
cd ~/claw-extensions/linear
npx vitest run                   # Run all tests
npx vitest run --reporter=verbose  # See every test name
npx vitest run src/pipeline/     # Just pipeline tests
```

### UAT (live integration tests)

The UAT script runs against your real Linear workspace. It creates actual issues, triggers the pipeline, and verifies the results.

```bash
# Run all UAT scenarios
npx tsx scripts/uat-linear.ts

# Run a specific scenario
npx tsx scripts/uat-linear.ts --test dispatch
npx tsx scripts/uat-linear.ts --test planning
npx tsx scripts/uat-linear.ts --test mention
```

**What each scenario does:**

#### `--test dispatch` (Single issue, full pipeline)

1. Creates a test issue in Linear
2. Assigns it to the agent
3. Waits for the dispatch comment (confirms the agent picked it up)
4. Waits for the audit result (pass, fail, or escalation)
5. Reports success/failure with timing

**Expected output:**

```
[dispatch] Created issue ENG-200: "UAT: simple config tweak"
[dispatch] Assigned to agent — waiting for dispatch comment...
[dispatch] ✔ Dispatch confirmed (12s) — assessed as junior
[dispatch] Waiting for audit result...
[dispatch] ✔ Audit passed (94s) — issue marked done
[dispatch] Total: 106s
```

#### `--test planning` (Project planning flow)

1. Creates a root issue in a test project
2. Posts `plan this project` comment
3. Waits for the planner's welcome message
4. Posts feature requirements
5. Waits for the planner to create issues
6. Posts `finalize plan`
7. Waits for plan approval or failure

**Expected output:**

```
[planning] Created project "UAT Planning Test"
[planning] Posted "plan this project" — waiting for welcome...
[planning] ✔ Welcome received (8s)
[planning] Posted feature description — waiting for response...
[planning] ✔ Planner created 3 issues (15s)
[planning] Posted "finalize plan" — waiting for audit...
[planning] ✔ Plan approved (6s) — 3 issues queued for dispatch
[planning] Total: 29s
```

#### `--test mention` (Agent routing)

1. Creates a test issue
2. Posts a comment mentioning a specific agent (e.g., `@kaylee`)
3. Waits for that agent to respond
4. Verifies the response came from the right agent

**Expected output:**

```
[mention] Created issue ENG-201
[mention] Posted "@kaylee analyze this issue"
[mention] ✔ Kaylee responded (18s)
[mention] Total: 18s
```

### Verify notifications

```bash
openclaw openclaw-linear notify test              # Send test to all targets
openclaw openclaw-linear notify test --channel discord  # Test one channel
openclaw openclaw-linear notify status             # Show what's configured
```

### Verify prompts

```bash
openclaw openclaw-linear prompts validate   # Check for template errors
openclaw openclaw-linear prompts show       # View the active prompts
```

---

## CLI Reference

```bash
# Auth & status
openclaw openclaw-linear auth                      # Run OAuth flow
openclaw openclaw-linear status                    # Check connection

# Worktrees
openclaw openclaw-linear worktrees                 # List active worktrees
openclaw openclaw-linear worktrees --prune <path>  # Remove a worktree

# Multi-repo
openclaw openclaw-linear repos check               # Validate paths, preview labels
openclaw openclaw-linear repos sync                # Create missing repo: labels in Linear

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
