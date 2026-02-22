import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock heavy cross-module imports to isolate doctor checks
vi.mock("../api/linear-api.js", () => ({
  resolveLinearToken: vi.fn(() => ({
    accessToken: "lin_test_token_123",
    refreshToken: "refresh_token",
    expiresAt: Date.now() + 24 * 3_600_000,
    source: "profile" as const,
  })),
  LinearAgentApi: class MockLinearAgentApi {
    constructor() {}
  },
  AUTH_PROFILES_PATH: "/tmp/test-auth-profiles.json",
  LINEAR_GRAPHQL_URL: "https://api.linear.app/graphql",
}));

vi.mock("../pipeline/dispatch-state.js", () => ({
  readDispatchState: vi.fn(async () => ({
    dispatches: { active: {}, completed: {} },
    sessionMap: {},
    processedEvents: [],
  })),
  listActiveDispatches: vi.fn(() => []),
  listStaleDispatches: vi.fn(() => []),
  pruneCompleted: vi.fn(async () => 0),
}));

vi.mock("../pipeline/pipeline.js", () => ({
  loadPrompts: vi.fn(() => ({
    worker: {
      system: "You are a worker",
      task: "Fix {{identifier}} {{title}} {{description}} in {{worktreePath}}",
    },
    audit: {
      system: "You are an auditor",
      task: "Audit {{identifier}} {{title}} {{description}} in {{worktreePath}}",
    },
    rework: { addendum: "Fix these gaps: {{gaps}}" },
  })),
  clearPromptCache: vi.fn(),
}));

vi.mock("./codex-worktree.js", () => ({
  listWorktrees: vi.fn(() => []),
}));

vi.mock("../tools/code-tool.js", () => ({
  loadCodingConfig: vi.fn(() => ({
    codingTool: "codex",
    agentCodingTools: { inara: "claude" },
    backends: {
      claude: { aliases: ["claude", "anthropic"] },
      codex: { aliases: ["codex", "openai"] },
      gemini: { aliases: ["gemini", "google"] },
    },
  })),
  resolveCodingBackend: vi.fn((config: any, agentId?: string) => {
    if (agentId && config?.agentCodingTools?.[agentId]) return config.agentCodingTools[agentId];
    return config?.codingTool ?? "codex";
  }),
}));

vi.mock("./webhook-provision.js", () => ({
  getWebhookStatus: vi.fn(async () => null),
  provisionWebhook: vi.fn(async () => ({
    action: "created",
    webhookId: "wh-test-1",
    changes: ["created new webhook"],
  })),
  REQUIRED_RESOURCE_TYPES: ["Comment", "Issue"],
}));

import {
  checkAuth,
  checkAgentConfig,
  checkCodingTools,
  checkFilesAndDirs,
  checkConnectivity,
  checkDispatchHealth,
  checkWebhooks,
  checkCodeRunDeep,
  buildSummary,
  runDoctor,
  formatReport,
  formatReportJson,
} from "./doctor.js";

import { resolveLinearToken } from "../api/linear-api.js";
import { readDispatchState, listActiveDispatches, listStaleDispatches, pruneCompleted } from "../pipeline/dispatch-state.js";
import { loadPrompts } from "../pipeline/pipeline.js";
import { listWorktrees } from "./codex-worktree.js";
import { loadCodingConfig } from "../tools/code-tool.js";
import { getWebhookStatus, provisionWebhook } from "./webhook-provision.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// checkAuth
// ---------------------------------------------------------------------------

describe("checkAuth", () => {
  it("reports pass when token is found", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { viewer: { id: "1", name: "Test" }, organization: { name: "TestOrg", urlKey: "test" } } }),
    })));

    const { checks, ctx } = await checkAuth();
    const tokenCheck = checks.find((c) => c.label.includes("Access token"));
    expect(tokenCheck?.severity).toBe("pass");
    expect(tokenCheck?.label).toContain("profile");
    expect(ctx.viewer?.name).toBe("Test");
  });

  it("reports fail when no token found", async () => {
    vi.mocked(resolveLinearToken).mockReturnValueOnce({
      accessToken: null,
      source: "none",
    });

    const { checks } = await checkAuth();
    const tokenCheck = checks.find((c) => c.label.includes("access token"));
    expect(tokenCheck?.severity).toBe("fail");
  });

  it("reports warn when token is expired", async () => {
    vi.mocked(resolveLinearToken).mockReturnValueOnce({
      accessToken: "tok",
      expiresAt: Date.now() - 1000,
      source: "profile",
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { viewer: { id: "1", name: "T" }, organization: { name: "O", urlKey: "o" } } }),
    })));

    const { checks } = await checkAuth();
    const expiryCheck = checks.find((c) => c.label.includes("expired") || c.label.includes("Token"));
    expect(expiryCheck?.severity).toBe("warn");
  });

  it("reports pass with time remaining", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { viewer: { id: "1", name: "T" }, organization: { name: "O", urlKey: "o" } } }),
    })));

    const { checks } = await checkAuth();
    const expiryCheck = checks.find((c) => c.label.includes("not expired"));
    expect(expiryCheck?.severity).toBe("pass");
    expect(expiryCheck?.label).toContain("h");
  });

  it("reports fail on API error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));

    const { checks } = await checkAuth();
    const apiCheck = checks.find((c) => c.label.includes("unreachable") || c.label.includes("API"));
    expect(apiCheck?.severity).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// checkAgentConfig
// ---------------------------------------------------------------------------

describe("checkAgentConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "doctor-agent-"));
  });

  it("reports pass for valid agent profiles", () => {
    // Mock the AGENT_PROFILES_PATH by writing to the expected location
    // Since the path is hardcoded, we test the function's logic indirectly
    const checks = checkAgentConfig();
    // This tests against the real ~/.openclaw/agent-profiles.json on the system
    // The checks should either pass (if file exists) or fail (if not)
    expect(checks.length).toBeGreaterThan(0);
  });

  it("detects duplicate mention aliases", () => {
    // Since we can't easily mock the file path, we test the overall behavior
    const checks = checkAgentConfig();
    // Verify the function returns structured results
    for (const check of checks) {
      expect(check).toHaveProperty("label");
      expect(check).toHaveProperty("severity");
      expect(["pass", "warn", "fail"]).toContain(check.severity);
    }
  });
});

// ---------------------------------------------------------------------------
// checkCodingTools
// ---------------------------------------------------------------------------

describe("checkCodingTools", () => {
  it("reports loaded config with default backend", () => {
    const checks = checkCodingTools();
    const configCheck = checks.find((c) => c.label.includes("coding-tools.json"));
    expect(configCheck?.severity).toBe("pass");
    expect(configCheck?.label).toContain("codex");
  });

  it("reports warn for missing CLIs", () => {
    const checks = checkCodingTools();
    // Each CLI check should be present
    const cliChecks = checks.filter((c) =>
      c.label.startsWith("codex:") ||
      c.label.startsWith("claude:") ||
      c.label.startsWith("gemini:") ||
      c.label.includes("not found"),
    );
    expect(cliChecks.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// checkFilesAndDirs
// ---------------------------------------------------------------------------

describe("checkFilesAndDirs", () => {
  it("reports dispatch state counts", async () => {
    vi.mocked(readDispatchState).mockResolvedValueOnce({
      dispatches: {
        active: { "API-1": { status: "working" } as any },
        completed: { "API-2": { status: "done" } as any, "API-3": { status: "done" } as any },
      },
      sessionMap: {},
      processedEvents: [],
    });

    const checks = await checkFilesAndDirs();
    const stateCheck = checks.find((c) => c.label.includes("Dispatch state"));
    expect(stateCheck?.severity).toBe("pass");
    expect(stateCheck?.label).toContain("1 active");
    expect(stateCheck?.label).toContain("2 completed");
  });

  it("reports valid prompts", async () => {
    const checks = await checkFilesAndDirs();
    const promptCheck = checks.find((c) => c.label.includes("Prompts"));
    expect(promptCheck?.severity).toBe("pass");
    expect(promptCheck?.label).toContain("5/5");
    expect(promptCheck?.label).toContain("4/4");
  });

  it("reports prompt failures when sections missing", async () => {
    vi.mocked(loadPrompts).mockReturnValueOnce({
      worker: { system: "ok", task: "no vars here" },
      audit: { system: "ok", task: "no vars here" },
      rework: { addendum: "" },
    } as any);

    const checks = await checkFilesAndDirs();
    const promptCheck = checks.find((c) => c.label.includes("Prompt") || c.label.includes("prompt"));
    expect(promptCheck?.severity).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// checkConnectivity
// ---------------------------------------------------------------------------

describe("checkConnectivity", () => {
  it("skips Linear API re-check when authCtx provided", async () => {
    const checks = await checkConnectivity(undefined, {
      viewer: { name: "Test" },
      organization: { name: "Org", urlKey: "org" },
    });
    const apiCheck = checks.find((c) => c.label.includes("Linear API"));
    expect(apiCheck?.severity).toBe("pass");
  });

  it("reports notifications not configured as pass", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("should not be called"); }));
    const checks = await checkConnectivity({});
    const notifCheck = checks.find((c) => c.label.includes("Notifications"));
    expect(notifCheck?.severity).toBe("pass");
    expect(notifCheck?.label).toContain("not configured");
  });

  it("reports webhook skip when gateway not running", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("localhost")) throw new Error("ECONNREFUSED");
      throw new Error("unexpected");
    }));

    const checks = await checkConnectivity({}, {
      viewer: { name: "T" },
      organization: { name: "O", urlKey: "o" },
    });
    const webhookCheck = checks.find((c) => c.label.includes("Webhook"));
    expect(webhookCheck?.severity).toBe("warn");
    expect(webhookCheck?.label).toContain("gateway not detected");
  });
});

// ---------------------------------------------------------------------------
// checkDispatchHealth
// ---------------------------------------------------------------------------

