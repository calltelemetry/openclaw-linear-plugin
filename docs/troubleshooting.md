# Troubleshooting

Something not working? Start here. Most problems have simple fixes.

---

## Quick Health Check

```bash
systemctl --user status openclaw-gateway        # Gateway running?
openclaw openclaw-linear status                  # Token valid?
openclaw doctor                                  # Config valid?
journalctl --user -u openclaw-gateway -f         # Live logs
linearis issues list -l 1                        # linearis auth working?
openclaw openclaw-linear prompts validate        # Prompts valid?
```

---

## Doctor Command

The plugin has a built-in health checker that diagnoses most problems automatically:

```bash
openclaw openclaw-linear doctor            # Run all checks
openclaw openclaw-linear doctor --fix      # Auto-fix safe issues (stale locks, old dispatches)
openclaw openclaw-linear doctor --json     # Machine-readable output
```

It checks 6 areas:

| Check | What it looks for |
|-------|-------------------|
| **Auth** | Token exists, not expired, Linear API responds |
| **Agent Config** | Default agent set, no duplicate mention aliases |
| **Files & Config** | Dispatch state readable, prompts valid, permissions correct |
| **Connectivity** | Gateway reachable, webhook endpoint responds, tunnel working |
| **Dispatch Health** | No stale dispatches, no stuck issues older than threshold |
| **Coding Tools** | CLI binaries found in PATH (claude, codex, gemini) |

If something's wrong, doctor tells you exactly what and how to fix it. Run this first before digging into logs.

---

## Service Status

```bash
# Gateway service
systemctl --user status openclaw-gateway
systemctl --user restart openclaw-gateway

# View logs (live tail)
journalctl --user -u openclaw-gateway -f

# View recent logs
journalctl --user -u openclaw-gateway --since "10 min ago" --no-pager

# Filter for errors only
journalctl --user -u openclaw-gateway --since "1 hour ago" | grep -iE 'error|fail|crash|panic'

# Check service config
systemctl --user show openclaw-gateway | grep -E 'Environment|ExecStart|Active'
```

---

## Token & Auth

```bash
# Check token status
openclaw openclaw-linear status

# Check which token profiles exist
cat ~/.openclaw/auth-profiles.json | jq '.profiles | keys'

# Check token expiry (human-readable)
cat ~/.openclaw/auth-profiles.json | \
  jq -r '.profiles["linear:default"].expiresAt' | \
  xargs -I{} date -d @$(echo "{} / 1000" | bc)

# Test Linear API directly
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {OAUTH_TOKEN}" \
  -d '{"query":"{ viewer { id name email } }"}' | jq .

# Re-authorize if tokens are stale
openclaw openclaw-linear auth
systemctl --user restart openclaw-gateway
```

---

## Webhook Testing

```bash
# Ping test (should return "ok")
curl -s -X POST http://localhost:18789/linear/webhook \
  -H "Content-Type: application/json" \
  -d '{"type":"test","action":"ping"}'

# Test through tunnel
curl -s -X POST https://your-domain.com/linear/webhook \
  -H "Content-Type: application/json" \
  -d '{"type":"test","action":"ping"}' \
  -w "\nHTTP %{http_code}\n"

# Simulate Comment.create with @mention
curl -s -X POST http://localhost:18789/linear/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "type": "Comment",
    "action": "create",
    "data": {
      "id": "test-comment-id",
      "body": "@mal what is the status?",
      "user": { "name": "Tester" },
      "issue": { "id": "test-issue-id", "identifier": "UAT-999", "title": "Test Issue" }
    }
  }'

# Simulate AgentSessionEvent.created
curl -s -X POST http://localhost:18789/linear/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "type": "AgentSessionEvent",
    "action": "created",
    "agentSession": {
      "id": "test-session-id",
      "issue": { "id": "test-issue", "identifier": "UAT-100", "title": "Test" }
    }
  }'

# Watch webhook arrivals in logs
journalctl --user -u openclaw-gateway -f | grep -i "webhook\|Linear"
```

---

## Watchdog & Timeouts

```bash
# Check if watchdog is firing
journalctl --user -u openclaw-gateway --since "30 min ago" | grep -i "watchdog"

# Look for specific watchdog kills
journalctl --user -u openclaw-gateway --since "1 hour ago" | grep "Watchdog KILL"

# Check watchdog config for a specific agent
cat ~/.openclaw/agent-profiles.json | jq '.agents.zoe.watchdog'

# Check .claw/ artifact logs for watchdog events
cat /path/to/worktree/.claw/log.jsonl | jq 'select(.phase == "watchdog")'

# Check all .claw/ logs for a dispatch
cat /path/to/worktree/.claw/log.jsonl | jq .

# Check dispatch manifest
cat /path/to/worktree/.claw/manifest.json | jq .
```

