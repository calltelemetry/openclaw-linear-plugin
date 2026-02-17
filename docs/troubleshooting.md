# Troubleshooting

Operational reference for diagnosing issues with the Linear agent plugin.

## Service Status

```bash
# Check gateway service status
systemctl --user status openclaw-gateway

# View gateway logs (live tail)
journalctl --user -u openclaw-gateway -f

# View recent gateway logs
journalctl --user -u openclaw-gateway --since "10 min ago" --no-pager

# Restart the gateway
systemctl --user restart openclaw-gateway

# Check what the service is configured with
systemctl --user show openclaw-gateway | grep -E 'Environment|ExecStart|Active'
```

## Token & Auth Debugging

```bash
# Check current token status via CLI
openclaw openclaw-linear status

# Verify token is loaded (look for "token: profile|env|config|missing")
journalctl --user -u openclaw-gateway --since "1 min ago" | grep -i "token"

# Test Linear API connection directly
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {OAUTH_TOKEN}" \
  -d '{"query":"{ viewer { id name email } }"}' | jq .

# Check which token profiles exist
cat ~/.openclaw/auth-profiles.json | jq '.profiles | keys'

# Check token expiry (human-readable)
cat ~/.openclaw/auth-profiles.json | \
  jq -r '.profiles["linear:default"].expiresAt' | \
  xargs -I{} date -d @$(echo "{} / 1000" | bc)

# Check OAuth scopes
cat ~/.openclaw/auth-profiles.json | jq '.profiles["linear:default"].scope'
```

## Webhook Testing

```bash
# Test webhook endpoint locally (simulate Comment.create with @mention)
curl -s -X POST http://localhost:18789/linear/webhook \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {GATEWAY_TOKEN}" \
  -d '{
    "type": "Comment",
    "action": "create",
    "data": {
      "id": "test-comment-id",
      "body": "@mal what is the status?",
      "user": { "name": "Tester" },
      "issue": { "id": "test-issue-id", "identifier": "UAT-999", "title": "Test Issue" }
    }
  }' && echo

# Test webhook through the tunnel
curl -s -X POST https://your-domain.com/linear/webhook \
  -H "Content-Type: application/json" \
  -d '{"type":"test","action":"ping"}' \
  -w "\nHTTP %{http_code}\n"

# Simulate AgentSessionEvent.created
curl -s -X POST http://localhost:18789/linear/webhook \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {GATEWAY_TOKEN}" \
  -d '{
    "type": "AgentSessionEvent",
    "action": "created",
    "agentSession": {
      "id": "test-session-id",
      "issue": { "id": "test-issue", "identifier": "UAT-100", "title": "Test" }
    }
  }' && echo

# Watch webhook arrivals in logs
journalctl --user -u openclaw-gateway -f | grep -i "webhook\|Linear"
```

## Tunnel & Proxy

```bash
# Check Cloudflare tunnel status
systemctl status cloudflared

# View tunnel config
cat /etc/cloudflared/config.yml 2>/dev/null || cat ~/.cloudflared/config.yml

# Check listening ports (gateway on 18789, proxy on 18790)
ss -tlnp | grep -E '1878[09]'

# Check proxy process
ps aux | grep linear-proxy

# Test proxy connectivity (POST)
curl -s -o /dev/null -w "HTTP %{http_code}\n" \
  http://localhost:18790/linear/webhook \
  -X POST -H "Content-Type: application/json" -d '{}'

# Test gateway directly (bypassing proxy)
curl -s -o /dev/null -w "HTTP %{http_code}\n" \
  http://localhost:18789/linear/webhook \
  -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer {GATEWAY_TOKEN}" -d '{}'

# Verify DNS resolves to tunnel
dig +short your-subdomain.yourdomain.com CNAME
```

## Agent Profiles

```bash
# View configured agent profiles
cat ~/.openclaw/agent-profiles.json | jq '.agents | keys'

# Check which agent is default
cat ~/.openclaw/agent-profiles.json | jq '.agents | to_entries[] | select(.value.isDefault) | .key'

# List all mention aliases
cat ~/.openclaw/agent-profiles.json | \
  jq '[.agents | to_entries[] | {agent: .key, aliases: .value.mentionAliases}]'

# List all app aliases (default agent only)
cat ~/.openclaw/agent-profiles.json | \
  jq '[.agents | to_entries[] | select(.value.appAliases) | {agent: .key, appAliases: .value.appAliases}]'
```

## OpenClaw Config Validation

```bash
# Validate config (catches unrecognized keys that cause crashes)
openclaw doctor --fix

# Check plugin load paths
cat ~/.openclaw/openclaw.json | jq '.plugins'

# Check systemd service environment vars
systemctl --user show openclaw-gateway | grep Environment

# Check what agents are defined
cat ~/.openclaw/openclaw.json | jq '.agents | keys'
```

## Process & Port Inspection

```bash
# Show all OpenClaw-related processes
ps aux | grep -E 'openclaw|cloudflared|linear-proxy'

# Check for port conflicts
ss -tlnp | grep -E '1878[09]'

# Check for TIME_WAIT sockets (prevents restart)
ss -tan | grep -E '1878[09]' | grep TIME-WAIT

# Gateway systemd service logs (last 50 lines)
journalctl --user -u openclaw-gateway -n 50 --no-pager

# Filter logs for errors only
journalctl --user -u openclaw-gateway --since "1 hour ago" | grep -iE 'error|fail|crash|panic'
```

## Common Issues

| Symptom | Cause | Fix |
|---|---|---|
| `token: missing` in logs | No token in env or auth profile store | Run `openclaw openclaw-linear auth` or set `LINEAR_API_KEY` in systemd service env |
| `Unrecognized key` crash | Added custom keys to `plugins.entries` in `openclaw.json` | Remove the key — use env vars or auth profile store instead. Plugin entries only accept `enabled`. |
| Webhook returns 405 | GET request to webhook endpoint | Webhooks must be POST |
| 502 through tunnel | Proxy or gateway not running | Check `ss -tlnp \| grep 1878`, restart proxy/gateway |
| Agent not responding to @mentions | `mentionAliases` not in agent profiles | Add aliases to `~/.openclaw/agent-profiles.json` |
| Duplicate responses | Both webhooks firing for same event | Dedup window handles this; check webhook event subscriptions aren't overlapping |
| `AgentSession.created missing session` | Payload structure mismatch | Check logs — Linear uses `AgentSessionEvent`/`created`, NOT `AgentSession`/`create` |
| OAuth 401 errors | Token expired and refresh failed | Re-run `openclaw openclaw-linear auth` |
| `No defaultAgentId` error | No agent marked `isDefault` and no `defaultAgentId` in config | Mark one agent `"isDefault": true` in agent-profiles.json |
| Agent timeout | Agent subprocess exceeded time limit | Defaults: 3 min for mentions, 5/10/5 min for pipeline stages |
| OAuth callback 501/502 | Proxy doesn't support GET, or tunnel routing issue | Exchange code manually via curl (see README manual OAuth section) |
| Port "Address already in use" on restart | TIME_WAIT sockets holding the port | Wait 60s, or check with `ss -tan \| grep TIME-WAIT` |