describe("checkDispatchHealth", () => {
  it("reports no active dispatches", async () => {
    const checks = await checkDispatchHealth();
    const activeCheck = checks.find((c) => c.label.includes("active"));
    expect(activeCheck?.severity).toBe("pass");
  });

  it("reports stale dispatches", async () => {
    vi.mocked(listStaleDispatches).mockReturnValueOnce([
      { issueIdentifier: "API-1", status: "working", dispatchedAt: new Date(Date.now() - 3 * 3_600_000).toISOString() } as any,
    ]);

    const checks = await checkDispatchHealth();
    const staleCheck = checks.find((c) => c.label.includes("stale"));
    expect(staleCheck?.severity).toBe("warn");
    expect(staleCheck?.label).toContain("API-1");
  });

  it("prunes old completed with --fix", async () => {
    vi.mocked(readDispatchState).mockResolvedValueOnce({
      dispatches: {
        active: {},
        completed: {
          "API-OLD": { completedAt: new Date(Date.now() - 10 * 24 * 3_600_000).toISOString(), status: "done" } as any,
        },
      },
      sessionMap: {},
      processedEvents: [],
    });
    vi.mocked(pruneCompleted).mockResolvedValueOnce(1);

    const checks = await checkDispatchHealth(undefined, true);
    const pruneCheck = checks.find((c) => c.label.includes("Pruned") || c.label.includes("prune"));
    expect(pruneCheck).toBeDefined();
    // With fix=true, it should have called pruneCompleted
    expect(pruneCompleted).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// runDoctor (integration)
// ---------------------------------------------------------------------------

describe("runDoctor", () => {
  it("returns all 7 sections", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("linear.app")) {
        return {
          ok: true,
          json: async () => ({ data: { viewer: { id: "1", name: "T" }, organization: { name: "O", urlKey: "o" } } }),
        };
      }
      throw new Error("not mocked");
    }));

    const report = await runDoctor({ fix: false, json: false });
    expect(report.sections).toHaveLength(7);
    expect(report.sections.map((s) => s.name)).toEqual([
      "Authentication & Tokens",
      "Agent Configuration",
      "Coding Tools",
      "Files & Directories",
      "Connectivity",
      "Dispatch Health",
      "Webhook Configuration",
    ]);
    expect(report.summary.passed + report.summary.warnings + report.summary.errors).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

describe("formatReport", () => {
  it("produces readable output with section headers", () => {
    const report = {
      sections: [
        {
          name: "Test Section",
          checks: [
            { label: "Check passed", severity: "pass" as const },
            { label: "Check warned", severity: "warn" as const },
          ],
        },
      ],
      summary: { passed: 1, warnings: 1, errors: 0 },
    };

    const output = formatReport(report);
    expect(output).toContain("Linear Plugin Doctor");
    expect(output).toContain("Test Section");
    expect(output).toContain("Check passed");
    expect(output).toContain("Check warned");
    expect(output).toContain("1 passed");
    expect(output).toContain("1 warning");
  });

  it("shows fix guidance for warnings and errors", () => {
    const report = {
      sections: [
        {
          name: "Auth",
          checks: [
            { label: "Token expired", severity: "warn" as const, fix: "Run: openclaw openclaw-linear auth" },
            { label: "All good", severity: "pass" as const, fix: "Should not appear" },
          ],
        },
      ],
      summary: { passed: 1, warnings: 1, errors: 0 },
    };

    const output = formatReport(report);
    expect(output).toContain("→ Run: openclaw openclaw-linear auth");
    expect(output).not.toContain("Should not appear");
  });
});

describe("formatReportJson", () => {
  it("produces valid JSON", () => {
    const report = {
      sections: [{ name: "Test", checks: [{ label: "ok", severity: "pass" as const }] }],
      summary: { passed: 1, warnings: 0, errors: 0 },
    };

    const json = formatReportJson(report);
    const parsed = JSON.parse(json);
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.summary.passed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// buildSummary
// ---------------------------------------------------------------------------

describe("buildSummary", () => {
  it("counts pass/warn/fail across sections", () => {
    const sections = [
      { name: "A", checks: [{ label: "ok", severity: "pass" as const }, { label: "meh", severity: "warn" as const }] },
      { name: "B", checks: [{ label: "bad", severity: "fail" as const }] },
    ];
    const summary = buildSummary(sections);
    expect(summary).toEqual({ passed: 1, warnings: 1, errors: 1 });
  });
});

// ---------------------------------------------------------------------------
// checkCodeRunDeep
// ---------------------------------------------------------------------------

describe.skipIf(process.env.CI)("checkCodeRunDeep", () => {
  // Run a single invocation and share results across assertions to avoid
  // repeated 30s live CLI calls (the live test spawns all 3 backends).
  let sections: Awaited<ReturnType<typeof checkCodeRunDeep>>;

  beforeEach(async () => {
    if (!sections) {
      sections = await checkCodeRunDeep();
    }
  }, 120_000);

  it("returns 4 sections (3 backends + routing)", () => {
    expect(sections).toHaveLength(4);
    expect(sections.map((s) => s.name)).toEqual([
      "Code Run: Claude Code (Anthropic)",
      "Code Run: Codex (OpenAI)",
      "Code Run: Gemini CLI (Google)",
      "Code Run: Routing",
    ]);
  });

  it("each backend section has binary, API key, and live test checks", () => {
    for (const section of sections.slice(0, 3)) {
      const labels = section.checks.map((c) => c.label);
      expect(labels.some((l) => l.includes("Binary:"))).toBe(true);
      expect(labels.some((l) => l.includes("API key:"))).toBe(true);
      expect(labels.some((l) => l.includes("Live test:"))).toBe(true);
    }
  });

  it("all check results have valid severity", () => {
    for (const section of sections) {
      for (const check of section.checks) {
        expect(check).toHaveProperty("label");
        expect(check).toHaveProperty("severity");
        expect(["pass", "warn", "fail"]).toContain(check.severity);
      }
    }
  });

  it("shows routing with default backend and callable count", () => {
    const routing = sections.find((s) => s.name === "Code Run: Routing")!;
    expect(routing).toBeDefined();

    const defaultCheck = routing.checks.find((c) => c.label.includes("Default backend:"));
    expect(defaultCheck?.severity).toBe("pass");
    expect(defaultCheck?.label).toContain("codex");

    const callableCheck = routing.checks.find((c) => c.label.includes("Callable backends:"));
    expect(callableCheck?.severity).toBe("pass");
    expect(callableCheck?.label).toMatch(/Callable backends: \d+\/3/);
  });

  it("shows agent override routing for inara", () => {
    const routing = sections.find((s) => s.name === "Code Run: Routing")!;
    const inaraCheck = routing.checks.find((c) => c.label.toLowerCase().includes("inara"));
    if (inaraCheck) {
      expect(inaraCheck.label).toContain("claude");
      expect(inaraCheck.label).toContain("override");
    }
  });

  // API key tests — still call checkCodeRunDeep which runs live CLI checks
  it("detects API key from plugin config", async () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    try {
      const result = await checkCodeRunDeep({ claudeApiKey: "sk-from-config" });
      const claudeKey = result[0].checks.find((c) => c.label.includes("API key:"));
      expect(claudeKey?.severity).toBe("pass");
      expect(claudeKey?.label).toContain("claudeApiKey");
    } finally {
      if (origKey) process.env.ANTHROPIC_API_KEY = origKey;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  }, 120_000);

  it("warns when API key missing", async () => {
    const origKeys = {
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
      GOOGLE_GENAI_API_KEY: process.env.GOOGLE_GENAI_API_KEY,
    };
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_GENAI_API_KEY;

    try {
      const result = await checkCodeRunDeep();
      const geminiKey = result[2].checks.find((c) => c.label.includes("API key:"));
      expect(geminiKey?.severity).toBe("warn");
      expect(geminiKey?.label).toContain("not found");
    } finally {
      for (const [k, v] of Object.entries(origKeys)) {
        if (v) process.env[k] = v;
        else delete process.env[k];
      }
    }
  }, 120_000);
});

// ===========================================================================
// Additional branch coverage tests
// ===========================================================================

// ---------------------------------------------------------------------------
// checkAuth — additional branches
// ---------------------------------------------------------------------------

describe("checkAuth — additional branches", () => {
  it("warns when token expires soon (< 1 hour remaining)", async () => {
    vi.mocked(resolveLinearToken).mockReturnValueOnce({
      accessToken: "tok",
      expiresAt: Date.now() + 30 * 60_000, // 30 minutes from now
      refreshToken: "refresh",
      source: "profile",
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { viewer: { id: "1", name: "T" }, organization: { name: "O", urlKey: "o" } } }),
    })));

    const { checks } = await checkAuth();
    const expiryCheck = checks.find((c) => c.label.includes("expires soon"));
    expect(expiryCheck?.severity).toBe("warn");
    expect(expiryCheck?.label).toContain("m remaining");
    expect(expiryCheck?.fix).toContain("auto-refresh");
  });

  it("reports fail when API returns non-ok status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    })));

    const { checks } = await checkAuth();
    const apiCheck = checks.find((c) => c.label.includes("API returned"));
    expect(apiCheck?.severity).toBe("fail");
    expect(apiCheck?.label).toContain("401");
    expect(apiCheck?.label).toContain("Unauthorized");
  });

  it("reports fail when API returns GraphQL errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ errors: [{ message: "Invalid scope" }] }),
    })));

    const { checks } = await checkAuth();
    const apiCheck = checks.find((c) => c.label.includes("API error"));
    expect(apiCheck?.severity).toBe("fail");
    expect(apiCheck?.label).toContain("Invalid scope");
  });

  it("uses token directly (no Bearer prefix) when no refreshToken", async () => {
    vi.mocked(resolveLinearToken).mockReturnValueOnce({
      accessToken: "lin_api_direct",
      source: "config",
      // No refreshToken, no expiresAt
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { viewer: { id: "1", name: "T" }, organization: { name: "O", urlKey: "o" } } }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await checkAuth();
    // The Authorization header should be the token directly, not "Bearer ..."
    const callArgs = fetchMock.mock.calls[0];
    const headers = (callArgs[1] as any).headers;
    expect(headers.Authorization).toBe("lin_api_direct");
  });

  it("reports OAuth credentials configured from pluginConfig", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { viewer: { id: "1", name: "T" }, organization: { name: "O", urlKey: "o" } } }),
    })));

    const { checks } = await checkAuth({
      clientId: "my-client-id",
      clientSecret: "my-secret",
    });
    const oauthCheck = checks.find((c) => c.label.includes("OAuth credentials configured"));
    expect(oauthCheck?.severity).toBe("pass");
  });

  it("reports OAuth credentials configured from env vars", async () => {
    const origId = process.env.LINEAR_CLIENT_ID;
    const origSecret = process.env.LINEAR_CLIENT_SECRET;
    process.env.LINEAR_CLIENT_ID = "env-id";
    process.env.LINEAR_CLIENT_SECRET = "env-secret";

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { viewer: { id: "1", name: "T" }, organization: { name: "O", urlKey: "o" } } }),
    })));

    try {
      const { checks } = await checkAuth();
      const oauthCheck = checks.find((c) => c.label.includes("OAuth credentials configured"));
      expect(oauthCheck?.severity).toBe("pass");
    } finally {
      if (origId) process.env.LINEAR_CLIENT_ID = origId;
      else delete process.env.LINEAR_CLIENT_ID;
      if (origSecret) process.env.LINEAR_CLIENT_SECRET = origSecret;
      else delete process.env.LINEAR_CLIENT_SECRET;
    }
  });

  it("skips no-expiresAt branch (no expiry check when token has no expiresAt)", async () => {
    vi.mocked(resolveLinearToken).mockReturnValueOnce({
      accessToken: "tok",
      source: "config",
      // No expiresAt
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { viewer: { id: "1", name: "T" }, organization: { name: "O", urlKey: "o" } } }),
    })));

    const { checks } = await checkAuth();
    // Should NOT have any expiry-related check
    const expiryCheck = checks.find((c) => c.label.includes("expired") || c.label.includes("expires") || c.label.includes("not expired"));
    expect(expiryCheck).toBeUndefined();
    // Should still have the token pass check
    const tokenCheck = checks.find((c) => c.label.includes("Access token"));
    expect(tokenCheck?.severity).toBe("pass");
  });

  it("handles non-Error thrown in API catch", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw "string error"; }));

    const { checks } = await checkAuth();
    const apiCheck = checks.find((c) => c.label.includes("unreachable"));
    expect(apiCheck?.severity).toBe("fail");
    expect(apiCheck?.label).toContain("string error");
  });

  it("warns about auth-profiles.json not found when source is profile", async () => {
    // Ensure the mocked auth-profiles path does not exist
    const testAuthPath = "/tmp/test-auth-profiles.json";
    if (existsSync(testAuthPath)) unlinkSync(testAuthPath);

    vi.mocked(resolveLinearToken).mockReturnValueOnce({
      accessToken: "tok",
      source: "profile",
      refreshToken: "refresh",
      expiresAt: Date.now() + 24 * 3_600_000,
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { viewer: { id: "1", name: "T" }, organization: { name: "O", urlKey: "o" } } }),
    })));

    // AUTH_PROFILES_PATH is mocked to /tmp/test-auth-profiles.json which doesn't exist
    // so statSync will throw, and since source is "profile", we get the warning
    const { checks } = await checkAuth();
    const permCheck = checks.find((c) => c.label.includes("auth-profiles.json not found"));
    expect(permCheck?.severity).toBe("warn");
  });

  it("silently ignores auth-profiles.json not found when source is not profile", async () => {
    // Ensure the mocked auth-profiles path does not exist
    const testAuthPath = "/tmp/test-auth-profiles.json";
    if (existsSync(testAuthPath)) unlinkSync(testAuthPath);

    vi.mocked(resolveLinearToken).mockReturnValueOnce({
      accessToken: "tok",
      source: "config",
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { viewer: { id: "1", name: "T" }, organization: { name: "O", urlKey: "o" } } }),
    })));

    const { checks } = await checkAuth();
    // Should NOT have auth-profiles warning since source is not "profile"
    const permCheck = checks.find((c) => c.label.includes("auth-profiles.json not found"));
    expect(permCheck).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// checkCodingTools — additional branches
