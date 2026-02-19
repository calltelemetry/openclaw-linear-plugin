import { describe, it, expect, vi, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (vi.hoisted + vi.mock)
// ---------------------------------------------------------------------------

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn().mockResolvedValue({ success: true, output: "Mock planner response" }),
}));

vi.mock("../agent/agent.js", () => ({
  runAgent: runAgentMock,
}));

vi.mock("../api/linear-api.js", () => ({}));

vi.mock("openclaw/plugin-sdk", () => ({}));

// Mock CLI tool runners for cross-model review
vi.mock("../tools/claude-tool.js", () => ({
  runClaude: vi.fn().mockResolvedValue({ success: true, output: "Claude review feedback" }),
}));
vi.mock("../tools/codex-tool.js", () => ({
  runCodex: vi.fn().mockResolvedValue({ success: true, output: "Codex review feedback" }),
}));
vi.mock("../tools/gemini-tool.js", () => ({
  runGemini: vi.fn().mockResolvedValue({ success: true, output: "Gemini review feedback" }),
}));

const mockLinearApi = {
  getProject: vi.fn().mockResolvedValue({
    id: "proj-1",
    name: "Test Project",
    teams: { nodes: [{ id: "team-1", name: "Team" }] },
  }),
  getProjectIssues: vi.fn().mockResolvedValue([]),
  getTeamStates: vi.fn().mockResolvedValue([
    { id: "st-1", name: "Backlog", type: "backlog" },
  ]),
  getTeamLabels: vi.fn().mockResolvedValue([]),
  createComment: vi.fn().mockResolvedValue("comment-id"),
  getIssueDetails: vi.fn().mockResolvedValue({
    id: "issue-1",
    identifier: "PROJ-1",
    title: "Root",
    comments: { nodes: [] },
    project: { id: "proj-1" },
    team: { id: "team-1" },
  }),
};

vi.mock("./planning-state.js", () => ({
  registerPlanningSession: vi.fn().mockResolvedValue(undefined),
  updatePlanningSession: vi.fn().mockResolvedValue({
    turnCount: 1,
    projectId: "proj-1",
    status: "interviewing",
  }),
  endPlanningSession: vi.fn().mockResolvedValue(undefined),
  setPlanningCache: vi.fn(),
  clearPlanningCache: vi.fn(),
}));

vi.mock("../tools/planner-tools.js", () => ({
  setActivePlannerContext: vi.fn(),
  clearActivePlannerContext: vi.fn(),
  buildPlanSnapshot: vi.fn().mockReturnValue("_No issues created yet._"),
  auditPlan: vi.fn().mockReturnValue({ pass: true, problems: [], warnings: [] }),
}));

// ---------------------------------------------------------------------------
// Imports (AFTER mocks)
// ---------------------------------------------------------------------------

import {
  initiatePlanningSession,
  handlePlannerTurn,
  runPlanAudit,
  runCrossModelReview,
  resolveReviewModel,
} from "./planner.js";
import {
  registerPlanningSession,
  updatePlanningSession,
  endPlanningSession,
  setPlanningCache,
} from "./planning-state.js";
import {
  setActivePlannerContext,
  clearActivePlannerContext,
  auditPlan,
} from "../tools/planner-tools.js";
import { runClaude } from "../tools/claude-tool.js";
import { runCodex } from "../tools/codex-tool.js";
import { runGemini } from "../tools/gemini-tool.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createApi() {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    pluginConfig: {},
  } as any;
}

function createCtx(overrides?: Partial<{ api: any; linearApi: any; pluginConfig: any }>) {
  return {
    api: createApi(),
    linearApi: mockLinearApi,
    pluginConfig: {},
    ...overrides,
  };
}

function createSession(overrides?: Record<string, unknown>) {
  return {
    projectId: "proj-1",
    projectName: "Test Project",
    rootIssueId: "issue-1",
    rootIdentifier: "PROJ-1",
    teamId: "team-1",
    status: "interviewing" as const,
    startedAt: new Date().toISOString(),
    turnCount: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.clearAllMocks();
  runAgentMock.mockResolvedValue({ success: true, output: "Mock planner response" });
  vi.mocked(auditPlan).mockReturnValue({ pass: true, problems: [], warnings: [] });
});

// ---------------------------------------------------------------------------
// initiatePlanningSession
// ---------------------------------------------------------------------------

