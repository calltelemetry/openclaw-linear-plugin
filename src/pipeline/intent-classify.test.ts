import { describe, it, expect, vi, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn().mockResolvedValue({
    success: true,
    output: '{"intent":"general","reasoning":"test"}',
  }),
}));

vi.mock("../agent/agent.js", () => ({
  runAgent: runAgentMock,
}));

vi.mock("../api/linear-api.js", () => ({}));
vi.mock("openclaw/plugin-sdk", () => ({}));

// ---------------------------------------------------------------------------
// Imports (AFTER mocks)
// ---------------------------------------------------------------------------

import { classifyIntent, regexFallback, type IntentContext } from "./intent-classify.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createApi(overrides?: Record<string, unknown>) {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    pluginConfig: overrides ?? {},
  } as any;
}

function createCtx(overrides?: Partial<IntentContext>): IntentContext {
  return {
    commentBody: "hello world",
    issueTitle: "Test Issue",
    issueStatus: "In Progress",
    isPlanning: false,
    agentNames: ["mal", "kaylee", "inara"],
    hasProject: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.clearAllMocks();
  runAgentMock.mockResolvedValue({
    success: true,
    output: '{"intent":"general","reasoning":"test"}',
  });
});

// ---------------------------------------------------------------------------
// classifyIntent — LLM path
// ---------------------------------------------------------------------------

