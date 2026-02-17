# @calltelemetry/openclaw-linear

An OpenClaw plugin that connects your Linear workspace to AI agents. Issues get triaged automatically, agents respond to @mentions, and a full plan-implement-audit pipeline runs when you assign work to the agent.

## Features

- **Auto-triage** — New issues get story point estimates, labels, and priority automatically
- **@mention routing** — `@qa`, `@infra`, `@docs` in comments route to specialized agents
- **Agent pipeline** — Assign an issue to the agent and it plans, implements, and audits the work
- **Branded replies** — Each agent posts with its own name and avatar in Linear
- **Real-time progress** — Agent activity (thinking, acting, responding) shows in Linear's UI

## How It Works

```
  Linear                  OpenClaw Gateway              AI Agents
    |                           |                          |
    |  Webhook (issue created)  |                          |
    |  ────────────────────────>|                          |
    |                           |  Dispatch triage agent   |
    |                           |  ───────────────────────>|
    |                           |                          |
    |                           |  Estimate + labels       |
    |                           |  <───────────────────────|
    |  Update issue             |                          |
    |  <────────────────────────|                          |
    |  Post assessment comment  |                          |
    |  <────────────────────────|                          |
```

```
  Linear                  OpenClaw Gateway              AI Agents
    |                           |                          |
    |  "@qa check this"         |                          |
    |  ────────────────────────>|                          |
    |                           |  Route to QA agent       |
    |                           |  ───────────────────────>|
    |                           |                          |
    |                           |  Response                |
    |                           |  <───────────────────────|
    |  Comment from "QA"        |                          |
    |  <────────────────────────|                          |
```

## Prerequisites

- **OpenClaw** gateway running (v2026.2+)
- **Linear** workspace with API access
- **Public URL** for webhook delivery (Cloudflare Tunnel recommended)

## Install

```bash
openclaw plugins install @calltelemetry/openclaw-linear
```

## Setup

### 1. Create a Linear OAuth App

Go to **Linear Settings > API > Applications** and create a new application:

- **Webhook URL:** `https://<your-domain>/linear/webhook`
- **Redirect URI:** `https://<your-domain>/linear/oauth/callback`
- Enable webhook events: **Agent Sessions**, **Comments**, **Issues**

Save the **Client ID** and **Client Secret**.

### 2. Set Credentials

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

### 3. Expose the Gateway

Linear needs to reach your gateway over HTTPS to deliver webhooks. A [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) is the recommended approach — no open ports, no TLS certificates to manage.

#### a. Install `cloudflared`

```bash
# RHEL / Rocky / Alma
sudo dnf install -y cloudflared

# Debian / Ubuntu
sudo apt install -y cloudflared

# macOS
brew install cloudflare/cloudflare/cloudflared
```

#### b. Authenticate with Cloudflare

```bash
cloudflared tunnel login
```

This opens your browser. Log in, select the domain you want to use, and click **Authorize**.

#### c. Create a tunnel

```bash
cloudflared tunnel create openclaw
```

Note the **Tunnel ID** (a UUID) from the output.

#### d. Point a subdomain at the tunnel

```bash
cloudflared tunnel route dns openclaw linear.yourdomain.com
```

This creates a DNS record so `linear.yourdomain.com` routes through the tunnel.

#### e. Configure the tunnel

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL_ID>
credentials-file: ~/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: linear.yourdomain.com
    service: http://localhost:18789
  - service: http_status:404
```

#### f. Start the tunnel

```bash
# Install as a system service (starts on boot)
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

To test without installing as a service:

```bash
cloudflared tunnel run openclaw
```

#### g. Verify the tunnel

```bash
curl -s https://linear.yourdomain.com/linear/webhook \
  -X POST -H "Content-Type: application/json" \
  -d '{"type":"test","action":"ping"}'
# Should return: "ok"
```

### 4. Authorize with Linear

