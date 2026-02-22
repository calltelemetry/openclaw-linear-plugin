/**
 * webhook-scenarios.test.ts — Full handler flow tests using captured payloads.
 *
 * Replays webhook payloads through handleLinearWebhook with mocked API
 * dependencies. Tests the complete async handler behavior for each event
 * type: API calls made, session lifecycle, agent runs, and responses.
 *
 * Unlike webhook-dedup.test.ts (dedup logic) and webhook.test.ts (HTTP basics),
 * these tests verify the full business logic paths end-to-end.
 *
 * Key pattern: handlers prefer emitActivity(response) over createComment
 * when an agent session exists — createComment is only used as a fallback
 * when the session activity emission fails.
 */
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mock references ──────────────────────────────────────

const {
  mockRunAgent,
  mockGetViewerId,
  mockGetIssueDetails,
  mockCreateComment,
  mockEmitActivity,
  mockUpdateSession,
  mockUpdateIssue,
  mockGetTeamLabels,
  mockGetTeamStates,
  mockCreateSessionOnIssue,
  mockClassifyIntent,
  mockSpawnWorker,
  mockSetActiveSession,
  mockClearActiveSession,
  mockEmitDiagnostic,
} = vi.hoisted(() => ({
  mockRunAgent: vi.fn(),
  mockGetViewerId: vi.fn(),
  mockGetIssueDetails: vi.fn(),
  mockCreateComment: vi.fn(),
  mockEmitActivity: vi.fn(),
  mockUpdateSession: vi.fn(),
  mockUpdateIssue: vi.fn(),
  mockGetTeamLabels: vi.fn(),
  mockGetTeamStates: vi.fn(),
  mockCreateSessionOnIssue: vi.fn(),
  mockClassifyIntent: vi.fn(),
  mockSpawnWorker: vi.fn(),
  mockSetActiveSession: vi.fn(),
  mockClearActiveSession: vi.fn(),
  mockEmitDiagnostic: vi.fn(),
}));

// ── Module mocks (must precede all imports of tested code) ───────

vi.mock("../agent/agent.js", () => ({
  runAgent: mockRunAgent,
}));

vi.mock("../api/linear-api.js", () => ({
  LinearAgentApi: class MockLinearAgentApi {
    emitActivity = mockEmitActivity;
    createComment = mockCreateComment;
    getIssueDetails = mockGetIssueDetails;
    updateSession = mockUpdateSession;
    getViewerId = mockGetViewerId;
    updateIssue = mockUpdateIssue;
    getTeamLabels = mockGetTeamLabels;
    getTeamStates = mockGetTeamStates;
    createSessionOnIssue = mockCreateSessionOnIssue;
  },
  resolveLinearToken: vi.fn().mockReturnValue({
    accessToken: "test-token",
    source: "env",
  }),
}));

vi.mock("../pipeline/pipeline.js", () => ({
  spawnWorker: mockSpawnWorker,
  runPlannerStage: vi.fn().mockResolvedValue("mock plan"),
  runFullPipeline: vi.fn().mockResolvedValue(undefined),
  resumePipeline: vi.fn().mockResolvedValue(undefined),
  buildProjectContext: () => "",
}));

vi.mock("../pipeline/active-session.js", () => ({
  setActiveSession: mockSetActiveSession,
  clearActiveSession: mockClearActiveSession,
  getIssueAffinity: vi.fn().mockReturnValue(null),
  _configureAffinityTtl: vi.fn(),
  _resetAffinityForTesting: vi.fn(),
}));

vi.mock("../infra/observability.js", () => ({
  emitDiagnostic: mockEmitDiagnostic,
}));

vi.mock("../pipeline/intent-classify.js", () => ({
  classifyIntent: mockClassifyIntent,
}));

vi.mock("../pipeline/dispatch-state.js", () => ({
  readDispatchState: vi.fn().mockResolvedValue({ version: 2, dispatches: { active: {}, completed: {} }, sessionMap: {}, processedEvents: [] }),
  getActiveDispatch: vi.fn().mockReturnValue(null),
  registerDispatch: vi.fn().mockResolvedValue(undefined),
  updateDispatchStatus: vi.fn().mockResolvedValue(undefined),
  completeDispatch: vi.fn().mockResolvedValue(undefined),
  removeActiveDispatch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../infra/notify.js", () => ({
  createNotifierFromConfig: vi.fn(() => vi.fn().mockResolvedValue(undefined)),
}));

