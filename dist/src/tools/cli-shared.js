import { join } from "node:path";
import { homedir } from "node:os";
import { resolveLinearToken, LinearAgentApi as LinearAgentApiClass } from "../api/linear-api.js";
import { getCurrentSession, getActiveSessionByIdentifier } from "../pipeline/active-session.js";
export const DEFAULT_TIMEOUT_MS = 10 * 60_000; // 10 minutes (legacy — prefer watchdog config)
export { DEFAULT_INACTIVITY_SEC, DEFAULT_MAX_TOTAL_SEC, DEFAULT_TOOL_TIMEOUT_SEC } from "../agent/watchdog.js";
export const DEFAULT_BASE_REPO = join(homedir(), "ai-workspace");
/**
 * Format a Linear activity as a single streaming log line for session progress.
 */
export function formatActivityLogLine(activity) {
    if (activity.type === "thought") {
        return `▸ ${(activity.body ?? "").slice(0, 300)}`;
    }
    if (activity.type === "action") {
        const result = activity.result ? `\n  → ${activity.result.slice(0, 200)}` : "";
        return `▸ ${activity.action ?? ""}: ${(activity.parameter ?? "").slice(0, 300)}${result}`;
    }
    return `▸ ${JSON.stringify(activity).slice(0, 300)}`;
}
/**
 * Create a progress emitter that maintains a rolling log of streaming events.
 * Calls onUpdate with the full accumulated log on each new event.
 */
export function createProgressEmitter(opts) {
    const lines = [];
    const maxLines = opts.maxLines ?? 40;
    const { header, onUpdate } = opts;
    function emit() {
        if (!onUpdate)
            return;
        const log = lines.length > 0 ? "\n---\n" + lines.join("\n") : "";
        try {
            onUpdate({ status: "running", summary: header + log });
        }
        catch { }
    }
    return {
        emitHeader() { emit(); },
        push(line) {
            lines.push(line);
            if (lines.length > maxLines)
                lines.splice(0, lines.length - maxLines);
            emit();
        },
    };
}
/**
 * Build a LinearAgentApi instance for streaming activities to Linear.
 */
export function buildLinearApi(api, agentSessionId) {
    if (!agentSessionId)
        return null;
    const pluginConfig = api.pluginConfig;
    const tokenInfo = resolveLinearToken(pluginConfig);
    if (!tokenInfo.accessToken)
        return null;
    const clientId = pluginConfig?.clientId ?? process.env.LINEAR_CLIENT_ID;
    const clientSecret = pluginConfig?.clientSecret ?? process.env.LINEAR_CLIENT_SECRET;
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
export function resolveSession(params) {
    let { issueId, issueIdentifier, agentSessionId } = params;
    if (!agentSessionId || !issueIdentifier) {
        const active = issueIdentifier
            ? getActiveSessionByIdentifier(issueIdentifier)
            : getCurrentSession();
        if (active) {
            agentSessionId = agentSessionId ?? active.agentSessionId;
            issueId = issueId ?? active.issueId;
            issueIdentifier = issueIdentifier ?? active.issueIdentifier;
        }
    }
    return { agentSessionId, issueId, issueIdentifier };
}
/**
 * Robustly extract a prompt from params, handling various key names.
 */
export function extractPrompt(params) {
    return params.prompt ?? params.text ?? params.message ?? params.task;
}
