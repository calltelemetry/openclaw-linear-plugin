import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock dispatch-state
// ---------------------------------------------------------------------------

const mockReadDispatchState = vi.fn();
const mockGetActiveDispatch = vi.fn();
const mockListActiveDispatches = vi.fn();
const mockTransitionDispatch = vi.fn();
const mockRemoveActiveDispatch = vi.fn();
const mockRegisterDispatch = vi.fn();

vi.mock("../pipeline/dispatch-state.js", () => ({
  readDispatchState: (...args: any[]) => mockReadDispatchState(...args),
  getActiveDispatch: (...args: any[]) => mockGetActiveDispatch(...args),
  listActiveDispatches: (...args: any[]) => mockListActiveDispatches(...args),
  transitionDispatch: (...args: any[]) => mockTransitionDispatch(...args),
  removeActiveDispatch: (...args: any[]) => mockRemoveActiveDispatch(...args),
  registerDispatch: (...args: any[]) => mockRegisterDispatch(...args),
  TransitionError: class TransitionError extends Error {},
}));

import { registerDispatchMethods } from "./dispatch-methods.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createApi() {
  const methods: Record<string, Function> = {};
  return {
    api: {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      pluginConfig: {},
      registerGatewayMethod: (name: string, handler: Function) => {
        methods[name] = handler;
      },
    } as any,
    methods,
  };
}

function makeDispatch(overrides?: Record<string, any>) {
  return {
    issueIdentifier: "CT-100",
    issueId: "issue-id",
    status: "working",
    tier: "senior",
    attempt: 0,
    worktreePath: "/wt/ct-100",
    model: "opus",
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeState(active: Record<string, any> = {}, completed: Record<string, any> = {}) {
  return {
    dispatches: { active, completed },
    sessionMap: {},
    processedEvents: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerDispatchMethods", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers all 6 methods", () => {
    const { api, methods } = createApi();
    registerDispatchMethods(api);
    expect(Object.keys(methods)).toEqual(
      expect.arrayContaining([
        "dispatch.list",
        "dispatch.get",
        "dispatch.retry",
        "dispatch.escalate",
        "dispatch.cancel",
        "dispatch.stats",
      ]),
    );
  });
});

describe("dispatch.list", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns active and completed dispatches", async () => {
    const { api, methods } = createApi();
    registerDispatchMethods(api);

    const d = makeDispatch();
    mockReadDispatchState.mockResolvedValue(makeState({ "CT-100": d }, { "CT-99": { status: "done" } }));
    mockListActiveDispatches.mockReturnValue([d]);

    const respond = vi.fn();
    await methods["dispatch.list"]({ params: {}, respond });

    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({
      ok: true,
      active: [d],
    }));
  });

  it("filters by status", async () => {
    const { api, methods } = createApi();
    registerDispatchMethods(api);

    const d1 = makeDispatch({ issueIdentifier: "CT-1", status: "working" });
    const d2 = makeDispatch({ issueIdentifier: "CT-2", status: "stuck" });
    mockReadDispatchState.mockResolvedValue(makeState());
    mockListActiveDispatches.mockReturnValue([d1, d2]);

    const respond = vi.fn();
    await methods["dispatch.list"]({ params: { status: "stuck" }, respond });

    const result = respond.mock.calls[0][1];
    expect(result.ok).toBe(true);
    expect(result.active).toEqual([d2]);
  });

  it("filters by tier", async () => {
    const { api, methods } = createApi();
    registerDispatchMethods(api);

    const d1 = makeDispatch({ issueIdentifier: "CT-1", tier: "junior" });
    const d2 = makeDispatch({ issueIdentifier: "CT-2", tier: "senior" });
    mockReadDispatchState.mockResolvedValue(makeState());
    mockListActiveDispatches.mockReturnValue([d1, d2]);

    const respond = vi.fn();
    await methods["dispatch.list"]({ params: { tier: "senior" }, respond });

    const result = respond.mock.calls[0][1];
    expect(result.active).toEqual([d2]);
  });
});

