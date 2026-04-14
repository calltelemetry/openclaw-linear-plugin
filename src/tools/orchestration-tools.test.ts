import { describe, it, expect, vi, beforeEach } from "vitest";
import { createOrchestrationTools } from "./orchestration-tools.js";

// ---------------------------------------------------------------------------
// Mock runAgent
// ---------------------------------------------------------------------------

const mockRunAgent = vi.fn();

vi.mock("../agent/agent.js", () => ({
  runAgent: (...args: unknown[]) => mockRunAgent(...args),
}));

// ---------------------------------------------------------------------------
// Mock jsonResult (from openclaw/plugin-sdk)
// ---------------------------------------------------------------------------

vi.mock("openclaw/plugin-sdk/core", () => ({
  jsonResult: (obj: unknown) => ({ type: "json", data: obj, content: [{ type: "text", text: JSON.stringify(obj) }], details: obj }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApi() {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as any;
}

function makeCtx(): Record<string, unknown> {
  return {};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createOrchestrationTools", () => {
  beforeEach(() => {
    mockRunAgent.mockReset();
  });

  it("returns 2 tools", () => {
    const tools = createOrchestrationTools(makeApi(), makeCtx());

    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe("spawn_agent");
    expect(tools[1].name).toBe("ask_agent");
  });

  it("spawn_agent tool has correct name and parameters schema", () => {
    const tools = createOrchestrationTools(makeApi(), makeCtx());
    const spawn = tools[0];

    expect(spawn.name).toBe("spawn_agent");
    expect(spawn.parameters).toBeDefined();
    expect(spawn.parameters.type).toBe("object");
    expect(spawn.parameters.properties.agentId).toBeDefined();
    expect(spawn.parameters.properties.task).toBeDefined();
    expect(spawn.parameters.properties.timeoutSeconds).toBeDefined();
    expect(spawn.parameters.required).toEqual(["agentId", "task"]);
  });

  it("spawn_agent dispatches to runAgent and returns immediately", async () => {
    // runAgent returns a promise that never resolves (to prove fire-and-forget)
    let resolveAgent!: (value: unknown) => void;
    const agentPromise = new Promise((resolve) => { resolveAgent = resolve; });
    mockRunAgent.mockReturnValue(agentPromise);

    const api = makeApi();
    const tools = createOrchestrationTools(api, makeCtx());
    const spawn = tools[0];

    const result = await spawn.execute("call-1", {
      agentId: "kaylee",
      task: "Investigate database performance",
    });

    // Should return immediately with a sessionId, even though runAgent hasn't resolved
    expect(result.details.agentId).toBe("kaylee");
    expect(result.details.sessionId).toMatch(/^spawn-kaylee-/);
    expect(result.details.message).toContain("Dispatched task");
    expect(mockRunAgent).toHaveBeenCalledOnce();

    // Clean up: resolve the hanging promise to avoid unhandled rejection
    resolveAgent({ success: true, output: "done" });
  });

  it("ask_agent returns response on success", async () => {
    mockRunAgent.mockResolvedValue({
      success: true,
      output: "No, the schema change is backward-compatible and won't break tests.",
    });

    const api = makeApi();
    const tools = createOrchestrationTools(api, makeCtx());
    const askAgent = tools[1];

    const result = await askAgent.execute("call-2", {
      agentId: "kaylee",
      message: "Would this schema change break existing tests?",
    });

    expect(result.details.agentId).toBe("kaylee");
    expect(result.details.response).toBe(
      "No, the schema change is backward-compatible and won't break tests.",
    );
    expect(result.details.message).toContain("Response from agent");
  });

  it("ask_agent returns error message on failure", async () => {
    mockRunAgent.mockResolvedValue({
      success: false,
      output: "Agent timed out after 120s",
    });

    const api = makeApi();
    const tools = createOrchestrationTools(api, makeCtx());
    const askAgent = tools[1];

    const result = await askAgent.execute("call-3", {
      agentId: "kaylee",
      message: "Check if the migration works",
    });

    expect(result.details.agentId).toBe("kaylee");
    expect(result.details.error).toBe("Agent timed out after 120s");
    expect(result.details.message).toContain("failed to respond");
    expect(result.details.response).toBeUndefined();
  });

  it("ask_agent uses custom timeout when provided", async () => {
    mockRunAgent.mockResolvedValue({
      success: true,
      output: "Result from agent",
    });

    const api = makeApi();
    const tools = createOrchestrationTools(api, makeCtx());
    const askAgent = tools[1];

    await askAgent.execute("call-4", {
      agentId: "mal",
      message: "Run a long analysis",
      timeoutSeconds: 600,
    });

    const callArgs = mockRunAgent.mock.calls[0][0];
    // 600 seconds = 600_000 ms
    expect(callArgs.timeoutMs).toBe(600_000);
  });
});
