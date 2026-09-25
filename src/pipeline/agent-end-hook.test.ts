/**
 * agent-end-hook.test.ts — Tests for the agent_end hook escalation behavior.
 *
 * Verifies that when triggerAudit or processVerdict throws, the hook:
 * 1. Marks the dispatch as "stuck" via transitionDispatch
 * 2. Sends an escalation notification
 * 3. Does not crash if escalation itself fails
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Mocks (vi.hoisted to ensure they're available before vi.mock)
// ---------------------------------------------------------------------------

const { triggerAuditMock, processVerdictMock } = vi.hoisted(() => ({
  triggerAuditMock: vi.fn(),
  processVerdictMock: vi.fn(),
}));

vi.mock("./pipeline.js", () => ({
  triggerAudit: triggerAuditMock,
  processVerdict: processVerdictMock,
}));

vi.mock("../api/linear-api.js", () => ({
  LinearAgentApi: class {},
  resolveLinearToken: vi.fn().mockReturnValue({
    accessToken: "test-token",
    source: "env",
    refreshToken: "refresh",
    expiresAt: Date.now() + 3600_000,
  }),
}));

vi.mock("../infra/notify.js", () => ({
  createNotifierFromConfig: vi.fn(() => vi.fn().mockResolvedValue(undefined)),
}));

vi.mock("../infra/observability.js", () => ({
  emitDiagnostic: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/core", () => ({}));

// ---------------------------------------------------------------------------
// Imports (AFTER mocks)
// ---------------------------------------------------------------------------

import {
  registerDispatch,
  readDispatchState,
  getActiveDispatch,
  registerSessionMapping,
  transitionDispatch,
  type ActiveDispatch,
} from "./dispatch-state.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpStatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "claw-agent-end-"));
  return join(dir, "state.json");
}

function makeDispatch(overrides?: Partial<ActiveDispatch>): ActiveDispatch {
  return {
    issueId: "uuid-1",
    issueIdentifier: "API-100",
    issueTitle: "Fix the thing",
    worktreePath: "/tmp/wt/API-100",
    branch: "codex/API-100",
    tier: "small",
    model: "test-model",
    status: "working",
    dispatchedAt: new Date().toISOString(),
    attempt: 0,
    ...overrides,
  };
}

/**
 * Simulate the agent_end hook's catch-block escalation logic.
 *
 * This extracts the escalation path from index.ts so we can test it
 * in isolation without bootstrapping the entire plugin registration.
 */