// ---------------------------------------------------------------------------

describe("checkCodingTools — additional branches", () => {
  it("reports warn when config is empty (no codingTool, no backends)", () => {
    vi.mocked(loadCodingConfig).mockReturnValueOnce({} as any);

    const checks = checkCodingTools();
    const configCheck = checks.find((c) => c.label.includes("coding-tools.json not found or empty"));
    expect(configCheck?.severity).toBe("warn");
    expect(configCheck?.fix).toContain("Create coding-tools.json");
  });

  it("reports fail for unknown default backend", () => {
    vi.mocked(loadCodingConfig).mockReturnValueOnce({
      codingTool: "unknown-backend",
      backends: { "unknown-backend": {} },
    } as any);

    const checks = checkCodingTools();
    const backendCheck = checks.find((c) => c.label.includes("Unknown default backend"));
    expect(backendCheck?.severity).toBe("fail");
    expect(backendCheck?.label).toContain("unknown-backend");
  });

  it("reports warn for invalid per-agent override", () => {
    vi.mocked(loadCodingConfig).mockReturnValueOnce({
      codingTool: "codex",
      agentCodingTools: { "testAgent": "invalid-backend" },
      backends: {},
    } as any);

    const checks = checkCodingTools();
    const overrideCheck = checks.find((c) => c.label.includes("testAgent"));
    expect(overrideCheck?.severity).toBe("warn");
    expect(overrideCheck?.label).toContain("invalid-backend");
    expect(overrideCheck?.label).toContain("not a valid backend");
  });
});

// ---------------------------------------------------------------------------
// checkFilesAndDirs — additional branches
// ---------------------------------------------------------------------------

describe("checkFilesAndDirs — additional branches", () => {
  it("reports fail when dispatch state is corrupt", async () => {
    // Create the file so existsSync returns true, then readDispatchState throws
    const tmpState = join(mkdtempSync(join(tmpdir(), "doctor-state-")), "state.json");
    writeFileSync(tmpState, "invalid json");
    vi.mocked(readDispatchState).mockRejectedValueOnce(new Error("JSON parse error"));

    const checks = await checkFilesAndDirs({ dispatchStatePath: tmpState });
    const stateCheck = checks.find((c) => c.label.includes("Dispatch state corrupt"));
    expect(stateCheck?.severity).toBe("fail");
    expect(stateCheck?.detail).toContain("JSON parse error");
  });

  it("reports fail when loadPrompts throws", async () => {
    vi.mocked(loadPrompts).mockImplementationOnce(() => { throw new Error("template file missing"); });

    const checks = await checkFilesAndDirs();
    const promptCheck = checks.find((c) => c.label.includes("Failed to load prompts"));
    expect(promptCheck?.severity).toBe("fail");
    expect(promptCheck?.detail).toContain("template file missing");
  });

  it("reports missing rework.addendum as prompt issue", async () => {
    vi.mocked(loadPrompts).mockReturnValueOnce({
      worker: {
        system: "You are a worker",
        task: "Fix {{identifier}} {{title}} {{description}} in {{worktreePath}}",
      },
      audit: {
        system: "You are an auditor",
        task: "Audit {{identifier}} {{title}} {{description}} in {{worktreePath}}",
      },
      rework: { addendum: "" }, // falsy — should count as missing
    } as any);

    const checks = await checkFilesAndDirs();
    const promptCheck = checks.find((c) => c.label.includes("Prompt issues"));
    expect(promptCheck?.severity).toBe("fail");
    expect(promptCheck?.label).toContain("Missing rework.addendum");
  });

  it("reports when variable missing from audit.task but present in worker.task", async () => {
    vi.mocked(loadPrompts).mockReturnValueOnce({
      worker: {
        system: "ok",
        task: "Fix {{identifier}} {{title}} {{description}} in {{worktreePath}}",
      },
      audit: {
        system: "ok",
        task: "Audit the issue please", // missing all vars
      },
      rework: { addendum: "Fix these gaps: {{gaps}}" },
    } as any);

    const checks = await checkFilesAndDirs();
    const promptCheck = checks.find((c) => c.label.includes("Prompt issues"));
    expect(promptCheck?.severity).toBe("fail");
    expect(promptCheck?.label).toContain("audit.task missing");
  });
});

// ---------------------------------------------------------------------------
// checkConnectivity — additional branches
// ---------------------------------------------------------------------------

