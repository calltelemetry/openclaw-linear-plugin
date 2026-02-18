/**
 * active-session.ts — Idempotent registry of active Linear agent sessions.
 *
 * When the pipeline starts work on an issue, it registers the session here.
 * Any tool (code_run, etc.) can look up the active session for the current
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

export interface ActiveSession {
  agentSessionId: string;
  issueIdentifier: string;
  issueId: string;
  agentId?: string;
  startedAt: number;
}

// Keyed by issue ID — one active session per issue at a time.
const sessions = new Map<string, ActiveSession>();

/**
 * Register the active session for an issue. Idempotent — calling again
 * for the same issue just updates the session.
 */
export function setActiveSession(session: ActiveSession): void {
  sessions.set(session.issueId, session);
}

/**
 * Clear the active session for an issue.
 */
export function clearActiveSession(issueId: string): void {
  sessions.delete(issueId);
}

/**
 * Look up the active session for an issue by issue ID.
 */
export function getActiveSession(issueId: string): ActiveSession | null {
  return sessions.get(issueId) ?? null;
}

/**
 * Look up the active session by issue identifier (e.g. "API-472").
 * Slower than by ID — scans all sessions.
 */
export function getActiveSessionByIdentifier(identifier: string): ActiveSession | null {
  for (const session of sessions.values()) {
    if (session.issueIdentifier === identifier) return session;
  }
  return null;
}

/**
 * Get the current active session. If there's exactly one, return it.
 * If there are multiple (concurrent pipelines), returns null — caller
 * must specify which issue.
 */
export function getCurrentSession(): ActiveSession | null {
  if (sessions.size === 1) {
    return sessions.values().next().value ?? null;
  }
  return null;
}

/**
 * Hydrate the in-memory session Map from dispatch-state.json.
 * Called on startup by the dispatch service to restore sessions
 * that were active before a gateway restart.
 *
 * Returns the number of sessions restored.
 */
export async function hydrateFromDispatchState(configPath?: string): Promise<number> {
  const state = await readDispatchState(configPath);
  const active = state.dispatches.active;
  let restored = 0;

  for (const [, dispatch] of Object.entries(active)) {
    if (dispatch.status === "dispatched" || dispatch.status === "running") {
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
export function getSessionCount(): number {
  return sessions.size;
}
