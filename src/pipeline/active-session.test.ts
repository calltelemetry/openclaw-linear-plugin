import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  setActiveSession,
  clearActiveSession,
  getActiveSession,
  getActiveSessionByIdentifier,
  getCurrentSession,
  getSessionCount,
  hydrateFromDispatchState,
  recordIssueAffinity,
  getIssueAffinity,
  _configureAffinityTtl,
  _getAffinityTtlMs,
  _resetAffinityForTesting,
  type ActiveSession,
} from "./active-session.js";

function makeSession(overrides?: Partial<ActiveSession>): ActiveSession {
  return {
    agentSessionId: "sess-1",
    issueIdentifier: "API-100",
    issueId: "uuid-1",
    startedAt: Date.now(),
    ...overrides,
  };
}

// Clean up after each test to avoid cross-contamination
afterEach(() => {
  // Clear all known sessions (use sessions.delete directly to avoid triggering affinity)
  clearActiveSession("uuid-1");
  clearActiveSession("uuid-2");
  clearActiveSession("uuid-3");
  _resetAffinityForTesting();
});

describe("set + get", () => {
  it("round-trip by issueId", () => {
    const session = makeSession();
    setActiveSession(session);
    const found = getActiveSession("uuid-1");
    expect(found).not.toBeNull();
    expect(found!.issueIdentifier).toBe("API-100");
    expect(found!.agentSessionId).toBe("sess-1");
  });

  it("returns null for unknown issueId", () => {
    expect(getActiveSession("no-such-id")).toBeNull();
  });
});

describe("clearActiveSession", () => {
  it("removes session", () => {
    setActiveSession(makeSession());
    clearActiveSession("uuid-1");
    expect(getActiveSession("uuid-1")).toBeNull();
  });
});

describe("getActiveSessionByIdentifier", () => {
  it("finds by identifier string", () => {
    setActiveSession(makeSession({ issueIdentifier: "API-200", issueId: "uuid-2" }));
    const found = getActiveSessionByIdentifier("API-200");
    expect(found).not.toBeNull();
    expect(found!.issueId).toBe("uuid-2");
  });

  it("returns null for unknown identifier", () => {
    expect(getActiveSessionByIdentifier("NOPE-999")).toBeNull();
  });
});

describe("getCurrentSession", () => {
  it("returns session when exactly 1", () => {
    setActiveSession(makeSession());
    const current = getCurrentSession();
    expect(current).not.toBeNull();
    expect(current!.issueId).toBe("uuid-1");
  });

  it("returns null when 0 sessions", () => {
    expect(getCurrentSession()).toBeNull();
  });

  it("returns null when >1 sessions", () => {
    setActiveSession(makeSession({ issueId: "uuid-1" }));
    setActiveSession(makeSession({ issueId: "uuid-2", issueIdentifier: "API-200" }));
    expect(getCurrentSession()).toBeNull();
  });
});

describe("getSessionCount", () => {
  it("reflects current count", () => {
    expect(getSessionCount()).toBe(0);
    setActiveSession(makeSession());
    expect(getSessionCount()).toBe(1);
    setActiveSession(makeSession({ issueId: "uuid-2", issueIdentifier: "API-200" }));
    expect(getSessionCount()).toBe(2);
    clearActiveSession("uuid-1");
    expect(getSessionCount()).toBe(1);
  });
});