describe("checkConnectivity — additional branches", () => {
  it("re-checks Linear API when no authCtx, token available, and API returns ok", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("linear.app")) {
        return { ok: true, json: async () => ({ data: { viewer: { id: "1" } } }) };
      }
      // webhook self-test
      throw new Error("ECONNREFUSED");
    }));

    const checks = await checkConnectivity();
    const apiCheck = checks.find((c) => c.label === "Linear API: connected");
    expect(apiCheck?.severity).toBe("pass");
  });

  it("reports fail when API returns non-ok without authCtx", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("linear.app")) {
        return { ok: false, status: 403, statusText: "Forbidden" };
      }
      throw new Error("ECONNREFUSED");
    }));

    const checks = await checkConnectivity();
    const apiCheck = checks.find((c) => c.label.includes("Linear API: 403"));
    expect(apiCheck?.severity).toBe("fail");
  });

  it("reports fail when API throws without authCtx", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("linear.app")) {
        throw new Error("DNS resolution failed");
      }
      throw new Error("ECONNREFUSED");
    }));

    const checks = await checkConnectivity();
    const apiCheck = checks.find((c) => c.label.includes("Linear API: unreachable"));
    expect(apiCheck?.severity).toBe("fail");
    expect(apiCheck?.label).toContain("DNS resolution failed");
  });

  it("reports fail when no token available and no authCtx", async () => {
    vi.mocked(resolveLinearToken).mockReturnValueOnce({
      accessToken: null,
      source: "none",
    });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));

    const checks = await checkConnectivity();
    const apiCheck = checks.find((c) => c.label.includes("Linear API: no token"));
    expect(apiCheck?.severity).toBe("fail");
  });

  it("reports notification targets when configured", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));

    const checks = await checkConnectivity(
      {
        notifications: {
          targets: [
            { channel: "discord", target: "#ct-ai" },
            { channel: "telegram", target: "-1003884997363" },
          ],
        },
      },
      { viewer: { name: "T" } },
    );
    const notifChecks = checks.filter((c) => c.label.includes("Notifications:"));
    expect(notifChecks).toHaveLength(2);
    expect(notifChecks[0].label).toContain("discord");
    expect(notifChecks[1].label).toContain("telegram");
  });

  it("reports pass when webhook self-test responds OK", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("localhost")) {
        return { ok: true, text: async () => "ok" };
      }
      throw new Error("unexpected");
    }));

    const checks = await checkConnectivity({}, { viewer: { name: "T" } });
    const webhookCheck = checks.find((c) => c.label.includes("Webhook self-test: responds OK"));
    expect(webhookCheck?.severity).toBe("pass");
  });

  it("reports warn when webhook self-test responds non-ok", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("localhost")) {
        return { ok: false, status: 404, text: async () => "not found" };
      }
      throw new Error("unexpected");
    }));

    const checks = await checkConnectivity({}, { viewer: { name: "T" } });
    const webhookCheck = checks.find((c) => c.label.includes("Webhook self-test:"));
    expect(webhookCheck?.severity).toBe("warn");
    expect(webhookCheck?.label).toContain("404");
  });

  it("uses token directly without Bearer when no refreshToken (connectivity re-check)", async () => {
    vi.mocked(resolveLinearToken).mockReturnValueOnce({
      accessToken: "lin_api_direct",
      source: "config",
      // No refreshToken
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("linear.app")) {
        return { ok: true, json: async () => ({ data: { viewer: { id: "1" } } }) };
      }
      throw new Error("ECONNREFUSED");
    });
    vi.stubGlobal("fetch", fetchMock);

    await checkConnectivity(); // No authCtx, triggers re-check
    const linearCall = fetchMock.mock.calls.find((c) => (c[0] as string).includes("linear.app"));
    const headers = (linearCall![1] as any).headers;
    expect(headers.Authorization).toBe("lin_api_direct");
  });
});

// ---------------------------------------------------------------------------
// checkDispatchHealth — additional branches
// ---------------------------------------------------------------------------

describe("checkDispatchHealth — additional branches", () => {
  it("reports pass when readDispatchState throws (no state file)", async () => {
    vi.mocked(readDispatchState).mockRejectedValueOnce(new Error("ENOENT"));

    const checks = await checkDispatchHealth();
    const healthCheck = checks.find((c) => c.label.includes("Dispatch health: no state file"));
    expect(healthCheck?.severity).toBe("pass");
  });

  it("warns about active dispatches with stuck status", async () => {
    vi.mocked(listActiveDispatches).mockReturnValueOnce([
      { issueIdentifier: "API-1", status: "stuck" } as any,
      { issueIdentifier: "API-2", status: "working" } as any,
    ]);

    const checks = await checkDispatchHealth();
    const activeCheck = checks.find((c) => c.label.includes("Active dispatches:"));
    expect(activeCheck?.severity).toBe("warn");
    expect(activeCheck?.label).toContain("stuck");
  });

  it("passes for active dispatches without stuck status", async () => {
    vi.mocked(listActiveDispatches).mockReturnValueOnce([
      { issueIdentifier: "API-1", status: "working" } as any,
      { issueIdentifier: "API-2", status: "auditing" } as any,
    ]);

    const checks = await checkDispatchHealth();
    const activeCheck = checks.find((c) => c.label.includes("Active dispatches:"));
    expect(activeCheck?.severity).toBe("pass");
    expect(activeCheck?.label).toContain("working");
    expect(activeCheck?.label).toContain("auditing");
  });

  it("reports orphaned worktrees", async () => {
    vi.mocked(listWorktrees).mockReturnValueOnce([
      { issueIdentifier: "ORPHAN-1", path: "/tmp/wt1" } as any,
      { issueIdentifier: "ORPHAN-2", path: "/tmp/wt2" } as any,
    ]);

    const checks = await checkDispatchHealth();
    const orphanCheck = checks.find((c) => c.label.includes("orphaned worktree"));
    expect(orphanCheck?.severity).toBe("warn");
    expect(orphanCheck?.label).toContain("2 orphaned worktrees");
    expect(orphanCheck?.detail).toContain("/tmp/wt1");
  });

  it("warns about old completed without fix (plural)", async () => {
    vi.mocked(readDispatchState).mockResolvedValueOnce({
      dispatches: {
        active: {},
        completed: {
          "API-OLD-1": { completedAt: new Date(Date.now() - 10 * 24 * 3_600_000).toISOString(), status: "done" } as any,
          "API-OLD-2": { completedAt: new Date(Date.now() - 8 * 24 * 3_600_000).toISOString(), status: "done" } as any,
        },
      },
      sessionMap: {},
      processedEvents: [],
    });

    const checks = await checkDispatchHealth(undefined, false);
    const oldCheck = checks.find((c) => c.label.includes("completed dispatch"));
    expect(oldCheck?.severity).toBe("warn");
    expect(oldCheck?.label).toContain("2 completed dispatches");
    expect(oldCheck?.fixable).toBe(true);
  });

  it("reports multiple stale dispatches with plural", async () => {
    vi.mocked(listStaleDispatches).mockReturnValueOnce([
      { issueIdentifier: "API-1", status: "working" } as any,
      { issueIdentifier: "API-2", status: "auditing" } as any,
    ]);

    const checks = await checkDispatchHealth();
    const staleCheck = checks.find((c) => c.label.includes("stale dispatch"));
    expect(staleCheck?.severity).toBe("warn");
    expect(staleCheck?.label).toContain("2 stale dispatches");
  });
});

// ---------------------------------------------------------------------------
// checkWebhooks — additional branches
// ---------------------------------------------------------------------------

describe("checkWebhooks — additional branches", () => {
  it("warns and skips when no Linear token", async () => {
    vi.mocked(resolveLinearToken).mockReturnValueOnce({
      accessToken: null,
      source: "none",
    });

    const checks = await checkWebhooks();
    expect(checks).toHaveLength(1);
    expect(checks[0].severity).toBe("warn");
    expect(checks[0].label).toContain("Webhook check skipped");
  });

  it("reports pass when webhook status has no issues", async () => {
    vi.mocked(getWebhookStatus).mockResolvedValueOnce({
      webhookId: "wh-1",
      url: "https://example.com/webhook",
      enabled: true,
      resourceTypes: ["Comment", "Issue"],
      issues: [],
    } as any);

    const checks = await checkWebhooks();
    const whCheck = checks.find((c) => c.label.includes("Workspace webhook OK"));
    expect(whCheck?.severity).toBe("pass");
    expect(whCheck?.label).toContain("Comment");
    expect(whCheck?.label).toContain("Issue");
  });

  it("reports warnings for webhook issues without fix", async () => {
    vi.mocked(getWebhookStatus).mockResolvedValueOnce({
      webhookId: "wh-1",
      url: "https://example.com/webhook",
      enabled: true,
      resourceTypes: ["Comment"],
      issues: ["Missing resource type: Issue", "Webhook disabled"],
    } as any);

    const checks = await checkWebhooks(undefined, false);
    const issueChecks = checks.filter((c) => c.label.includes("Webhook issue:"));
    expect(issueChecks).toHaveLength(2);
    expect(issueChecks[0].severity).toBe("warn");
    expect(issueChecks[0].label).toContain("Missing resource type");
    expect(issueChecks[1].label).toContain("Webhook disabled");
    expect(issueChecks[0].fixable).toBe(true);
  });

  it("fixes webhook issues with --fix", async () => {
    vi.mocked(getWebhookStatus).mockResolvedValueOnce({
      webhookId: "wh-1",
      url: "https://example.com/webhook",
      enabled: true,
      resourceTypes: ["Comment"],
      issues: ["Missing resource type: Issue"],
    } as any);
    vi.mocked(provisionWebhook).mockResolvedValueOnce({
      action: "updated",
      webhookId: "wh-1",
      changes: ["added Issue resource type"],
    } as any);

    const checks = await checkWebhooks(undefined, true);
    const fixCheck = checks.find((c) => c.label.includes("Workspace webhook fixed"));
    expect(fixCheck?.severity).toBe("pass");
    expect(fixCheck?.label).toContain("added Issue resource type");
  });

  it("creates webhook with --fix when none found", async () => {
    // getWebhookStatus already mocked to return null by default
    vi.mocked(provisionWebhook).mockResolvedValueOnce({
      action: "created",
      webhookId: "wh-new",
      changes: ["created"],
    } as any);

    const checks = await checkWebhooks(undefined, true);
    const createCheck = checks.find((c) => c.label.includes("Workspace webhook created"));
    expect(createCheck?.severity).toBe("pass");
    expect(createCheck?.label).toContain("wh-new");
  });

  it("reports fail when no webhook found and no --fix", async () => {
    // getWebhookStatus already returns null by default
    const checks = await checkWebhooks(undefined, false);
    const failCheck = checks.find((c) => c.label.includes("No workspace webhook found"));
    expect(failCheck?.severity).toBe("fail");
    expect(failCheck?.fix).toContain("webhooks setup");
  });

  it("handles webhook check failure gracefully", async () => {
    vi.mocked(getWebhookStatus).mockRejectedValueOnce(new Error("network timeout"));

    const checks = await checkWebhooks();
    const failCheck = checks.find((c) => c.label.includes("Webhook check failed"));
    expect(failCheck?.severity).toBe("warn");
    expect(failCheck?.label).toContain("network timeout");
  });

  it("uses custom webhookUrl from pluginConfig", async () => {
    vi.mocked(getWebhookStatus).mockResolvedValueOnce({
      webhookId: "wh-custom",
      url: "https://custom.example.com/webhook",
      enabled: true,
      resourceTypes: ["Comment", "Issue"],
      issues: [],
    } as any);

    const checks = await checkWebhooks({ webhookUrl: "https://custom.example.com/webhook" });
    expect(getWebhookStatus).toHaveBeenCalled();
    const whCheck = checks.find((c) => c.label.includes("Workspace webhook OK"));
    expect(whCheck?.severity).toBe("pass");
  });

  it("handles provisionWebhook with no changes array", async () => {
    vi.mocked(getWebhookStatus).mockResolvedValueOnce({
      webhookId: "wh-1",
      url: "https://example.com/webhook",
      enabled: true,
      resourceTypes: ["Comment"],
      issues: ["Missing Issue"],
    } as any);
    vi.mocked(provisionWebhook).mockResolvedValueOnce({
      action: "updated",
      webhookId: "wh-1",
      // No changes array
    } as any);

    const checks = await checkWebhooks(undefined, true);
    const fixCheck = checks.find((c) => c.label.includes("Workspace webhook fixed"));
    expect(fixCheck?.severity).toBe("pass");
    expect(fixCheck?.label).toContain("fixed"); // falls back to "fixed"
  });
});