describe("dispatch.get", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns active dispatch", async () => {
    const { api, methods } = createApi();
    registerDispatchMethods(api);

    const d = makeDispatch();
    mockReadDispatchState.mockResolvedValue(makeState({ "CT-100": d }));
    mockGetActiveDispatch.mockReturnValue(d);

    const respond = vi.fn();
    await methods["dispatch.get"]({ params: { identifier: "CT-100" }, respond });

    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({
      ok: true,
      dispatch: d,
      source: "active",
    }));
  });

  it("returns completed dispatch when not active", async () => {
    const { api, methods } = createApi();
    registerDispatchMethods(api);

    const completed = { status: "done", tier: "junior" };
    mockReadDispatchState.mockResolvedValue(makeState({}, { "CT-99": completed }));
    mockGetActiveDispatch.mockReturnValue(undefined);

    const respond = vi.fn();
    await methods["dispatch.get"]({ params: { identifier: "CT-99" }, respond });

    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({
      ok: true,
      source: "completed",
    }));
  });

  it("fails when identifier missing", async () => {
    const { api, methods } = createApi();
    registerDispatchMethods(api);

    const respond = vi.fn();
    await methods["dispatch.get"]({ params: {}, respond });

    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({
      ok: false,
      error: expect.stringContaining("identifier"),
    }));
  });

  it("fails when dispatch not found", async () => {
    const { api, methods } = createApi();
    registerDispatchMethods(api);

    mockReadDispatchState.mockResolvedValue(makeState());
    mockGetActiveDispatch.mockReturnValue(undefined);

    const respond = vi.fn();
    await methods["dispatch.get"]({ params: { identifier: "NOPE-1" }, respond });

    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({
      ok: false,
      error: expect.stringContaining("NOPE-1"),
    }));
  });
});

describe("dispatch.retry", () => {
  beforeEach(() => vi.clearAllMocks());

  it("retries stuck dispatch", async () => {
    const { api, methods } = createApi();
    registerDispatchMethods(api);

    const d = makeDispatch({ status: "stuck", attempt: 1 });
    mockReadDispatchState.mockResolvedValue(makeState({ "CT-100": d }));
    mockGetActiveDispatch.mockReturnValue(d);
    mockRemoveActiveDispatch.mockResolvedValue(undefined);
    mockRegisterDispatch.mockResolvedValue(undefined);

    const respond = vi.fn();
    await methods["dispatch.retry"]({ params: { identifier: "CT-100" }, respond });

    const result = respond.mock.calls[0][1];
    expect(result.ok).toBe(true);
    expect(result.dispatch.status).toBe("dispatched");
    expect(result.dispatch.attempt).toBe(2);
    expect(mockRemoveActiveDispatch).toHaveBeenCalledWith("CT-100", undefined);
    expect(mockRegisterDispatch).toHaveBeenCalled();
  });

  it("rejects retry for working dispatch", async () => {
    const { api, methods } = createApi();
    registerDispatchMethods(api);

    const d = makeDispatch({ status: "working" });
    mockReadDispatchState.mockResolvedValue(makeState({ "CT-100": d }));
    mockGetActiveDispatch.mockReturnValue(d);

    const respond = vi.fn();
    await methods["dispatch.retry"]({ params: { identifier: "CT-100" }, respond });

    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({
      ok: false,
      error: expect.stringContaining("working"),
    }));
  });

  it("rejects retry for missing dispatch", async () => {
    const { api, methods } = createApi();
    registerDispatchMethods(api);

    mockReadDispatchState.mockResolvedValue(makeState());
    mockGetActiveDispatch.mockReturnValue(undefined);

    const respond = vi.fn();
    await methods["dispatch.retry"]({ params: { identifier: "CT-100" }, respond });

    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({
      ok: false,
    }));
  });
});