describe("hydrateFromDispatchState", () => {
  it("restores working dispatches from state file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claw-hydrate-"));
    const statePath = join(dir, "state.json");
    writeFileSync(statePath, JSON.stringify({
      dispatches: {
        active: {
          "API-300": {
            issueId: "uuid-300",
            issueIdentifier: "API-300",
            worktreePath: "/tmp/wt/API-300",
            branch: "codex/API-300",
            tier: "small",
            model: "test",
            status: "working",
            dispatchedAt: "2026-01-01T00:00:00Z",
            attempt: 0,
          },
          "API-301": {
            issueId: "uuid-301",
            issueIdentifier: "API-301",
            worktreePath: "/tmp/wt/API-301",
            branch: "codex/API-301",
            tier: "small",
            model: "test",
            status: "done",
            dispatchedAt: "2026-01-01T00:00:00Z",
            attempt: 1,
          },
        },
        completed: {},
      },
      sessionMap: {},
      processedEvents: [],
    }), "utf-8");

    const restored = await hydrateFromDispatchState(statePath);
    // Only "working" and "dispatched" are restored, not "done"
    expect(restored).toBe(1);
    expect(getActiveSession("uuid-300")).not.toBeNull();
    expect(getActiveSession("uuid-300")!.issueIdentifier).toBe("API-300");
    expect(getActiveSession("uuid-301")).toBeNull();

    // Cleanup
    clearActiveSession("uuid-300");
  });

  it("returns 0 when no active dispatches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claw-hydrate-"));
    const statePath = join(dir, "state.json");
    const restored = await hydrateFromDispatchState(statePath);
    expect(restored).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Issue-agent affinity
// ---------------------------------------------------------------------------

describe("issue agent affinity", () => {
  it("recordIssueAffinity + getIssueAffinity round-trip", () => {
    recordIssueAffinity("uuid-1", "mal");
    expect(getIssueAffinity("uuid-1")).toBe("mal");
  });

  it("returns null for unknown issue", () => {
    expect(getIssueAffinity("no-such-id")).toBeNull();
  });

  it("returns null after TTL expires", () => {
    _configureAffinityTtl(100); // 100ms TTL
    recordIssueAffinity("uuid-1", "mal");
    vi.useFakeTimers();
    vi.advanceTimersByTime(150);
    expect(getIssueAffinity("uuid-1")).toBeNull();
    vi.useRealTimers();
  });

  it("returns agent within TTL", () => {
    _configureAffinityTtl(60_000);
    recordIssueAffinity("uuid-1", "kaylee");
    expect(getIssueAffinity("uuid-1")).toBe("kaylee");
  });

  it("overwrites previous affinity for same issue", () => {
    recordIssueAffinity("uuid-1", "mal");
    recordIssueAffinity("uuid-1", "kaylee");
    expect(getIssueAffinity("uuid-1")).toBe("kaylee");
  });

  it("tracks separate issues independently", () => {
    recordIssueAffinity("uuid-1", "mal");
    recordIssueAffinity("uuid-2", "kaylee");
    expect(getIssueAffinity("uuid-1")).toBe("mal");
    expect(getIssueAffinity("uuid-2")).toBe("kaylee");
  });

  it("clearActiveSession records affinity when agentId present", () => {
    setActiveSession({
      agentSessionId: "sess-1",
      issueIdentifier: "API-100",
      issueId: "uuid-1",
      agentId: "mal",
      startedAt: Date.now(),
    });
    clearActiveSession("uuid-1");
    expect(getActiveSession("uuid-1")).toBeNull(); // session cleared
    expect(getIssueAffinity("uuid-1")).toBe("mal"); // affinity preserved
  });

  it("clearActiveSession does NOT record affinity when agentId missing", () => {
    setActiveSession({
      agentSessionId: "sess-1",
      issueIdentifier: "API-100",
      issueId: "uuid-1",
      startedAt: Date.now(),
      // no agentId
    });
    clearActiveSession("uuid-1");
    expect(getIssueAffinity("uuid-1")).toBeNull();
  });

  it("_resetAffinityForTesting clears all entries and resets TTL", () => {
    _configureAffinityTtl(5000);
    recordIssueAffinity("uuid-1", "mal");
    recordIssueAffinity("uuid-2", "kaylee");
    _resetAffinityForTesting();
    expect(getIssueAffinity("uuid-1")).toBeNull();
    expect(getIssueAffinity("uuid-2")).toBeNull();
    expect(_getAffinityTtlMs()).toBe(30 * 60_000);
  });

  it("_configureAffinityTtl sets custom TTL", () => {
    _configureAffinityTtl(5000);
    expect(_getAffinityTtlMs()).toBe(5000);
  });

  it("_configureAffinityTtl resets to default when called with undefined", () => {
    _configureAffinityTtl(5000);
    _configureAffinityTtl(undefined);
    expect(_getAffinityTtlMs()).toBe(30 * 60_000);
  });
});