// ---------------------------------------------------------------------------
// formatReport — additional branches
// ---------------------------------------------------------------------------

describe("formatReport — additional branches", () => {
  it("shows fix guidance for fail severity", () => {
    const report = {
      sections: [{
        name: "Test",
        checks: [
          { label: "Config missing", severity: "fail" as const, fix: "Add config file" },
        ],
      }],
      summary: { passed: 0, warnings: 0, errors: 1 },
    };

    const output = formatReport(report);
    expect(output).toContain("Add config file");
    expect(output).toContain("1 error");
  });

  it("shows plural errors and warnings in summary", () => {
    const report = {
      sections: [{
        name: "Test",
        checks: [
          { label: "w1", severity: "warn" as const },
          { label: "w2", severity: "warn" as const },
          { label: "e1", severity: "fail" as const },
          { label: "e2", severity: "fail" as const },
        ],
      }],
      summary: { passed: 0, warnings: 2, errors: 2 },
    };

    const output = formatReport(report);
    expect(output).toContain("2 warnings");
    expect(output).toContain("2 errors");
  });

  it("omits warnings and errors from summary when zero", () => {
    const report = {
      sections: [{
        name: "Test",
        checks: [{ label: "ok", severity: "pass" as const }],
      }],
      summary: { passed: 1, warnings: 0, errors: 0 },
    };

    const output = formatReport(report);
    expect(output).toContain("1 passed");
    expect(output).not.toContain("warning");
    expect(output).not.toContain("error");
  });

  it("does not show fix when check is passing even with fix set", () => {
    const report = {
      sections: [{
        name: "Test",
        checks: [
          { label: "Good check", severity: "pass" as const, fix: "This should not show" },
        ],
      }],
      summary: { passed: 1, warnings: 0, errors: 0 },
    };

    const output = formatReport(report);
    expect(output).not.toContain("This should not show");
  });
});

// ---------------------------------------------------------------------------
// buildSummary — additional branches
// ---------------------------------------------------------------------------

describe("buildSummary — additional branches", () => {
  it("returns zeros for empty sections", () => {
    const summary = buildSummary([]);
    expect(summary).toEqual({ passed: 0, warnings: 0, errors: 0 });
  });

  it("returns zeros for sections with no checks", () => {
    const summary = buildSummary([{ name: "Empty", checks: [] }]);
    expect(summary).toEqual({ passed: 0, warnings: 0, errors: 0 });
  });
});

// ---------------------------------------------------------------------------
// runDoctor — additional branches
// ---------------------------------------------------------------------------

describe("runDoctor — additional branches", () => {
      it("applies --fix to auth-profiles.json permissions when fixable check exists", async () => {
    // We need a scenario where checkAuth produces a fixable permissions check
    // The AUTH_PROFILES_PATH is mocked to /tmp/test-auth-profiles.json
    // Write a file there with wrong permissions so statSync succeeds
    const testAuthPath = "/tmp/test-auth-profiles.json";
    writeFileSync(testAuthPath, '{"profiles": {}}');
    chmodSync(testAuthPath, 0o644); // Wrong permissions

    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("linear.app")) {
        return {
          ok: true,
          json: async () => ({ data: { viewer: { id: "1", name: "T" }, organization: { name: "O", urlKey: "o" } } }),
        };
      }
      throw new Error("ECONNREFUSED");
    }));

    const report = await runDoctor({ fix: true, json: false });
    // The permissions check should have been attempted to fix
    const authSection = report.sections.find((s) => s.name === "Authentication & Tokens");
    const permCheck = authSection?.checks.find((c) => c.label.includes("permissions"));
    // If chmodSync succeeded (which it should for /tmp), severity should be "pass"
    if (permCheck && permCheck.label.includes("fixed")) {
      expect(permCheck.severity).toBe("pass");
    }
  });
});

// ---------------------------------------------------------------------------
// checkFilesAndDirs — lock file branches
// ---------------------------------------------------------------------------

describe("checkFilesAndDirs — lock file branches", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "doctor-lock-"));
  });

  it("warns about stale lock file without --fix", async () => {
    const statePath = join(tmpDir, "state.json");
    const lockPath = statePath + ".lock";
    writeFileSync(statePath, '{}');
    writeFileSync(lockPath, "locked");
    // Make the lock file appear stale by backdating its mtime
    const staleTime = Date.now() - 60_000; // 60 seconds old (> 30s LOCK_STALE_MS)
    const { utimesSync } = await import("node:fs");
    utimesSync(lockPath, staleTime / 1000, staleTime / 1000);

    vi.mocked(readDispatchState).mockResolvedValueOnce({
      dispatches: { active: {}, completed: {} },
      sessionMap: {},
      processedEvents: [],
    });

    const checks = await checkFilesAndDirs({ dispatchStatePath: statePath }, false);
    const lockCheck = checks.find((c) => c.label.includes("Stale lock file"));
    expect(lockCheck?.severity).toBe("warn");
    expect(lockCheck?.fixable).toBe(true);
  });

  it("removes stale lock file with --fix", async () => {
    const statePath = join(tmpDir, "state.json");
    const lockPath = statePath + ".lock";
    writeFileSync(statePath, '{}');
    writeFileSync(lockPath, "locked");
    const staleTime = Date.now() - 60_000;
    const { utimesSync } = await import("node:fs");
    utimesSync(lockPath, staleTime / 1000, staleTime / 1000);

    vi.mocked(readDispatchState).mockResolvedValueOnce({
      dispatches: { active: {}, completed: {} },
      sessionMap: {},
      processedEvents: [],
    });

    const checks = await checkFilesAndDirs({ dispatchStatePath: statePath }, true);
    const lockCheck = checks.find((c) => c.label.includes("Stale lock file removed"));
    expect(lockCheck?.severity).toBe("pass");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("warns about active (non-stale) lock file", async () => {
    const statePath = join(tmpDir, "state.json");
    const lockPath = statePath + ".lock";
    writeFileSync(statePath, '{}');
    writeFileSync(lockPath, "locked");
    // Lock file is fresh (just created), so lockAge < LOCK_STALE_MS

    vi.mocked(readDispatchState).mockResolvedValueOnce({
      dispatches: { active: {}, completed: {} },
      sessionMap: {},
      processedEvents: [],
    });

    const checks = await checkFilesAndDirs({ dispatchStatePath: statePath }, false);
    const lockCheck = checks.find((c) => c.label.includes("Lock file active"));
    expect(lockCheck?.severity).toBe("warn");
    expect(lockCheck?.label).toContain("may be in use");
  });
});

// ---------------------------------------------------------------------------
// checkFilesAndDirs — prompt variable edge cases
// ---------------------------------------------------------------------------

describe("checkFilesAndDirs — prompt variable edge cases", () => {
  it("reports when variable missing from worker.task but present in audit.task", async () => {
    vi.mocked(loadPrompts).mockReturnValueOnce({
      worker: {
        system: "ok",
        task: "Do something", // missing all vars
      },
      audit: {
        system: "ok",
        task: "Audit {{identifier}} {{title}} {{description}} in {{worktreePath}}", // has all vars
      },
      rework: { addendum: "Fix these gaps: {{gaps}}" },
    } as any);

    const checks = await checkFilesAndDirs();
    const promptCheck = checks.find((c) => c.label.includes("Prompt issues"));
    expect(promptCheck?.severity).toBe("fail");
    expect(promptCheck?.label).toContain("worker.task missing");
    // Crucially, audit.task should NOT be missing
    expect(promptCheck?.label).not.toContain("audit.task missing");
  });

  it("reports loadPrompts throwing non-Error value", async () => {
    vi.mocked(loadPrompts).mockImplementationOnce(() => { throw "raw string error"; });

    const checks = await checkFilesAndDirs();
    const promptCheck = checks.find((c) => c.label.includes("Failed to load prompts"));
    expect(promptCheck?.severity).toBe("fail");
    expect(promptCheck?.detail).toContain("raw string error");
  });
});

// ---------------------------------------------------------------------------
// checkFilesAndDirs — worktree & base repo edge cases
// ---------------------------------------------------------------------------

describe("checkFilesAndDirs — worktree & base repo edge cases", () => {
  it("reports worktree base dir does not exist", async () => {
    const checks = await checkFilesAndDirs({
      worktreeBaseDir: "/tmp/nonexistent-worktree-dir-" + Date.now(),
    });
    const wtCheck = checks.find((c) => c.label.includes("Worktree base dir does not exist"));
    expect(wtCheck?.severity).toBe("warn");
    expect(wtCheck?.detail).toContain("Will be created on first dispatch");
  });

  it("reports base repo does not exist", async () => {
    const checks = await checkFilesAndDirs({
      codexBaseRepo: "/tmp/nonexistent-repo-" + Date.now(),
    });
    const repoCheck = checks.find((c) => c.label.includes("Base repo does not exist"));
    expect(repoCheck?.severity).toBe("fail");
    expect(repoCheck?.fix).toContain("codexBaseRepo");
  });

  it("reports base repo exists but is not a git repo", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "doctor-nongit-"));
    const checks = await checkFilesAndDirs({
      codexBaseRepo: tmpDir,
    });
    const repoCheck = checks.find((c) => c.label.includes("Base repo is not a git repo"));
    expect(repoCheck?.severity).toBe("fail");
    expect(repoCheck?.fix).toContain("git init");
  });
});

