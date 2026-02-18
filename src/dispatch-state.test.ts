import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readDispatchState,
  registerDispatch,
  transitionDispatch,
  completeDispatch,
  updateDispatchStatus,
  getActiveDispatch,
  listActiveDispatches,
  listStaleDispatches,
  listRecoverableDispatches,
  registerSessionMapping,
  lookupSessionMapping,
  removeSessionMapping,
  markEventProcessed,
  pruneCompleted,
  removeActiveDispatch,
  TransitionError,
  type ActiveDispatch,
} from "./dispatch-state.js";

function tmpStatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "claw-ds-"));
  return join(dir, "state.json");
}

function makeDispatch(overrides?: Partial<ActiveDispatch>): ActiveDispatch {
  return {
    issueId: "uuid-1",
    issueIdentifier: "API-100",
    worktreePath: "/tmp/wt/API-100",
    branch: "codex/API-100",
    tier: "junior",
    model: "test-model",
    status: "dispatched",
    dispatchedAt: new Date().toISOString(),
    attempt: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Read / Register
// ---------------------------------------------------------------------------

describe("readDispatchState", () => {
  it("returns empty state when file missing", async () => {
    const p = tmpStatePath();
    const state = await readDispatchState(p);
    expect(state.dispatches.active).toEqual({});
    expect(state.dispatches.completed).toEqual({});
    expect(state.sessionMap).toEqual({});
    expect(state.processedEvents).toEqual([]);
  });
});

describe("registerDispatch", () => {
  it("registers and reads back", async () => {
    const p = tmpStatePath();
    const d = makeDispatch();
    await registerDispatch("API-100", d, p);
    const state = await readDispatchState(p);
    const active = getActiveDispatch(state, "API-100");
    expect(active).not.toBeNull();
    expect(active!.issueIdentifier).toBe("API-100");
    expect(active!.attempt).toBe(0);
  });

  it("sets attempt=0 default", async () => {
    const p = tmpStatePath();
    const d = makeDispatch();
    (d as any).attempt = undefined;
    await registerDispatch("API-100", d, p);
    const state = await readDispatchState(p);
    expect(getActiveDispatch(state, "API-100")!.attempt).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CAS transitions
// ---------------------------------------------------------------------------

describe("transitionDispatch", () => {
  it("dispatched → working", async () => {
    const p = tmpStatePath();
    await registerDispatch("API-100", makeDispatch(), p);
    const updated = await transitionDispatch("API-100", "dispatched", "working", undefined, p);
    expect(updated.status).toBe("working");
  });

  it("working → auditing", async () => {
    const p = tmpStatePath();
    await registerDispatch("API-100", makeDispatch({ status: "working" }), p);
    const updated = await transitionDispatch("API-100", "working", "auditing", undefined, p);
    expect(updated.status).toBe("auditing");
  });

  it("auditing → done", async () => {
    const p = tmpStatePath();
    await registerDispatch("API-100", makeDispatch({ status: "auditing" }), p);
    const updated = await transitionDispatch("API-100", "auditing", "done", undefined, p);
    expect(updated.status).toBe("done");
  });

  it("auditing → working (rework) with attempt update", async () => {
    const p = tmpStatePath();
    await registerDispatch("API-100", makeDispatch({ status: "auditing", attempt: 0 }), p);
    const updated = await transitionDispatch("API-100", "auditing", "working", { attempt: 1 }, p);
    expect(updated.status).toBe("working");
    expect(updated.attempt).toBe(1);
  });

  it("throws TransitionError when fromStatus mismatch", async () => {
    const p = tmpStatePath();
    await registerDispatch("API-100", makeDispatch({ status: "working" }), p);
    await expect(
      transitionDispatch("API-100", "dispatched", "working", undefined, p),
    ).rejects.toThrow(TransitionError);
  });

  it("throws on invalid transition", async () => {
    const p = tmpStatePath();
    await registerDispatch("API-100", makeDispatch({ status: "done" }), p);
    await expect(
      transitionDispatch("API-100", "done", "working", undefined, p),
    ).rejects.toThrow();
  });

  it("throws when dispatch missing", async () => {
    const p = tmpStatePath();
    await expect(
      transitionDispatch("MISSING-1", "dispatched", "working", undefined, p),
    ).rejects.toThrow("No active dispatch");
  });

  it("applies stuckReason", async () => {
    const p = tmpStatePath();
    await registerDispatch("API-100", makeDispatch({ status: "working" }), p);
    const updated = await transitionDispatch(
      "API-100", "working", "stuck", { stuckReason: "watchdog_kill_2x" }, p,
    );
    expect(updated.status).toBe("stuck");
    expect(updated.stuckReason).toBe("watchdog_kill_2x");
  });

  it("applies session key updates", async () => {
    const p = tmpStatePath();
    await registerDispatch("API-100", makeDispatch({ status: "dispatched" }), p);
    const updated = await transitionDispatch(
      "API-100", "dispatched", "working",
      { workerSessionKey: "sess-w-1" }, p,
    );
    expect(updated.workerSessionKey).toBe("sess-w-1");
  });
});

// ---------------------------------------------------------------------------
// Session mapping
// ---------------------------------------------------------------------------

describe("session mapping", () => {
  it("register + lookup round-trip", async () => {
    const p = tmpStatePath();
    await registerSessionMapping("sess-1", {
      dispatchId: "API-100",
      phase: "worker",
      attempt: 0,
    }, p);
    const state = await readDispatchState(p);
    const mapping = lookupSessionMapping(state, "sess-1");
    expect(mapping).not.toBeNull();
    expect(mapping!.dispatchId).toBe("API-100");
    expect(mapping!.phase).toBe("worker");
  });

  it("lookup returns null for unknown key", async () => {
    const p = tmpStatePath();
    const state = await readDispatchState(p);
    expect(lookupSessionMapping(state, "no-such")).toBeNull();
  });

  it("removeSessionMapping deletes", async () => {
    const p = tmpStatePath();
    await registerSessionMapping("sess-1", {
      dispatchId: "API-100",
      phase: "worker",
      attempt: 0,
    }, p);
    await removeSessionMapping("sess-1", p);
    const state = await readDispatchState(p);
    expect(lookupSessionMapping(state, "sess-1")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("markEventProcessed", () => {
  it("returns true (new) first call", async () => {
    const p = tmpStatePath();
    const isNew = await markEventProcessed("evt-1", p);
    expect(isNew).toBe(true);
  });

  it("returns false (dupe) second call", async () => {
    const p = tmpStatePath();
    await markEventProcessed("evt-1", p);
    const isDupe = await markEventProcessed("evt-1", p);
    expect(isDupe).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Complete dispatch
// ---------------------------------------------------------------------------

describe("completeDispatch", () => {
  it("moves active → completed", async () => {
    const p = tmpStatePath();
    await registerDispatch("API-100", makeDispatch(), p);
    await completeDispatch("API-100", {
      tier: "junior",
      status: "done",
      completedAt: new Date().toISOString(),
    }, p);
    const state = await readDispatchState(p);
    expect(getActiveDispatch(state, "API-100")).toBeNull();
    expect(state.dispatches.completed["API-100"]).toBeDefined();
    expect(state.dispatches.completed["API-100"].status).toBe("done");
  });

  it("cleans up session mappings for the dispatch", async () => {
    const p = tmpStatePath();
    await registerDispatch("API-100", makeDispatch(), p);
    await registerSessionMapping("sess-w", { dispatchId: "API-100", phase: "worker", attempt: 0 }, p);
    await registerSessionMapping("sess-a", { dispatchId: "API-100", phase: "audit", attempt: 0 }, p);
    await completeDispatch("API-100", {
      tier: "junior",
      status: "done",
      completedAt: new Date().toISOString(),
    }, p);
    const state = await readDispatchState(p);
    expect(lookupSessionMapping(state, "sess-w")).toBeNull();
    expect(lookupSessionMapping(state, "sess-a")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// List helpers
// ---------------------------------------------------------------------------

describe("listStaleDispatches", () => {
  it("returns old dispatches", async () => {
    const p = tmpStatePath();
    const oldDate = new Date(Date.now() - 3 * 60 * 60_000).toISOString(); // 3 hours ago
    await registerDispatch("OLD-1", makeDispatch({
      issueIdentifier: "OLD-1",
      dispatchedAt: oldDate,
    }), p);
    const state = await readDispatchState(p);
    const stale = listStaleDispatches(state, 2 * 60 * 60_000); // 2h threshold
    expect(stale).toHaveLength(1);
    expect(stale[0].issueIdentifier).toBe("OLD-1");
  });

  it("excludes recent dispatches", async () => {
    const p = tmpStatePath();
    await registerDispatch("NEW-1", makeDispatch({ issueIdentifier: "NEW-1" }), p);
    const state = await readDispatchState(p);
    const stale = listStaleDispatches(state, 2 * 60 * 60_000);
    expect(stale).toHaveLength(0);
  });
});

describe("listRecoverableDispatches", () => {
  it("returns working + workerKey - no auditKey", async () => {
    const p = tmpStatePath();
    await registerDispatch("REC-1", makeDispatch({
      issueIdentifier: "REC-1",
      status: "working",
      workerSessionKey: "sess-w",
    }), p);
    const state = await readDispatchState(p);
    const rec = listRecoverableDispatches(state);
    expect(rec).toHaveLength(1);
  });

  it("excludes dispatches with auditKey", async () => {
    const p = tmpStatePath();
    await registerDispatch("REC-2", makeDispatch({
      issueIdentifier: "REC-2",
      status: "working",
      workerSessionKey: "sess-w",
      auditSessionKey: "sess-a",
    }), p);
    const state = await readDispatchState(p);
    expect(listRecoverableDispatches(state)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Prune completed
// ---------------------------------------------------------------------------

describe("pruneCompleted", () => {
  it("removes old entries", async () => {
    const p = tmpStatePath();
    await registerDispatch("DONE-1", makeDispatch({ issueIdentifier: "DONE-1" }), p);
    await completeDispatch("DONE-1", {
      tier: "junior",
      status: "done",
      completedAt: new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString(), // 2 days ago
    }, p);
    const pruned = await pruneCompleted(24 * 60 * 60_000, p); // 1 day threshold
    expect(pruned).toBe(1);
  });

  it("preserves recent entries", async () => {
    const p = tmpStatePath();
    await registerDispatch("DONE-2", makeDispatch({ issueIdentifier: "DONE-2" }), p);
    await completeDispatch("DONE-2", {
      tier: "junior",
      status: "done",
      completedAt: new Date().toISOString(),
    }, p);
    const pruned = await pruneCompleted(24 * 60 * 60_000, p);
    expect(pruned).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

describe("migration", () => {
  it("adds missing sessionMap and processedEvents", async () => {
    const p = tmpStatePath();
    // Write v1 state with no v2 fields
    writeFileSync(p, JSON.stringify({
      dispatches: {
        active: { "X-1": makeDispatch({ issueIdentifier: "X-1" }) },
        completed: {},
      },
    }), "utf-8");
    const state = await readDispatchState(p);
    expect(state.sessionMap).toEqual({});
    expect(state.processedEvents).toEqual([]);
  });

  it('migrates "running" → "working"', async () => {
    const p = tmpStatePath();
    const d = makeDispatch({ issueIdentifier: "X-2" });
    (d as any).status = "running"; // old v1 status
    writeFileSync(p, JSON.stringify({
      dispatches: { active: { "X-2": d }, completed: {} },
      sessionMap: {},
      processedEvents: [],
    }), "utf-8");
    const state = await readDispatchState(p);
    expect(getActiveDispatch(state, "X-2")!.status).toBe("working");
  });
});

// ---------------------------------------------------------------------------
// Remove active dispatch
// ---------------------------------------------------------------------------

describe("removeActiveDispatch", () => {
  it("removes dispatch and cleans session mappings", async () => {
    const p = tmpStatePath();
    await registerDispatch("RM-1", makeDispatch({ issueIdentifier: "RM-1" }), p);
    await registerSessionMapping("sess-rm", { dispatchId: "RM-1", phase: "worker", attempt: 0 }, p);
    await removeActiveDispatch("RM-1", p);
    const state = await readDispatchState(p);
    expect(getActiveDispatch(state, "RM-1")).toBeNull();
    expect(lookupSessionMapping(state, "sess-rm")).toBeNull();
  });
});
