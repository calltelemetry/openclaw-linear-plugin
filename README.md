# Linear Agent Plugin for OpenClaw

Webhook-driven Linear integration with OAuth support, multi-agent routing, and a 3-stage AI pipeline for issue triage and implementation.

## What It Does

- **Issue triage** — When an issue is assigned/delegated to the app user, an agent estimates story points, applies labels, and posts an assessment
- **Agent sessions** — Full plan-approve-implement-audit pipeline triggered from Linear's agent UI
- **@mention routing** — Comment mentions like `@qa` or `@infra` route to specific role-based agents with different expertise
- **App notifications** — Responds to Linear app mentions and assignments via branded comments
- **Activity tracking** — Emits thought/action/response events visible in Linear's agent session UI

## Quick Install

```bash
openclaw plugins install @calltelemetry/openclaw-linear
openclaw gateway restart
```

That's it — the plugin is installed and enabled. Continue with the [setup steps](#setup) below to configure Linear OAuth and webhooks.

> To install from a local checkout instead: `openclaw plugins install --link /path/to/linear`

## Prerequisites

- OpenClaw gateway running (systemd service)
- A Linear workspace with API access
- A Linear OAuth application (Settings > API > Applications)
- A public URL for webhook delivery (e.g., Cloudflare tunnel)

## Setup

### 1. Create a Linear OAuth Application

1. Go to **Linear Settings > API > Applications**
2. Click **Create new application**
3. Fill in:
   - **Application name:** your agent's name
   - **Redirect URI:** `https://<your-domain>/linear/oauth/callback`
   - **Webhook URL:** `https://<your-domain>/linear/webhook`
4. Note the **Client ID** and **Client Secret**
5. Enable the webhook events you need (Agent Sessions, Issues)

### 2. Create a Workspace Webhook

Separately from the OAuth app, create a workspace-level webhook:

1. Go to **Linear Settings > API > Webhooks**
2. Create a new webhook pointing to `https://<your-domain>/linear/webhook`
3. Enable these event types: **Comment**, **Issue**, **User**

> **Why two webhooks?** The OAuth app webhook handles `AgentSessionEvent` and `AppUserNotification` events (agent-specific). The workspace webhook handles `Comment` and `Issue` events (workspace-wide). Both must point to the same URL — the plugin routes internally.

### 3. Expose the Gateway via Cloudflare Tunnel

The OpenClaw gateway listens on `localhost:<port>` (default `18789`). Linear must reach it over HTTPS to deliver webhooks. A [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) is the recommended approach — no open inbound ports, no self-managed TLS.

#### Install `cloudflared`

```bash
# RHEL / Rocky / Alma
sudo dnf install -y cloudflared

# Debian / Ubuntu
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install -y cloudflared

# macOS
brew install cloudflare/cloudflare/cloudflared
```

#### Authenticate with Cloudflare

```bash
cloudflared tunnel login
```

This opens your browser to Cloudflare's authorization page. You must:

1. Log in to your Cloudflare account
2. **Select the domain** (zone) you want the tunnel to use (e.g., `yourdomain.com`)
3. Click **Authorize**

Cloudflare writes an origin certificate to `~/.cloudflared/cert.pem`. This certificate grants `cloudflared` permission to create tunnels and DNS records under that domain. Without it, tunnel creation will fail.

#### Create a tunnel

```bash
cloudflared tunnel create openclaw
```

This outputs a **Tunnel ID** (a UUID like `da1f21bf-856e-...`) and writes a credentials file to `~/.cloudflared/<TUNNEL_ID>.json`.

#### Create a DNS subdomain for the tunnel

```bash
cloudflared tunnel route dns openclaw linear.yourdomain.com
```

This creates a **CNAME record** in your Cloudflare DNS:

```
linear.yourdomain.com  CNAME  <TUNNEL_ID>.cfargotunnel.com
```

You can verify it in the Cloudflare dashboard under **DNS > Records** for your domain. The subdomain (`linear.yourdomain.com`) is what Linear will use for webhook delivery and OAuth callbacks.

> **Important:** Your domain must already be on Cloudflare (nameservers pointed to Cloudflare). If it's not, add it in the Cloudflare dashboard first.

#### Configure the tunnel

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL_ID>
credentials-file: /home/<user>/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: linear.yourdomain.com
    service: http://localhost:18789
  - service: http_status:404