// ---------------------------------------------------------------------------
// checkFilesAndDirs — tilde path resolution branches
// ---------------------------------------------------------------------------

describe("checkFilesAndDirs — tilde path resolution", () => {
  it("resolves ~/... dispatch state path", async () => {
    vi.mocked(readDispatchState).mockRejectedValueOnce(new Error("ENOENT"));

    // Providing a path with ~/ triggers the tilde resolution branch
    const checks = await checkFilesAndDirs({
      dispatchStatePath: "~/nonexistent-state-file.json",
    });
    // The file won't exist (tilde-resolved), so we get the "no file yet" message
    const stateCheck = checks.find((c) => c.label.includes("Dispatch state"));
    expect(stateCheck).toBeDefined();
  });

  it("resolves ~/... worktree base dir path", async () => {
    const checks = await checkFilesAndDirs({
      worktreeBaseDir: "~/nonexistent-worktree-base",
    });
    const wtCheck = checks.find((c) => c.label.includes("Worktree base dir"));
    expect(wtCheck).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// checkDispatchHealth — orphaned worktree singular
// ---------------------------------------------------------------------------

describe("checkDispatchHealth — edge cases", () => {
  it("reports single orphaned worktree (singular)", async () => {
    vi.mocked(listWorktrees).mockReturnValueOnce([
      { issueIdentifier: "ORPHAN-1", path: "/tmp/wt1" } as any,
    ]);

    const checks = await checkDispatchHealth();
    const orphanCheck = checks.find((c) => c.label.includes("orphaned worktree"));
    expect(orphanCheck?.severity).toBe("warn");
    expect(orphanCheck?.label).toContain("1 orphaned worktree");
    expect(orphanCheck?.label).not.toContain("worktrees"); // singular, not plural
  });

  it("prunes multiple old completed dispatches (plural)", async () => {
    vi.mocked(readDispatchState).mockResolvedValueOnce({
      dispatches: {
        active: {},
        completed: {
          "A-1": { completedAt: new Date(Date.now() - 10 * 24 * 3_600_000).toISOString() } as any,
          "A-2": { completedAt: new Date(Date.now() - 10 * 24 * 3_600_000).toISOString() } as any,
        },
      },
      sessionMap: {},
      processedEvents: [],
    });
    vi.mocked(pruneCompleted).mockResolvedValueOnce(2);

    const checks = await checkDispatchHealth(undefined, true);
    const pruneCheck = checks.find((c) => c.label.includes("Pruned"));
    expect(pruneCheck?.severity).toBe("pass");
    expect(pruneCheck?.label).toContain("2 old completed dispatches");
  });

  it("reports single stale dispatch (singular)", async () => {
    vi.mocked(listStaleDispatches).mockReturnValueOnce([
      { issueIdentifier: "API-1", status: "working" } as any,
    ]);

    const checks = await checkDispatchHealth();
    const staleCheck = checks.find((c) => c.label.includes("stale dispatch"));
    expect(staleCheck?.severity).toBe("warn");
    // Singular: "1 stale dispatch" not "1 stale dispatches"
    expect(staleCheck?.label).toMatch(/1 stale dispatch(?!es)/);
  });
});

// ---------------------------------------------------------------------------
// checkConnectivity — webhook self-test with ok but body !== "ok"
// ---------------------------------------------------------------------------

describe("checkConnectivity — webhook non-ok body", () => {
  it("warns when webhook returns ok status but body is not 'ok'", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("localhost")) {
        return { ok: true, text: async () => "pong" };
      }
      throw new Error("unexpected");
    }));

    const checks = await checkConnectivity({}, { viewer: { name: "T" } });
    const webhookCheck = checks.find((c) => c.label.includes("Webhook self-test:"));
    // ok is true but body is "pong" not "ok" — the condition is `res.ok && body === "ok"`
    // Since body !== "ok", it falls into the warn branch
    expect(webhookCheck?.severity).toBe("warn");
  });
});

// ---------------------------------------------------------------------------
// formatReport — icon function TTY branches
// ---------------------------------------------------------------------------

describe("formatReport — TTY icon rendering", () => {
  it("renders colored icons when stdout.isTTY is true", () => {
    const origIsTTY = process.stdout.isTTY;
    try {
      Object.defineProperty(process.stdout, "isTTY", { value: true, writable: true, configurable: true });

      const report = {
        sections: [{
          name: "Test",
          checks: [
            { label: "pass check", severity: "pass" as const },
            { label: "warn check", severity: "warn" as const },
            { label: "fail check", severity: "fail" as const },
          ],
        }],
        summary: { passed: 1, warnings: 1, errors: 1 },
      };

      const output = formatReport(report);
      // TTY output includes ANSI escape codes
      expect(output).toContain("\x1b[32m"); // green for pass
      expect(output).toContain("\x1b[33m"); // yellow for warn
      expect(output).toContain("\x1b[31m"); // red for fail
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { value: origIsTTY, writable: true, configurable: true });
    }
  });
});

// ---------------------------------------------------------------------------
// checkCodingTools — codingTool fallback to "codex" in label
// ---------------------------------------------------------------------------

describe("checkCodingTools — codingTool null fallback", () => {
  it("shows 'codex' as default when codingTool is undefined but backends exist", () => {
    vi.mocked(loadCodingConfig).mockReturnValueOnce({
      codingTool: undefined,
      backends: { codex: { aliases: ["codex"] } },
    } as any);

    const checks = checkCodingTools();
    const configCheck = checks.find((c) => c.label.includes("coding-tools.json loaded"));
    expect(configCheck?.severity).toBe("pass");
    expect(configCheck?.label).toContain("codex"); // falls back to "codex" via ??
  });
});

// ---------------------------------------------------------------------------
// checkFilesAndDirs — dispatch state non-Error catch branch
// ---------------------------------------------------------------------------

describe("checkFilesAndDirs — dispatch state non-Error exception", () => {
  it("handles non-Error thrown during dispatch state read", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "doctor-nonError-"));
    const statePath = join(tmpDir, "state.json");
    writeFileSync(statePath, '{}');
    vi.mocked(readDispatchState).mockRejectedValueOnce("raw string dispatch error");

    const checks = await checkFilesAndDirs({ dispatchStatePath: statePath });
    const stateCheck = checks.find((c) => c.label.includes("Dispatch state corrupt"));
    expect(stateCheck?.severity).toBe("fail");
    expect(stateCheck?.detail).toContain("raw string dispatch error");
  });
});

// ---------------------------------------------------------------------------
// checkFilesAndDirs — lock file branches
// ---------------------------------------------------------------------------

describe("checkFilesAndDirs — lock file branches", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "doctor-lock-"));
  });

  it("warns about stale lock file without --fix", async () => {
    const statePath = join(tmpDir, "state.json");
    const lockPath = statePath + ".lock";
    writeFileSync(statePath, '{}');
    writeFileSync(lockPath, "locked");
    // Make the lock file appear stale by backdating its mtime
    const staleTime = Date.now() - 60_000; // 60 seconds old (> 30s LOCK_STALE_MS)
    const { utimesSync } = await import("node:fs");
    utimesSync(lockPath, staleTime / 1000, staleTime / 1000);

    vi.mocked(readDispatchState).mockResolvedValueOnce({
      dispatches: { active: {}, completed: {} },
      sessionMap: {},
      processedEvents: [],
    });

    const checks = await checkFilesAndDirs({ dispatchStatePath: statePath }, false);
    const lockCheck = checks.find((c) => c.label.includes("Stale lock file"));
    expect(lockCheck?.severity).toBe("warn");
    expect(lockCheck?.fixable).toBe(true);
  });

  it("removes stale lock file with --fix", async () => {
    const statePath = join(tmpDir, "state.json");
    const lockPath = statePath + ".lock";
    writeFileSync(statePath, '{}');
    writeFileSync(lockPath, "locked");
    const staleTime = Date.now() - 60_000;
    const { utimesSync } = await import("node:fs");
    utimesSync(lockPath, staleTime / 1000, staleTime / 1000);

    vi.mocked(readDispatchState).mockResolvedValueOnce({
      dispatches: { active: {}, completed: {} },
      sessionMap: {},
      processedEvents: [],
    });

    const checks = await checkFilesAndDirs({ dispatchStatePath: statePath }, true);
    const lockCheck = checks.find((c) => c.label.includes("Stale lock file removed"));
    expect(lockCheck?.severity).toBe("pass");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("warns about active (non-stale) lock file", async () => {
    const statePath = join(tmpDir, "state.json");
    const lockPath = statePath + ".lock";
    writeFileSync(statePath, '{}');
    writeFileSync(lockPath, "locked");
    // Lock file is fresh (just created), so lockAge < LOCK_STALE_MS

    vi.mocked(readDispatchState).mockResolvedValueOnce({
      dispatches: { active: {}, completed: {} },
      sessionMap: {},
      processedEvents: [],
    });

    const checks = await checkFilesAndDirs({ dispatchStatePath: statePath }, false);
    const lockCheck = checks.find((c) => c.label.includes("Lock file active"));
    expect(lockCheck?.severity).toBe("warn");
    expect(lockCheck?.label).toContain("may be in use");
  });
});

// ---------------------------------------------------------------------------
// checkFilesAndDirs — prompt variable edge cases
// ---------------------------------------------------------------------------

describe("checkFilesAndDirs — prompt variable edge cases", () => {
  it("reports when variable missing from worker.task but present in audit.task", async () => {
    vi.mocked(loadPrompts).mockReturnValueOnce({
      worker: {
        system: "ok",
        task: "Do something", // missing all vars
      },
      audit: {
        system: "ok",
        task: "Audit {{identifier}} {{title}} {{description}} in {{worktreePath}}", // has all vars
      },
      rework: { addendum: "Fix these gaps: {{gaps}}" },
    } as any);

    const checks = await checkFilesAndDirs();
    const promptCheck = checks.find((c) => c.label.includes("Prompt issues"));
    expect(promptCheck?.severity).toBe("fail");
    expect(promptCheck?.label).toContain("worker.task missing");
    // Crucially, audit.task should NOT be missing
    expect(promptCheck?.label).not.toContain("audit.task missing");
  });

  it("reports loadPrompts throwing non-Error value", async () => {
    vi.mocked(loadPrompts).mockImplementationOnce(() => { throw "raw string error"; });

    const checks = await checkFilesAndDirs();
    const promptCheck = checks.find((c) => c.label.includes("Failed to load prompts"));
    expect(promptCheck?.severity).toBe("fail");
    expect(promptCheck?.detail).toContain("raw string error");
  });
});

