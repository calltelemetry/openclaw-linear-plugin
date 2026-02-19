import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock openclaw/plugin-sdk
vi.mock("openclaw/plugin-sdk", () => ({
  jsonResult: (data: any) => ({ type: "json", data }),
}));

// Mock dispatch-state
vi.mock("../pipeline/dispatch-state.js", () => ({
  readDispatchState: vi.fn(),
  listActiveDispatches: vi.fn(),
}));

// Mock artifacts — resolveOrchestratorWorkspace
vi.mock("../pipeline/artifacts.js", () => ({
  resolveOrchestratorWorkspace: vi.fn(() => "/mock/workspace"),
}));

// Mock node:fs (readdirSync, readFileSync)
vi.mock("node:fs", () => ({
  readdirSync: vi.fn(() => []),
  readFileSync: vi.fn(() => ""),
}));

import { createDispatchHistoryTool } from "./dispatch-history-tool.js";
import { readDispatchState, listActiveDispatches } from "../pipeline/dispatch-state.js";
import { readdirSync, readFileSync } from "node:fs";
import type { DispatchState, ActiveDispatch, CompletedDispatch } from "../pipeline/dispatch-state.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockReadDispatchState = readDispatchState as ReturnType<typeof vi.fn>;
const mockListActiveDispatches = listActiveDispatches as ReturnType<typeof vi.fn>;
const mockReaddirSync = readdirSync as unknown as ReturnType<typeof vi.fn>;
const mockReadFileSync = readFileSync as unknown as ReturnType<typeof vi.fn>;

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
    dispatchedAt: new Date().toISOString(),
    attempt: 0,
    ...overrides,
  };
}

function makeCompleted(overrides?: Partial<CompletedDispatch>): CompletedDispatch {
  return {
    issueIdentifier: "CT-200",
    tier: "senior",
    status: "done",
    completedAt: new Date().toISOString(),
    totalAttempts: 2,
    ...overrides,
  };
}

const fakeApi = {
  runtime: { config: { loadConfig: () => ({}) } },
} as any;

