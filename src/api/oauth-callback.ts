import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const LINEAR_OAUTH_TOKEN_URL = "https://api.linear.app/oauth/token";
const AUTH_PROFILES_PATH = join(
  process.env.HOME ?? "/home/claw",
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

  const clientId = process.env.LINEAR_CLIENT_ID;
  const clientSecret = process.env.LINEAR_CLIENT_SECRET;
  const redirectUri = process.env.LINEAR_REDIRECT_URI ?? `${req.headers["x-forwarded-proto"] ?? "https"}://${req.headers.host}/linear/oauth/callback`;

  if (!clientId || !clientSecret) {
    res.statusCode = 500;
    res.end("LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET must be set");
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
