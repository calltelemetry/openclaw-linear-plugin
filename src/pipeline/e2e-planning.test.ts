/**
 * E2E planning pipeline tests.
 *
 * Exercises the real planning lifecycle: initiatePlanningSession → handlePlannerTurn
 * → runPlanAudit → plan_review → (webhook handles approval) → DAG dispatch cascade.
 *
 * Mocked: runAgent, LinearAgentApi, CLI tool runners. Real: planning-state.ts,
 * planner.ts, planner-tools.ts (auditPlan, buildPlanSnapshot), dag-dispatch.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — external boundaries only
// ---------------------------------------------------------------------------

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn().mockResolvedValue({ success: true, output: "Mock planner response" }),
}));

vi.mock("../agent/agent.js", () => ({
  runAgent: runAgentMock,
}));

vi.mock("../api/linear-api.js", () => ({}));
vi.mock("openclaw/plugin-sdk/core", () => ({}));
vi.mock("../infra/observability.js", () => ({
  emitDiagnostic: vi.fn(),
}));

// Mock CLI tool runners for cross-model review
vi.mock("../tools/claude-tool.js", () => ({
  runClaude: vi.fn().mockResolvedValue({ success: true, output: "Claude review: looks good" }),
}));
vi.mock("../tools/codex-tool.js", () => ({
  runCodex: vi.fn().mockResolvedValue({ success: true, output: "Codex review: approved" }),
}));
vi.mock("../tools/gemini-tool.js", () => ({
  runGemini: vi.fn().mockResolvedValue({ success: true, output: "Gemini review: no issues" }),
}));

// ---------------------------------------------------------------------------
// Imports (AFTER mocks)
// ---------------------------------------------------------------------------

import { initiatePlanningSession, handlePlannerTurn, runPlanAudit } from "./planner.js";
import { readPlanningState, type PlanningSession } from "./planning-state.js";
import { writeProjectDispatch, readProjectDispatch, onProjectIssueCompleted, onProjectIssueStuck, type ProjectDispatchState } from "./dag-dispatch.js";
import { createMockLinearApi, tmpStatePath } from "../__test__/helpers.js";
import { makeProjectIssue } from "../__test__/fixtures/linear-responses.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCtx(configPath: string, overrides?: Record<string, unknown>) {
  const linearApi = createMockLinearApi();
  return {
    ctx: {
      api: {
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        pluginConfig: { planningStatePath: configPath, ...overrides },
      } as any,
      linearApi: linearApi as any,
      pluginConfig: { planningStatePath: configPath, ...overrides },
    },
    linearApi,
  };
}

function createSession(configPath: string, overrides?: Partial<PlanningSession>): PlanningSession {
  return {
    projectId: "proj-1",
    projectName: "Test Project",
    rootIssueId: "issue-1",
    rootIdentifier: "PROJ-1",
    teamId: "team-1",
    status: "interviewing",
    startedAt: new Date().toISOString(),
    turnCount: 0,
    ...overrides,
  };
}

/** Build a set of project issues that will pass auditPlan (description ≥ 50 chars, estimate, priority). */
function makePassingIssues() {
  return [
    makeProjectIssue("PROJ-2", {
      title: "Implement search API",
      description: "As a user, I want a search API so that I can find content. Given I send a query, When results exist, Then they are returned with pagination.",
      estimate: 3,
      priority: 2,
      labels: ["Epic"],
    }),
    makeProjectIssue("PROJ-3", {
      title: "Build search results page",
      description: "As a user, I want to see search results in a page. Given I perform a search, When results load, Then I see a paginated list of matching items.",
      estimate: 2,
      priority: 2,
      parentIdentifier: "PROJ-2",
    }),
    makeProjectIssue("PROJ-4", {
      title: "Add search autocomplete",
      description: "As a user, I want autocomplete suggestions. Given I type in the search box, When 3+ characters entered, Then suggestions appear from the typeahead API.",
      estimate: 1,
      priority: 3,
      parentIdentifier: "PROJ-2",
    }),
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E planning pipeline", () => {
  let configPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    configPath = tmpStatePath("claw-e2e-plan-");
    runAgentMock.mockResolvedValue({ success: true, output: "Mock planner response" });
  });

  // =========================================================================
  // Test 1: Full lifecycle — initiate → interview → audit → plan_review
  // =========================================================================
  it("full lifecycle: initiate → interview turns → audit → plan_review", async () => {
    const { ctx, linearApi } = createCtx(configPath);

    const rootIssue = { id: "issue-1", identifier: "PROJ-1", title: "Root Issue", team: { id: "team-1" } };

    // Mock getProject and getTeamStates for initiation
    linearApi.getProject.mockResolvedValue({
      id: "proj-1",
      name: "Test Project",
      teams: { nodes: [{ id: "team-1", name: "Team" }] },
    });
    linearApi.getTeamStates.mockResolvedValue([
      { id: "st-1", name: "Backlog", type: "backlog" },
    ]);

    // Step 1: Initiate planning session
    await initiatePlanningSession(ctx, "proj-1", rootIssue);

    // Verify welcome comment posted
    expect(linearApi.createComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("planning mode"),
    );

    // Verify session registered
    let state = await readPlanningState(configPath);
    expect(state.sessions["proj-1"]).toBeDefined();
    expect(state.sessions["proj-1"].status).toBe("interviewing");
    expect(state.sessions["proj-1"].turnCount).toBe(0);

    // Step 2: Interview turn 1
    const session = createSession(configPath);

    // Mock getProjectIssues and getIssueDetails for interview
    linearApi.getProjectIssues.mockResolvedValue([]);
    linearApi.getIssueDetails.mockResolvedValue({
      id: "issue-1",
      identifier: "PROJ-1",
      title: "Root Issue",
      comments: { nodes: [] },
      project: { id: "proj-1" },
      team: { id: "team-1" },
    });

    await handlePlannerTurn(ctx, session, {
      issueId: "issue-1",
      commentBody: "Build a search API and results page",
      commentorName: "User",
    });

    // Verify runAgent called for interview
    expect(runAgentMock).toHaveBeenCalledTimes(1);

    // Verify agent response posted as comment
    expect(linearApi.createComment).toHaveBeenCalledWith("issue-1", "Mock planner response");

    // Verify turnCount incremented
    state = await readPlanningState(configPath);
    expect(state.sessions["proj-1"].turnCount).toBe(1);

    // Step 3: Interview turn 2
    vi.clearAllMocks();
    runAgentMock.mockResolvedValue({ success: true, output: "Great, plan updated." });

    const session2 = { ...session, turnCount: 1 };
    await handlePlannerTurn(ctx, session2, {
      issueId: "issue-1",
      commentBody: "Add autocomplete too",
      commentorName: "User",
    });

    expect(runAgentMock).toHaveBeenCalledTimes(1);
    state = await readPlanningState(configPath);
    expect(state.sessions["proj-1"].turnCount).toBe(2);

    // Step 4: Audit — with passing issues
    // Note: finalize intent detection now happens in webhook.ts, not handlePlannerTurn.
    // We call runPlanAudit directly (as the webhook would after intent classification).
    vi.clearAllMocks();
    runAgentMock.mockResolvedValue({ success: true, output: "Review complete." });
    linearApi.getProjectIssues.mockResolvedValue(makePassingIssues());

    const session3 = { ...session, turnCount: 2 };
    await runPlanAudit(ctx, session3);

    // Verify "Plan Passed Checks" comment (not "Approved" — that comes from webhook)
    expect(linearApi.createComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("Plan Passed Checks"),
    );

    // Session transitions to plan_review (awaiting user's "approve plan")
    state = await readPlanningState(configPath);
    expect(state.sessions["proj-1"].status).toBe("plan_review");

    // Cross-model review ran (runAgent called for review prompt)
    expect(runAgentMock).toHaveBeenCalled();
  });

  // =========================================================================
  // Test 2: Audit fail → fix issues → re-audit → plan_review
  // =========================================================================
  it("audit fail → fix issues → re-audit → plan_review", async () => {
    const { ctx, linearApi } = createCtx(configPath);
    const session = createSession(configPath);

    // Register session so updatePlanningSession/endPlanningSession can find it
    const { registerPlanningSession } = await import("./planning-state.js");
    await registerPlanningSession("proj-1", session, configPath);

    linearApi.getIssueDetails.mockResolvedValue({
      id: "issue-1",
      identifier: "PROJ-1",
      title: "Root Issue",
      comments: { nodes: [] },
    });

    // First audit — with issues that fail (missing descriptions/estimates)
    linearApi.getProjectIssues.mockResolvedValue([
      makeProjectIssue("PROJ-2", {
        title: "Bad issue",
        description: "short", // <50 chars → audit fails
      }),
    ]);

    await runPlanAudit(ctx, session);

    // Verify "Plan Audit Failed" comment
    expect(linearApi.createComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("Plan Audit Failed"),
    );

    // Session should still be interviewing (NOT plan_review)
    let state = await readPlanningState(configPath);
    expect(state.sessions["proj-1"].status).toBe("interviewing");

    // Second audit — with proper issues
    vi.clearAllMocks();
    runAgentMock.mockResolvedValue({ success: true, output: "Review complete." });
    linearApi.getProjectIssues.mockResolvedValue(makePassingIssues());

    await runPlanAudit(ctx, session);

    // Now should be plan_review (waiting for user approval via webhook)
    expect(linearApi.createComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("Plan Passed Checks"),
    );

    state = await readPlanningState(configPath);
    expect(state.sessions["proj-1"].status).toBe("plan_review");
  });

  // =========================================================================
  // Test 3: handlePlannerTurn is pure continue — no intent detection
  // =========================================================================
  it("handlePlannerTurn always runs agent regardless of message content", async () => {
    const { ctx, linearApi } = createCtx(configPath);
    const session = createSession(configPath);

    const { registerPlanningSession } = await import("./planning-state.js");
    await registerPlanningSession("proj-1", session, configPath);

    linearApi.getProjectIssues.mockResolvedValue([]);
    linearApi.getIssueDetails.mockResolvedValue({
      id: "issue-1",
      identifier: "PROJ-1",
      title: "Root Issue",
      comments: { nodes: [] },
    });

    // Even "finalize plan" goes through the agent (intent detection is in webhook)
    await handlePlannerTurn(ctx, session, {
      issueId: "issue-1",
      commentBody: "finalize plan",
      commentorName: "User",
    });

    expect(runAgentMock).toHaveBeenCalledTimes(1);
    expect(linearApi.createComment).toHaveBeenCalledWith("issue-1", "Mock planner response");
  });

  // =========================================================================
  // Test 4: Audit with warnings still passes
  // =========================================================================
  it("audit passes with warnings (AC warnings do not block)", async () => {
    const { ctx, linearApi } = createCtx(configPath);
    const session = createSession(configPath);

    const { registerPlanningSession } = await import("./planning-state.js");
    await registerPlanningSession("proj-1", session, configPath);

    // Issues that pass but lack AC markers → warnings
    linearApi.getProjectIssues.mockResolvedValue([
      makeProjectIssue("PROJ-2", {
        title: "Search feature",
        description: "Build the search API endpoint with filtering and pagination support for the frontend application.",
        estimate: 3,
        priority: 2,
        labels: ["Epic"],
      }),
    ]);

    runAgentMock.mockResolvedValue({ success: true, output: "Review with warnings." });

    await runPlanAudit(ctx, session);

    // Still passes (warnings are not problems)
    expect(linearApi.createComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("Plan Passed Checks"),
    );

    const state = await readPlanningState(configPath);
    expect(state.sessions["proj-1"].status).toBe("plan_review");
  });

  // =========================================================================
  // Test 5: DAG cascade — full chain
  // =========================================================================
  it("DAG cascade: complete issues in sequence, project completes", async () => {
    const dagConfigPath = tmpStatePath("claw-e2e-dag-");
    const notifyCalls: Array<[string, unknown]> = [];
    const hookCtx = {
      api: {
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      } as any,
      linearApi: {} as any,
      notify: vi.fn(async (kind: string, payload: unknown) => {
        notifyCalls.push([kind, payload]);
      }),
      pluginConfig: {},
      configPath: dagConfigPath,
    };

    // Set up 3-issue project: A → B → C
    const projectDispatch: ProjectDispatchState = {
      projectId: "proj-1",
      projectName: "Test Project",
      rootIdentifier: "PROJ-1",
      status: "dispatching",
      startedAt: new Date().toISOString(),
      maxConcurrent: 3,
      issues: {
        "PROJ-A": {
          identifier: "PROJ-A",
          issueId: "id-a",
          dependsOn: [],
          unblocks: ["PROJ-B"],
          dispatchStatus: "dispatched",
        },
        "PROJ-B": {
          identifier: "PROJ-B",
          issueId: "id-b",
          dependsOn: ["PROJ-A"],
          unblocks: ["PROJ-C"],
          dispatchStatus: "pending",
        },
        "PROJ-C": {
          identifier: "PROJ-C",
          issueId: "id-c",
          dependsOn: ["PROJ-B"],
          unblocks: [],
          dispatchStatus: "pending",
        },
      },
    };
    await writeProjectDispatch(projectDispatch, dagConfigPath);

    // Complete A → B becomes ready
    await onProjectIssueCompleted(hookCtx, "proj-1", "PROJ-A");

    let state = await readProjectDispatch("proj-1", dagConfigPath);
    expect(state!.issues["PROJ-A"].dispatchStatus).toBe("done");
    expect(state!.issues["PROJ-B"].dispatchStatus).toBe("dispatched");
    expect(state!.issues["PROJ-C"].dispatchStatus).toBe("pending");
    expect(state!.status).toBe("dispatching");

    // Complete B → C becomes ready
    await onProjectIssueCompleted(hookCtx, "proj-1", "PROJ-B");

    state = await readProjectDispatch("proj-1", dagConfigPath);
    expect(state!.issues["PROJ-B"].dispatchStatus).toBe("done");
    expect(state!.issues["PROJ-C"].dispatchStatus).toBe("dispatched");
    expect(state!.status).toBe("dispatching");

    // Complete C → project complete
    await onProjectIssueCompleted(hookCtx, "proj-1", "PROJ-C");

    state = await readProjectDispatch("proj-1", dagConfigPath);
    expect(state!.issues["PROJ-C"].dispatchStatus).toBe("done");
    expect(state!.status).toBe("completed");

    // Verify notifications
    const progressNotifications = notifyCalls.filter(([k]) => k === "project_progress");
    const completeNotifications = notifyCalls.filter(([k]) => k === "project_complete");
    expect(progressNotifications.length).toBe(2); // after A, after B
    expect(completeNotifications.length).toBe(1); // after C
  });

  // =========================================================================
  // Test 6: DAG stuck
  // =========================================================================
  it("DAG stuck: stuck issue blocks dependent, project stuck", async () => {
    const dagConfigPath = tmpStatePath("claw-e2e-dag-stuck-");
    const hookCtx = {
      api: {
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      } as any,
      linearApi: {} as any,
      notify: vi.fn().mockResolvedValue(undefined),
      pluginConfig: {},
      configPath: dagConfigPath,
    };

    // 2-issue project: A → B
    const projectDispatch: ProjectDispatchState = {
      projectId: "proj-1",
      projectName: "Test Project",
      rootIdentifier: "PROJ-1",
      status: "dispatching",
      startedAt: new Date().toISOString(),
      maxConcurrent: 3,
      issues: {
        "PROJ-A": {
          identifier: "PROJ-A",
          issueId: "id-a",
          dependsOn: [],
          unblocks: ["PROJ-B"],
          dispatchStatus: "dispatched",
        },
        "PROJ-B": {
          identifier: "PROJ-B",
          issueId: "id-b",
          dependsOn: ["PROJ-A"],
          unblocks: [],
          dispatchStatus: "pending",
        },
      },
    };
    await writeProjectDispatch(projectDispatch, dagConfigPath);

    // A gets stuck
    await onProjectIssueStuck(hookCtx, "proj-1", "PROJ-A");

    const state = await readProjectDispatch("proj-1", dagConfigPath);
    expect(state!.issues["PROJ-A"].dispatchStatus).toBe("stuck");
    expect(state!.issues["PROJ-B"].dispatchStatus).toBe("pending"); // still blocked
    expect(state!.status).toBe("stuck"); // project stuck — no progress possible
  });
});
