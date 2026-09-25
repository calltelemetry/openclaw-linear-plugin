import { describe, it, expect, vi, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (vi.hoisted + vi.mock)
// ---------------------------------------------------------------------------

const { runAgentMock, loadRawPromptYamlMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn().mockResolvedValue({ success: true, output: "Mock planner response" }),
  loadRawPromptYamlMock: vi.fn().mockReturnValue(null),
}));

vi.mock("../agent/agent.js", () => ({
  runAgent: runAgentMock,
}));

vi.mock("../api/linear-api.js", () => ({}));

vi.mock("openclaw/plugin-sdk/core", () => ({}));

vi.mock("./pipeline.js", () => ({
  loadRawPromptYaml: loadRawPromptYamlMock,
}));

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
  loadRawPromptYamlMock.mockReturnValue(null);
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

    // Agent should run with a review prompt containing cross-model feedback
    expect(runAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("passed checks"),
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

  it("returns '(no feedback)' when runner returns success with no output", async () => {
    vi.mocked(runGemini).mockResolvedValueOnce({ success: true, output: undefined } as any);
    const api = createApi();
    const result = await runCrossModelReview(api, "gemini", "test snapshot");
    expect(result).toBe("(no feedback)");
  });

  it("passes pluginConfig to runner", async () => {
    const api = createApi();
    const cfg = { someKey: "someValue" };
    await runCrossModelReview(api, "codex", "test snapshot", cfg);
    expect(runCodex).toHaveBeenCalledWith(api, expect.any(Object), cfg);
  });
});

// ---------------------------------------------------------------------------
// initiatePlanningSession — additional branch coverage
// ---------------------------------------------------------------------------

describe("initiatePlanningSession — additional branches", () => {
  it("falls back to project teams when rootIssue.team is missing", async () => {
    const rootIssue = {
      id: "issue-1",
      identifier: "PROJ-1",
      title: "Root",
      // No team property
    };

    const ctx = createCtx();
    await initiatePlanningSession(ctx, "proj-1", rootIssue);

    // Should use team from project.teams.nodes[0].id = "team-1"
    expect(registerPlanningSession).toHaveBeenCalledWith(
      "proj-1",
      expect.objectContaining({
        teamId: "team-1",
      }),
      undefined,
    );
  });

  it("throws error when no team can be determined", async () => {
    const rootIssue = {
      id: "issue-1",
      identifier: "PROJ-1",
      title: "Root",
    };

    mockLinearApi.getProject.mockResolvedValueOnce({
      id: "proj-no-team",
      name: "No Team Project",
      teams: { nodes: [] },
    });

    const ctx = createCtx();
    await expect(
      initiatePlanningSession(ctx, "proj-no-team", rootIssue),
    ).rejects.toThrow("Cannot determine team");
  });

  it("uses planningStatePath from pluginConfig", async () => {
    const rootIssue = {
      id: "issue-1",
      identifier: "PROJ-1",
      title: "Root",
      team: { id: "team-1" },
    };

    const ctx = createCtx({
      pluginConfig: { planningStatePath: "/tmp/custom-state.json" },
    });
    await initiatePlanningSession(ctx, "proj-1", rootIssue);

    expect(registerPlanningSession).toHaveBeenCalledWith(
      "proj-1",
      expect.any(Object),
      "/tmp/custom-state.json",
    );
  });
});

// ---------------------------------------------------------------------------
// handlePlannerTurn — additional branch coverage
// ---------------------------------------------------------------------------

describe("handlePlannerTurn — additional branches", () => {
  const input = {
    issueId: "issue-1",
    commentBody: "Continue planning",
    commentorName: "Tester",
  };

  it("does not post comment when agent returns no output", async () => {
    runAgentMock.mockResolvedValueOnce({ success: true, output: "" });
    const ctx = createCtx();
    const session = createSession();

    await handlePlannerTurn(ctx, session, input);

    // createComment should NOT be called (empty output is falsy)
    expect(mockLinearApi.createComment).not.toHaveBeenCalled();
  });

  it("does not post comment when agent returns null output", async () => {
    runAgentMock.mockResolvedValueOnce({ success: true, output: null });
    const ctx = createCtx();
    const session = createSession();

    await handlePlannerTurn(ctx, session, input);

    expect(mockLinearApi.createComment).not.toHaveBeenCalled();
  });

  it("clears planner context even when agent throws", async () => {
    runAgentMock.mockRejectedValueOnce(new Error("agent crash"));
    const ctx = createCtx();
    const session = createSession();

    await expect(
      handlePlannerTurn(ctx, session, input),
    ).rejects.toThrow("agent crash");

    expect(clearActivePlannerContext).toHaveBeenCalled();
  });

  it("uses defaultAgentId from pluginConfig", async () => {
    const ctx = createCtx({
      pluginConfig: { defaultAgentId: "custom-agent" },
    });
    const session = createSession();

    await handlePlannerTurn(ctx, session, input);

    expect(runAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "custom-agent",
      }),
    );
  });

  it("continues even when comment history fetch fails", async () => {
    mockLinearApi.getIssueDetails.mockRejectedValueOnce(new Error("API failure"));
    const ctx = createCtx();
    const session = createSession();

    // Should not throw — best-effort comment history
    await handlePlannerTurn(ctx, session, input);

    expect(runAgentMock).toHaveBeenCalled();
  });

  it("uses planningStatePath from pluginConfig", async () => {
    const ctx = createCtx({
      pluginConfig: { planningStatePath: "/tmp/custom-state.json" },
    });
    const session = createSession();

    await handlePlannerTurn(ctx, session, input);

    expect(updatePlanningSession).toHaveBeenCalledWith(
      "proj-1",
      { turnCount: 1 },
      "/tmp/custom-state.json",
    );
  });
});