async function simulateAgentEndEscalation(opts: {
  statePath: string;
  sessionKey: string;
  error: Error;
  notify: ReturnType<typeof vi.fn>;
  logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}): Promise<void> {
  const { statePath, sessionKey, error, notify, logger } = opts;

  // This mirrors the catch block in index.ts agent_end hook
  logger.error(`agent_end hook error: ${error}`);
  try {
    const state = await readDispatchState(statePath);
    const { lookupSessionMapping } = await import("./dispatch-state.js");
    const mapping = sessionKey ? lookupSessionMapping(state, sessionKey) : null;
    if (mapping) {
      const dispatch = getActiveDispatch(state, mapping.dispatchId);
      if (dispatch && dispatch.status !== "done" && dispatch.status !== "stuck" && dispatch.status !== "failed") {
        const stuckReason = `Hook error: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500);
        await transitionDispatch(
          mapping.dispatchId,
          dispatch.status as any,
          "stuck",
          { stuckReason },
          statePath,
        );
        await notify("escalation", {
          identifier: dispatch.issueIdentifier,
          title: dispatch.issueTitle ?? "Unknown",
          status: "stuck",
          reason: `Dispatch failed in ${mapping.phase} phase: ${stuckReason}`,
        }).catch(() => {});
      }
    }
  } catch (escalateErr) {
    logger.error(`agent_end escalation also failed: ${escalateErr}`);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("agent_end hook escalation", () => {
  let statePath: string;
  let notifyMock: ReturnType<typeof vi.fn>;
  let logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    statePath = tmpStatePath();
    notifyMock = vi.fn().mockResolvedValue(undefined);
    logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    vi.clearAllMocks();
  });

  it("marks dispatch as stuck when audit throws", async () => {
    // Setup: register a dispatch in "working" status with a session mapping
    await registerDispatch("API-100", makeDispatch({ status: "working" }), statePath);
    await registerSessionMapping("sess-worker-1", {
      dispatchId: "API-100",
      phase: "worker",
      attempt: 0,
    }, statePath);

    // Simulate the hook error
    await simulateAgentEndEscalation({
      statePath,
      sessionKey: "sess-worker-1",
      error: new Error("triggerAudit exploded"),
      notify: notifyMock,
      logger,
    });

    // Verify: dispatch should now be "stuck"
    const state = await readDispatchState(statePath);
    const dispatch = getActiveDispatch(state, "API-100");
    expect(dispatch).not.toBeNull();
    expect(dispatch!.status).toBe("stuck");
    expect(dispatch!.stuckReason).toBe("Hook error: triggerAudit exploded");
  });

  it("sends escalation notification with correct payload", async () => {
    await registerDispatch("API-200", makeDispatch({
      issueIdentifier: "API-200",
      issueTitle: "Auth regression",
      status: "auditing",
    }), statePath);
    await registerSessionMapping("sess-audit-1", {
      dispatchId: "API-200",
      phase: "audit",
      attempt: 0,
    }, statePath);

    await simulateAgentEndEscalation({
      statePath,
      sessionKey: "sess-audit-1",
      error: new Error("processVerdict failed"),
      notify: notifyMock,
      logger,
    });

    expect(notifyMock).toHaveBeenCalledWith("escalation", expect.objectContaining({
      identifier: "API-200",
      title: "Auth regression",
      status: "stuck",
      reason: expect.stringContaining("audit phase"),
    }));
  });

  it("does not crash when escalation itself fails", async () => {
    await registerDispatch("API-300", makeDispatch({
      issueIdentifier: "API-300",
      status: "working",
    }), statePath);
    await registerSessionMapping("sess-worker-2", {
      dispatchId: "API-300",
      phase: "worker",
      attempt: 0,
    }, statePath);

    // Make notify throw
    notifyMock.mockRejectedValueOnce(new Error("Discord is down"));

    // Should not throw even though notify fails — the .catch(() => {}) eats it
    await expect(
      simulateAgentEndEscalation({
        statePath,
        sessionKey: "sess-worker-2",
        error: new Error("worker failed"),
        notify: notifyMock,
        logger,
      }),
    ).resolves.not.toThrow();

    // Dispatch should still be marked stuck
    const state = await readDispatchState(statePath);
    expect(getActiveDispatch(state, "API-300")!.status).toBe("stuck");
  });

  it("skips escalation for already-terminal dispatches", async () => {
    await registerDispatch("API-400", makeDispatch({
      issueIdentifier: "API-400",
      status: "done",
    }), statePath);
    await registerSessionMapping("sess-done", {
      dispatchId: "API-400",
      phase: "worker",
      attempt: 0,
    }, statePath);

    await simulateAgentEndEscalation({
      statePath,
      sessionKey: "sess-done",
      error: new Error("late error"),
      notify: notifyMock,
      logger,
    });

    // Notify should NOT have been called (dispatch is already terminal)
    expect(notifyMock).not.toHaveBeenCalled();

    // Status should still be "done" (unchanged)
    const state = await readDispatchState(statePath);
    expect(getActiveDispatch(state, "API-400")!.status).toBe("done");
  });

  it("skips escalation when no session mapping found", async () => {
    await simulateAgentEndEscalation({
      statePath,
      sessionKey: "unknown-session-key",
      error: new Error("some error"),
      notify: notifyMock,
      logger,
    });

    // Only the initial error log, no escalation error
    expect(notifyMock).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1); // Just the initial error
  });

  it("truncates long error messages to 500 chars", async () => {
    await registerDispatch("API-500", makeDispatch({
      issueIdentifier: "API-500",
      status: "working",
    }), statePath);
    await registerSessionMapping("sess-long", {
      dispatchId: "API-500",
      phase: "worker",
      attempt: 0,
    }, statePath);

    const longMessage = "x".repeat(1000);
    await simulateAgentEndEscalation({
      statePath,
      sessionKey: "sess-long",
      error: new Error(longMessage),
      notify: notifyMock,
      logger,
    });

    const state = await readDispatchState(statePath);
    const dispatch = getActiveDispatch(state, "API-500")!;
    expect(dispatch.stuckReason!.length).toBeLessThanOrEqual(500);
    expect(dispatch.stuckReason).toContain("Hook error:");
  });
});