vi.mock("../pipeline/tier-assess.js", () => ({
  assessTier: vi.fn().mockResolvedValue({ tier: "standard", model: "test-model", reasoning: "mock assessment" }),
}));

vi.mock("../infra/codex-worktree.js", () => ({
  createWorktree: vi.fn().mockReturnValue({ path: "/tmp/mock-worktree", branch: "codex/ENG-123", resumed: false }),
  createMultiWorktree: vi.fn(),
  prepareWorkspace: vi.fn().mockReturnValue({ pulled: false, submodulesInitialized: false, errors: [] }),
}));

vi.mock("../infra/multi-repo.js", () => ({
  resolveRepos: vi.fn().mockReturnValue({ repos: [] }),
  isMultiRepo: vi.fn().mockReturnValue(false),
}));

vi.mock("../pipeline/artifacts.js", () => ({
  ensureClawDir: vi.fn(),
  writeManifest: vi.fn(),
  writeDispatchMemory: vi.fn(),
  resolveOrchestratorWorkspace: vi.fn().mockReturnValue("/mock/workspace"),
}));

vi.mock("../pipeline/planning-state.js", () => ({
  readPlanningState: vi.fn().mockResolvedValue({ sessions: {} }),
  isInPlanningMode: vi.fn().mockReturnValue(false),
  getPlanningSession: vi.fn().mockReturnValue(null),
  endPlanningSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../pipeline/planner.js", () => ({
  initiatePlanningSession: vi.fn().mockResolvedValue(undefined),
  handlePlannerTurn: vi.fn().mockResolvedValue(undefined),
  runPlanAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../pipeline/dag-dispatch.js", () => ({
  startProjectDispatch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../infra/shared-profiles.js", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, validateProfiles: vi.fn().mockReturnValue(null) };
});

// ── Imports (after mocks) ────────────────────────────────────────

import { handleLinearWebhook, _resetForTesting } from "../pipeline/webhook.js";
import {
  makeAgentSessionEventCreated,
  makeAgentSessionEventPrompted,
  makeCommentCreate,
  makeCommentCreateFromBot,
  makeIssueCreate,
  makeIssueUpdateWithAssignment,
  makeAppUserNotification,
} from "./fixtures/webhook-payloads.js";
import { makeIssueDetails } from "./fixtures/linear-responses.js";

// ── Helpers ──────────────────────────────────────────────────────

function createApi(): OpenClawPluginApi {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    runtime: {},
    pluginConfig: { defaultAgentId: "mal" },
  } as unknown as OpenClawPluginApi;
}

async function withServer(
  handler: Parameters<typeof createServer>[0],
  fn: (baseUrl: string) => Promise<void>,
) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error("missing server address");
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function postWebhook(api: OpenClawPluginApi, payload: unknown) {
  let status = 0;
  let body = "";
  await withServer(
    async (req, res) => {
      await handleLinearWebhook(api, req, res);
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/linear/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      status = response.status;
      body = await response.text();
    },
  );
  return { status, body };
}

function infoLogs(api: OpenClawPluginApi): string[] {
  return (api.logger.info as ReturnType<typeof vi.fn>).mock.calls.map(
    (c: unknown[]) => String(c[0]),
  );
}

function errorLogs(api: OpenClawPluginApi): string[] {
  return (api.logger.error as ReturnType<typeof vi.fn>).mock.calls.map(
    (c: unknown[]) => String(c[0]),
  );
}

/**
 * Wait for a mock to be called within a timeout.
 * Used for fire-and-forget `void (async () => {...})()` handlers.
 */
async function waitForMock(
  mock: ReturnType<typeof vi.fn>,
  opts?: { timeout?: number; times?: number },
): Promise<void> {
  const timeout = opts?.timeout ?? 2000;
  const times = opts?.times ?? 1;
  await vi.waitFor(
    () => { expect(mock).toHaveBeenCalledTimes(times); },
    { timeout, interval: 50 },
  );
}

