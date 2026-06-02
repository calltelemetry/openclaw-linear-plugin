/**
 * active-session.ts — Idempotent registry of active Linear agent sessions.
 *
 * When the pipeline starts work on an issue, it registers the session here.
 * Any tool (cli_codex, cli_claude, etc.) can look up the active session for the current
 * issue to stream activities without relying on the LLM agent to pass params.
 *
 * This runs in the gateway process. Tool execution also happens in the gateway,
 * so tools can read from this registry directly.
 *
 * The in-memory Map is the fast-path for tool lookups. On startup, the
 * dispatch service calls hydrateFromDispatchState() to rebuild it from
 * the persistent dispatch-state.json file.
 */
import { readDispatchState } from "./dispatch-state.js";
// Keyed by issue ID — one active session per issue at a time.
const sessions = new Map();
const issueAgentAffinity = new Map();
let _affinityTtlMs = 30 * 60_000; // 30 minutes default
/**
 * Register the active session for an issue. Idempotent — calling again
 * for the same issue just updates the session.
 *
 * Also eagerly records agent affinity so that follow-up webhooks arriving
 * during or after the run resolve to the correct agent — even if the
 * gateway restarts before clearActiveSession is called.
 */
export function setActiveSession(session) {
    sessions.set(session.issueId, session);
    if (session.agentId) {
        recordIssueAffinity(session.issueId, session.agentId);
    }
}
/**
 * Clear the active session for an issue.
 * If the session had an agentId, records it as affinity for future routing.
 */
export function clearActiveSession(issueId) {
    const session = sessions.get(issueId);
    if (session?.agentId) {
        recordIssueAffinity(issueId, session.agentId);
    }
    sessions.delete(issueId);
}
/**
 * Look up the active session for an issue by issue ID.
 */
export function getActiveSession(issueId) {
    return sessions.get(issueId) ?? null;
}
/**
 * Look up the active session by issue identifier (e.g. "API-472").
 * Slower than by ID — scans all sessions.
 */
export function getActiveSessionByIdentifier(identifier) {
    for (const session of sessions.values()) {
        if (session.issueIdentifier === identifier)
            return session;
    }
    return null;
}
/**
 * Get the current active session. If there's exactly one, return it.
 * If there are multiple (concurrent pipelines), returns null — caller
 * must specify which issue.
 */
export function getCurrentSession() {
    if (sessions.size === 1) {
        return sessions.values().next().value ?? null;
    }
    return null;
}
/**
 * Look up the most recent active session for a given agent ID.
 * When multiple sessions exist for the same agent, returns the most
 * recently started one. This is the primary lookup for tool execution
 * contexts where the agent ID is known but the issue isn't.
 */
export function getActiveSessionByAgentId(agentId) {
    let best = null;
    for (const session of sessions.values()) {
        if (session.agentId === agentId) {
            if (!best || session.startedAt > best.startedAt) {
                best = session;
            }
        }
    }
    return best;
}
/**
 * Hydrate the in-memory session Map from dispatch-state.json.
 * Called on startup by the dispatch service to restore sessions
 * that were active before a gateway restart.
 *
 * Returns the number of sessions restored.
 */
export async function hydrateFromDispatchState(configPath) {
    const state = await readDispatchState(configPath);
    const active = state.dispatches.active;
    let restored = 0;
    for (const [, dispatch] of Object.entries(active)) {
        if (dispatch.status === "dispatched" || dispatch.status === "working") {
            sessions.set(dispatch.issueId, {
                agentSessionId: dispatch.agentSessionId ?? "",
                issueIdentifier: dispatch.issueIdentifier,
                issueId: dispatch.issueId,
                startedAt: new Date(dispatch.dispatchedAt).getTime(),
            });
            restored++;
        }
    }
    return restored;
}
/**
 * Get the count of currently tracked sessions.
 */
export function getSessionCount() {
    return sessions.size;
}
// ---------------------------------------------------------------------------
// Issue-agent affinity — public API
// ---------------------------------------------------------------------------
/**
 * Record which agent last handled an issue.
 * Called automatically from clearActiveSession when an agentId is present.
 */
export function recordIssueAffinity(issueId, agentId) {
    issueAgentAffinity.set(issueId, { agentId, recordedAt: Date.now() });
}
/**
 * Look up which agent last handled an issue.
 * Returns null if no affinity recorded or if the entry has expired.
 */
export function getIssueAffinity(issueId) {
    const entry = issueAgentAffinity.get(issueId);
    if (!entry)
        return null;
    if (Date.now() - entry.recordedAt > _affinityTtlMs) {
        issueAgentAffinity.delete(issueId);
        return null;
    }
    return entry.agentId;
}
/** @internal — configure affinity TTL from pluginConfig. */
export function _configureAffinityTtl(ttlMs) {
    _affinityTtlMs = ttlMs ?? 30 * 60_000;
}
/** @internal — read current affinity TTL (for testing). */
export function _getAffinityTtlMs() {
    return _affinityTtlMs;
}
/** @internal — test-only; clears all affinity state and resets TTL. */
export function _resetAffinityForTesting() {
    issueAgentAffinity.clear();
    _affinityTtlMs = 30 * 60_000;
}
