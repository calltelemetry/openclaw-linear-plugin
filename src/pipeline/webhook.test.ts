import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the pipeline module
const { runPlannerStageMock, runFullPipelineMock, resumePipelineMock } = vi.hoisted(() => ({
  runPlannerStageMock: vi.fn().mockResolvedValue("mock plan"),
  runFullPipelineMock: vi.fn().mockResolvedValue(undefined),
  resumePipelineMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./pipeline.js", () => ({
  runPlannerStage: runPlannerStageMock,
  runFullPipeline: runFullPipelineMock,
  resumePipeline: resumePipelineMock,
}));

// Mock the linear-api module
vi.mock("../api/linear-api.js", () => ({
  LinearAgentApi: class MockLinearAgentApi {
    emitActivity = vi.fn().mockResolvedValue(undefined);
    createComment = vi.fn().mockResolvedValue("comment-id");
    getIssueDetails = vi.fn().mockResolvedValue(null);
    updateSession = vi.fn().mockResolvedValue(undefined);
  },
  resolveLinearToken: vi.fn().mockReturnValue({
    accessToken: "test-token",
    source: "env",
  }),
}));

import { handleLinearWebhook } from "./webhook.js";

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
  if (!address) {
    throw new Error("missing server address");
  }
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function postWebhook(payload: unknown, path = "/linear/webhook") {
  const api = createApi();
  let status = 0;
  let body = "";

  await withServer(
    async (req, res) => {
      const handled = await handleLinearWebhook(api, req, res);
      if (!handled) {
        res.statusCode = 404;
        res.end("not found");
      }
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      status = response.status;
      body = await response.text();
    },
  );

  return { api, status, body };
}

afterEach(() => {
  runPlannerStageMock.mockReset().mockResolvedValue("mock plan");
  runFullPipelineMock.mockReset().mockResolvedValue(undefined);
  resumePipelineMock.mockReset().mockResolvedValue(undefined);
});

describe("handleLinearWebhook", () => {
  it("responds 200 to AgentSession create within time limit", async () => {
    const payload = {
      type: "AgentSession",
      action: "create",
      data: {
        id: "sess-1",
        context: { commentBody: "Please investigate this issue" },
      },
      issue: {
        id: "issue-1",
        identifier: "ENG-123",
        title: "Fix webhook routing",
      },
    };

    const result = await postWebhook(payload);

    expect(result.status).toBe(200);
    expect(result.body).toBe("ok");
  });

  it("logs error when session or issue data is missing", async () => {
    const payload = {
      type: "AgentSession",
      action: "create",
      data: { id: null },
      issue: null,
    };

    const result = await postWebhook(payload);

    expect(result.status).toBe(200);
    expect((result.api.logger.error as any).mock.calls.length).toBeGreaterThan(0);
  });

  it("responds 200 to AgentSession prompted", async () => {
    const payload = {
      type: "AgentSession",
      action: "prompted",
      data: {
        id: "sess-prompted",
        context: { prompt: "Looks good, approved!" },
      },
      issue: {
        id: "issue-2",
        identifier: "ENG-124",
        title: "Approved issue",
      },
    };

    const result = await postWebhook(payload);

    expect(result.status).toBe(200);
    expect(result.body).toBe("ok");
  });

  it("responds 200 to unknown webhook types", async () => {
    const payload = {
      type: "Issue",
      action: "update",
      data: { id: "issue-5" },
    };

    const result = await postWebhook(payload);

    expect(result.status).toBe(200);
    expect(result.body).toBe("ok");
  });

  it("returns 405 for non-POST methods", async () => {
    const api = createApi();
    let status = 0;

    await withServer(
      async (req, res) => {
        await handleLinearWebhook(api, req, res);
      },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/linear/webhook`, {
          method: "GET",
        });
        status = response.status;
      },
    );

    expect(status).toBe(405);
  });
});
