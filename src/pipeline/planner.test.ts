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

import { initiatePlanningSession, handlePlannerTurn, runPlanAudit } from "./planner.js";
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

  it("detects finalize plan intent and triggers audit instead of regular turn", async () => {
    const ctx = createCtx();
    const session = createSession();

    await handlePlannerTurn(ctx, session, {
      issueId: "issue-1",
      commentBody: "finalize plan",
      commentorName: "Tester",
    });

    // Audit path: auditPlan is called, runAgent is NOT called
    expect(auditPlan).toHaveBeenCalled();
    expect(runAgentMock).not.toHaveBeenCalled();
  });

  it("detects abandon intent and ends session as abandoned", async () => {
    const ctx = createCtx();
    const session = createSession();

    await handlePlannerTurn(ctx, session, {
      issueId: "issue-1",
      commentBody: "abandon planning",
      commentorName: "Tester",
    });

    expect(endPlanningSession).toHaveBeenCalledWith(
      "proj-1",
      "abandoned",
      undefined,
    );
    // Should NOT run the agent
    expect(runAgentMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// runPlanAudit
// ---------------------------------------------------------------------------

describe("runPlanAudit", () => {
  it("posts success comment on passing audit", async () => {
    vi.mocked(auditPlan).mockReturnValue({ pass: true, problems: [], warnings: [] });
    const ctx = createCtx();
    const session = createSession();

    await runPlanAudit(ctx, session);

    expect(mockLinearApi.createComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("Approved"),
    );
  });

  it("ends session as approved on pass", async () => {
    vi.mocked(auditPlan).mockReturnValue({ pass: true, problems: [], warnings: [] });
    const ctx = createCtx();
    const session = createSession();

    await runPlanAudit(ctx, session);

    expect(endPlanningSession).toHaveBeenCalledWith(
      "proj-1",
      "approved",
      undefined,
    );
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

  it("does NOT end session as approved on fail", async () => {
    vi.mocked(auditPlan).mockReturnValue({
      pass: false,
      problems: ["No estimates"],
      warnings: [],
    });
    const ctx = createCtx();
    const session = createSession();

    await runPlanAudit(ctx, session);

    expect(endPlanningSession).not.toHaveBeenCalledWith(
      "proj-1",
      "approved",
      expect.anything(),
    );
  });
});