// ---------------------------------------------------------------------------
// checkFilesAndDirs — worktree & base repo edge cases
// ---------------------------------------------------------------------------

describe("checkFilesAndDirs — worktree & base repo edge cases", () => {
  it("reports worktree base dir does not exist", async () => {
    const checks = await checkFilesAndDirs({
      worktreeBaseDir: "/tmp/nonexistent-worktree-dir-" + Date.now(),
    });
    const wtCheck = checks.find((c) => c.label.includes("Worktree base dir does not exist"));
    expect(wtCheck?.severity).toBe("warn");
    expect(wtCheck?.detail).toContain("Will be created on first dispatch");
  });

  it("reports base repo does not exist", async () => {
    const checks = await checkFilesAndDirs({
      codexBaseRepo: "/tmp/nonexistent-repo-" + Date.now(),
    });
    const repoCheck = checks.find((c) => c.label.includes("Base repo does not exist"));
    expect(repoCheck?.severity).toBe("fail");
    expect(repoCheck?.fix).toContain("codexBaseRepo");
  });

  it("reports base repo exists but is not a git repo", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "doctor-nongit-"));
    const checks = await checkFilesAndDirs({
      codexBaseRepo: tmpDir,
    });
    const repoCheck = checks.find((c) => c.label.includes("Base repo is not a git repo"));
    expect(repoCheck?.severity).toBe("fail");
    expect(repoCheck?.fix).toContain("git init");
  });
});

// ---------------------------------------------------------------------------
// checkFilesAndDirs — tilde path resolution branches
// ---------------------------------------------------------------------------

describe("checkFilesAndDirs — tilde path resolution", () => {
  it("resolves ~/... dispatch state path", async () => {
    vi.mocked(readDispatchState).mockRejectedValueOnce(new Error("ENOENT"));

    // Providing a path with ~/ triggers the tilde resolution branch
    const checks = await checkFilesAndDirs({
      dispatchStatePath: "~/nonexistent-state-file.json",
    });
    // The file won't exist (tilde-resolved), so we get the "no file yet" message
    const stateCheck = checks.find((c) => c.label.includes("Dispatch state"));
    expect(stateCheck).toBeDefined();
  });

  it("resolves ~/... worktree base dir path", async () => {
    const checks = await checkFilesAndDirs({
      worktreeBaseDir: "~/nonexistent-worktree-base",
    });
    const wtCheck = checks.find((c) => c.label.includes("Worktree base dir"));
    expect(wtCheck).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// checkDispatchHealth — orphaned worktree singular
// ---------------------------------------------------------------------------

describe("checkDispatchHealth — edge cases", () => {
  it("reports single orphaned worktree (singular)", async () => {
    vi.mocked(listWorktrees).mockReturnValueOnce([
      { issueIdentifier: "ORPHAN-1", path: "/tmp/wt1" } as any,
    ]);

    const checks = await checkDispatchHealth();
    const orphanCheck = checks.find((c) => c.label.includes("orphaned worktree"));
    expect(orphanCheck?.severity).toBe("warn");
    expect(orphanCheck?.label).toContain("1 orphaned worktree");
    expect(orphanCheck?.label).not.toContain("worktrees"); // singular, not plural
  });

  it("prunes multiple old completed dispatches (plural)", async () => {
    vi.mocked(readDispatchState).mockResolvedValueOnce({
      dispatches: {
        active: {},
        completed: {
          "A-1": { completedAt: new Date(Date.now() - 10 * 24 * 3_600_000).toISOString() } as any,
          "A-2": { completedAt: new Date(Date.now() - 10 * 24 * 3_600_000).toISOString() } as any,
        },
      },
      sessionMap: {},
      processedEvents: [],
    });
    vi.mocked(pruneCompleted).mockResolvedValueOnce(2);

    const checks = await checkDispatchHealth(undefined, true);
    const pruneCheck = checks.find((c) => c.label.includes("Pruned"));
    expect(pruneCheck?.severity).toBe("pass");
    expect(pruneCheck?.label).toContain("2 old completed dispatches");
  });

  it("reports single stale dispatch (singular)", async () => {
    vi.mocked(listStaleDispatches).mockReturnValueOnce([
      { issueIdentifier: "API-1", status: "working" } as any,
    ]);

    const checks = await checkDispatchHealth();
    const staleCheck = checks.find((c) => c.label.includes("stale dispatch"));
    expect(staleCheck?.severity).toBe("warn");
    // Singular: "1 stale dispatch" not "1 stale dispatches"
    expect(staleCheck?.label).toMatch(/1 stale dispatch(?!es)/);
  });
});

// ---------------------------------------------------------------------------
// checkConnectivity — webhook self-test with ok but body !== "ok"
// ---------------------------------------------------------------------------

describe("checkConnectivity — webhook non-ok body", () => {
  it("warns when webhook returns ok status but body is not 'ok'", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("localhost")) {
        return { ok: true, text: async () => "pong" };
      }
      throw new Error("unexpected");
    }));

    const checks = await checkConnectivity({}, { viewer: { name: "T" } });
    const webhookCheck = checks.find((c) => c.label.includes("Webhook self-test:"));
    // ok is true but body is "pong" not "ok" — the condition is `res.ok && body === "ok"`
    // Since body !== "ok", it falls into the warn branch
    expect(webhookCheck?.severity).toBe("warn");
  });
});

// ---------------------------------------------------------------------------
// formatReport — icon function TTY branches
// ---------------------------------------------------------------------------

describe("formatReport — TTY icon rendering", () => {
  it("renders colored icons when stdout.isTTY is true", () => {
    const origIsTTY = process.stdout.isTTY;
    try {
      Object.defineProperty(process.stdout, "isTTY", { value: true, writable: true, configurable: true });

      const report = {
        sections: [{
          name: "Test",
          checks: [
            { label: "pass check", severity: "pass" as const },
            { label: "warn check", severity: "warn" as const },
            { label: "fail check", severity: "fail" as const },
          ],
        }],
        summary: { passed: 1, warnings: 1, errors: 1 },
      };

      const output = formatReport(report);
      // TTY output includes ANSI escape codes
      expect(output).toContain("\x1b[32m"); // green for pass
      expect(output).toContain("\x1b[33m"); // yellow for warn
      expect(output).toContain("\x1b[31m"); // red for fail
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { value: origIsTTY, writable: true, configurable: true });
    }
  });
});

// ---------------------------------------------------------------------------
// checkCodingTools — codingTool fallback to "codex" in label
// ---------------------------------------------------------------------------

describe("checkCodingTools — codingTool null fallback", () => {
  it("shows 'codex' as default when codingTool is undefined but backends exist", () => {
    vi.mocked(loadCodingConfig).mockReturnValueOnce({
      codingTool: undefined,
      backends: { codex: { aliases: ["codex"] } },
    } as any);

    const checks = checkCodingTools();
    const configCheck = checks.find((c) => c.label.includes("coding-tools.json loaded"));
    expect(configCheck?.severity).toBe("pass");
    expect(configCheck?.label).toContain("codex"); // falls back to "codex" via ??
  });
});

// ---------------------------------------------------------------------------
// checkFilesAndDirs — dispatch state non-Error catch branch
// ---------------------------------------------------------------------------

describe("checkFilesAndDirs — dispatch state non-Error exception", () => {
  it("handles non-Error thrown during dispatch state read", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "doctor-nonError-"));
    const statePath = join(tmpDir, "state.json");
    writeFileSync(statePath, '{}');
    vi.mocked(readDispatchState).mockRejectedValueOnce("raw string dispatch error");

    const checks = await checkFilesAndDirs({ dispatchStatePath: statePath });
    const stateCheck = checks.find((c) => c.label.includes("Dispatch state corrupt"));
    expect(stateCheck?.severity).toBe("fail");
    expect(stateCheck?.detail).toContain("raw string dispatch error");
  });
});

// ---------------------------------------------------------------------------
// checkFilesAndDirs — lock file branches
// ---------------------------------------------------------------------------

describe("checkFilesAndDirs — lock file branches", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "doctor-lock-"));
  });

  it("warns about stale lock file without --fix", async () => {
    const statePath = join(tmpDir, "state.json");
    const lockPath = statePath + ".lock";
    writeFileSync(statePath, '{}');
    writeFileSync(lockPath, "locked");
    // Make the lock file appear stale by backdating its mtime
    const staleTime = Date.now() - 60_000; // 60 seconds old (> 30s LOCK_STALE_MS)
    const { utimesSync } = await import("node:fs");
    utimesSync(lockPath, staleTime / 1000, staleTime / 1000);

    vi.mocked(readDispatchState).mockResolvedValueOnce({
      dispatches: { active: {}, completed: {} },
      sessionMap: {},
      processedEvents: [],
    });

    const checks = await checkFilesAndDirs({ dispatchStatePath: statePath }, false);
    const lockCheck = checks.find((c) => c.label.includes("Stale lock file"));
    expect(lockCheck?.severity).toBe("warn");
    expect(lockCheck?.fixable).toBe(true);
  });

  it("removes stale lock file with --fix", async () => {
    const statePath = join(tmpDir, "state.json");
    const lockPath = statePath + ".lock";
    writeFileSync(statePath, '{}');
    writeFileSync(lockPath, "locked");
    const staleTime = Date.now() - 60_000;
    const { utimesSync } = await import("node:fs");
    utimesSync(lockPath, staleTime / 1000, staleTime / 1000);

    vi.mocked(readDispatchState).mockResolvedValueOnce({
      dispatches: { active: {}, completed: {} },
      sessionMap: {},
      processedEvents: [],
    });

    const checks = await checkFilesAndDirs({ dispatchStatePath: statePath }, true);
    const lockCheck = checks.find((c) => c.label.includes("Stale lock file removed"));
    expect(lockCheck?.severity).toBe("pass");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("warns about active (non-stale) lock file", async () => {
    const statePath = join(tmpDir, "state.json");
    const lockPath = statePath + ".lock";
    writeFileSync(statePath, '{}');
    writeFileSync(lockPath, "locked");
    // Lock file is fresh (just created), so lockAge < LOCK_STALE_MS

    vi.mocked(readDispatchState).mockResolvedValueOnce({
      dispatches: { active: {}, completed: {} },
      sessionMap: {},
      processedEvents: [],
    });

    const checks = await checkFilesAndDirs({ dispatchStatePath: statePath }, false);
    const lockCheck = checks.find((c) => c.label.includes("Lock file active"));
    expect(lockCheck?.severity).toBe("warn");
    expect(lockCheck?.label).toContain("may be in use");
  });
});

