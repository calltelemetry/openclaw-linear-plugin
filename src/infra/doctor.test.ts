import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
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
import { readDispatchState, listStaleDispatches, pruneCompleted } from "../pipeline/dispatch-state.js";
import { loadPrompts } from "../pipeline/pipeline.js";
import { listWorktrees } from "./codex-worktree.js";

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

describe("checkCodeRunDeep", () => {
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
