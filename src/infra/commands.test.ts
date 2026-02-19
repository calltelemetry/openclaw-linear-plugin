import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../pipeline/dispatch-state.js", () => ({
  readDispatchState: vi.fn(),
  getActiveDispatch: vi.fn(),
  listActiveDispatches: vi.fn(),
  removeActiveDispatch: vi.fn(),
  transitionDispatch: vi.fn(),
  TransitionError: class TransitionError extends Error {
    constructor(
      public dispatchId: string,
      public fromStatus: string,
      public toStatus: string,
      public actualStatus: string,
    ) {
      super(
        `CAS transition failed for ${dispatchId}: ` +
        `expected ${fromStatus} → ${toStatus}, but current status is ${actualStatus}`,
      );
      this.name = "TransitionError";
    }
  },
  registerDispatch: vi.fn(),
}));

import { registerDispatchCommands } from "./commands.js";
import {
  readDispatchState,
  getActiveDispatch,
  listActiveDispatches,
  removeActiveDispatch,
  transitionDispatch,
  registerDispatch,
} from "../pipeline/dispatch-state.js";
import type { DispatchState, ActiveDispatch } from "../pipeline/dispatch-state.js";

const mockReadDispatchState = readDispatchState as ReturnType<typeof vi.fn>;
const mockGetActiveDispatch = getActiveDispatch as ReturnType<typeof vi.fn>;
const mockListActiveDispatches = listActiveDispatches as ReturnType<typeof vi.fn>;
const mockRemoveActiveDispatch = removeActiveDispatch as ReturnType<typeof vi.fn>;
const mockTransitionDispatch = transitionDispatch as ReturnType<typeof vi.fn>;
const mockRegisterDispatch = registerDispatch as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyState(): DispatchState {
  return {
    dispatches: { active: {}, completed: {} },
    sessionMap: {},
    processedEvents: [],
  };
}

function makeActive(overrides?: Partial<ActiveDispatch>): ActiveDispatch {
  return {
    issueId: "uuid-1",
    issueIdentifier: "CT-100",
    worktreePath: "/tmp/wt/CT-100",
    branch: "codex/CT-100",
    tier: "junior",
    model: "test-model",
    status: "dispatched",
    dispatchedAt: new Date("2026-02-18T10:00:00Z").toISOString(),
    attempt: 0,
    ...overrides,
  };
}

