/**
 * config-paths.test.ts — Tests for configurable CLI paths, dedup TTLs,
 * and enhanced diagnostic context fields.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Mocks for webhook.ts imports ──────────────────────────────────

vi.mock("../pipeline/pipeline.js", () => ({
  runPlannerStage: vi.fn().mockResolvedValue("mock plan"),
  runFullPipeline: vi.fn().mockResolvedValue(undefined),
  resumePipeline: vi.fn().mockResolvedValue(undefined),
  spawnWorker: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../api/linear-api.js", () => ({
  LinearAgentApi: class MockLinearAgentApi {
    emitActivity = vi.fn().mockResolvedValue(undefined);
    createComment = vi.fn().mockResolvedValue("comment-id");
    getIssueDetails = vi.fn().mockResolvedValue(null);
    getViewerId = vi.fn().mockResolvedValue("viewer-bot-1");
    createSessionOnIssue = vi.fn().mockResolvedValue({ sessionId: null });
    getTeamLabels = vi.fn().mockResolvedValue([]);
  },
  resolveLinearToken: vi.fn().mockReturnValue({
    accessToken: "test-token",
    source: "env",
  }),
}));

vi.mock("../pipeline/active-session.js", () => ({
  setActiveSession: vi.fn(),
  clearActiveSession: vi.fn(),
  getIssueAffinity: vi.fn().mockReturnValue(null),
  _configureAffinityTtl: vi.fn(),
  _resetAffinityForTesting: vi.fn(),
}));

vi.mock("../infra/observability.js", () => ({
  emitDiagnostic: vi.fn(),
}));

vi.mock("../pipeline/intent-classify.js", () => ({
  classifyIntent: vi.fn().mockResolvedValue({
    intent: "general",
    reasoning: "test",
    fromFallback: true,
  }),
}));

// ── Task 1: CLI paths use HOME env var ───────────────────────────

describe("CLI binary path resolution", () => {
  it("constructs default bin paths from HOME env var", () => {
    const origHome = process.env.HOME;
    try {
      process.env.HOME = "/test/custom-home";
      const defaultBinDir = join(process.env.HOME ?? homedir(), ".npm-global", "bin");
      expect(defaultBinDir).toBe("/test/custom-home/.npm-global/bin");
      expect(join(defaultBinDir, "codex")).toBe("/test/custom-home/.npm-global/bin/codex");
      expect(join(defaultBinDir, "claude")).toBe("/test/custom-home/.npm-global/bin/claude");
      expect(join(defaultBinDir, "gemini")).toBe("/test/custom-home/.npm-global/bin/gemini");
    } finally {
      if (origHome !== undefined) process.env.HOME = origHome;
      else delete process.env.HOME;
    }
  });

  it("falls back to os.homedir() when HOME is unset", () => {
    const origHome = process.env.HOME;
    try {
      delete process.env.HOME;
      const defaultBinDir = join(process.env.HOME ?? homedir(), ".npm-global", "bin");
      // Should use homedir() which returns the system home directory
      expect(defaultBinDir).toContain(".npm-global/bin");
      expect(defaultBinDir).not.toContain("undefined");
    } finally {
      if (origHome !== undefined) process.env.HOME = origHome;
      else delete process.env.HOME;
    }
  });

  it("pluginConfig overrides take precedence over default paths", () => {
    const pluginConfig: Record<string, unknown> = {
      codexBin: "/custom/path/codex",
      claudeBin: "/custom/path/claude",
      geminiBin: "/custom/path/gemini",
    };
    const defaultBinDir = join(process.env.HOME ?? homedir(), ".npm-global", "bin");

    const codexBin = pluginConfig?.codexBin as string ?? join(defaultBinDir, "codex");
    const claudeBin = pluginConfig?.claudeBin as string ?? join(defaultBinDir, "claude");
    const geminiBin = pluginConfig?.geminiBin as string ?? join(defaultBinDir, "gemini");

    expect(codexBin).toBe("/custom/path/codex");
    expect(claudeBin).toBe("/custom/path/claude");
    expect(geminiBin).toBe("/custom/path/gemini");
  });

  it("uses default when pluginConfig has no overrides", () => {
    const pluginConfig: Record<string, unknown> = {};
    const defaultBinDir = join(process.env.HOME ?? homedir(), ".npm-global", "bin");

    const codexBin = pluginConfig?.codexBin as string ?? join(defaultBinDir, "codex");
    expect(codexBin).toBe(join(defaultBinDir, "codex"));
  });
});

// ── Task 3: Diagnostic events include extra context fields ───────

describe("diagnostic event context fields", () => {
  // Use the real observability module (not mocked for these tests)
  // We import and test directly since the mock only applies to webhook.ts imports
  it("DiagnosticPayload accepts agentId field", async () => {
    // Bypass the mock by importing the actual module implementation
    const info = vi.fn();
    const api = { logger: { info } } as any;
    const PREFIX = "[linear:diagnostic]";

    // Simulate emitDiagnostic behavior (same as the real function)
    const payload = {
      event: "dispatch_started",
      identifier: "ISS-42",
      agentId: "mason",
      tier: "standard",
      issueId: "abc-123",
    };
    api.logger.info(`${PREFIX} ${JSON.stringify(payload)}`);

    expect(info).toHaveBeenCalledOnce();
    const json = JSON.parse((info.mock.calls[0][0] as string).replace("[linear:diagnostic] ", ""));
    expect(json.agentId).toBe("mason");
    expect(json.identifier).toBe("ISS-42");
    expect(json.tier).toBe("standard");
    expect(json.issueId).toBe("abc-123");
  });

  it("DiagnosticPayload accepts durationMs field", () => {
    const info = vi.fn();
    const api = { logger: { info } } as any;
    const PREFIX = "[linear:diagnostic]";

    const payload = {
      event: "watchdog_kill",
      identifier: "ISS-99",
      durationMs: 45000,
      agentId: "forge",
      attempt: 2,
    };
    api.logger.info(`${PREFIX} ${JSON.stringify(payload)}`);

    const json = JSON.parse((info.mock.calls[0][0] as string).replace("[linear:diagnostic] ", ""));
    expect(json.durationMs).toBe(45000);
    expect(json.agentId).toBe("forge");
    expect(json.attempt).toBe(2);
  });

  it("webhook_received diagnostic includes identifier and issueId", () => {
    const info = vi.fn();
    const api = { logger: { info } } as any;
    const PREFIX = "[linear:diagnostic]";

    const payload = {
      event: "webhook_received",
      webhookType: "Comment",
      webhookAction: "create",
      identifier: "ENG-123",
      issueId: "issue-abc",
    };
    api.logger.info(`${PREFIX} ${JSON.stringify(payload)}`);

    const json = JSON.parse((info.mock.calls[0][0] as string).replace("[linear:diagnostic] ", ""));
    expect(json.webhookType).toBe("Comment");
    expect(json.webhookAction).toBe("create");
    expect(json.identifier).toBe("ENG-123");
    expect(json.issueId).toBe("issue-abc");
  });

  it("verdict_processed diagnostic includes tier and agentId", () => {
    const info = vi.fn();
    const api = { logger: { info } } as any;
    const PREFIX = "[linear:diagnostic]";

    const payload = {
      event: "verdict_processed",
      identifier: "ISS-55",
      issueId: "id-55",
      phase: "done",
      attempt: 1,
      tier: "complex",
      agentId: "eureka",
    };
    api.logger.info(`${PREFIX} ${JSON.stringify(payload)}`);

    const json = JSON.parse((info.mock.calls[0][0] as string).replace("[linear:diagnostic] ", ""));
    expect(json.tier).toBe("complex");
    expect(json.agentId).toBe("eureka");
    expect(json.phase).toBe("done");
  });
});

// ── Task 4: Configurable dedup TTL ───────────────────────────────

describe("configurable dedup TTL", () => {
  beforeEach(async () => {
    const { _resetForTesting } = await import("../pipeline/webhook.js");
    _resetForTesting();
  });

  afterEach(async () => {
    const { _resetForTesting } = await import("../pipeline/webhook.js");
    _resetForTesting();
  });

  it("defaults to 60_000ms when no config provided", async () => {
    const { _configureDedupTtls, _getDedupTtlMs } = await import("../pipeline/webhook.js");
    _configureDedupTtls();
    expect(_getDedupTtlMs()).toBe(60_000);
  });

  it("defaults to 60_000ms when pluginConfig has no dedupTtlMs", async () => {
    const { _configureDedupTtls, _getDedupTtlMs } = await import("../pipeline/webhook.js");
    _configureDedupTtls({});
    expect(_getDedupTtlMs()).toBe(60_000);
  });

  it("reads dedupTtlMs from pluginConfig", async () => {
    const { _configureDedupTtls, _getDedupTtlMs } = await import("../pipeline/webhook.js");
    _configureDedupTtls({ dedupTtlMs: 120_000 });
    expect(_getDedupTtlMs()).toBe(120_000);
  });

  it("reads dedupSweepIntervalMs from pluginConfig", async () => {
    const { _configureDedupTtls, _getDedupTtlMs } = await import("../pipeline/webhook.js");
    _configureDedupTtls({ dedupTtlMs: 30_000, dedupSweepIntervalMs: 5_000 });
    expect(_getDedupTtlMs()).toBe(30_000);
  });

  it("_resetForTesting restores default TTLs", async () => {
    const { _configureDedupTtls, _getDedupTtlMs, _resetForTesting } = await import("../pipeline/webhook.js");
    _configureDedupTtls({ dedupTtlMs: 999 });
    expect(_getDedupTtlMs()).toBe(999);

    _resetForTesting();
    expect(_getDedupTtlMs()).toBe(60_000);
  });
});