describe("dispatch.escalate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("escalates working dispatch to stuck", async () => {
    const { api, methods } = createApi();
    registerDispatchMethods(api);

    const d = makeDispatch({ status: "working" });
    const updated = { ...d, status: "stuck", stuckReason: "Manual escalation" };
    mockReadDispatchState.mockResolvedValue(makeState({ "CT-100": d }));
    mockGetActiveDispatch.mockReturnValue(d);
    mockTransitionDispatch.mockResolvedValue(updated);

    const respond = vi.fn();
    await methods["dispatch.escalate"]({ params: { identifier: "CT-100", reason: "Manual escalation" }, respond });

    const result = respond.mock.calls[0][1];
    expect(result.ok).toBe(true);
    expect(mockTransitionDispatch).toHaveBeenCalledWith("CT-100", "working", "stuck", expect.objectContaining({ stuckReason: "Manual escalation" }), undefined);
  });

  it("uses default reason when none provided", async () => {
    const { api, methods } = createApi();
    registerDispatchMethods(api);

    const d = makeDispatch({ status: "auditing" });
    mockReadDispatchState.mockResolvedValue(makeState({ "CT-100": d }));
    mockGetActiveDispatch.mockReturnValue(d);
    mockTransitionDispatch.mockResolvedValue(d);

    const respond = vi.fn();
    await methods["dispatch.escalate"]({ params: { identifier: "CT-100" }, respond });

    expect(mockTransitionDispatch).toHaveBeenCalledWith(
      "CT-100", "auditing", "stuck",
      expect.objectContaining({ stuckReason: "Manually escalated via gateway" }),
      undefined,
    );
  });

  it("rejects escalation for stuck dispatch", async () => {
    const { api, methods } = createApi();
    registerDispatchMethods(api);

    const d = makeDispatch({ status: "stuck" });
    mockReadDispatchState.mockResolvedValue(makeState({ "CT-100": d }));
    mockGetActiveDispatch.mockReturnValue(d);

    const respond = vi.fn();
    await methods["dispatch.escalate"]({ params: { identifier: "CT-100" }, respond });

    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({
      ok: false,
      error: expect.stringContaining("stuck"),
    }));
  });
});

describe("dispatch.cancel", () => {
  beforeEach(() => vi.clearAllMocks());

  it("removes active dispatch", async () => {
    const { api, methods } = createApi();
    registerDispatchMethods(api);

    const d = makeDispatch({ status: "working" });
    mockReadDispatchState.mockResolvedValue(makeState({ "CT-100": d }));
    mockGetActiveDispatch.mockReturnValue(d);
    mockRemoveActiveDispatch.mockResolvedValue(undefined);

    const respond = vi.fn();
    await methods["dispatch.cancel"]({ params: { identifier: "CT-100" }, respond });

    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({
      ok: true,
      cancelled: "CT-100",
      previousStatus: "working",
    }));
    expect(mockRemoveActiveDispatch).toHaveBeenCalledWith("CT-100", undefined);
  });

  it("fails for missing dispatch", async () => {
    const { api, methods } = createApi();
    registerDispatchMethods(api);

    mockReadDispatchState.mockResolvedValue(makeState());
    mockGetActiveDispatch.mockReturnValue(undefined);

    const respond = vi.fn();
    await methods["dispatch.cancel"]({ params: { identifier: "CT-999" }, respond });

    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({
      ok: false,
    }));
  });
});

describe("dispatch.stats", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns counts by status and tier", async () => {
    const { api, methods } = createApi();
    registerDispatchMethods(api);

    const active = [
      makeDispatch({ status: "working", tier: "senior" }),
      makeDispatch({ status: "working", tier: "junior" }),
      makeDispatch({ status: "stuck", tier: "senior" }),
    ];
    mockReadDispatchState.mockResolvedValue(makeState({}, { "CT-99": {} }));
    mockListActiveDispatches.mockReturnValue(active);

    const respond = vi.fn();
    await methods["dispatch.stats"]({ params: {}, respond });

    const result = respond.mock.calls[0][1];
    expect(result.ok).toBe(true);
    expect(result.activeCount).toBe(3);
    expect(result.completedCount).toBe(1);
    expect(result.byStatus).toEqual({ working: 2, stuck: 1 });
    expect(result.byTier).toEqual({ senior: 2, junior: 1 });
  });

  it("returns zeros when no dispatches", async () => {
    const { api, methods } = createApi();
    registerDispatchMethods(api);

    mockReadDispatchState.mockResolvedValue(makeState());
    mockListActiveDispatches.mockReturnValue([]);

    const respond = vi.fn();
    await methods["dispatch.stats"]({ params: {}, respond });

    const result = respond.mock.calls[0][1];
    expect(result.activeCount).toBe(0);
    expect(result.completedCount).toBe(0);
    expect(result.byStatus).toEqual({});
    expect(result.byTier).toEqual({});
  });
});
