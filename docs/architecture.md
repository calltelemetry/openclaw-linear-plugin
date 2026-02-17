# Architecture

Internal reference for developers and maintainers of the Linear agent plugin.

## System Topology

```
                          Linear App
                       (OAuth App Webhook)
                             |
                             | HTTPS POST
                             v
                    ┌─────────────────┐
                    │   Cloudflare    │
                    │   Tunnel        │
                    │ (cloudflared)   │
                    └────────┬────────┘
                             |
                 linear.yourdomain.com
                             |
                             v
                    ┌─────────────────┐
                    │   Auth Proxy    │
                    │ (linear-proxy)  │
                    │   :18790        │
                    │  Adds Bearer    │
                    │  auth header    │
                    └────────┬────────┘
                             |
                             v
                    ┌─────────────────┐
                    │   OpenClaw      │
                    │   Gateway       │
                    │   :18789        │
                    └────────┬────────┘
                             |
              ┌──────────────┼──────────────┐
              |              |              |
              v              v              v
     /linear/webhook   /linear/oauth   /hooks/linear
     (primary route)   /callback        (back-compat)
              |
              v
     ┌─────────────────┐
     │  Webhook Router  │
     │  (webhook.ts)    │
     └────────┬─────────┘
              |
    ┌─────────┼──────────┬──────────────┬──────────────┐
    v         v          v              v              v
 AgentSess  Comment   Issue.update   Issue.create   AppUser
 Event      .create   (assign/       (auto-triage)  Notification
 (pipeline) (@mention  delegate)
             routing)
```

## Webhook Event Types

All events arrive via the OAuth app webhook. The router dispatches by `payload.type`:

```
POST /linear/webhook
  |
  +-- AgentSessionEvent.created  --> 3-stage pipeline (plan -> implement -> audit)
  +-- AgentSessionEvent.prompted --> Resume pipeline (user approved plan)
  +-- AppUserNotification        --> Direct agent response to mention/assignment
  +-- Comment.create             --> Route @mention to role-based sub-agent
  +-- Issue.create               --> Auto-triage new issues (estimate, labels, priority)
  +-- Issue.update               --> Triage if assigned/delegated to app user
```

All handlers respond `200 OK` within 5 seconds (Linear requirement), then process asynchronously.

**Payload structure differences:**
- Workspace events: `type=Comment action=create`, data at `payload.data`
- OAuth app events: `type=AgentSessionEvent action=created`, session at `payload.agentSession`, also has `previousComments`, `guidance`, `promptContext`
- Important: the actual values are `AgentSessionEvent`/`created`, NOT `AgentSession`/`create`

## Pipeline Stages

```
AgentSessionEvent.created
         |
         | respond 200 within 5s
         | emit "thought" within 10s
         v
  ┌──────────────┐
  │  Stage 1:    │
  │  PLANNER     │  5 min timeout
  │              │  Reads issue context
  │              │  Emits "action" activities
  │              │  Posts plan as Linear comment
  │              │  Emits "elicitation" (asks for approval)
  └──────┬───────┘
         |
         | user replies → AgentSessionEvent.prompted
         v
  ┌──────────────┐
  │  Stage 2:    │
  │  IMPLEMENTOR │  10 min timeout
  │              │  Executes approved plan
  │              │  Writes code, creates commits
  │              │  Creates PR if needed
  └──────┬───────┘
         |
         v
  ┌──────────────┐
  │  Stage 3:    │
  │  AUDITOR     │  5 min timeout
  │              │  Reviews implementation vs plan
  │              │  Posts audit summary
  │              │  Emits "response" (closes session)
  └──────────────┘
```

## @Mention Routing Flow

```
Linear comment "@qa review this test plan"
  → Plugin matches "qa" in mentionAliases
  → Looks up agent-profiles.json → finds "qa" profile
  → Dispatches: openclaw agent --agent qa --message "<context>"
  → OpenClaw loads "qa" agent config from openclaw.json
  → Agent runs with the qa profile's mission as context
  → Response posted back to Linear as branded comment
```

For agent sessions (triggered by the Linear agent UI or app @mentions):

```
Linear AgentSessionEvent.created
  → Plugin resolves the default agent (isDefault: true)
  → Runs the 3-stage pipeline (plan → implement → audit)
  → Each stage dispatches via the default agent's openclaw.json config
```

## OAuth Flow

```
  User                   Gateway                    Linear
   |                        |                          |
   |  Browser opens         |                          |
   |  auth URL with         |                          |
   |  actor=app scope       |                          |
   |  ──────────────────────────────────────────────> |
   |                        |                          |
   |  Approve permissions   |                          |
   |  <─────────────────────────── redirect ─────── |
   |                        |                          |
   |  GET /linear/oauth     |                          |
   |  /callback?code=xxx    |                          |
   |  ─────────────────────>|                          |
   |                        |  POST /oauth/token       |
   |                        |  code + client_id/secret |
   |                        |  ─────────────────────> |
   |                        |                          |
   |                        |  { access_token,         |
   |                        |    refresh_token,         |
   |                        |    expires_in, scope }    |
   |                        |  <───────────────────── |
   |                        |                          |
   |                        | Store in                 |
   |                        | auth-profiles.json       |
   |  "OAuth Complete"      |                          |
   |  <─────────────────────|                          |
```

