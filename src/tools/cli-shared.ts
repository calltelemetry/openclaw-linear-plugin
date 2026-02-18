import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { LinearAgentApi } from "../api/linear-api.js";
import { resolveLinearToken, LinearAgentApi as LinearAgentApiClass } from "../api/linear-api.js";
import { getCurrentSession, getActiveSessionByIdentifier } from "../pipeline/active-session.js";

export const DEFAULT_TIMEOUT_MS = 10 * 60_000; // 10 minutes (legacy — prefer watchdog config)
export { DEFAULT_INACTIVITY_SEC, DEFAULT_MAX_TOTAL_SEC, DEFAULT_TOOL_TIMEOUT_SEC } from "../agent/watchdog.js";
export const DEFAULT_BASE_REPO = "/home/claw/ai-workspace";

export interface CliToolParams {
  prompt: string;
  workingDir?: string;
  model?: string;
  timeoutMs?: number;
  issueIdentifier?: string;
  agentSessionId?: string;
}

export interface CliResult {
  success: boolean;
  output: string;
  error?: string;
}

/**
 * Build a LinearAgentApi instance for streaming activities to Linear.
 */
export function buildLinearApi(
  api: OpenClawPluginApi,
  agentSessionId?: string,
): LinearAgentApi | null {
  if (!agentSessionId) return null;

  const pluginConfig = (api as any).pluginConfig as Record<string, unknown> | undefined;
  const tokenInfo = resolveLinearToken(pluginConfig);
  if (!tokenInfo.accessToken) return null;

  const clientId = (pluginConfig?.clientId as string) ?? process.env.LINEAR_CLIENT_ID;
  const clientSecret = (pluginConfig?.clientSecret as string) ?? process.env.LINEAR_CLIENT_SECRET;

  return new LinearAgentApiClass(tokenInfo.accessToken, {
    refreshToken: tokenInfo.refreshToken,
    expiresAt: tokenInfo.expiresAt,
    clientId: clientId ?? undefined,
    clientSecret: clientSecret ?? undefined,
  });
}

/**
 * Resolve session info from explicit params or the active session registry.
 */
export function resolveSession(params: CliToolParams): {
  agentSessionId: string | undefined;
  issueIdentifier: string | undefined;
} {
  let { issueIdentifier, agentSessionId } = params;

  if (!agentSessionId || !issueIdentifier) {
    const active = issueIdentifier
      ? getActiveSessionByIdentifier(issueIdentifier)
      : getCurrentSession();
    if (active) {
      agentSessionId = agentSessionId ?? active.agentSessionId;
      issueIdentifier = issueIdentifier ?? active.issueIdentifier;
    }
  }

  return { agentSessionId, issueIdentifier };
}

/**
 * Robustly extract a prompt from params, handling various key names.
 */
export function extractPrompt(params: CliToolParams): string | undefined {
  return params.prompt ?? (params as any).text ?? (params as any).message ?? (params as any).task;
}