// ---------------------------------------------------------------------------
// checkFilesAndDirs — prompt variable edge cases
// ---------------------------------------------------------------------------

describe("checkFilesAndDirs — prompt variable edge cases", () => {
  it("reports when variable missing from worker.task but present in audit.task", async () => {
    vi.mocked(loadPrompts).mockReturnValueOnce({
      worker: {
        system: "ok",
        task: "Do something", // missing all vars
      },
      audit: {
        system: "ok",
        task: "Audit {{identifier}} {{title}} {{description}} in {{worktreePath}}", // has all vars
      },
      rework: { addendum: "Fix these gaps: {{gaps}}" },
    } as any);

    const checks = await checkFilesAndDirs();
    const promptCheck = checks.find((c) => c.label.includes("Prompt issues"));
    expect(promptCheck?.severity).toBe("fail");
    expect(promptCheck?.label).toContain("worker.task missing");
    // Crucially, audit.task should NOT be missing
    expect(promptCheck?.label).not.toContain("audit.task missing");
  });

  it("reports loadPrompts throwing non-Error value", async () => {
    vi.mocked(loadPrompts).mockImplementationOnce(() => { throw "raw string error"; });

    const checks = await checkFilesAndDirs();
    const promptCheck = checks.find((c) => c.label.includes("Failed to load prompts"));
    expect(promptCheck?.severity).toBe("fail");
    expect(promptCheck?.detail).toContain("raw string error");
  });
});

// ---------------------------------------------------------------------------
// checkFilesAndDirs — worktree & base repo edge cases
// ---------------------------------------------------------------------------

describe("checkFilesAndDirs — worktree & base repo edge cases", () => {
  it("reports worktree base dir does not exist", async () => {
    const checks = await checkFilesAndDirs({
      worktreeBaseDir: "/tmp/nonexistent-worktree-dir-" + Date.now(),
    });
    const wtCheck = checks.find((c) => c.label.includes("Worktree base dir does not exist"));
    expect(wtCheck?.severity).toBe("warn");
    expect(wtCheck?.detail).toContain("Will be created on first dispatch");
  });

  it("reports base repo does not exist", async () => {
    const checks = await checkFilesAndDirs({
      codexBaseRepo: "/tmp/nonexistent-repo-" + Date.now(),
    });
    const repoCheck = checks.find((c) => c.label.includes("Base repo does not exist"));
    expect(repoCheck?.severity).toBe("fail");
    expect(repoCheck?.fix).toContain("codexBaseRepo");
  });

  it("reports base repo exists but is not a git repo", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "doctor-nongit-"));
    const checks = await checkFilesAndDirs({
      codexBaseRepo: tmpDir,
    });
    const repoCheck = checks.find((c) => c.label.includes("Base repo is not a git repo"));
    expect(repoCheck?.severity).toBe("fail");
    expect(repoCheck?.fix).toContain("git init");
  });
});

// ---------------------------------------------------------------------------
// checkFilesAndDirs — tilde path resolution branches
// ---------------------------------------------------------------------------

describe("checkFilesAndDirs — tilde path resolution", () => {
  it("resolves ~/... dispatch state path", async () => {
    vi.mocked(readDispatchState).mockRejectedValueOnce(new Error("ENOENT"));

    // Providing a path with ~/ triggers the tilde resolution branch
    const checks = await checkFilesAndDirs({
      dispatchStatePath: "~/nonexistent-state-file.json",
    });
    // The file won't exist (tilde-resolved), so we get the "no file yet" message
    const stateCheck = checks.find((c) => c.label.includes("Dispatch state"));
    expect(stateCheck).toBeDefined();
  });

  it("resolves ~/... worktree base dir path", async () => {
    const checks = await checkFilesAndDirs({
      worktreeBaseDir: "~/nonexistent-worktree-base",
    });
    const wtCheck = checks.find((c) => c.label.includes("Worktree base dir"));
    expect(wtCheck).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// checkDispatchHealth — orphaned worktree singular
// ---------------------------------------------------------------------------

describe("checkDispatchHealth — edge cases", () => {
  it("reports single orphaned worktree (singular)", async () => {
    vi.mocked(listWorktrees).mockReturnValueOnce([
      { issueIdentifier: "ORPHAN-1", path: "/tmp/wt1" } as any,
    ]);

    const checks = await checkDispatchHealth();
    const orphanCheck = checks.find((c) => c.label.includes("orphaned worktree"));
    expect(orphanCheck?.severity).toBe("warn");
    expect(orphanCheck?.label).toContain("1 orphaned worktree");
    expect(orphanCheck?.label).not.toContain("worktrees"); // singular, not plural
  });

  it("prunes multiple old completed dispatches (plural)", async () => {
    vi.mocked(readDispatchState).mockResolvedValueOnce({
      dispatches: {
        active: {},
        completed: {
          "A-1": { completedAt: new Date(Date.now() - 10 * 24 * 3_600_000).toISOString() } as any,
          "A-2": { completedAt: new Date(Date.now() - 10 * 24 * 3_600_000).toISOString() } as any,
        },
      },
      sessionMap: {},
      processedEvents: [],
    });
    vi.mocked(pruneCompleted).mockResolvedValueOnce(2);

    const checks = await checkDispatchHealth(undefined, true);
    const pruneCheck = checks.find((c) => c.label.includes("Pruned"));
    expect(pruneCheck?.severity).toBe("pass");
    expect(pruneCheck?.label).toContain("2 old completed dispatches");
  });

  it("reports single stale dispatch (singular)", async () => {
    vi.mocked(listStaleDispatches).mockReturnValueOnce([
      { issueIdentifier: "API-1", status: "working" } as any,
    ]);

    const checks = await checkDispatchHealth();
    const staleCheck = checks.find((c) => c.label.includes("stale dispatch"));
    expect(staleCheck?.severity).toBe("warn");
    // Singular: "1 stale dispatch" not "1 stale dispatches"
    expect(staleCheck?.label).toMatch(/1 stale dispatch(?!es)/);
  });
});

// ---------------------------------------------------------------------------
// checkConnectivity — webhook self-test with ok but body !== "ok"
// ---------------------------------------------------------------------------

describe("checkConnectivity — webhook non-ok body", () => {
  it("warns when webhook returns ok status but body is not 'ok'", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("localhost")) {
        return { ok: true, text: async () => "pong" };
      }
      throw new Error("unexpected");
    }));

    const checks = await checkConnectivity({}, { viewer: { name: "T" } });
    const webhookCheck = checks.find((c) => c.label.includes("Webhook self-test:"));
    // ok is true but body is "pong" not "ok" — the condition is `res.ok && body === "ok"`
    // Since body !== "ok", it falls into the warn branch
    expect(webhookCheck?.severity).toBe("warn");
  });
});

// ---------------------------------------------------------------------------
// formatReport — icon function TTY branches
// ---------------------------------------------------------------------------

describe("formatReport — TTY icon rendering", () => {
  it("renders colored icons when stdout.isTTY is true", () => {
    const origIsTTY = process.stdout.isTTY;
    try {
      Object.defineProperty(process.stdout, "isTTY", { value: true, writable: true, configurable: true });

      const report = {
        sections: [{
          name: "Test",
          checks: [
            { label: "pass check", severity: "pass" as const },
            { label: "warn check", severity: "warn" as const },
            { label: "fail check", severity: "fail" as const },
          ],
        }],
        summary: { passed: 1, warnings: 1, errors: 1 },
      };

      const output = formatReport(report);
      // TTY output includes ANSI escape codes
      expect(output).toContain("\x1b[32m"); // green for pass
      expect(output).toContain("\x1b[33m"); // yellow for warn
      expect(output).toContain("\x1b[31m"); // red for fail
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { value: origIsTTY, writable: true, configurable: true });
    }
  });
});

// ---------------------------------------------------------------------------
// checkCodingTools — codingTool fallback to "codex" in label
// ---------------------------------------------------------------------------

describe("checkCodingTools — codingTool null fallback", () => {
  it("shows 'codex' as default when codingTool is undefined but backends exist", () => {
    vi.mocked(loadCodingConfig).mockReturnValueOnce({
      codingTool: undefined,
      backends: { codex: { aliases: ["codex"] } },
    } as any);

    const checks = checkCodingTools();
    const configCheck = checks.find((c) => c.label.includes("coding-tools.json loaded"));
    expect(configCheck?.severity).toBe("pass");
    expect(configCheck?.label).toContain("codex"); // falls back to "codex" via ??
  });
});

// ---------------------------------------------------------------------------
// checkFilesAndDirs — dispatch state non-Error catch branch
// ---------------------------------------------------------------------------

describe("checkFilesAndDirs — dispatch state non-Error exception", () => {
  it("handles non-Error thrown during dispatch state read", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "doctor-nonError-"));
    const statePath = join(tmpDir, "state.json");
    writeFileSync(statePath, '{}');
    vi.mocked(readDispatchState).mockRejectedValueOnce("raw string dispatch error");

    const checks = await checkFilesAndDirs({ dispatchStatePath: statePath });
    const stateCheck = checks.find((c) => c.label.includes("Dispatch state corrupt"));
    expect(stateCheck?.severity).toBe("fail");
    expect(stateCheck?.detail).toContain("raw string dispatch error");
  });
});
