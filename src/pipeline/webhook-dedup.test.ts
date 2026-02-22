/**
 * webhook-dedup.test.ts — Deduplication and feedback-loop prevention tests.
 *
 * Tests that duplicate webhooks, own-comment feedback, and concurrent runs
 * are correctly handled without double-processing.
 */
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────

vi.mock("./pipeline.js", () => ({
  runPlannerStage: vi.fn().mockResolvedValue("mock plan"),
  runFullPipeline: vi.fn().mockResolvedValue(undefined),
  resumePipeline: vi.fn().mockResolvedValue(undefined),
  spawnWorker: vi.fn().mockResolvedValue(undefined),
}));

const mockGetViewerId = vi.fn().mockResolvedValue("viewer-bot-1");

vi.mock("../api/linear-api.js", () => ({
  LinearAgentApi: class MockLinearAgentApi {
    emitActivity = vi.fn().mockResolvedValue(undefined);
    createComment = vi.fn().mockResolvedValue("comment-new-id");
    getIssueDetails = vi.fn().mockResolvedValue(null);
    updateSession = vi.fn().mockResolvedValue(undefined);
    getViewerId = mockGetViewerId;
    createSessionOnIssue = vi.fn().mockResolvedValue({ sessionId: null });
    getTeamLabels = vi.fn().mockResolvedValue([]);
  },
  resolveLinearToken: vi.fn().mockReturnValue({
    accessToken: "test-token",
    source: "env",
  }),
}));

vi.mock("./active-session.js", () => ({
  setActiveSession: vi.fn(),
  clearActiveSession: vi.fn(),
  getIssueAffinity: vi.fn().mockReturnValue(null),
  _configureAffinityTtl: vi.fn(),
  _resetAffinityForTesting: vi.fn(),
}));

vi.mock("../infra/observability.js", () => ({
  emitDiagnostic: vi.fn(),
}));

vi.mock("./intent-classify.js", () => ({
  classifyIntent: vi.fn().mockResolvedValue({
    intent: "general",
    reasoning: "test",
    fromFallback: true,
  }),
}));

import { handleLinearWebhook, _resetForTesting, _addActiveRunForTesting, _markAsProcessedForTesting } from "./webhook.js";
import { classifyIntent } from "./intent-classify.js";

// ── Helpers ────────────────────────────────────────────────────────

function createApi(): OpenClawPluginApi {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    runtime: {},
    pluginConfig: {},
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

/** Post a webhook payload and capture response + logger calls. */
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

// ── Tests ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTesting();
  mockGetViewerId.mockResolvedValue("viewer-bot-1");
  vi.mocked(classifyIntent).mockResolvedValue({
    intent: "general",
    reasoning: "test",
    fromFallback: true,
  });
});

afterEach(() => {
  _resetForTesting();
});