// ---------------------------------------------------------------------------
// runPlanAudit — additional branch coverage
// ---------------------------------------------------------------------------

describe("runPlanAudit — additional branches", () => {
  it("includes warnings in failure comment when present", async () => {
    vi.mocked(auditPlan).mockReturnValue({
      pass: false,
      problems: ["Missing estimate on PROJ-3"],
      warnings: ["PROJ-4 is an orphan issue"],
    });
    const ctx = createCtx();
    const session = createSession();

    await runPlanAudit(ctx, session);

    expect(mockLinearApi.createComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("PROJ-4 is an orphan issue"),
    );
  });

  it("failure comment does not include warnings section when none", async () => {
    vi.mocked(auditPlan).mockReturnValue({
      pass: false,
      problems: ["Missing estimate on PROJ-3"],
      warnings: [],
    });
    const ctx = createCtx();
    const session = createSession();

    await runPlanAudit(ctx, session);

    expect(mockLinearApi.createComment).toHaveBeenCalledWith(
      "issue-1",
      expect.not.stringContaining("**Warnings:**"),
    );
  });

  it("does not post review agent comment when output is empty", async () => {
    vi.mocked(auditPlan).mockReturnValue({ pass: true, problems: [], warnings: [] });
    runAgentMock.mockResolvedValueOnce({ success: true, output: "" });
    const ctx = createCtx();
    const session = createSession();

    await runPlanAudit(ctx, session);

    // First call is "Plan Passed Checks" message, there should be no second call for agent output
    const commentCalls = mockLinearApi.createComment.mock.calls;
    const agentOutputCalls = commentCalls.filter(
      (call: any[]) => !String(call[1]).includes("Plan Passed Checks"),
    );
    expect(agentOutputCalls).toHaveLength(0);
  });

  it("clears planner context even if review agent throws", async () => {
    vi.mocked(auditPlan).mockReturnValue({ pass: true, problems: [], warnings: [] });
    runAgentMock.mockRejectedValueOnce(new Error("agent failure"));
    const ctx = createCtx();
    const session = createSession();

    await expect(runPlanAudit(ctx, session)).rejects.toThrow("agent failure");

    expect(clearActivePlannerContext).toHaveBeenCalled();
  });

  it("uses custom plannerReviewModel from pluginConfig", async () => {
    vi.mocked(auditPlan).mockReturnValue({ pass: true, problems: [], warnings: [] });
    const ctx = createCtx({
      pluginConfig: { plannerReviewModel: "claude" },
    });
    const session = createSession();

    await runPlanAudit(ctx, session);

    expect(runClaude).toHaveBeenCalled();
  });

  it("uses defaultAgentId from pluginConfig for review agent", async () => {
    vi.mocked(auditPlan).mockReturnValue({ pass: true, problems: [], warnings: [] });
    const ctx = createCtx({
      pluginConfig: { defaultAgentId: "my-agent" },
    });
    const session = createSession();

    await runPlanAudit(ctx, session);

    expect(runAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "my-agent",
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// resolveReviewModel — additional branch coverage
// ---------------------------------------------------------------------------

describe("resolveReviewModel — additional branches", () => {
  it("ignores invalid plannerReviewModel and falls through", () => {
    expect(resolveReviewModel({
      plannerReviewModel: "invalid-model",
      agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4" } } },
    } as any)).toBe("codex"); // falls through to primary model logic
  });

  it("returns 'gemini' for kimi model", () => {
    expect(resolveReviewModel({
      agents: { defaults: { model: { primary: "openrouter/moonshotai/kimi-k2.5" } } },
    } as any)).toBe("gemini");
  });

  it("returns 'gemini' for mistral model", () => {
    expect(resolveReviewModel({
      agents: { defaults: { model: { primary: "mistral/mistral-large" } } },
    } as any)).toBe("gemini");
  });

  it("returns 'codex' for anthropic model (without claude in name)", () => {
    expect(resolveReviewModel({
      agents: { defaults: { model: { primary: "anthropic/some-model" } } },
    } as any)).toBe("codex");
  });

  it("returns 'gemini' for openai model (without codex in name)", () => {
    expect(resolveReviewModel({
      agents: { defaults: { model: { primary: "openai/gpt-5" } } },
    } as any)).toBe("gemini");
  });

  it("returns 'codex' for google model (without gemini in name)", () => {
    expect(resolveReviewModel({
      agents: { defaults: { model: { primary: "google/palm-3" } } },
    } as any)).toBe("codex");
  });

  it("returns 'gemini' when pluginConfig is undefined", () => {
    expect(resolveReviewModel(undefined)).toBe("gemini");
  });

  it("returns 'gemini' when agents.defaults.model is undefined", () => {
    expect(resolveReviewModel({
      agents: { defaults: {} },
    } as any)).toBe("gemini");
  });

  it("respects plannerReviewModel 'codex'", () => {
    expect(resolveReviewModel({
      plannerReviewModel: "codex",
    } as any)).toBe("codex");
  });

  it("respects plannerReviewModel 'claude'", () => {
    expect(resolveReviewModel({
      plannerReviewModel: "claude",
    } as any)).toBe("claude");
  });
});

// ---------------------------------------------------------------------------
// loadPlannerPrompts — custom YAML prompts branch
// ---------------------------------------------------------------------------

describe("loadPlannerPrompts — via handlePlannerTurn", () => {
  const input = {
    issueId: "issue-1",
    commentBody: "Continue planning",
    commentorName: "Tester",
  };

  it("uses custom planner prompts from YAML when available", async () => {
    loadRawPromptYamlMock.mockReturnValue({
      planner: {
        system: "Custom system prompt",
        interview: "Custom interview: {{userMessage}}",
        // leave other keys undefined to test ?? fallback
      },
    });

    const ctx = createCtx();
    const session = createSession();

    await handlePlannerTurn(ctx, session, input);

    expect(runAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("Custom system prompt"),
      }),
    );
  });

  it("uses default welcome when YAML planner.welcome is undefined", async () => {
    loadRawPromptYamlMock.mockReturnValue({
      planner: {
        welcome: "Custom welcome for **{{projectName}}**!",
      },
    });

    const rootIssue = {
      id: "issue-1",
      identifier: "PROJ-1",
      title: "Root",
      team: { id: "team-1" },
    };

    const ctx = createCtx();
    await initiatePlanningSession(ctx, "proj-1", rootIssue);

    expect(mockLinearApi.createComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("Custom welcome"),
    );
  });
});

// ---------------------------------------------------------------------------
// handlePlannerTurn — comment history with null/missing nodes
// ---------------------------------------------------------------------------

describe("handlePlannerTurn — comment history edge cases", () => {
  const input = {
    issueId: "issue-1",
    commentBody: "Continue",
    commentorName: "Tester",
  };

  it("handles null comments.nodes gracefully", async () => {
    mockLinearApi.getIssueDetails.mockResolvedValueOnce({
      id: "issue-1",
      identifier: "PROJ-1",
      title: "Root",
      comments: { nodes: null },
    });

    const ctx = createCtx();
    const session = createSession();

    // Should not throw — the ?. operator handles null
    await handlePlannerTurn(ctx, session, input);

    expect(runAgentMock).toHaveBeenCalled();
  });

  it("handles undefined comments gracefully", async () => {
    mockLinearApi.getIssueDetails.mockResolvedValueOnce({
      id: "issue-1",
      identifier: "PROJ-1",
      title: "Root",
      // no comments property
    });

    const ctx = createCtx();
    const session = createSession();

    await handlePlannerTurn(ctx, session, input);

    expect(runAgentMock).toHaveBeenCalled();
  });

  it("handles comments with missing user name", async () => {
    mockLinearApi.getIssueDetails.mockResolvedValueOnce({
      id: "issue-1",
      identifier: "PROJ-1",
      title: "Root",
      comments: {
        nodes: [
          { body: "A comment", user: null },
          { body: "Another comment", user: { name: "Alice" } },
        ],
      },
    });

    const ctx = createCtx();
    const session = createSession();

    await handlePlannerTurn(ctx, session, input);

    expect(runAgentMock).toHaveBeenCalled();
  });
});