describe("initiatePlanningSession", () => {
  const rootIssue = {
    id: "issue-1",
    identifier: "PROJ-1",
    title: "Root",
    team: { id: "team-1" },
  };

  it("registers session in state with projectId and status interviewing", async () => {
    const ctx = createCtx();
    await initiatePlanningSession(ctx, "proj-1", rootIssue);

    expect(registerPlanningSession).toHaveBeenCalledWith(
      "proj-1",
      expect.objectContaining({
        projectId: "proj-1",
        status: "interviewing",
      }),
      undefined,
    );
  });

  it("sets planning cache with the session", async () => {
    const ctx = createCtx();
    await initiatePlanningSession(ctx, "proj-1", rootIssue);

    expect(setPlanningCache).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        projectName: "Test Project",
        status: "interviewing",
      }),
    );
  });

  it("posts welcome comment containing the project name", async () => {
    const ctx = createCtx();
    await initiatePlanningSession(ctx, "proj-1", rootIssue);

    expect(mockLinearApi.createComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("Test Project"),
    );
  });

  it("fetches project metadata and team states", async () => {
    const ctx = createCtx();
    await initiatePlanningSession(ctx, "proj-1", rootIssue);

    expect(mockLinearApi.getProject).toHaveBeenCalledWith("proj-1");
    expect(mockLinearApi.getTeamStates).toHaveBeenCalledWith("team-1");
  });
});

// ---------------------------------------------------------------------------
// handlePlannerTurn
// ---------------------------------------------------------------------------

describe("handlePlannerTurn", () => {
  const input = {
    issueId: "issue-1",
    commentBody: "Let's add a search feature",
    commentorName: "Tester",
  };

  it("increments turn count via updatePlanningSession", async () => {
    const ctx = createCtx();
    const session = createSession();
    await handlePlannerTurn(ctx, session, input);

    expect(updatePlanningSession).toHaveBeenCalledWith(
      "proj-1",
      { turnCount: 1 },
      undefined,
    );
  });

  it("builds plan snapshot from project issues", async () => {
    const ctx = createCtx();
    const session = createSession();
    await handlePlannerTurn(ctx, session, input);

    expect(mockLinearApi.getProjectIssues).toHaveBeenCalledWith("proj-1");
  });

  it("calls runAgent with system prompt", async () => {
    const ctx = createCtx();
    const session = createSession();
    await handlePlannerTurn(ctx, session, input);

    expect(runAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("planning"),
      }),
    );
  });

  it("posts agent response as comment", async () => {
    const ctx = createCtx();
    const session = createSession();
    await handlePlannerTurn(ctx, session, input);

    expect(mockLinearApi.createComment).toHaveBeenCalledWith(
      "issue-1",
      "Mock planner response",
    );
  });

  // Note: finalize/abandon intent detection has moved to webhook.ts via
  // intent-classify.ts. handlePlannerTurn is now a pure "continue planning"
  // function that always runs the agent.
});

// ---------------------------------------------------------------------------
// runPlanAudit
// ---------------------------------------------------------------------------