describe("webhook deduplication", () => {
  it("skips duplicate AgentSessionEvent.created with same session ID", async () => {
    const payload = {
      type: "AgentSessionEvent",
      action: "created",
      agentSession: {
        id: "sess-dedup-1",
        issue: { id: "issue-dedup-1", identifier: "ENG-500", title: "Test" },
      },
      previousComments: [],
    };

    const api = createApi();

    // First call — should be processed
    await postWebhook(api, payload);
    const firstLogs = infoLogs(api);
    expect(firstLogs.some((l) => l.includes("AgentSession created:"))).toBe(true);

    // Second call with same session ID — should be skipped
    const api2 = createApi();
    await postWebhook(api2, payload);
    const secondLogs = infoLogs(api2);
    // activeRuns guard fires first (issue already active from first call's async handler)
    const skippedByActive = secondLogs.some((l) => l.includes("already running") || l.includes("already handled"));
    expect(skippedByActive).toBe(true);
  });

  it("skips duplicate Comment.create with same comment ID", async () => {
    const payload = {
      type: "Comment",
      action: "create",
      data: {
        id: "comment-dedup-1",
        body: "Test comment",
        user: { id: "user-other", name: "Human User" },
        issue: {
          id: "issue-dedup-2",
          identifier: "ENG-501",
          title: "Test Issue",
          team: { id: "team-1" },
          project: null,
        },
      },
    };

    const api = createApi();

    // First call
    await postWebhook(api, payload);
    const firstLogs = infoLogs(api);
    // Should not contain "already processed"
    expect(firstLogs.some((l) => l.includes("already processed"))).toBe(false);

    // Second call with same comment ID
    const api2 = createApi();
    await postWebhook(api2, payload);
    const secondLogs = infoLogs(api2);
    expect(secondLogs.some((l) => l.includes("already processed"))).toBe(true);
  });

  it("skips Comment.create when activeRuns has the issue — before LLM classification", async () => {
    // Pre-set activeRuns for this issue
    _addActiveRunForTesting("issue-active-1");

    const payload = {
      type: "Comment",
      action: "create",
      data: {
        id: "comment-while-active",
        body: "@mal please fix this",
        user: { id: "user-other", name: "Human User" },
        issue: {
          id: "issue-active-1",
          identifier: "ENG-502",
          title: "Active Issue",
          team: { id: "team-1" },
          project: null,
        },
      },
    };

    const api = createApi();
    await postWebhook(api, payload);

    const logs = infoLogs(api);
    expect(logs.some((l) => l.includes("active run — skipping"))).toBe(true);

    // Intent classifier should NOT have been called (saved LLM cost)
    expect(classifyIntent).not.toHaveBeenCalled();
  });

  it("skips bot's own comments via viewerId check", async () => {
    mockGetViewerId.mockResolvedValue("viewer-bot-1");

    const payload = {
      type: "Comment",
      action: "create",
      data: {
        id: "comment-own-1",
        body: "**[Mal]** Here is my response",
        user: { id: "viewer-bot-1", name: "CT Claw" },
        issue: {
          id: "issue-own-1",
          identifier: "ENG-503",
          title: "Own Comment Issue",
          team: { id: "team-1" },
          project: null,
        },
      },
    };

    const api = createApi();
    await postWebhook(api, payload);

    const logs = infoLogs(api);
    expect(logs.some((l) => l.includes("skipping our own comment"))).toBe(true);
  });

  it("skips duplicate Issue.update with same assignment", async () => {
    const payload = {
      type: "Issue",
      action: "update",
      data: {
        id: "issue-assign-1",
        identifier: "ENG-504",
        title: "Assigned Issue",
        assigneeId: "viewer-bot-1",
        delegateId: null,
      },
      updatedFrom: {
        assigneeId: null,
      },
    };

    const api = createApi();

    // First call
    await postWebhook(api, payload);
    // Second call with same payload
    const api2 = createApi();
    await postWebhook(api2, payload);

    const secondLogs = infoLogs(api2);
    // Should be skipped — either "already processed" or "no assignment change" on repeat
    const skipped = secondLogs.some(
      (l) => l.includes("already processed") || l.includes("no assignment") || l.includes("not us"),
    );
    expect(skipped).toBe(true);
  });

  it("skips AgentSessionEvent.created when activeRuns already has the issue", async () => {
    // Simulates: our handler called createSessionOnIssue() which fires
    // AgentSessionEvent.created webhook back to us. activeRuns was set
    // BEFORE the API call, so the webhook is caught.
    _addActiveRunForTesting("issue-race-1");

    const payload = {
      type: "AgentSessionEvent",
      action: "created",
      agentSession: {
        id: "sess-race-1",
        issue: { id: "issue-race-1", identifier: "ENG-505", title: "Race Issue" },
      },
      previousComments: [],
    };

    const api = createApi();
    await postWebhook(api, payload);

    const logs = infoLogs(api);
    // Should hit the activeRuns guard FIRST (before wasRecentlyProcessed)
    expect(logs.some((l) => l.includes("already running") && l.includes("ENG-505"))).toBe(true);
  });

  it("ignores AppUserNotification events", async () => {
    const payload = {
      type: "AppUserNotification",
      action: "create",
      notification: { type: "issueAssigned" },
      appUserId: "app-user-1",
    };

    const api = createApi();
    const result = await postWebhook(api, payload);

    expect(result.status).toBe(200);
    const logs = infoLogs(api);
    expect(logs.some((l) => l.includes("AppUserNotification ignored"))).toBe(true);
  });

  it("skips duplicate Issue.create with same issue ID", async () => {
    const payload = {
      type: "Issue",
      action: "create",
      data: {
        id: "issue-create-dedup-1",
        identifier: "ENG-600",
        title: "New Issue Dedup Test",
        state: { name: "Backlog", type: "backlog" },
        assignee: null,
        team: { id: "team-1" },
        project: null,
      },
    };

    const api = createApi();

    // First call — should be processed
    await postWebhook(api, payload);
    const firstLogs = infoLogs(api);
    expect(firstLogs.some((l) => l.includes("already processed"))).toBe(false);

    // Second call with same issue ID — should be skipped
    const api2 = createApi();
    await postWebhook(api2, payload);
    const secondLogs = infoLogs(api2);
    expect(secondLogs.some((l) => l.includes("already processed"))).toBe(true);
  });

  it("skips AgentSessionEvent.prompted when activeRuns has the issue (feedback loop)", async () => {
    _addActiveRunForTesting("issue-prompted-feedback-1");

    const payload = {
      type: "AgentSessionEvent",
      action: "prompted",
      agentSession: {
        id: "sess-prompted-fb-1",
        issue: { id: "issue-prompted-feedback-1", identifier: "ENG-601", title: "Prompted Feedback" },
      },
      agentActivity: { content: { body: "Follow-up question" } },
      webhookId: "wh-prompted-fb-1",
    };

    const api = createApi();
    await postWebhook(api, payload);

    const logs = infoLogs(api);
    expect(logs.some((l) => l.includes("active") || l.includes("ignoring"))).toBe(true);

    // Intent classifier should NOT have been called
    expect(classifyIntent).not.toHaveBeenCalled();
  });

  it.skipIf(process.env.CI)("skips duplicate AgentSessionEvent.prompted by webhookId", async () => {
    const payload = {
      type: "AgentSessionEvent",
      action: "prompted",
      agentSession: {
        id: "sess-prompted-dedup-1",
        issue: { id: "issue-prompted-dedup-1", identifier: "ENG-602", title: "Prompted Dedup" },
      },
      agentActivity: { content: { body: "First message" } },
      webhookId: "wh-dedup-prompted-1",
    };

    const api = createApi();

    // First call
    await postWebhook(api, payload);

    // Second call with same webhookId
    const api2 = createApi();
    await postWebhook(api2, payload);
    const secondLogs = infoLogs(api2);
    // Should be caught by either activeRuns (from first call's async handler) or wasRecentlyProcessed
    const skipped = secondLogs.some(
      (l) => l.includes("already") || l.includes("running") || l.includes("processed"),
    );
    expect(skipped).toBe(true);
  });

  it("skips Issue.update when activeRuns has the issue (triage still running)", async () => {
    // Simulates: triage from Issue.create is still running (activeRuns set),
    // then updateIssue() triggers an Issue.update webhook. The sync guard
    // should catch it before any async getViewerId() call.
    _addActiveRunForTesting("issue-triage-active-1");

    const payload = {
      type: "Issue",
      action: "update",
      data: {
        id: "issue-triage-active-1",
        identifier: "ENG-604",
        title: "Triage Active Issue",
        assigneeId: "viewer-bot-1",
        delegateId: null,
      },
      updatedFrom: {
        assigneeId: null,
      },
    };

    const api = createApi();
    await postWebhook(api, payload);

    const logs = infoLogs(api);
    expect(logs.some((l) => l.includes("active run — skipping"))).toBe(true);
  });

  it("skips Comment.create when comment ID was pre-registered by createCommentWithDedup", async () => {
    // Simulate: our handler created a comment via createCommentWithDedup,
    // which pre-registered the comment ID in wasRecentlyProcessed.
    // When Linear echoes the Comment.create webhook back, it should be caught.
    _markAsProcessedForTesting("comment:pre-registered-comment-1");

    const payload = {
      type: "Comment",
      action: "create",
      data: {
        id: "pre-registered-comment-1",
        body: "Response from the agent",
        user: { id: "user-other", name: "Human User" },
        issue: {
          id: "issue-echo-1",
          identifier: "ENG-603",
          title: "Echo Test Issue",
          team: { id: "team-1" },
          project: null,
        },
      },
    };

    const api = createApi();
    await postWebhook(api, payload);

    const logs = infoLogs(api);
    expect(logs.some((l) => l.includes("already processed"))).toBe(true);
  });
});