```bash
openclaw openclaw-linear auth
```

This opens your browser to authorize the agent. The plugin needs these OAuth scopes:

| Scope | What it enables |
|---|---|
| `read` / `write` | Read and update issues, post comments |
| `app:assignable` | Agent appears in Linear's assignment menus |
| `app:mentionable` | Users can @mention the agent in comments |

After authorization, restart the gateway:

```bash
systemctl --user restart openclaw-gateway
```

Verify it's working:

```bash
openclaw openclaw-linear status
```

You should see `token: profile` in the gateway logs.

### 5. Configure Agents

Create `~/.openclaw/agent-profiles.json` to define your agent team:

```json
{
  "agents": {
    "lead": {
      "label": "Lead",
      "mission": "Product owner. Sets direction, prioritizes backlog.",
      "isDefault": true,
      "mentionAliases": ["lead"],
      "avatarUrl": "https://example.com/lead.png"
    },
    "qa": {
      "label": "QA",
      "mission": "Test engineer. Quality guardian, test strategy.",
      "mentionAliases": ["qa", "tester"]
    },
    "infra": {
      "label": "Infra",
      "mission": "Backend engineer. Performance, reliability, observability.",
      "mentionAliases": ["infra", "backend"]
    }
  }
}
```

Each agent name must match an agent definition in your `~/.openclaw/openclaw.json`.

One agent must be marked `isDefault: true` — this is the agent that handles issue assignments and the pipeline.

### 6. Verify

```bash
systemctl --user restart openclaw-gateway
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
| Assign an issue to the agent | Agent triages and posts assessment |
| Trigger an agent session | 3-stage pipeline: plan, implement, audit |
| Comment `@qa check the tests` | QA agent responds with its expertise |
| Comment `@infra why is this slow` | Infra agent investigates and replies |

## Configuration Reference

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `LINEAR_CLIENT_ID` | Yes | OAuth app client ID |
| `LINEAR_CLIENT_SECRET` | Yes | OAuth app client secret |
| `LINEAR_API_KEY` | No | Personal API key (fallback if no OAuth) |
| `LINEAR_REDIRECT_URI` | No | Override the OAuth callback URL |
| `OPENCLAW_GATEWAY_PORT` | No | Gateway port (default: 18789) |

### Plugin Config

Optional overrides in `openclaw.json` under the plugin entry:

| Key | Type | Default | Description |
|---|---|---|---|
| `defaultAgentId` | string | — | Override which agent handles pipeline/triage |
| `enableAudit` | boolean | `true` | Run the auditor stage after implementation |

### Agent Profile Fields

| Field | Required | Description |
|---|---|---|
| `label` | Yes | Display name shown on comments in Linear |
| `mission` | Yes | Role description (injected as context when the agent runs) |
| `isDefault` | One agent | Handles issue triage and the pipeline |
| `mentionAliases` | Yes | `@mention` triggers (e.g., `["qa", "tester"]`) |
| `avatarUrl` | No | Avatar for branded comments |

### CLI

```bash
openclaw openclaw-linear auth      # Run OAuth authorization
openclaw openclaw-linear status    # Check connection and token status
```

## Troubleshooting

Quick checks:

```bash
systemctl --user status openclaw-gateway        # Is the gateway running?
openclaw openclaw-linear status                  # Is the token valid?
journalctl --user -u openclaw-gateway -f         # Watch live logs
```

For detailed diagnostics, see **[docs/troubleshooting.md](docs/troubleshooting.md)**.

## Further Reading

- **[docs/architecture.md](docs/architecture.md)** — Internal design, webhook routing, pipeline stages, triage flow, deduplication, token resolution
- **[docs/troubleshooting.md](docs/troubleshooting.md)** — Diagnostic commands, curl recipes, common issues table
- **[Linear Agent API docs](https://linear.app/developers/agents)** — Linear's official agent developer guide

## License

MIT