```

The `ingress` rule routes all traffic for your subdomain to the OpenClaw gateway on localhost. The catch-all `http_status:404` rejects requests for any other hostname.

#### Run as a systemd service

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

This installs a system-level service that starts on boot. To test without installing:

```bash
cloudflared tunnel run openclaw
```

#### Verify end-to-end

```bash
curl -s https://linear.yourdomain.com/linear/webhook \
  -X POST -H "Content-Type: application/json" \
  -d '{"type":"test","action":"ping"}'
# Should return: "ok"
```

> **Note:** The hostname you choose here (`linear.yourdomain.com`) is what you'll use for the OAuth redirect URI and both webhook URLs in Linear. Make sure they all match.

### 4. Set Environment Variables

Required:
```bash
export LINEAR_CLIENT_ID="your_client_id"
export LINEAR_CLIENT_SECRET="your_client_secret"
```

Optional:
```bash
export LINEAR_REDIRECT_URI="https://your-domain.com/linear/oauth/callback"
export OPENCLAW_GATEWAY_PORT="18789"  # if non-default
```

### 5. Install the Plugin

If you haven't already installed via [Quick Install](#quick-install):

```bash
openclaw plugins install @calltelemetry/openclaw-linear
openclaw gateway restart
```

This registers the plugin in your OpenClaw config and restarts the gateway to load it.

<details>
<summary>Manual config (advanced)</summary>

If you prefer to manage config by hand, add the plugin path to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "load": {
      "paths": ["/path/to/linear"]
    },
    "entries": {
      "linear": {
        "enabled": true
      }
    }
  }
}
```

Then restart: `openclaw gateway restart`
</details>

### 6. Run the OAuth Flow

There are two ways to authorize the plugin with Linear.

#### Option A: CLI Flow (Recommended)

```bash
openclaw auth linear oauth
```

This launches the OAuth flow interactively:

1. The plugin constructs the authorization URL with the required scopes
2. Your browser opens to Linear's authorization page
3. You approve the permissions
4. Linear redirects to the callback URL with an authorization code
5. The plugin exchanges the code for access + refresh tokens
6. Tokens are stored in `~/.openclaw/auth-profiles.json`

#### Option B: Manual URL

If the CLI flow doesn't work (headless server, tunnel issues), construct the URL yourself:

```
https://linear.app/oauth/authorize
  ?client_id=YOUR_CLIENT_ID
  &redirect_uri=https://your-domain.com/linear/oauth/callback
  &response_type=code
  &scope=read,write,app:assignable,app:mentionable
  &state=random_string
  &actor=app
```

Key parameters:

| Parameter | Value | Why |
|---|---|---|
| `scope` | `read,write,app:assignable,app:mentionable` | `app:assignable` lets the agent appear in assignment menus. `app:mentionable` lets users @mention the agent. |
| `actor` | `app` | Makes the token act as the **application identity**, not a personal user. Agent sessions require this. |
| `redirect_uri` | Your callback URL | Must match what you registered in the OAuth app settings. |

Click the URL, authorize in Linear, and the callback handler at `/linear/oauth/callback` will exchange the code and store the tokens automatically.

#### What Gets Stored

After a successful OAuth flow, `~/.openclaw/auth-profiles.json` will contain:

```json
{
  "version": 1,
  "profiles": {
    "linear:default": {
      "type": "oauth",
      "provider": "linear",
      "accessToken": "...",
      "refreshToken": "...",
      "expiresAt": 1708109280000,
      "scope": "app:assignable app:mentionable read write"
    }
  }
}
```

This file should be `chmod 600` (owner-only). The plugin auto-refreshes tokens 60 seconds before expiry and persists the new tokens back to this file.

### 7. Configure Agent Profiles

Create `~/.openclaw/agent-profiles.json` to define role-based agents:

```json
{
  "agents": {
    "lead": {
      "label": "Lead",
      "mission": "Product owner. Sets direction, makes scope decisions, prioritizes backlog.",
      "isDefault": true,
      "mentionAliases": ["lead", "product"],
      "appAliases": ["myagent"],
      "avatarUrl": "https://example.com/lead-avatar.png"
    },
    "qa": {
      "label": "QA",
      "mission": "Test engineer. Quality guardian, test strategy, release confidence.",
      "mentionAliases": ["qa", "tester"]
    },
    "infra": {
      "label": "Infra",
      "mission": "Backend and infrastructure engineer. Performance, reliability, observability.",
      "mentionAliases": ["infra", "backend"]
    },
    "ux": {
      "label": "UX",
      "mission": "User experience advocate. Accessibility, user journeys, pain points.",
      "mentionAliases": ["ux", "design"]
    },
    "docs": {
      "label": "Docs",
      "mission": "Technical writer. Setup guides, API references, release notes.",
      "mentionAliases": ["docs", "writer"]
    }
  }
}
```