/** Extract emitActivity calls that have a specific type (thought, response, error, action). */
function activityCallsOfType(type: string): unknown[][] {
  return mockEmitActivity.mock.calls.filter(
    (c: unknown[]) => (c[1] as any)?.type === type,
  );
}

// ── Setup / Teardown ─────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTesting();

  // Default mock behaviors
  mockGetViewerId.mockResolvedValue("viewer-bot-1");
  mockGetIssueDetails.mockResolvedValue(makeIssueDetails());
  mockCreateComment.mockResolvedValue("comment-new-id");
  mockEmitActivity.mockResolvedValue(undefined);
  mockUpdateSession.mockResolvedValue(undefined);
  mockUpdateIssue.mockResolvedValue(true);
  mockCreateSessionOnIssue.mockResolvedValue({ sessionId: "session-mock-1" });
  mockGetTeamLabels.mockResolvedValue([
    { id: "label-bug", name: "Bug" },
    { id: "label-feature", name: "Feature" },
  ]);
  mockGetTeamStates.mockResolvedValue([
    { id: "st-backlog", name: "Backlog", type: "backlog" },
    { id: "st-started", name: "In Progress", type: "started" },
    { id: "st-done", name: "Done", type: "completed" },
    { id: "st-canceled", name: "Canceled", type: "canceled" },
  ]);
  mockRunAgent.mockResolvedValue({ success: true, output: "Agent response text" });
  mockSpawnWorker.mockResolvedValue(undefined);
  mockClassifyIntent.mockResolvedValue({
    intent: "general",
    reasoning: "test fallback",
    fromFallback: true,
  });
});

afterEach(() => {
  _resetForTesting();
});

// ── Tests ────────────────────────────────────────────────────────