describe("classifyIntent", () => {
  it("parses valid intent from LLM response", async () => {
    runAgentMock.mockResolvedValueOnce({
      success: true,
      output: '{"intent":"request_work","reasoning":"user wants something built"}',
    });

    const result = await classifyIntent(createApi(), createCtx({ commentBody: "fix the bug" }));

    expect(result.intent).toBe("request_work");
    expect(result.reasoning).toBe("user wants something built");
    expect(result.fromFallback).toBe(false);
  });

  it("parses intent with extra text around JSON", async () => {
    runAgentMock.mockResolvedValueOnce({
      success: true,
      output: 'Here is my analysis:\n{"intent":"question","reasoning":"user asking for help"}\nDone.',
    });

    const result = await classifyIntent(createApi(), createCtx());
    expect(result.intent).toBe("question");
    expect(result.fromFallback).toBe(false);
  });

  it("populates agentId for ask_agent with valid name", async () => {
    runAgentMock.mockResolvedValueOnce({
      success: true,
      output: '{"intent":"ask_agent","agentId":"Kaylee","reasoning":"user addressing kaylee"}',
    });

    const result = await classifyIntent(createApi(), createCtx({
      commentBody: "hey kaylee look at this",
    }));

    expect(result.intent).toBe("ask_agent");
    expect(result.agentId).toBe("kaylee");
  });

  it("clears agentId for ask_agent with hallucinated name", async () => {
    runAgentMock.mockResolvedValueOnce({
      success: true,
      output: '{"intent":"ask_agent","agentId":"wash","reasoning":"user wants wash"}',
    });

    const result = await classifyIntent(createApi(), createCtx());

    expect(result.intent).toBe("ask_agent");
    expect(result.agentId).toBeUndefined();
  });

  it("falls back to regex when LLM returns invalid JSON", async () => {
    runAgentMock.mockResolvedValueOnce({
      success: true,
      output: "I cannot determine the intent",
    });

    const result = await classifyIntent(createApi(), createCtx());
    expect(result.fromFallback).toBe(true);
  });

  it("falls back to regex when LLM returns invalid intent enum", async () => {
    runAgentMock.mockResolvedValueOnce({
      success: true,
      output: '{"intent":"destroy_everything","reasoning":"chaos"}',
    });

    const result = await classifyIntent(createApi(), createCtx());
    expect(result.fromFallback).toBe(true);
  });

  it("falls back to regex when LLM call fails", async () => {
    runAgentMock.mockResolvedValueOnce({
      success: false,
      output: "Agent error",
    });

    const result = await classifyIntent(createApi(), createCtx());
    expect(result.fromFallback).toBe(true);
  });

  it("falls back to regex when LLM call throws", async () => {
    runAgentMock.mockRejectedValueOnce(new Error("timeout"));

    const result = await classifyIntent(createApi(), createCtx());
    expect(result.fromFallback).toBe(true);
  });

  it("uses 12s timeout for classification", async () => {
    await classifyIntent(createApi(), createCtx());

    expect(runAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 12_000,
      }),
    );
  });

  it("includes context in the prompt", async () => {
    await classifyIntent(createApi(), createCtx({
      commentBody: "what can I do?",
      issueTitle: "Auth Feature",
      isPlanning: true,
    }));

    const call = runAgentMock.mock.calls[0][0];
    expect(call.message).toContain("Auth Feature");
    expect(call.message).toContain("Planning mode: true");
    expect(call.message).toContain("what can I do?");
  });

  it("uses classifierAgentId from pluginConfig when configured", async () => {
    await classifyIntent(
      createApi({ classifierAgentId: "haiku-classifier" }),
      createCtx(),
      { classifierAgentId: "haiku-classifier" },
    );

    expect(runAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "haiku-classifier",
      }),
    );
  });

  it("truncates long comments to 500 chars", async () => {
    const longComment = "x".repeat(1000);
    await classifyIntent(createApi(), createCtx({ commentBody: longComment }));

    const call = runAgentMock.mock.calls[0][0];
    expect(call.message).not.toContain("x".repeat(501));
  });

  it("parses close_issue intent from LLM response", async () => {
    runAgentMock.mockResolvedValueOnce({
      success: true,
      output: '{"intent":"close_issue","reasoning":"user wants to close the issue"}',
    });

    const result = await classifyIntent(createApi(), createCtx({ commentBody: "close this" }));

    expect(result.intent).toBe("close_issue");
    expect(result.reasoning).toBe("user wants to close the issue");
    expect(result.fromFallback).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// regexFallback
// ---------------------------------------------------------------------------

describe("regexFallback", () => {
  describe("planning mode active", () => {
    it("detects finalize intent", () => {
      const result = regexFallback(createCtx({
        isPlanning: true,
        commentBody: "finalize the plan",
      }));
      expect(result.intent).toBe("plan_finalize");
      expect(result.fromFallback).toBe(true);
    });

    it("detects approve plan intent", () => {
      const result = regexFallback(createCtx({
        isPlanning: true,
        commentBody: "approve plan",
      }));
      expect(result.intent).toBe("plan_finalize");
    });

    it("detects abandon intent", () => {
      const result = regexFallback(createCtx({
        isPlanning: true,
        commentBody: "abandon planning",
      }));
      expect(result.intent).toBe("plan_abandon");
      expect(result.fromFallback).toBe(true);
    });

    it("detects cancel planning", () => {
      const result = regexFallback(createCtx({
        isPlanning: true,
        commentBody: "cancel planning",
      }));
      expect(result.intent).toBe("plan_abandon");
    });

    it("defaults to plan_continue for unmatched text", () => {
      const result = regexFallback(createCtx({
        isPlanning: true,
        commentBody: "add a search feature please",
      }));
      expect(result.intent).toBe("plan_continue");
      expect(result.fromFallback).toBe(true);
    });
  });

  describe("not planning", () => {
    it("detects plan_start when issue has project", () => {
      const result = regexFallback(createCtx({
        hasProject: true,
        commentBody: "plan this project",
      }));
      expect(result.intent).toBe("plan_start");
      expect(result.fromFallback).toBe(true);
    });

    it("does NOT detect plan_start without project", () => {
      const result = regexFallback(createCtx({
        hasProject: false,
        commentBody: "plan this project",
      }));
      expect(result.intent).toBe("general");
    });

    it("detects agent name in comment", () => {
      const result = regexFallback(createCtx({
        commentBody: "hey kaylee check this out",
      }));
      expect(result.intent).toBe("ask_agent");
      expect(result.agentId).toBe("kaylee");
    });

    it("returns general for no pattern match", () => {
      const result = regexFallback(createCtx({
        commentBody: "thanks for the update",
        agentNames: [],
      }));
      expect(result.intent).toBe("general");
      expect(result.fromFallback).toBe(true);
    });

    it("detects close_issue for 'close this' pattern", () => {
      const result = regexFallback(createCtx({
        commentBody: "close this issue",
      }));
      expect(result.intent).toBe("close_issue");
      expect(result.fromFallback).toBe(true);
    });

    it("detects close_issue for 'mark as done' pattern", () => {
      const result = regexFallback(createCtx({
        commentBody: "mark as done",
      }));
      expect(result.intent).toBe("close_issue");
    });

    it("detects close_issue for 'this is resolved' pattern", () => {
      const result = regexFallback(createCtx({
        commentBody: "this is resolved",
      }));
      expect(result.intent).toBe("close_issue");
    });

    it("does NOT detect close_issue for ambiguous text", () => {
      const result = regexFallback(createCtx({
        commentBody: "I think this might be resolved soon",
        agentNames: [],
      }));
      expect(result.intent).toBe("general");
    });
  });
});