| Field | Required | Description |
|---|---|---|
| `label` | Yes | Display name in Linear comments |
| `mission` | Yes | Agent's role description (injected as system context when the agent is dispatched) |
| `isDefault` | One agent | The default agent handles OAuth app events, agent sessions, and assignment triage |
| `mentionAliases` | Yes | @mention triggers in comments (e.g., `@qa` in a comment routes to the QA agent) |
| `appAliases` | No | Triggers via OAuth app webhook (default agent only, for app-level @mentions) |
| `avatarUrl` | No | Avatar displayed on branded comments. Falls back to `[Label]` prefix if not set. |

#### How agent-profiles.json connects to openclaw.json

Each key in `agent-profiles.json` (e.g., `"lead"`, `"qa"`) must have a matching agent definition in your OpenClaw config (`~/.openclaw/openclaw.json`). The Linear plugin dispatches work via `openclaw agent --agent <id>`, so the agent must actually exist.

Example — if `agent-profiles.json` defines `"lead"` and `"qa"`, your `openclaw.json` needs:

```json
{
  "agents": {
    "lead": {
      "model": "claude-sonnet-4-5-20250929",
      "systemPrompt": "You are a product lead agent...",
      "tools": ["linear_list_issues", "linear_create_issue", "linear_add_comment"]
    },
    "qa": {
      "model": "claude-sonnet-4-5-20250929",
      "systemPrompt": "You are a QA engineer agent...",
      "tools": ["linear_list_issues", "linear_add_comment"]
    }
  }
}
```

#### Routing flow

```
Linear comment "@qa review this test plan"
  → Plugin matches "qa" in mentionAliases
  → Looks up agent-profiles.json → finds "qa" profile
  → Dispatches: openclaw agent --agent qa --message "<issue context + comment>"
  → OpenClaw loads "qa" agent config from openclaw.json
  → Agent runs with the qa profile's mission as context
  → Response posted back to Linear as a branded comment with qa's label/avatar
```

For agent sessions (triggered by the Linear agent UI or app @mentions):

```
Linear AgentSessionEvent.created
  → Plugin resolves the default agent (isDefault: true)
  → Runs the 3-stage pipeline (plan → implement → audit)
  → Each stage dispatches via the default agent's openclaw.json config
```

#### What happens if they don't match

- **Agent profile exists but no matching openclaw.json agent:** The dispatch fails and an error is logged. The webhook returns 200 (Linear requirement) but no comment is posted.
- **openclaw.json agent exists but no profile:** The agent works for direct CLI use but won't be reachable from Linear. No @mention alias maps to it.
- **No agent marked `isDefault`:** Agent sessions and assignment triage will fail with `"No defaultAgentId"` error.

### 8. Verify

```bash
openclaw gateway restart
openclaw logs | grep -i linear
# Should show: "Linear agent extension registered (agent: default, token: profile)"
```

Test the webhook is reachable:
```bash
curl -s -X POST https://your-domain.com/linear/webhook \
  -H "Content-Type: application/json" \
  -d '{"type":"test","action":"ping"}'
# Should return: "ok"
```

## How It Works

### Token Resolution

The plugin resolves an OAuth token from:

1. Plugin config `accessToken` (static, for testing)
2. Auth profile store `linear:default` (from the OAuth flow — this is the normal path)

OAuth is required. The plugin needs `app:assignable` and `app:mentionable` scopes to function — agent sessions, branded comments, assignment triage, and @mention routing all depend on the application identity that only OAuth provides.

### Webhook Event Routing

```
POST /linear/webhook
  |
  +-- AgentSessionEvent.created  --> 3-stage pipeline (plan -> implement -> audit)
  +-- AgentSessionEvent.prompted --> Resume pipeline (user approved plan)
  +-- AppUserNotification        --> Direct agent response to mention/assignment
  +-- Comment.create             --> Route @mention to role-based agent
  +-- Issue.update               --> Triage if assigned/delegated to app user
```

All handlers respond `200 OK` within 5 seconds (Linear requirement), then process asynchronously.

### Pipeline Stages

Triggered by `AgentSessionEvent.created`:

| Stage | Timeout | What It Does |
|---|---|---|
| **Planner** | 5 min | Analyzes issue, generates implementation plan, posts as comment, waits for approval |
| **Implementor** | 10 min | Follows the approved plan, makes changes, creates commits/PRs |
| **Auditor** | 5 min | Reviews implementation against plan, posts audit report |

The auditor stage can be disabled via plugin config: `"enableAudit": false`.

### Assignment Triage

When an issue is assigned or delegated to the app user:

1. Fetches full issue details and available team labels
2. Dispatches the default agent with a triage prompt
3. Agent returns JSON with story point estimate and label IDs
4. Plugin applies the estimate and labels to the issue
5. Posts the assessment as a branded comment

### @Mention Routing

When a comment contains `@qa`, `@infra`, or any configured `mentionAliases`:

1. Plugin matches the alias to an agent profile
2. Reacts with eyes emoji to acknowledge
3. Fetches full issue context (description, recent comments, labels, state)
4. Dispatches the matched agent with the comment context
5. Posts the agent's response as a branded comment on the issue

The default agent's `mentionAliases` are excluded from comment routing — the default agent is reached via `appAliases` through the OAuth app webhook instead.

### Comment Deduplication

Webhook events are deduplicated for 60 seconds using a key based on:
- Comment ID (for `Comment.create`)
- Session ID (for `AgentSessionEvent`)
- Assignment tuple (for `Issue.update`)

## Plugin Config Schema

Optional settings in `openclaw.json` under the plugin entry:

```json
{
  "plugins": {
    "entries": {
      "linear": {
        "enabled": true,
        "clientId": "...",
        "clientSecret": "...",
        "redirectUri": "...",
        "accessToken": "...",
        "defaultAgentId": "...",
        "enableAudit": true
      }
    }
  }
}
```

All fields are optional — environment variables and auth profiles are the preferred configuration method.

## HTTP Routes

| Route | Method | Purpose |
|---|---|---|
| `/linear/webhook` | POST | Primary webhook endpoint |
| `/hooks/linear` | POST | Backward-compatible webhook endpoint |
| `/linear/oauth/callback` | GET | OAuth authorization callback |

## Agent Tools

Agents have access to these Linear tools during execution:

| Tool | Description |
|---|---|
| `linear_list_issues` | List issues (with optional team filter) |
| `linear_create_issue` | Create a new issue |
| `linear_add_comment` | Add a comment to an issue |

## File Structure

```
linear/
├── index.ts              # Entry point, registers routes and provider
├── openclaw.plugin.json  # Plugin metadata and config schema
├── package.json          # Package definition (zero runtime deps)
├── README.md
└── src/
    ├── agent.ts          # Agent dispatch via openclaw CLI
    ├── auth.ts           # OAuth provider registration and token refresh
    ├── client.ts         # Basic GraphQL client (for agent tools)
    ├── linear-api.ts     # Full GraphQL API wrapper (LinearAgentApi)
    ├── oauth-callback.ts # OAuth callback handler
    ├── pipeline.ts       # 3-stage pipeline (plan -> implement -> audit)
    ├── tools.ts          # Agent tools (list, create, comment)
    ├── webhook.ts        # Webhook dispatcher (5 event handlers)
    └── webhook.test.ts   # Tests (vitest)
```

## Troubleshooting

**Plugin not loading:**
```bash
openclaw doctor --fix
openclaw logs | grep -i "linear\|plugin\|error"
```

**Webhook not receiving events:**
- Verify both webhooks (workspace + OAuth app) point to the same URL
- Check that your tunnel/proxy is forwarding to the gateway port
- Linear requires `200 OK` within 5 seconds — check for gateway latency

**Agent sessions not working:**
- OAuth tokens require `app:assignable` and `app:mentionable` scopes
- Personal API keys cannot create agent sessions — use OAuth
- Re-run `openclaw auth linear oauth` to get fresh tokens

**"No defaultAgentId" error:**
- Set `defaultAgentId` in plugin config, OR
- Mark one agent as `"isDefault": true` in `agent-profiles.json`

**Token refresh failures:**
- Ensure `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET` are set
- Check that the refresh token in `auth-profiles.json` hasn't been revoked
- Re-run the OAuth flow to get new tokens

**OAuth callback not working:**
- Verify the redirect URI in Linear's app settings matches your gateway URL
- If behind a reverse proxy, ensure `X-Forwarded-Proto` and `Host` headers are forwarded
- For local dev, the callback defaults to `http://localhost:<gateway-port>/linear/oauth/callback`