### Watchdog Tuning

If agents are being killed too aggressively, increase `inactivitySec` in the agent profile:

```json
{
  "agents": {
    "coder": {
      "watchdog": {
        "inactivitySec": 300,
        "maxTotalSec": 7200,
        "toolTimeoutSec": 900
      }
    }
  }
}
```

If agents are hanging too long before being killed, decrease it. Restart the gateway after changing profiles.

---

## Tunnel & Proxy

```bash
# Cloudflare tunnel status
systemctl status cloudflared

# Tunnel config
cat /etc/cloudflared/config.yml 2>/dev/null || cat ~/.cloudflared/config.yml

# Check listening ports
ss -tlnp | grep -E '1878[09]'

# Verify DNS resolves to tunnel
dig +short your-subdomain.yourdomain.com CNAME

# Test gateway directly (bypassing tunnel)
curl -s -o /dev/null -w "HTTP %{http_code}\n" \
  http://localhost:18789/linear/webhook \
  -X POST -H "Content-Type: application/json" -d '{}'
```

---

## Agent Profiles

```bash
# List configured agents
cat ~/.openclaw/agent-profiles.json | jq '.agents | keys'

# Find the default agent
cat ~/.openclaw/agent-profiles.json | jq '.agents | to_entries[] | select(.value.isDefault) | .key'

# List all mention aliases
cat ~/.openclaw/agent-profiles.json | \
  jq '[.agents | to_entries[] | {agent: .key, aliases: .value.mentionAliases}]'

# List all watchdog configs
cat ~/.openclaw/agent-profiles.json | \
  jq '[.agents | to_entries[] | {agent: .key, watchdog: .value.watchdog}]'
```

---

## Dispatch State

```bash
# View active dispatches
cat ~/.openclaw/linear-dispatch-state.json | jq '.dispatches.active'

# View completed dispatches
cat ~/.openclaw/linear-dispatch-state.json | jq '.dispatches.completed'

# View session mappings
cat ~/.openclaw/linear-dispatch-state.json | jq '.sessionMap'

# Count processed events
cat ~/.openclaw/linear-dispatch-state.json | jq '.processedEvents | length'
```

---

## Planning State

```bash
# View active planning sessions
cat ~/.openclaw/linear-planning-state.json | jq '.sessions'

# Check a specific project's planning status
cat ~/.openclaw/linear-planning-state.json | jq '.sessions["<projectId>"]'

# View project dispatch state (after plan approved)
cat ~/.openclaw/linear-planning-state.json | jq '.projectDispatches["<projectId>"]'

# Check which issues are pending/dispatched/done/stuck in a project
cat ~/.openclaw/linear-planning-state.json | jq '.projectDispatches["<projectId>"].issues | to_entries[] | {identifier: .key, status: .value.dispatchStatus}'
```

### Common Planning Issues

| Symptom | Cause | Fix |
|---|---|---|
| "This project is in planning mode" | Dispatch blocked during active planning | Finalize or abandon the plan first |
| Plan audit keeps failing | Issues missing descriptions, estimates, or priorities | Check audit feedback comment for specifics |
| Planning session stuck | No recent turns, session abandoned | Post "cancel planning" on the root issue |
| Project dispatch stuck | One issue stuck, blocking dependents | Check stuck issue's `.claw/log.jsonl`, re-assign to retry |

---

## Config Validation

```bash
# Validate gateway config (catches unrecognized keys that cause crashes)
openclaw doctor --fix

# Check plugin entries
cat ~/.openclaw/openclaw.json | jq '.plugins'

# Check agent definitions
cat ~/.openclaw/openclaw.json | jq '.agents | keys'

# Check systemd environment
systemctl --user show openclaw-gateway | grep Environment
```

---

## Process & Port Inspection

```bash
# Show all related processes
ps aux | grep -E 'openclaw|cloudflared'

# Check for port conflicts
ss -tlnp | grep -E '1878[09]'

# Check for TIME_WAIT sockets (can prevent restart)
ss -tan | grep -E '1878[09]' | grep TIME-WAIT

# Last 50 lines of gateway logs
journalctl --user -u openclaw-gateway -n 50 --no-pager
```

---

## Multi-Repo Dispatch

```bash
# Check if multi-repo is being detected
journalctl --user -u openclaw-gateway --since "10 min ago" | grep -i "multi-repo\|resolveRepos"

# Verify repos config
cat ~/.openclaw/openclaw.json | jq '.plugins.entries["openclaw-linear"].config.repos'

# Check worktree parent directory
ls -la ~/.openclaw/worktrees/
```