describe("runPlanAudit", () => {
  it("transitions to plan_review on passing audit", async () => {
    vi.mocked(auditPlan).mockReturnValue({ pass: true, problems: [], warnings: [] });
    const ctx = createCtx();
    const session = createSession();

    await runPlanAudit(ctx, session);

    expect(updatePlanningSession).toHaveBeenCalledWith(
      "proj-1",
      { status: "plan_review" },
      undefined,
    );
  });

  it("posts 'Passed Checks' comment on passing audit", async () => {
    vi.mocked(auditPlan).mockReturnValue({ pass: true, problems: [], warnings: [] });
    const ctx = createCtx();
    const session = createSession();

    await runPlanAudit(ctx, session);

    expect(mockLinearApi.createComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("Plan Passed Checks"),
    );
  });

  it("runs cross-model review automatically on passing audit", async () => {
    vi.mocked(auditPlan).mockReturnValue({ pass: true, problems: [], warnings: [] });
    const ctx = createCtx();
    const session = createSession();

    await runPlanAudit(ctx, session);

    // Default review model is "gemini" (since no primary model configured)
    expect(runGemini).toHaveBeenCalled();
  });

  it("runs planner agent with review prompt including cross-model feedback", async () => {
    vi.mocked(auditPlan).mockReturnValue({ pass: true, problems: [], warnings: [] });
    const ctx = createCtx();
    const session = createSession();

    await runPlanAudit(ctx, session);

    // Agent should run with a review prompt
    expect(runAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("Plan Review"),
      }),
    );
  });

  it("does NOT end session as approved on passing audit (waits for user approval)", async () => {
    vi.mocked(auditPlan).mockReturnValue({ pass: true, problems: [], warnings: [] });
    const ctx = createCtx();
    const session = createSession();

    await runPlanAudit(ctx, session);

    expect(endPlanningSession).not.toHaveBeenCalled();
  });

  it("posts problems on failing audit", async () => {
    vi.mocked(auditPlan).mockReturnValue({
      pass: false,
      problems: ["Missing description on PROJ-2"],
      warnings: [],
    });
    const ctx = createCtx();
    const session = createSession();

    await runPlanAudit(ctx, session);

    expect(mockLinearApi.createComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("Missing description on PROJ-2"),
    );
  });

  it("does NOT transition to plan_review on failing audit", async () => {
    vi.mocked(auditPlan).mockReturnValue({
      pass: false,
      problems: ["No estimates"],
      warnings: [],
    });
    const ctx = createCtx();
    const session = createSession();

    await runPlanAudit(ctx, session);

    expect(updatePlanningSession).not.toHaveBeenCalledWith(
      "proj-1",
      { status: "plan_review" },
      expect.anything(),
    );
  });

  it("includes warnings in success comment when present", async () => {
    vi.mocked(auditPlan).mockReturnValue({
      pass: true,
      problems: [],
      warnings: ["PROJ-3 has no acceptance criteria"],
    });
    const ctx = createCtx();
    const session = createSession();

    await runPlanAudit(ctx, session);

    expect(mockLinearApi.createComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("PROJ-3 has no acceptance criteria"),
    );
  });
});

// ---------------------------------------------------------------------------
// resolveReviewModel
// ---------------------------------------------------------------------------

describe("resolveReviewModel", () => {
  it("returns 'codex' when primary model is claude-based", () => {
    expect(resolveReviewModel({
      agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4" } } },
    } as any)).toBe("codex");
  });

  it("returns 'gemini' when primary model is codex-based", () => {
    expect(resolveReviewModel({
      agents: { defaults: { model: { primary: "openai/codex-3" } } },
    } as any)).toBe("gemini");
  });

  it("returns 'codex' when primary model is gemini-based", () => {
    expect(resolveReviewModel({
      agents: { defaults: { model: { primary: "google/gemini-2" } } },
    } as any)).toBe("codex");
  });

  it("returns 'gemini' when no primary model configured", () => {
    expect(resolveReviewModel({})).toBe("gemini");
  });

  it("respects explicit plannerReviewModel config override", () => {
    expect(resolveReviewModel({
      plannerReviewModel: "gemini",
      agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4" } } },
    } as any)).toBe("gemini");
  });
});

// ---------------------------------------------------------------------------
// runCrossModelReview
// ---------------------------------------------------------------------------

describe("runCrossModelReview", () => {
  it("calls the correct CLI runner for the specified model", async () => {
    const api = createApi();

    await runCrossModelReview(api, "claude", "test snapshot");
    expect(runClaude).toHaveBeenCalled();

    vi.clearAllMocks();
    await runCrossModelReview(api, "codex", "test snapshot");
    expect(runCodex).toHaveBeenCalled();

    vi.clearAllMocks();
    await runCrossModelReview(api, "gemini", "test snapshot");
    expect(runGemini).toHaveBeenCalled();
  });

  it("returns review output on success", async () => {
    const api = createApi();
    const result = await runCrossModelReview(api, "claude", "test snapshot");
    expect(result).toBe("Claude review feedback");
  });

  it("returns graceful fallback on failure", async () => {
    vi.mocked(runClaude).mockResolvedValueOnce({ success: false, error: "timeout" } as any);
    const api = createApi();
    const result = await runCrossModelReview(api, "claude", "test snapshot");
    expect(result).toContain("review failed");
  });

  it("returns graceful fallback on exception", async () => {
    vi.mocked(runClaude).mockRejectedValueOnce(new Error("network error"));
    const api = createApi();
    const result = await runCrossModelReview(api, "claude", "test snapshot");
    expect(result).toContain("review unavailable");
  });
});
