import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const LINEAR_OAUTH_TOKEN_URL = "https://api.linear.app/oauth/token";
const AUTH_PROFILES_PATH = join(
  homedir(),
  ".openclaw",
  "auth-profiles.json",
);

export async function handleOAuthCallback(
  api: OpenClawPluginApi,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    res.statusCode = 400;
    res.end(`OAuth error: ${error} — ${url.searchParams.get("error_description") ?? ""}`);
    return;
  }

  if (!code) {
    res.statusCode = 400;
    res.end("Missing authorization code");
    return;
  }

  // Read OAuth client credentials from plugin config first (the canonical
  // location), then env vars as a fallback. The gateway's systemd unit does
  // not set LINEAR_CLIENT_ID / LINEAR_CLIENT_SECRET, so requiring them via
  // env was a regression that made the HTTP callback unusable.
  const pluginConfig = (api as any).pluginConfig as Record<string, unknown> | undefined;
  const clientId =
    (pluginConfig?.clientId as string | undefined) ??
    process.env.LINEAR_CLIENT_ID;
  const clientSecret =
    (pluginConfig?.clientSecret as string | undefined) ??
    process.env.LINEAR_CLIENT_SECRET;
  // The redirect_uri sent in the token-exchange request MUST match the one
  // used in the authorize step. Resolution order:
  //   1. explicit plugin config override
  //   2. explicit env var override
  //   3. derive from inbound request headers (canonical for OAuth callbacks
  //      behind a reverse proxy / tunnel — uses x-forwarded-proto + host)
  //   4. localhost fallback (only when the request has no host header)
  const gatewayPort = process.env.OPENCLAW_GATEWAY_PORT ?? "18789";
  const requestHost = req.headers.host;
  const requestProto = req.headers["x-forwarded-proto"] ?? "https";
  const redirectUri =
    (pluginConfig?.redirectUri as string | undefined) ??
    process.env.LINEAR_REDIRECT_URI ??
    (requestHost
      ? `${requestProto}://${requestHost}/linear/oauth/callback`
      : `http://localhost:${gatewayPort}/linear/oauth/callback`);

  if (!clientId || !clientSecret) {
    res.statusCode = 500;
    res.end(
      "Linear OAuth callback: clientId/clientSecret missing from plugin config and env",
    );
    return;
  }

  api.logger.info("Linear OAuth: exchanging authorization code for token...");

  try {
    const tokenRes = await fetch(LINEAR_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      api.logger.error(`Linear OAuth token exchange failed: ${errText}`);
      res.statusCode = 502;
      res.end(`Token exchange failed: ${errText}`);
      return;
    }

    const tokens = await tokenRes.json();
    api.logger.info(`Linear OAuth: token received (expires_in: ${tokens.expires_in}s, scopes: ${tokens.scope})`);

    // Store in auth profile store
    let store: any = { version: 1, profiles: {} };
    try {
      const raw = readFileSync(AUTH_PROFILES_PATH, "utf8");
      store = JSON.parse(raw);
    } catch {
      // Fresh store
    }

    store.profiles = store.profiles ?? {};
    store.profiles["linear:default"] = {
      type: "oauth",
      provider: "linear",
      accessToken: tokens.access_token,
      access: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      refresh: tokens.refresh_token ?? null,
      expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
      expires: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
      scope: tokens.scope,
    };

    writeFileSync(AUTH_PROFILES_PATH, JSON.stringify(store, null, 2), "utf8");
    api.logger.info("Linear OAuth: token stored in auth profile store");

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html");
    res.end(`
      <html><body style="font-family: system-ui; max-width: 600px; margin: 80px auto; text-align: center;">
        <h1>Linear OAuth Complete</h1>
        <p>Access token stored. Scopes: <code>${tokens.scope ?? "unknown"}</code></p>
        <p>The Linear agent pipeline is now active. You can close this tab.</p>
        <p style="color: #888; font-size: 0.9em;">Restart the gateway to pick up the new token.</p>
      </body></html>
    `);
  } catch (err) {
    api.logger.error(`Linear OAuth error: ${err}`);
    res.statusCode = 500;
    res.end(`OAuth error: ${String(err)}`);
  }
}