Common issues:
- Issue body markers not detected → must be `<!-- repos: name1, name2 -->` (HTML comment) or `[repos: name1, name2]`
- Labels not matching → labels must be exactly `repo:name` (lowercase, no spaces)
- Repo path doesn't exist → check that all paths in `repos` config point to valid git repos
- Worktree creation fails → check git permissions and that the base branch exists

---

## Dispatch Management

```bash
# List active dispatches via slash command
# (In an agent session, type: /dispatch list)

# Check dispatch state directly
cat ~/.openclaw/linear-dispatch-state.json | jq '.dispatches.active | keys'

# Retry a stuck dispatch via gateway RPC
# (dispatch.retry method via gateway API)

# Check dispatch history/memory files
ls ~/.openclaw/workspace/memory/dispatch-*.md
```

Common issues:
- `/dispatch` command not found → restart gateway, check plugin loaded
- `dispatch.retry` not working → dispatch must be in `stuck` status
- Dispatch history empty → memory files are only written after dispatch completes

---

## Rich Notifications

```bash
# Check notification config
cat ~/.openclaw/openclaw.json | jq '.plugins.entries["openclaw-linear"].config.notifications'

# Test notifications
openclaw openclaw-linear notify test

# Check for notification failures in logs
journalctl --user -u openclaw-gateway --since "30 min ago" | grep -i "notify\|notification"
```

Common issues:
- No rich embeds → set `"richFormat": true` in notifications config
- Discord embeds not showing → bot needs "Embed Links" permission in the channel
- Telegram HTML broken → check the bot token and chat ID are correct

---

## Gateway RPC

```bash
# List available methods
# Methods: dispatch.list, dispatch.get, dispatch.retry, dispatch.escalate, dispatch.cancel, dispatch.stats

# Check if methods are registered
journalctl --user -u openclaw-gateway --since "5 min ago" | grep -i "dispatch\."
```

---

## Common Issues

| Symptom | Cause | Fix |
|---|---|---|
| Agent goes silent, eventually killed | LLM provider timeout or rate limit | Watchdog handles this automatically. Check `inactivitySec` config if kill is too fast/slow. |
| Dispatch stuck after watchdog kill | Both retry attempts failed | Check `.claw/log.jsonl` for watchdog entries. Re-assign issue to restart. |
| `token: missing` in logs | No token in env or auth profile | Run `openclaw openclaw-linear auth` or set `LINEAR_API_KEY` |
| `Unrecognized key` crash | Custom keys in `plugins.entries` | Remove the key -- use env vars or auth profile store. Plugin entries only accept `enabled`. |
| Webhook returns 405 | GET request to webhook endpoint | Webhooks must be POST |
| 502 through tunnel | Gateway not running | Check `ss -tlnp \| grep 1878`, restart gateway |
| Agent not responding to @mentions | Missing `mentionAliases` | Add aliases to `~/.openclaw/agent-profiles.json` |
| Duplicate responses | Both webhooks firing for same event | Dedup handles this; check webhook event subscriptions aren't overlapping |
| `AgentSession.created missing session` | Payload structure mismatch | Linear uses `AgentSessionEvent`/`created`, NOT `AgentSession`/`create` |
| OAuth 401 errors | Token expired, refresh failed | Re-run `openclaw openclaw-linear auth` |
| `No defaultAgentId` error | No agent marked `isDefault` | Set `"isDefault": true` on one agent in agent-profiles.json |
| Agent timeout (wall-clock) | Session exceeded `maxTotalSec` | Increase `maxTotalSec` in agent profile or plugin config |
| `code_run` killed by watchdog | CLI hung with no output | Check CLI binary availability. Increase `toolTimeoutSec` if legitimate slow operations. |
| OAuth callback 501/502 | Tunnel routing issue | Verify tunnel config routes to gateway port |
| Port "Address already in use" | TIME_WAIT sockets | Wait 60s, or check with `ss -tan \| grep TIME-WAIT` |
| Planning session not responding | Session expired or abandoned | Post "cancel planning" and start fresh |
| Project issues not dispatching after plan approval | DAG dependencies blocking | Check project dispatch state — earlier issues may be stuck |
| Doctor says "stale dispatch" | Dispatch inactive >2h | Run `openclaw openclaw-linear doctor --fix` to auto-clean |
| Multi-repo not detected | Wrong marker format | Use `<!-- repos: api, frontend -->` in issue body |
| `/dispatch` not responding | Plugin not loaded | Restart gateway, check `openclaw doctor` |
| Rich notifications plain text | `richFormat` not enabled | Add `"richFormat": true` to notifications config |
| Gateway RPC returns error | Dispatch not in expected status | Check dispatch state — retry requires `stuck` status |
| Dispatch history empty | No completed dispatches | Memory files written only after dispatches complete |
