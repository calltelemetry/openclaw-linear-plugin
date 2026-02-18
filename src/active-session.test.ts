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
  // Clear all known sessions
  clearActiveSession("uuid-1");
  clearActiveSession("uuid-2");
  clearActiveSession("uuid-3");
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
            tier: "junior",
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
            tier: "junior",
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
