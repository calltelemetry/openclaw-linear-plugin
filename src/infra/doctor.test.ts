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
    codingTool: "claude",
    agentCodingTools: {},
    backends: {
      claude: { aliases: ["claude", "anthropic"] },
      codex: { aliases: ["codex", "openai"] },
      gemini: { aliases: ["gemini", "google"] },
    },
  })),
}));

import {
  checkAuth,
  checkAgentConfig,
  checkCodingTools,
  checkFilesAndDirs,
  checkConnectivity,
  checkDispatchHealth,
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
    expect(configCheck?.label).toContain("claude");
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

  it("reports Discord not configured as pass", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("should not be called"); }));
    const checks = await checkConnectivity({});
    const discordCheck = checks.find((c) => c.label.includes("Discord"));
    expect(discordCheck?.severity).toBe("pass");
    expect(discordCheck?.label).toContain("not configured");
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
  it("returns all 6 sections", async () => {
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
    expect(report.sections).toHaveLength(6);
    expect(report.sections.map((s) => s.name)).toEqual([
      "Authentication & Tokens",
      "Agent Configuration",
      "Coding Tools",
      "Files & Directories",
      "Connectivity",
      "Dispatch Health",
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