function createTool(pluginConfig?: Record<string, unknown>) {
  return createDispatchHistoryTool(fakeApi, pluginConfig) as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dispatch_history tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no memory files
    mockReaddirSync.mockReturnValue([]);
    mockReadFileSync.mockReturnValue("");
  });

  it("returns empty results when no dispatches exist", async () => {
    mockReadDispatchState.mockResolvedValue(emptyState());
    mockListActiveDispatches.mockReturnValue([]);

    const tool = createTool();
    const result = await tool.execute("call-1", {});

    expect(result.data.results).toEqual([]);
    expect(result.data.message).toContain("No dispatch history found");
  });

  it("finds active dispatch by identifier query", async () => {
    const active = makeActive({ issueIdentifier: "CT-100", tier: "junior", status: "working" });
    const state = emptyState();
    state.dispatches.active["CT-100"] = active;

    mockReadDispatchState.mockResolvedValue(state);
    mockListActiveDispatches.mockReturnValue([active]);

    const tool = createTool();
    const result = await tool.execute("call-2", { query: "CT-100" });

    expect(result.data.results).toHaveLength(1);
    expect(result.data.results[0].identifier).toBe("CT-100");
    expect(result.data.results[0].active).toBe(true);
  });

  it("finds completed dispatch by identifier query", async () => {
    const completed = makeCompleted({ issueIdentifier: "CT-200", tier: "senior", status: "done" });
    const state = emptyState();
    state.dispatches.completed["CT-200"] = completed;

    mockReadDispatchState.mockResolvedValue(state);
    mockListActiveDispatches.mockReturnValue([]);

    const tool = createTool();
    const result = await tool.execute("call-3", { query: "CT-200" });

    expect(result.data.results).toHaveLength(1);
    expect(result.data.results[0].identifier).toBe("CT-200");
    expect(result.data.results[0].active).toBe(false);
  });

  it("filters by tier", async () => {
    const junior = makeActive({ issueIdentifier: "CT-10", tier: "junior", status: "working" });
    const senior = makeActive({ issueIdentifier: "CT-20", tier: "senior", status: "working" });
    const state = emptyState();
    state.dispatches.active["CT-10"] = junior;
    state.dispatches.active["CT-20"] = senior;

    mockReadDispatchState.mockResolvedValue(state);
    mockListActiveDispatches.mockReturnValue([junior, senior]);

    const tool = createTool();
    const result = await tool.execute("call-4", { tier: "senior" });

    expect(result.data.results).toHaveLength(1);
    expect(result.data.results[0].identifier).toBe("CT-20");
    expect(result.data.results[0].tier).toBe("senior");
  });

  it("filters by status", async () => {
    const working = makeActive({ issueIdentifier: "CT-10", status: "working" });
    const auditing = makeActive({ issueIdentifier: "CT-20", status: "auditing" });
    const state = emptyState();
    state.dispatches.active["CT-10"] = working;
    state.dispatches.active["CT-20"] = auditing;

    mockReadDispatchState.mockResolvedValue(state);
    mockListActiveDispatches.mockReturnValue([working, auditing]);

    const tool = createTool();
    const result = await tool.execute("call-5", { status: "working" });

    expect(result.data.results).toHaveLength(1);
    expect(result.data.results[0].identifier).toBe("CT-10");
    expect(result.data.results[0].status).toBe("working");
  });

  it("combines tier + status filters", async () => {
    const a = makeActive({ issueIdentifier: "CT-1", tier: "senior", status: "working" });
    const b = makeActive({ issueIdentifier: "CT-2", tier: "junior", status: "working" });
    const c = makeActive({ issueIdentifier: "CT-3", tier: "senior", status: "dispatched" });
    const state = emptyState();
    state.dispatches.active["CT-1"] = a;
    state.dispatches.active["CT-2"] = b;
    state.dispatches.active["CT-3"] = c;

    mockReadDispatchState.mockResolvedValue(state);
    mockListActiveDispatches.mockReturnValue([a, b, c]);

    const tool = createTool();
    const result = await tool.execute("call-6", { tier: "senior", status: "working" });

    expect(result.data.results).toHaveLength(1);
    expect(result.data.results[0].identifier).toBe("CT-1");
  });

  it("respects limit parameter", async () => {
    const dispatches = Array.from({ length: 5 }, (_, i) =>
      makeActive({ issueIdentifier: `CT-${i + 1}`, tier: "junior", status: "dispatched" }),
    );
    const state = emptyState();
    for (const d of dispatches) {
      state.dispatches.active[d.issueIdentifier] = d;
    }

    mockReadDispatchState.mockResolvedValue(state);
    mockListActiveDispatches.mockReturnValue(dispatches);

    const tool = createTool();
    const result = await tool.execute("call-7", { limit: 2 });

    expect(result.data.results).toHaveLength(2);
  });

  it("matches query substring in memory file content", async () => {
    // No active or completed dispatches — result comes only from memory file.
    // The tool's matchesFilters requires the query to appear in the identifier,
    // so we search for "CT-300" which matches the identifier AND will find
    // the memory file whose content has extra context that gets extracted as summary.
    const state = emptyState();
    mockReadDispatchState.mockResolvedValue(state);
    mockListActiveDispatches.mockReturnValue([]);

    // Memory file for CT-300 contains extra context
    mockReaddirSync.mockReturnValue(["dispatch-CT-300.md"]);
    mockReadFileSync.mockReturnValue(
      "---\ntier: medior\nstatus: done\nattempts: 1\n---\nApplied a workaround for the flaky test in CT-300.",
    );

    const tool = createTool();
    const result = await tool.execute("call-8", { query: "CT-300" });

    expect(result.data.results).toHaveLength(1);
    expect(result.data.results[0].identifier).toBe("CT-300");
    expect(result.data.results[0].tier).toBe("medior");
    expect(result.data.results[0].summary).toContain("workaround");
  });

  it("returns active flag true for active dispatches", async () => {
    const active = makeActive({ issueIdentifier: "CT-50", status: "working" });
    const state = emptyState();
    state.dispatches.active["CT-50"] = active;

    mockReadDispatchState.mockResolvedValue(state);
    mockListActiveDispatches.mockReturnValue([active]);

    const tool = createTool();
    const result = await tool.execute("call-9", {});

    expect(result.data.results[0].active).toBe(true);
  });

  it("returns active flag false for completed dispatches", async () => {
    const completed = makeCompleted({ issueIdentifier: "CT-60" });
    const state = emptyState();
    state.dispatches.completed["CT-60"] = completed;

    mockReadDispatchState.mockResolvedValue(state);
    mockListActiveDispatches.mockReturnValue([]);

    const tool = createTool();
    const result = await tool.execute("call-10", { query: "CT-60" });

    expect(result.data.results[0].active).toBe(false);
  });

  it("handles memory file read errors gracefully (skips, does not crash)", async () => {
    const active = makeActive({ issueIdentifier: "CT-70", status: "working" });
    const state = emptyState();
    state.dispatches.active["CT-70"] = active;

    mockReadDispatchState.mockResolvedValue(state);
    mockListActiveDispatches.mockReturnValue([active]);

    // Memory dir listing succeeds but reading individual files throws
    mockReaddirSync.mockReturnValue(["dispatch-CT-70.md"]);
    mockReadFileSync.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });

    const tool = createTool();
    const result = await tool.execute("call-11", {});

    // Should still return the active dispatch, just without summary enrichment
    expect(result.data.results).toHaveLength(1);
    expect(result.data.results[0].identifier).toBe("CT-70");
    expect(result.data.results[0].summary).toBeUndefined();
  });

  it("returns structured result with identifier, tier, status, attempt fields", async () => {
    const active = makeActive({
      issueIdentifier: "CT-80",
      tier: "medior",
      status: "auditing",
      attempt: 3,
    });
    const state = emptyState();
    state.dispatches.active["CT-80"] = active;

    mockReadDispatchState.mockResolvedValue(state);
    mockListActiveDispatches.mockReturnValue([active]);

    const tool = createTool();
    const result = await tool.execute("call-12", {});

    const entry = result.data.results[0];
    expect(entry).toEqual(
      expect.objectContaining({
        identifier: "CT-80",
        tier: "medior",
        status: "auditing",
        attempts: 3,
        active: true,
      }),
    );
  });
});