## Token Resolution Priority

```
1. pluginConfig.accessToken (static — rarely used)
       │ not found
       v
2. ~/.openclaw/auth-profiles.json "linear:default"
   (OAuth token — preferred for agent scopes)
       │ not found
       v
3. LINEAR_ACCESS_TOKEN or LINEAR_API_KEY env var
   (personal key fallback — no agent session support)
       │ not found
       v
4. No token → warning logged, webhooks fail gracefully
```

**Auth header distinction:** OAuth tokens use `Bearer` prefix; personal API keys do not.

### Token Refresh

OAuth tokens expire (~24h). The `LinearAgentApi` auto-refreshes:

1. Before each API call, checks `expiresAt` with 60s buffer
2. Calls Linear's token endpoint with `grant_type=refresh_token`
3. Persists new tokens back to `~/.openclaw/auth-profiles.json`
4. On 401 response, forces refresh and retries once

## Triage System

On `Issue.update` (assignment/delegation) and `Issue.create`:

```
Issue assigned/created
      |
      v
  Fetch issue details + team labels (GraphQL)
      |
      v
  Dispatch default agent with triage prompt
      |
      v
  Agent returns JSON:
  { "estimate": 5, "labelIds": [...], "priority": 3, "assessment": "..." }
      |
      v
  Apply estimate, labels, priority via issueUpdate mutation
      |
      v
  Strip JSON block, post assessment as branded comment
```

## Deduplication

A 60-second sliding window prevents double-handling:

| Key Pattern | Prevents |
|---|---|
| `session:{id}` | Same AgentSession processed by both Issue.update and AgentSessionEvent |
| `comment:{id}` | Same comment webhook delivered twice |
| `assigned:{issueId}:{viewerId}` | Rapid re-assignment events |
| `delegated:{issueId}:{viewerId}` | Rapid re-delegation events |
| `issue-create:{id}` | Duplicate Issue.create webhooks |

## Branded Comments

Responses are posted back to Linear with agent branding:

1. **Primary:** `createAsUser` + `displayIconUrl` (shows as the agent's avatar/name)
2. **Fallback:** `**[AgentLabel]** response text` prefix if branding API fails

## Narration Guard

Catches short agent responses that narrate intent without acting (e.g., "Let me explore the codebase...") and appends a warning. Triggered on `message_sending` events for responses under 250 characters matching patterns like:

- `let me explore/look/investigate/check...`
- `I'll explore/look into/investigate...`

## Linear GraphQL API Reference

### Key Mutations

| Mutation | Purpose |
|---|---|
| `agentActivityCreate` | Emit thought/action/response/elicitation/error to agent session |
| `agentSessionUpdate` | Set external URLs, plan on a session |
| `agentSessionCreateOnIssue` | Create a new agent session on an issue |
| `commentCreate` | Post a comment (supports `createAsUser` + `displayIconUrl` branding) |
| `issueUpdate` | Update estimate, labels, priority, state |
| `reactionCreate` | React to a comment (e.g., eyes emoji to acknowledge) |

### Activity Types

| Type | When Used |
|---|---|
| `thought` | Agent is analyzing/reviewing (shown as thinking indicator) |
| `action` | Agent is performing a step (with action + parameter + result) |
| `response` | Final response (closes the agent session) |
| `elicitation` | Asking user for input (e.g., plan approval) |
| `error` | Something failed (shown as error state) |

## File Structure

```
linear/
├── index.ts              # Entry point — registers routes, tools, CLI, narration guard
├── openclaw.plugin.json  # Plugin metadata and config schema
├── package.json          # Package definition
├── README.md
├── docs/
│   ├── architecture.md   # This file — internals reference
│   └── troubleshooting.md  # Diagnostic commands, common issues
└── src/
    ├── agent.ts          # Agent dispatch via `openclaw agent` CLI
    ├── auth.ts           # OAuth provider registration + token refresh
    ├── cli.ts            # CLI commands: auth, status
    ├── client.ts         # Basic GraphQL client (used by agent tools)
    ├── linear-api.ts     # Full GraphQL API wrapper (LinearAgentApi) with auto-refresh
    ├── oauth-callback.ts # HTTP handler for OAuth redirect callback
    ├── pipeline.ts       # 3-stage pipeline (plan → implement → audit)
    ├── tools.ts          # Agent tools (list_issues, create_issue, add_comment)
    ├── webhook.ts        # Webhook dispatcher — 6 event handlers
    └── webhook.test.ts   # Vitest tests
```