describe("webhook scenario tests — full handler flows", () => {
  describe("AgentSessionEvent", () => {
    it("created: runs agent, delivers response via emitActivity", async () => {
      const api = createApi();
      const payload = makeAgentSessionEventCreated();
      const result = await postWebhook(api, payload);
      expect(result.status).toBe(200);

      // Wait for the fire-and-forget handler to complete
      await waitForMock(mockClearActiveSession);

      // Issue enrichment
      expect(mockGetIssueDetails).toHaveBeenCalledWith("issue-1");

      // Agent invoked with correct session/message
      expect(mockRunAgent).toHaveBeenCalledOnce();
      const runArgs = mockRunAgent.mock.calls[0][0];
      expect(runArgs.sessionId).toContain("linear-session-sess-event-1");
      expect(runArgs.message).toContain("ENG-123");

      // emitActivity called with thought and response
      expect(activityCallsOfType("thought").length).toBeGreaterThan(0);
      expect(activityCallsOfType("response").length).toBeGreaterThan(0);

      // Response delivered via emitActivity (session-first pattern),
      // NOT via createComment — avoids duplicate visible messages.
      expect(mockCreateComment).not.toHaveBeenCalled();

      // Session lifecycle
      expect(mockSetActiveSession).toHaveBeenCalledWith(
        expect.objectContaining({ issueId: "issue-1", agentSessionId: "sess-event-1" }),
      );
      expect(mockClearActiveSession).toHaveBeenCalledWith("issue-1");
    });

    it("created: falls back to createComment when emitActivity fails", async () => {
      // Make the response emitActivity fail — comment is the fallback
      let emitCallCount = 0;
      mockEmitActivity.mockImplementation(async (_sessionId: string, content: any) => {
        emitCallCount++;
        // Let the "thought" emission succeed, but fail the "response" emission
        if (content?.type === "response") {
          throw new Error("session expired");
        }
      });

      const api = createApi();
      const payload = makeAgentSessionEventCreated();
      await postWebhook(api, payload);

      await waitForMock(mockClearActiveSession);

      // runAgent was called
      expect(mockRunAgent).toHaveBeenCalledOnce();

      // emitActivity(response) failed → fell back to createComment
      expect(mockCreateComment).toHaveBeenCalledOnce();
      const commentBody = mockCreateComment.mock.calls[0][1] as string;
      expect(commentBody).toContain("Agent response text");
    });

    it("prompted: processes follow-up, delivers via emitActivity", async () => {
      const api = createApi();
      const payload = makeAgentSessionEventPrompted();
      const result = await postWebhook(api, payload);
      expect(result.status).toBe(200);

      await waitForMock(mockClearActiveSession);

      expect(mockRunAgent).toHaveBeenCalledOnce();
      const msg = mockRunAgent.mock.calls[0][0].message;
      expect(msg).toContain("Follow-up question here");

      // Response via emitActivity, not createComment
      expect(activityCallsOfType("response").length).toBeGreaterThan(0);
      expect(mockCreateComment).not.toHaveBeenCalled();
      expect(mockClearActiveSession).toHaveBeenCalledWith("issue-1");
    });

    it("created with missing data: logs error, no crash", async () => {
      const api = createApi();
      const payload = {
        type: "AgentSessionEvent",
        action: "created",
        agentSession: { id: null, issue: null },
        previousComments: [],
      };
      const result = await postWebhook(api, payload);
      expect(result.status).toBe(200);

      const errors = errorLogs(api);
      expect(errors.some((e) => e.includes("missing session or issue"))).toBe(true);
      expect(mockRunAgent).not.toHaveBeenCalled();
    });
  });

  describe("Comment.create", () => {
    it("ask_agent intent: dispatches to named agent", async () => {
      mockClassifyIntent.mockResolvedValue({
        intent: "ask_agent",
        agentId: "mal",
        reasoning: "user asking for work",
        fromFallback: false,
      });

      const api = createApi();
      const payload = makeCommentCreate({
        data: {
          id: "comment-intent-1",
          body: "Can someone look at this issue?",
          user: { id: "user-human", name: "Human" },
          issue: {
            id: "issue-intent-1",
            identifier: "ENG-301",
            title: "Intent test",
            team: { id: "team-1" },
            project: null,
          },
          createdAt: new Date().toISOString(),
        },
      });
      await postWebhook(api, payload);

      // Wait for the full dispatch to complete
      await waitForMock(mockClearActiveSession);

      expect(mockClassifyIntent).toHaveBeenCalledOnce();
      expect(mockRunAgent).toHaveBeenCalledOnce();

      // Session created → response via emitActivity
      expect(activityCallsOfType("response").length).toBeGreaterThan(0);
    });

    it("request_work intent: dispatches to default agent", async () => {
      mockClassifyIntent.mockResolvedValue({
        intent: "request_work",
        reasoning: "user wants implementation",
        fromFallback: false,
      });

      const api = createApi();
      const payload = makeCommentCreate({
        data: {
          id: "comment-work-1",
          body: "Please implement the login page",
          user: { id: "user-human", name: "Human" },
          issue: {
            id: "issue-work-1",
            identifier: "ENG-350",
            title: "Login implementation",
            team: { id: "team-1" },
            project: null,
          },
          createdAt: new Date().toISOString(),
        },
      });
      await postWebhook(api, payload);

      await waitForMock(mockRunAgent);

      expect(mockClassifyIntent).toHaveBeenCalledOnce();

      const logs = infoLogs(api);
      expect(logs.some((l) => l.includes("request_work"))).toBe(true);
      expect(mockRunAgent).toHaveBeenCalledOnce();
    });

    it("bot's own comment: skips without running agent", async () => {
      const api = createApi();
      const payload = makeCommentCreateFromBot("viewer-bot-1");
      await postWebhook(api, payload);
      // Small wait for the async getViewerId check
      await new Promise((r) => setTimeout(r, 100));

      const logs = infoLogs(api);
      expect(logs.some((l) => l.includes("skipping our own comment"))).toBe(true);
      expect(mockRunAgent).not.toHaveBeenCalled();
      expect(mockClassifyIntent).not.toHaveBeenCalled();
    });

    it("general intent: no action taken, no agent run", async () => {
      const api = createApi();
      const payload = makeCommentCreate({
        data: {
          id: "comment-general-1",
          body: "Thanks for the update",
          user: { id: "user-human", name: "Human" },
          issue: {
            id: "issue-general-1",
            identifier: "ENG-302",
            title: "General test",
            team: { id: "team-1" },
            project: null,
          },
          createdAt: new Date().toISOString(),
        },
      });
      await postWebhook(api, payload);
      await vi.waitFor(
        () => { expect(mockClassifyIntent).toHaveBeenCalledOnce(); },
        { timeout: 2000, interval: 50 },
      );

      const logs = infoLogs(api);
      expect(logs.some((l) => l.includes("no action taken"))).toBe(true);
      expect(mockRunAgent).not.toHaveBeenCalled();
    });

    it("close_issue intent: generates closure report, transitions state, posts comment", async () => {
      mockClassifyIntent.mockResolvedValue({
        intent: "close_issue",
        reasoning: "user wants to close the issue",
        fromFallback: false,
      });

      mockRunAgent.mockResolvedValueOnce({
        success: true,
        output: "**Summary**: Fixed the authentication bug.\n**Resolution**: Updated token refresh logic.",
      });

      const api = createApi();
      const payload = makeCommentCreate({
        data: {
          id: "comment-close-1",
          body: "close this issue",
          user: { id: "user-human", name: "Human" },
          issue: {
            id: "issue-close-1",
            identifier: "ENG-400",
            title: "Auth bug fix",
            team: { id: "team-1" },
            project: null,
          },
          createdAt: new Date().toISOString(),
        },
      });
      await postWebhook(api, payload);

      await waitForMock(mockClearActiveSession);

      // Agent ran with readOnly for closure report
      expect(mockRunAgent).toHaveBeenCalledOnce();
      const runArgs = mockRunAgent.mock.calls[0][0];
      expect(runArgs.readOnly).toBe(true);
      expect(runArgs.message).toContain("closure report");

      // Issue state transitioned to completed
      expect(mockUpdateIssue).toHaveBeenCalledWith("issue-close-1", { stateId: "st-done" });

      // Team states fetched to find completed state
      expect(mockGetTeamStates).toHaveBeenCalledWith("team-1");

      // Closure report posted via emitActivity
      const responseCalls = activityCallsOfType("response");
      expect(responseCalls.length).toBeGreaterThan(0);
      const reportBody = (responseCalls[0][1] as any).body;
      expect(reportBody).toContain("Closure Report");
      expect(reportBody).toContain("authentication bug");
    });
  });

  describe("Issue.update", () => {
    it("assignment dispatch: triggers handleDispatch pipeline", async () => {
      // Set viewerId to match the fixture's assigneeId
      mockGetViewerId.mockResolvedValue("viewer-1");

      const api = createApi();
      const payload = makeIssueUpdateWithAssignment();
      await postWebhook(api, payload);

      await waitForMock(mockSpawnWorker, { timeout: 3000 });
      expect(mockSpawnWorker).toHaveBeenCalledOnce();
    });
  });

  describe("Issue.create", () => {
    it("auto-triage: applies estimate, labels, priority from agent output", async () => {
      // Mock getIssueDetails to return issue matching the payload
      mockGetIssueDetails.mockResolvedValue(makeIssueDetails({
        id: "issue-new",
        identifier: "ENG-200",
        title: "New issue",
      }));

      mockRunAgent.mockResolvedValueOnce({
        success: true,
        output:
          '```json\n{"estimate": 3, "labelIds": ["label-bug"], "priority": 3, "assessment": "Medium complexity"}\n```\n\nThis issue needs moderate work.',
      });

      const api = createApi();
      const payload = makeIssueCreate();
      await postWebhook(api, payload);

      // Wait for the triage handler to complete
      await waitForMock(mockClearActiveSession);

      // Issue enrichment + team labels
      expect(mockGetIssueDetails).toHaveBeenCalledWith("issue-new");
      expect(mockGetTeamLabels).toHaveBeenCalled();

      // Session created for triage
      expect(mockCreateSessionOnIssue).toHaveBeenCalledWith("issue-new");

      // Agent invoked in read-only mode
      expect(mockRunAgent).toHaveBeenCalledOnce();
      const runArgs = mockRunAgent.mock.calls[0][0];
      expect(runArgs.readOnly).toBe(true);
      expect(runArgs.message).toContain("ENG-200");

      // Triage JSON applied to issue
      expect(mockUpdateIssue).toHaveBeenCalledWith(
        "issue-new",
        expect.objectContaining({
          estimate: 3,
          priority: 3,
        }),
      );

      // Response delivered via emitActivity (session exists)
      expect(activityCallsOfType("response").length).toBeGreaterThan(0);
      expect(mockClearActiveSession).toHaveBeenCalledWith("issue-new");
    });
  });

  describe("AppUserNotification", () => {
    it("ignored: returns 200 with no API calls", async () => {
      const api = createApi();
      const result = await postWebhook(api, makeAppUserNotification());
      expect(result.status).toBe(200);

      const logs = infoLogs(api);
      expect(logs.some((l) => l.includes("AppUserNotification ignored"))).toBe(true);

      expect(mockRunAgent).not.toHaveBeenCalled();
      expect(mockCreateComment).not.toHaveBeenCalled();
      expect(mockGetIssueDetails).not.toHaveBeenCalled();
    });
  });

  describe("Guidance integration", () => {
    it("created: appends guidance to agent prompt", async () => {
      const api = createApi();
      const payload = makeAgentSessionEventCreated({
        guidance: "Always use the main branch. Run make test before closing.",
      });
      await postWebhook(api, payload);

      await waitForMock(mockClearActiveSession);

      expect(mockRunAgent).toHaveBeenCalledOnce();
      const runArgs = mockRunAgent.mock.calls[0][0];
      expect(runArgs.message).toContain("Workspace Guidance");
      expect(runArgs.message).toContain("Always use the main branch");
    });

    it("created: guidance is NOT used as user message", async () => {
      const api = createApi();
      const payload = makeAgentSessionEventCreated({
        guidance: "Always use the main branch. Run make test before closing.",
        previousComments: [
          { body: "Please fix the routing bug", userId: "user-1", createdAt: new Date().toISOString() },
        ],
      });
      await postWebhook(api, payload);

      await waitForMock(mockClearActiveSession);

      expect(mockRunAgent).toHaveBeenCalledOnce();
      const msg = mockRunAgent.mock.calls[0][0].message;

      // Guidance text should appear in the guidance section, not as the user's latest message
      expect(msg).toContain("Please fix the routing bug");
      // The guidance text should be within the guidance section, not in the "Latest message" block
      const latestMsgSection = msg.split("**Latest message:**")[1] ?? "";
      expect(latestMsgSection).toContain("Please fix the routing bug");
      expect(latestMsgSection).not.toContain("Always use the main branch");
    });

    it("prompted: includes guidance from promptContext", async () => {
      const api = createApi();
      const payload = makeAgentSessionEventPrompted({
        agentActivity: { content: { body: "Can you also fix the tests?" } },
        promptContext: "## Issue\nENG-123\n\n## Guidance\nUse TypeScript strict mode.\n\n## Comments\nThread.",
      });
      await postWebhook(api, payload);

      await waitForMock(mockClearActiveSession);

      expect(mockRunAgent).toHaveBeenCalledOnce();
      const msg = mockRunAgent.mock.calls[0][0].message;
      expect(msg).toContain("Can you also fix the tests?");
      expect(msg).toContain("Workspace Guidance");
      expect(msg).toContain("Use TypeScript strict mode");
    });

    it("guidance disabled via config: no guidance section in prompt", async () => {
      const api = createApi();
      (api as any).pluginConfig = { defaultAgentId: "mal", enableGuidance: false };
      const payload = makeAgentSessionEventCreated({
        guidance: "Should not appear in prompt",
      });
      await postWebhook(api, payload);

      await waitForMock(mockClearActiveSession);

      expect(mockRunAgent).toHaveBeenCalledOnce();
      const msg = mockRunAgent.mock.calls[0][0].message;
      expect(msg).not.toContain("Workspace Guidance");
      expect(msg).not.toContain("Should not appear in prompt");
    });

    it("team override disables guidance for specific team", async () => {
      const api = createApi();
      (api as any).pluginConfig = {
        defaultAgentId: "mal",
        enableGuidance: true,
        teamGuidanceOverrides: { "team-1": false },
      };
      const payload = makeAgentSessionEventCreated({
        guidance: "Should be suppressed for team-1",
      });
      await postWebhook(api, payload);

      await waitForMock(mockClearActiveSession);

      expect(mockRunAgent).toHaveBeenCalledOnce();
      const msg = mockRunAgent.mock.calls[0][0].message;
      expect(msg).not.toContain("Workspace Guidance");
      expect(msg).not.toContain("Should be suppressed");
    });

    it("comment handler uses cached guidance from prior session event", async () => {
      // Step 1: Trigger a created event to cache guidance
      const api = createApi();
      const sessionPayload = makeAgentSessionEventCreated({
        guidance: "Cached guidance from session event",
      });
      await postWebhook(api, sessionPayload);
      await waitForMock(mockClearActiveSession);

      // Reset mocks for the next webhook
      vi.clearAllMocks();
      mockGetViewerId.mockResolvedValue("viewer-bot-1");
      mockGetIssueDetails.mockResolvedValue(makeIssueDetails());
      mockCreateComment.mockResolvedValue("comment-new-id");
      mockEmitActivity.mockResolvedValue(undefined);
      mockUpdateSession.mockResolvedValue(undefined);
      mockUpdateIssue.mockResolvedValue(true);
      mockCreateSessionOnIssue.mockResolvedValue({ sessionId: "session-mock-2" });
      mockGetTeamLabels.mockResolvedValue([]);
      mockGetTeamStates.mockResolvedValue([
        { id: "st-backlog", name: "Backlog", type: "backlog" },
        { id: "st-started", name: "In Progress", type: "started" },
        { id: "st-done", name: "Done", type: "completed" },
      ]);
      mockRunAgent.mockResolvedValue({ success: true, output: "Agent response text" });
      mockClassifyIntent.mockResolvedValue({
        intent: "ask_agent",
        agentId: "mal",
        reasoning: "user requesting help",
        fromFallback: false,
      });

      // Step 2: Now send a comment — it should pick up cached guidance
      const commentPayload = makeCommentCreate({
        data: {
          id: "comment-guidance-1",
          body: "Can you investigate further?",
          user: { id: "user-human", name: "Human" },
          issue: {
            id: "issue-1",
            identifier: "ENG-123",
            title: "Fix webhook routing",
            team: { id: "team-1" },
            project: null,
          },
          createdAt: new Date().toISOString(),
        },
      });
      await postWebhook(api, commentPayload);

      await waitForMock(mockClearActiveSession);

      expect(mockRunAgent).toHaveBeenCalledOnce();
      const msg = mockRunAgent.mock.calls[0][0].message;
      expect(msg).toContain("Workspace Guidance");
      expect(msg).toContain("Cached guidance from session event");
    });
  });

  describe("Sub-issue guidance in agent prompt", () => {
    it("created: triaged issue includes sub-issue guidance with parentIssueId", async () => {
      // Issue is "In Progress" (type: "started") — triaged, so full tool access
      mockGetIssueDetails.mockResolvedValue(makeIssueDetails({
        state: { name: "In Progress", type: "started" },
      }));

      const api = createApi();
      const payload = makeAgentSessionEventCreated();
      await postWebhook(api, payload);

      await waitForMock(mockClearActiveSession);

      expect(mockRunAgent).toHaveBeenCalledOnce();
      const msg = mockRunAgent.mock.calls[0][0].message;

      // Verify sub-issue guidance text includes the correct parentIssueId
      expect(msg).toContain("Sub-issue guidance");
      expect(msg).toContain("break it into sub-issues");
      expect(msg).toContain('parentIssueId="ENG-123"');
    });

    it("created: backlog issue does NOT include sub-issue guidance", async () => {
      // Issue is "Backlog" (type: "backlog") — untriaged, so read-only tool access
      mockGetIssueDetails.mockResolvedValue(makeIssueDetails({
        state: { name: "Backlog", type: "backlog" },
      }));

      const api = createApi();
      const payload = makeAgentSessionEventCreated();
      await postWebhook(api, payload);

      await waitForMock(mockClearActiveSession);

      expect(mockRunAgent).toHaveBeenCalledOnce();
      const msg = mockRunAgent.mock.calls[0][0].message;

      // Backlog issues get READ ONLY access — no sub-issue guidance
      expect(msg).not.toContain("Sub-issue guidance");
      expect(msg).toContain("READ ONLY");
    });
  });
});
