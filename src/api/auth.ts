import type { 
  OpenClawPluginApi, 
  ProviderAuthContext, 
  ProviderAuthResult
} from "openclaw/plugin-sdk";

export const LINEAR_OAUTH_AUTH_URL = "https://linear.app/oauth/authorize";
export const LINEAR_OAUTH_TOKEN_URL = "https://api.linear.app/oauth/token";

// Agent scopes: read/write + assignable (appear in assignment menus) + mentionable (respond to @mentions)
export const LINEAR_AGENT_SCOPES = "read,write,app:assignable,app:mentionable";

// Token refresh helper — Linear tokens expire; refresh before they do
export async function refreshLinearToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const response = await fetch(LINEAR_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Linear token refresh failed (${response.status}): ${error}`);
  }

  return response.json();
}

export function registerLinearProvider(api: OpenClawPluginApi) {
  const provider = {
    id: "linear",
    label: "Linear",
    auth: [
      {
        id: "oauth",
        label: "OAuth",
        kind: "oauth" as const,
        run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
          // This is a placeholder for the actual OAuth flow.
          // In a real implementation, we would use ctx.oauth.createVpsAwareHandlers
          // and perform the Linear OAuth2 flow.
          
          const pluginConfig = api.pluginConfig as { clientId?: string; clientSecret?: string; redirectUri?: string } | undefined;
          const clientId = pluginConfig?.clientId ?? process.env.LINEAR_CLIENT_ID;
          const clientSecret = pluginConfig?.clientSecret ?? process.env.LINEAR_CLIENT_SECRET;
          
          if (!clientId || !clientSecret) {
            throw new Error("Linear client ID and secret must be configured in plugin config or environment.");
          }

          const prompter = ctx.prompter;
          const spin = prompter.progress("Starting Linear OAuth flow…");
          
          const handlers = ctx.oauth.createVpsAwareHandlers({
            isRemote: ctx.isRemote,
            prompter,
            runtime: ctx.runtime,
            spin,
            openUrl: ctx.openUrl,
            localBrowserMessage: "Waiting for Linear authorization…",
          });

          // Linear OAuth requires a redirect_uri.
          const gatewayPort = process.env.OPENCLAW_GATEWAY_PORT ?? "18789";
          const redirectUri = pluginConfig?.redirectUri ?? process.env.LINEAR_REDIRECT_URI ?? `http://localhost:${gatewayPort}/linear/oauth/callback`;
          
          const state = Math.random().toString(36).substring(7);
          const authUrl = `${LINEAR_OAUTH_AUTH_URL}?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(LINEAR_AGENT_SCOPES)}&state=${state}&actor=app`;

          await handlers.onAuth({ url: authUrl });
          
          const code = await handlers.onPrompt({
            message: "Enter the code from Linear",
          });

          spin.update("Exchanging code for token…");

          const response = await fetch(LINEAR_OAUTH_TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code,
              client_id: clientId,
              client_secret: clientSecret,
              redirect_uri: redirectUri,
            }),
          });

          if (!response.ok) {
            const error = await response.text();
            throw new Error(`Linear OAuth failed: ${error}`);
          }

          const tokens = await response.json();
          spin.stop("Linear authorized!");

          return {
            profiles: [
              {
                profileId: "linear:default",
                credential: {
                  type: "oauth" as const,
                  provider: "linear",
                  access: tokens.access_token,
                  refresh: tokens.refresh_token,
                  expires: Date.now() + (tokens.expires_in * 1000),
                  // Keep aliases for backward compat with linear-api.ts resolveLinearToken
                  accessToken: tokens.access_token,
                  refreshToken: tokens.refresh_token,
                  expiresAt: Date.now() + (tokens.expires_in * 1000),
                },
              },
            ],
          };
        },
      },
    ],
  };

  api.registerProvider(provider);
}