/** Capture the registered command handler from the mock api */
function captureHandler() {
  let handler: (ctx: any) => Promise<any>;
  const api = {
    pluginConfig: undefined,
    registerCommand: vi.fn((cmd: any) => {
      handler = cmd.handler;
    }),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  registerDispatchCommands(api as any);
  return { api, handler: handler! };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerDispatchCommands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers the /dispatch command", () => {
    const { api } = captureHandler();
    expect(api.registerCommand).toHaveBeenCalledOnce();
    const cmd = api.registerCommand.mock.calls[0][0];
    expect(cmd.name).toBe("dispatch");
    expect(cmd.acceptsArgs).toBe(true);
  });

  it("dispatch list shows active dispatches with age/tier/status", async () => {
    const d = makeActive({
      issueIdentifier: "CT-100",
      tier: "senior",
      status: "working",
      attempt: 1,
    });
    const state = emptyState();
    state.dispatches.active["CT-100"] = d;

    mockReadDispatchState.mockResolvedValue(state);
    mockListActiveDispatches.mockReturnValue([d]);

    const { handler } = captureHandler();
    const result = await handler({ args: "list" });

    expect(result.text).toContain("Active Dispatches (1)");
    expect(result.text).toContain("CT-100");
    expect(result.text).toContain("working");
    expect(result.text).toContain("senior");
    expect(result.text).toContain("attempt 1");
    // Should contain age in minutes (a number followed by 'm')
    expect(result.text).toMatch(/\d+m/);
  });

  it("dispatch list with no active dispatches shows 'No active dispatches'", async () => {
    mockReadDispatchState.mockResolvedValue(emptyState());
    mockListActiveDispatches.mockReturnValue([]);

    const { handler } = captureHandler();
    const result = await handler({ args: "list" });

    expect(result.text).toBe("No active dispatches.");
  });

  it("dispatch status shows details for active dispatch", async () => {
    const d = makeActive({
      issueIdentifier: "CT-100",
      issueTitle: "Fix the login bug",
      tier: "medior",
      status: "auditing",
      attempt: 2,
    });
    const state = emptyState();
    state.dispatches.active["CT-100"] = d;

    mockReadDispatchState.mockResolvedValue(state);
    mockGetActiveDispatch.mockReturnValue(d);

    const { handler } = captureHandler();
    const result = await handler({ args: "status CT-100" });

    expect(result.text).toContain("CT-100");
    expect(result.text).toContain("Fix the login bug");
    expect(result.text).toContain("auditing");
    expect(result.text).toContain("medior");
    expect(result.text).toContain("Attempt: 2");
  });

  it("dispatch status shows 'not found' for missing identifier", async () => {
    const state = emptyState();
    mockReadDispatchState.mockResolvedValue(state);
    mockGetActiveDispatch.mockReturnValue(null);

    const { handler } = captureHandler();
    const result = await handler({ args: "status CT-999" });

    expect(result.text).toContain("No dispatch found for CT-999");
  });

  it("dispatch retry on stuck dispatch transitions to dispatched", async () => {
    const d = makeActive({
      issueIdentifier: "CT-100",
      status: "stuck",
      stuckReason: "timed out",
    });
    const state = emptyState();
    state.dispatches.active["CT-100"] = d;

    mockReadDispatchState.mockResolvedValue(state);
    mockGetActiveDispatch.mockReturnValue(d);
    mockRemoveActiveDispatch.mockResolvedValue(undefined);
    mockRegisterDispatch.mockResolvedValue(undefined);

    const { handler } = captureHandler();
    const result = await handler({ args: "retry CT-100" });

    expect(mockRemoveActiveDispatch).toHaveBeenCalledWith("CT-100", undefined);
    expect(mockRegisterDispatch).toHaveBeenCalledWith(
      "CT-100",
      expect.objectContaining({ status: "dispatched", stuckReason: undefined }),
      undefined,
    );
    expect(result.text).toContain("CT-100");
    expect(result.text).toContain("reset to dispatched");
  });

  it("dispatch retry on working dispatch returns error", async () => {
    const d = makeActive({ issueIdentifier: "CT-100", status: "working" });
    const state = emptyState();
    state.dispatches.active["CT-100"] = d;

    mockReadDispatchState.mockResolvedValue(state);
    mockGetActiveDispatch.mockReturnValue(d);

    const { handler } = captureHandler();
    const result = await handler({ args: "retry CT-100" });

    expect(result.text).toContain("Cannot retry CT-100");
    expect(result.text).toContain("working");
    expect(result.text).toContain("must be stuck");
  });

  it("dispatch escalate sets dispatch to stuck with reason", async () => {
    const d = makeActive({ issueIdentifier: "CT-100", status: "working" });
    const state = emptyState();
    state.dispatches.active["CT-100"] = d;

    mockReadDispatchState.mockResolvedValue(state);
    mockGetActiveDispatch.mockReturnValue(d);
    mockTransitionDispatch.mockResolvedValue({ ...d, status: "stuck", stuckReason: "agent looping" });

    const { handler } = captureHandler();
    const result = await handler({ args: "escalate CT-100 agent looping" });

    expect(mockTransitionDispatch).toHaveBeenCalledWith(
      "CT-100",
      "working",
      "stuck",
      { stuckReason: "agent looping" },
      undefined,
    );
    expect(result.text).toContain("CT-100");
    expect(result.text).toContain("escalated to stuck");
    expect(result.text).toContain("agent looping");
  });

  it("dispatch escalate without reason uses default", async () => {
    const d = makeActive({ issueIdentifier: "CT-100", status: "dispatched" });
    const state = emptyState();
    state.dispatches.active["CT-100"] = d;

    mockReadDispatchState.mockResolvedValue(state);
    mockGetActiveDispatch.mockReturnValue(d);
    mockTransitionDispatch.mockResolvedValue({ ...d, status: "stuck", stuckReason: "manual escalation" });

    const { handler } = captureHandler();
    const result = await handler({ args: "escalate CT-100" });

    expect(mockTransitionDispatch).toHaveBeenCalledWith(
      "CT-100",
      "dispatched",
      "stuck",
      { stuckReason: "manual escalation" },
      undefined,
    );
    expect(result.text).toContain("escalated to stuck");
    expect(result.text).toContain("manual escalation");
  });

  it("help/unknown subcommand shows available commands", async () => {
    const { handler } = captureHandler();
    const result = await handler({ args: "help" });

    expect(result.text).toContain("Dispatch Commands");
    expect(result.text).toContain("/dispatch list");
    expect(result.text).toContain("/dispatch status");
    expect(result.text).toContain("/dispatch retry");
    expect(result.text).toContain("/dispatch escalate");
  });
});
