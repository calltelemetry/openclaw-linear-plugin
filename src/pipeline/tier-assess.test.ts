import { describe, it, expect, vi, beforeEach } from "vitest";
import { TIER_MODELS, assessTier, type IssueContext } from "./tier-assess.js";

// ---------------------------------------------------------------------------
// Mock runAgent
// ---------------------------------------------------------------------------

const mockRunAgent = vi.fn();

vi.mock("../agent/agent.js", () => ({
  runAgent: (...args: unknown[]) => mockRunAgent(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApi(overrides?: { defaultAgentId?: string }) {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    pluginConfig: {
      defaultAgentId: overrides?.defaultAgentId,
    },
  } as any;
}

function makeIssue(overrides?: Partial<IssueContext>): IssueContext {
  return {
    identifier: "CT-123",
    title: "Fix login bug",
    description: "Users cannot log in when using SSO",
    labels: ["bug"],
    commentCount: 2,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TIER_MODELS", () => {
  it("maps junior to haiku, medior to sonnet, senior to opus", () => {
    expect(TIER_MODELS.junior).toBe("anthropic/claude-haiku-4-5");
    expect(TIER_MODELS.medior).toBe("anthropic/claude-sonnet-4-6");
    expect(TIER_MODELS.senior).toBe("anthropic/claude-opus-4-6");
  });
});

describe("assessTier", () => {
  beforeEach(() => {
    mockRunAgent.mockReset();
  });

  it("returns parsed tier from agent response", async () => {
    mockRunAgent.mockResolvedValue({
      success: true,
      output: '{"tier":"senior","reasoning":"Multi-service architecture change"}',
    });

    const api = makeApi({ defaultAgentId: "mal" });
    const result = await assessTier(api, makeIssue());

    expect(result.tier).toBe("senior");
    expect(result.model).toBe(TIER_MODELS.senior);
    expect(result.reasoning).toBe("Multi-service architecture change");
    expect(api.logger.info).toHaveBeenCalled();
  });

  it("falls back to medior when agent fails (success: false) with no parseable JSON", async () => {
    mockRunAgent.mockResolvedValue({
      success: false,
      output: "Agent process exited with code 1",
    });

    const api = makeApi({ defaultAgentId: "mal" });
    const result = await assessTier(api, makeIssue());

    expect(result.tier).toBe("medior");
    expect(result.model).toBe(TIER_MODELS.medior);
    expect(result.reasoning).toBe("Assessment failed — defaulting to medior");
    expect(api.logger.warn).toHaveBeenCalled();
  });

  it("falls back to medior when output has no JSON", async () => {
    mockRunAgent.mockResolvedValue({
      success: true,
      output: "I think this is a medium complexity issue because it involves multiple files.",
    });

    const api = makeApi({ defaultAgentId: "mal" });
    const result = await assessTier(api, makeIssue());

    expect(result.tier).toBe("medior");
    expect(result.model).toBe(TIER_MODELS.medior);
    expect(result.reasoning).toBe("Assessment failed — defaulting to medior");
  });

  it("falls back to medior when JSON has invalid tier", async () => {
    mockRunAgent.mockResolvedValue({
      success: true,
      output: '{"tier":"expert","reasoning":"Very hard problem"}',
    });

    const api = makeApi({ defaultAgentId: "mal" });
    const result = await assessTier(api, makeIssue());

    expect(result.tier).toBe("medior");
    expect(result.model).toBe(TIER_MODELS.medior);
  });

  it("handles agent throwing an error", async () => {
    mockRunAgent.mockRejectedValue(new Error("Connection refused"));

    const api = makeApi({ defaultAgentId: "mal" });
    const result = await assessTier(api, makeIssue());

    expect(result.tier).toBe("medior");
    expect(result.model).toBe(TIER_MODELS.medior);
    expect(result.reasoning).toBe("Assessment failed — defaulting to medior");
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Tier assessment error for CT-123"),
    );
  });

  it("truncates long descriptions to 1500 chars", async () => {
    const longDescription = "A".repeat(3000);
    mockRunAgent.mockResolvedValue({
      success: true,
      output: '{"tier":"junior","reasoning":"Simple copy change"}',
    });

    const api = makeApi({ defaultAgentId: "mal" });
    await assessTier(api, makeIssue({ description: longDescription }));

    // Verify the message sent to runAgent has the description truncated
    const callArgs = mockRunAgent.mock.calls[0][0];
    const message: string = callArgs.message;
    // The description in the prompt should be at most 1500 chars of the original
    // "Description: " prefix + 1500 chars = the truncated form
    expect(message).toContain("Description: " + "A".repeat(1500));
    expect(message).not.toContain("A".repeat(1501));
  });

  it("uses configured agentId when provided", async () => {
    mockRunAgent.mockResolvedValue({
      success: true,
      output: '{"tier":"junior","reasoning":"Typo fix"}',
    });

    const api = makeApi({ defaultAgentId: "mal" });
    await assessTier(api, makeIssue(), "kaylee");

    const callArgs = mockRunAgent.mock.calls[0][0];
    expect(callArgs.agentId).toBe("kaylee");
  });

  it("parses JSON even when wrapped in markdown fences", async () => {
    mockRunAgent.mockResolvedValue({
      success: true,
      output: '```json\n{"tier":"junior","reasoning":"Config tweak"}\n```',
    });

    const api = makeApi({ defaultAgentId: "mal" });
    const result = await assessTier(api, makeIssue());

    expect(result.tier).toBe("junior");
    expect(result.model).toBe(TIER_MODELS.junior);
    expect(result.reasoning).toBe("Config tweak");
  });

  it("handles null description gracefully", async () => {
    mockRunAgent.mockResolvedValue({
      success: true,
      output: '{"tier":"junior","reasoning":"Trivial"}',
    });

    const api = makeApi({ defaultAgentId: "mal" });
    const result = await assessTier(api, makeIssue({ description: null }));

    expect(result.tier).toBe("junior");
  });

  it("handles empty labels and no comments", async () => {
    mockRunAgent.mockResolvedValue({
      success: true,
      output: '{"tier":"medior","reasoning":"Standard feature"}',
    });

    const api = makeApi({ defaultAgentId: "mal" });
    const result = await assessTier(api, makeIssue({ labels: [], commentCount: undefined }));

    expect(result.tier).toBe("medior");
  });

  it("falls back to medior on malformed JSON (half JSON)", async () => {
    mockRunAgent.mockResolvedValue({
      success: true,
      output: '{"tier":"seni',
    });

    const api = makeApi({ defaultAgentId: "mal" });
    const result = await assessTier(api, makeIssue());

    expect(result.tier).toBe("medior");
    expect(result.reasoning).toBe("Assessment failed — defaulting to medior");
  });

  it("provides default reasoning when missing from response", async () => {
    mockRunAgent.mockResolvedValue({
      success: true,
      output: '{"tier":"senior"}',
    });

    const api = makeApi({ defaultAgentId: "mal" });
    const result = await assessTier(api, makeIssue());

    expect(result.tier).toBe("senior");
    expect(result.reasoning).toBe("no reasoning provided");
  });

  it("extracts JSON from output with success=false but valid JSON", async () => {
    mockRunAgent.mockResolvedValue({
      success: false,
      output: 'Agent exited early but: {"tier":"junior","reasoning":"Simple fix"}',
    });

    const api = makeApi({ defaultAgentId: "mal" });
    const result = await assessTier(api, makeIssue());

    expect(result.tier).toBe("junior");
    expect(result.reasoning).toBe("Simple fix");
  });

  it("defaults agentId from pluginConfig when not passed", async () => {
    mockRunAgent.mockResolvedValue({
      success: true,
      output: '{"tier":"medior","reasoning":"Normal"}',
    });

    const api = makeApi({ defaultAgentId: "zoe" });
    await assessTier(api, makeIssue());

    const callArgs = mockRunAgent.mock.calls[0][0];
    expect(callArgs.agentId).toBe("zoe");
  });

  it("uses 30s timeout for assessment", async () => {
    mockRunAgent.mockResolvedValue({
      success: true,
      output: '{"tier":"medior","reasoning":"Normal"}',
    });

    const api = makeApi({ defaultAgentId: "mal" });
    await assessTier(api, makeIssue());

    const callArgs = mockRunAgent.mock.calls[0][0];
    expect(callArgs.timeoutMs).toBe(30_000);
  });
});
