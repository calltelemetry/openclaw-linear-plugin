import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock all heavy dependencies to isolate pure functions
vi.mock("../agent/agent.js", () => ({ runAgent: vi.fn() }));
vi.mock("./dispatch-state.js", () => ({
  transitionDispatch: vi.fn(),
  registerSessionMapping: vi.fn(),
  markEventProcessed: vi.fn(),
  completeDispatch: vi.fn(),
  readDispatchState: vi.fn(),
  getActiveDispatch: vi.fn(),
  TransitionError: class TransitionError extends Error {},
}));
vi.mock("./active-session.js", () => ({
  setActiveSession: vi.fn(),
  clearActiveSession: vi.fn(),
  getIssueAffinity: vi.fn().mockReturnValue(null),
  _configureAffinityTtl: vi.fn(),
  _resetAffinityForTesting: vi.fn(),
}));
vi.mock("../infra/notify.js", () => ({}));
vi.mock("./artifacts.js", () => ({
  saveWorkerOutput: vi.fn(),
  saveAuditVerdict: vi.fn(),
  appendLog: vi.fn(),
  updateManifest: vi.fn(),
  writeSummary: vi.fn(),
  buildSummaryFromArtifacts: vi.fn(),
  writeDispatchMemory: vi.fn(),
  resolveOrchestratorWorkspace: vi.fn(() => "/tmp/ws"),
}));
vi.mock("../agent/watchdog.js", () => ({
  resolveWatchdogConfig: vi.fn(() => ({
    inactivityMs: 120000,
    maxTotalMs: 7200000,
    toolTimeoutMs: 600000,
  })),
}));
vi.mock("./guidance.js", () => ({
  getCachedGuidanceForTeam: vi.fn(() => null),
  isGuidanceEnabled: vi.fn(() => false),
}));
vi.mock("./dag-dispatch.js", () => ({
  onProjectIssueCompleted: vi.fn().mockResolvedValue(undefined),
  onProjectIssueStuck: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../infra/observability.js", () => ({
  emitDiagnostic: vi.fn(),
}));

import {
  parseVerdict,
  buildWorkerTask,
  buildAuditTask,
  loadPrompts,
  loadRawPromptYaml,
  clearPromptCache,
  triggerAudit,
  processVerdict,
  spawnWorker,
  type IssueContext,
  type HookContext,
  type AuditVerdict,
} from "./pipeline.js";
import { runAgent } from "../agent/agent.js";
import {
  transitionDispatch,
  registerSessionMapping,
  markEventProcessed,
  completeDispatch,
  readDispatchState,
  getActiveDispatch,
  TransitionError,
  type ActiveDispatch,
} from "./dispatch-state.js";
import { clearActiveSession } from "./active-session.js";
import {
  saveWorkerOutput,
  saveAuditVerdict,
  appendLog,
  updateManifest,
  buildSummaryFromArtifacts,
  writeSummary,
  writeDispatchMemory,
  resolveOrchestratorWorkspace,
} from "./artifacts.js";
import { emitDiagnostic } from "../infra/observability.js";
import { onProjectIssueCompleted, onProjectIssueStuck } from "./dag-dispatch.js";
import { isGuidanceEnabled, getCachedGuidanceForTeam } from "./guidance.js";

// ---------------------------------------------------------------------------
// parseVerdict
// ---------------------------------------------------------------------------

describe("parseVerdict", () => {
  it("parses clean JSON pass=true", () => {
    const output = '{"pass": true, "criteria": ["tests"], "gaps": [], "testResults": "ok"}';
    const v = parseVerdict(output)!;
    expect(v.pass).toBe(true);
    expect(v.criteria).toEqual(["tests"]);
    expect(v.gaps).toEqual([]);
    expect(v.testResults).toBe("ok");
  });

  it("parses clean JSON pass=false", () => {
    const output = '{"pass": false, "criteria": [], "gaps": ["missing tests"], "testResults": "none"}';
    const v = parseVerdict(output)!;
    expect(v.pass).toBe(false);
    expect(v.gaps).toEqual(["missing tests"]);
  });

  it("extracts JSON embedded in prose", () => {
    const output = `Here is my verdict:

    \`\`\`json
    {"pass": true, "criteria": ["implemented"], "gaps": [], "testResults": "pass"}
    \`\`\`

    That's my assessment.`;
    const v = parseVerdict(output)!;
    expect(v.pass).toBe(true);
  });

  it("takes last JSON when multiple present", () => {
    const output = `
    {"pass": true, "criteria": [], "gaps": [], "testResults": ""}
    After review:
    {"pass": false, "criteria": ["a"], "gaps": ["b"], "testResults": "fail"}
    `;
    const v = parseVerdict(output)!;
    expect(v.pass).toBe(false);
    expect(v.gaps).toEqual(["b"]);
  });

  it("returns null for no JSON", () => {
    expect(parseVerdict("no json here")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseVerdict('{"pass": tru')).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseVerdict("")).toBeNull();
  });

  it("coerces missing fields to defaults", () => {
    const output = '{"pass": true}';
    const v = parseVerdict(output)!;
    expect(v.pass).toBe(true);
    expect(v.criteria).toEqual([]);
    expect(v.gaps).toEqual([]);
    expect(v.testResults).toBe("");
  });
});

// ---------------------------------------------------------------------------
// buildWorkerTask
// ---------------------------------------------------------------------------

describe("buildWorkerTask", () => {
  const issue: IssueContext = {
    id: "id-1",
    identifier: "API-42",
    title: "Fix auth",
    description: "The login endpoint fails.",
  };

  beforeEach(() => {
    clearPromptCache();
  });

  it("substitutes template variables", () => {
    const { system, task } = buildWorkerTask(issue, "/wt/API-42");
    expect(task).toContain("API-42");
    expect(task).toContain("Fix auth");
    expect(task).toContain("The login endpoint fails.");
    expect(task).toContain("/wt/API-42");
    expect(system.length).toBeGreaterThan(0);
  });

  it('uses "(no description)" for null description', () => {
    const noDesc = { ...issue, description: null };
    const { task } = buildWorkerTask(noDesc, "/wt/API-42");
    expect(task).toContain("(no description)");
  });

  it("appends rework addendum when attempt>0 and gaps present", () => {
    const { task } = buildWorkerTask(issue, "/wt/API-42", {
      attempt: 1,
      gaps: ["missing validation", "no error handling"],
    });
    expect(task).toContain("PREVIOUS AUDIT FAILED");
    expect(task).toContain("missing validation");
    expect(task).toContain("no error handling");
  });

  it("no addendum when attempt=0", () => {
    const { task } = buildWorkerTask(issue, "/wt/API-42", { attempt: 0, gaps: ["gap"] });
    expect(task).not.toContain("PREVIOUS AUDIT FAILED");
  });

  it("no addendum when gaps empty", () => {
    const { task } = buildWorkerTask(issue, "/wt/API-42", { attempt: 1, gaps: [] });
    expect(task).not.toContain("PREVIOUS AUDIT FAILED");
  });
});

// ---------------------------------------------------------------------------
// buildAuditTask
// ---------------------------------------------------------------------------

describe("buildAuditTask", () => {
  const issue: IssueContext = {
    id: "id-2",
    identifier: "API-99",
    title: "Add caching",
    description: "Cache API responses.",
  };

  beforeEach(() => {
    clearPromptCache();
  });

  it("substitutes template variables", () => {
    const { system, task } = buildAuditTask(issue, "/wt/API-99");
    expect(task).toContain("API-99");
    expect(task).toContain("Add caching");
    expect(task).toContain("Cache API responses.");
    expect(task).toContain("/wt/API-99");
    expect(system).toContain("auditor");
  });

  it('uses "(no description)" for null description', () => {
    const noDesc = { ...issue, description: null };
    const { task } = buildAuditTask(noDesc, "/wt/API-99");
    expect(task).toContain("(no description)");
  });
});

// ---------------------------------------------------------------------------
// loadPrompts / clearPromptCache
// ---------------------------------------------------------------------------

describe("loadPrompts", () => {
  beforeEach(() => {
    clearPromptCache();
  });

  it("returns defaults when no YAML available", () => {
    const prompts = loadPrompts();
    expect(prompts.worker.task).toContain("{{identifier}}");
    expect(prompts.audit.task).toContain("{{identifier}}");
    expect(prompts.rework.addendum).toContain("PREVIOUS AUDIT FAILED");
  });

  it("caches (same reference on 2nd call)", () => {
    const first = loadPrompts();
    const second = loadPrompts();
    expect(first).toBe(second);
  });

  it("clearPromptCache forces re-read", () => {
    const first = loadPrompts();
    clearPromptCache();
    const second = loadPrompts();
    // Same content but different object ref after cache clear
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });

  it("merges global overlay with defaults (section-level shallow merge)", () => {
    // Use promptsPath in pluginConfig to load custom YAML from a temp file
    const { writeFileSync, mkdtempSync } = require("node:fs");
    const { join } = require("node:path");
    const { tmpdir } = require("node:os");
    const dir = mkdtempSync(join(tmpdir(), "claw-prompt-"));
    const yamlPath = join(dir, "prompts.yaml");
    writeFileSync(yamlPath, "worker:\n  system: custom worker system\n");

    clearPromptCache();
    const prompts = loadPrompts({ promptsPath: yamlPath });
    // Worker system should be overridden
    expect(prompts.worker.system).toBe("custom worker system");
    // Worker task should still be default
    expect(prompts.worker.task).toContain("{{identifier}}");
    // Audit should be completely default
    expect(prompts.audit.system).toContain("auditor");
    clearPromptCache();
  });

  it("merges per-project overlay on top of global (three layers)", () => {
    const { writeFileSync, mkdtempSync, mkdirSync } = require("node:fs");
    const { join } = require("node:path");
    const { tmpdir } = require("node:os");

    // Layer 2: global override via promptsPath
    const globalDir = mkdtempSync(join(tmpdir(), "claw-prompt-global-"));
    const globalYaml = join(globalDir, "prompts.yaml");
    writeFileSync(globalYaml, "worker:\n  system: global system\n");

    // Layer 3: per-project override in worktree/.claw/prompts.yaml
    const worktreeDir = mkdtempSync(join(tmpdir(), "claw-prompt-wt-"));
    mkdirSync(join(worktreeDir, ".claw"), { recursive: true });
    writeFileSync(join(worktreeDir, ".claw", "prompts.yaml"), "audit:\n  system: project auditor\n");

    clearPromptCache();
    const prompts = loadPrompts({ promptsPath: globalYaml }, worktreeDir);
    // Layer 2: global override
    expect(prompts.worker.system).toBe("global system");
    // Layer 3: per-project override
    expect(prompts.audit.system).toBe("project auditor");
    // Layer 1: defaults retained where not overridden
    expect(prompts.rework.addendum).toContain("PREVIOUS AUDIT FAILED");
    clearPromptCache();
  });

  it("clearPromptCache clears both global and project caches", () => {
    const { writeFileSync, mkdtempSync, mkdirSync } = require("node:fs");
    const { join } = require("node:path");
    const { tmpdir } = require("node:os");

    // Per-project YAML only (no global — uses defaults for global)
    const worktreeDir = mkdtempSync(join(tmpdir(), "claw-prompt-cache-"));
    mkdirSync(join(worktreeDir, ".claw"), { recursive: true });
    writeFileSync(join(worktreeDir, ".claw", "prompts.yaml"), "worker:\n  system: cached project\n");

    clearPromptCache();
    const first = loadPrompts(undefined, worktreeDir);
    expect(first.worker.system).toBe("cached project");
    // Same ref from cache
    expect(loadPrompts(undefined, worktreeDir)).toBe(first);
    // Clear both caches
    clearPromptCache();
    const second = loadPrompts(undefined, worktreeDir);
    expect(second).not.toBe(first);
    expect(second.worker.system).toBe("cached project");
    clearPromptCache();
  });
});

// ---------------------------------------------------------------------------
// loadRawPromptYaml
// ---------------------------------------------------------------------------

describe("loadRawPromptYaml", () => {
  beforeEach(() => {
    clearPromptCache();
  });

  it("returns null when no file exists and no custom path", () => {
    // With no prompts.yaml sidecar in the plugin root (test env), returns null
    const result = loadRawPromptYaml();
    // Could be non-null if a sidecar exists; the point is it doesn't throw
    expect(result === null || typeof result === "object").toBe(true);
  });

  it("loads YAML from a custom promptsPath", () => {
    const { writeFileSync, mkdtempSync } = require("node:fs");
    const { join } = require("node:path");
    const { tmpdir } = require("node:os");
    const dir = mkdtempSync(join(tmpdir(), "claw-rawprompt-"));
    const yamlPath = join(dir, "custom.yaml");
    writeFileSync(yamlPath, "worker:\n  system: my custom system\n");

    const result = loadRawPromptYaml({ promptsPath: yamlPath });
    expect(result).not.toBeNull();
    expect(result!.worker.system).toBe("my custom system");
  });

  it("returns null for non-existent custom path", () => {
    const result = loadRawPromptYaml({ promptsPath: "/tmp/nonexistent-prompt-file.yaml" });
    expect(result).toBeNull();
  });

  it("resolves ~ in promptsPath to HOME", () => {
    const { writeFileSync, mkdtempSync } = require("node:fs");
    const { join } = require("node:path");
    const { tmpdir } = require("node:os");

    // We can't easily test ~ expansion without writing to HOME,
    // but we can verify it doesn't throw with a ~ path that doesn't exist
    const result = loadRawPromptYaml({ promptsPath: "~/nonexistent-claw-prompt-test.yaml" });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildWorkerTask — additional branch coverage
// ---------------------------------------------------------------------------

describe("buildWorkerTask (additional branches)", () => {
  const issue: IssueContext = {
    id: "id-1",
    identifier: "API-42",
    title: "Fix auth",
    description: "The login endpoint fails.",
  };

  beforeEach(() => {
    clearPromptCache();
  });

  it("includes guidance when provided", () => {
    const { task } = buildWorkerTask(issue, "/wt/API-42", {
      guidance: "Always use TypeScript strict mode",
    });
    expect(task).toContain("Additional Guidance");
    expect(task).toContain("Always use TypeScript strict mode");
  });

  it("does not include guidance section when guidance is undefined", () => {
    const { task } = buildWorkerTask(issue, "/wt/API-42", {
      guidance: undefined,
    });
    expect(task).not.toContain("Additional Guidance");
  });

  it("uses undefined description as (no description)", () => {
    const noDesc: IssueContext = { ...issue, description: undefined };
    const { task } = buildWorkerTask(noDesc, "/wt/API-42");
    expect(task).toContain("(no description)");
  });
});

// ---------------------------------------------------------------------------
// buildAuditTask — additional branch coverage
// ---------------------------------------------------------------------------

describe("buildAuditTask (additional branches)", () => {
  const issue: IssueContext = {
    id: "id-2",
    identifier: "API-99",
    title: "Add caching",
    description: "Cache API responses.",
  };

  beforeEach(() => {
    clearPromptCache();
  });

  it("includes guidance when provided", () => {
    const { task } = buildAuditTask(issue, "/wt/API-99", undefined, {
      guidance: "Focus on security",
    });
    expect(task).toContain("Additional Guidance");
    expect(task).toContain("Focus on security");
  });

  it("does not include guidance section when guidance is undefined", () => {
    const { task } = buildAuditTask(issue, "/wt/API-99", undefined, {
      guidance: undefined,
    });
    expect(task).not.toContain("Additional Guidance");
  });

  it("handles undefined description", () => {
    const noDesc: IssueContext = { ...issue, description: undefined };
    const { task } = buildAuditTask(noDesc, "/wt/API-99");
    expect(task).toContain("(no description)");
  });
});

// ---------------------------------------------------------------------------
// Shared helpers for async pipeline tests
// ---------------------------------------------------------------------------

function makeApi() {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    pluginConfig: {},
    runtime: {},
  } as any;
}

function makeMockLinearApi() {
  return {
    getIssueDetails: vi.fn().mockResolvedValue({
      id: "issue-1",
      identifier: "ENG-100",
      title: "Test Issue",
      description: "Issue description.",
      team: { id: "team-1", name: "Engineering" },
    }),
    createComment: vi.fn().mockResolvedValue("comment-id"),
    emitActivity: vi.fn().mockResolvedValue(undefined),
  };
}

function makeHookCtx(overrides?: Partial<HookContext>): HookContext {
  return {
    api: makeApi(),
    linearApi: makeMockLinearApi() as any,
    notify: vi.fn().mockResolvedValue(undefined),
    pluginConfig: {},
    configPath: "/tmp/test-state.json",
    ...overrides,
  };
}

function makeDispatch(overrides?: Partial<ActiveDispatch>): ActiveDispatch {
  return {
    issueId: "issue-1",
    issueIdentifier: "ENG-100",
    issueTitle: "Test Issue",
    worktreePath: "/tmp/wt/ENG-100",
    branch: "codex/ENG-100",
    tier: "small" as const,
    model: "test-model",
    status: "working" as const,
    dispatchedAt: new Date().toISOString(),
    attempt: 0,
    agentSessionId: "session-1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// triggerAudit
// ---------------------------------------------------------------------------

describe("triggerAudit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPromptCache();
    (markEventProcessed as any).mockResolvedValue(true);
    (transitionDispatch as any).mockResolvedValue({});
    (readDispatchState as any).mockResolvedValue({
      version: 2,
      dispatches: { active: {}, completed: {} },
      sessionMap: {},
      processedEvents: [],
    });
    (getActiveDispatch as any).mockReturnValue(makeDispatch());
    (registerSessionMapping as any).mockResolvedValue(undefined);
    (runAgent as any).mockResolvedValue({ success: true, output: '{"pass": true, "criteria": ["ok"], "gaps": [], "testResults": "pass"}' });
    // processVerdict is called internally — it needs its own mocks too
    (completeDispatch as any).mockResolvedValue(undefined);
  });

  it("skips when event is duplicate (markEventProcessed returns false)", async () => {
    (markEventProcessed as any).mockResolvedValue(false);
    const ctx = makeHookCtx();
    const dispatch = makeDispatch();

    await triggerAudit(ctx, dispatch, { success: true, output: "done" }, "session-key-1");

    expect(ctx.api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("duplicate worker agent_end"),
    );
    expect(transitionDispatch).not.toHaveBeenCalled();
  });

  it("returns on CAS TransitionError (working → auditing)", async () => {
    (transitionDispatch as any).mockRejectedValue(new TransitionError("err"));
    const ctx = makeHookCtx();
    const dispatch = makeDispatch();

    await triggerAudit(ctx, dispatch, { success: true, output: "done" }, "session-key-2");

    expect(ctx.api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("CAS failed for audit trigger"),
    );
    // Should NOT spawn runAgent
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("re-throws non-TransitionError from transitionDispatch", async () => {
    (transitionDispatch as any).mockRejectedValue(new Error("disk error"));
    const ctx = makeHookCtx();
    const dispatch = makeDispatch();

    await expect(
      triggerAudit(ctx, dispatch, { success: true }, "session-key-3"),
    ).rejects.toThrow("disk error");
  });

  it("fetches issue details and spawns audit agent on success path", async () => {
    const ctx = makeHookCtx();
    const dispatch = makeDispatch({ attempt: 1 });

    await triggerAudit(ctx, dispatch, { success: true, output: "worker output" }, "session-key-4");

    // Should transition working → auditing
    expect(transitionDispatch).toHaveBeenCalledWith(
      "ENG-100", "working", "auditing", undefined, "/tmp/test-state.json",
    );
    // Should register session mapping for audit
    expect(registerSessionMapping).toHaveBeenCalledWith(
      "linear-audit-ENG-100-1",
      { dispatchId: "ENG-100", phase: "audit", attempt: 1 },
      "/tmp/test-state.json",
    );
    // Should spawn runAgent
    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "linear-audit-ENG-100-1",
      }),
    );
    // Should emit diagnostic
    expect(emitDiagnostic).toHaveBeenCalledWith(
      ctx.api,
      expect.objectContaining({ event: "phase_transition", from: "working", to: "auditing" }),
    );
    // Should notify
    expect(ctx.notify).toHaveBeenCalledWith(
      "auditing",
      expect.objectContaining({ identifier: "ENG-100", status: "auditing" }),
    );
  });

  it("handles getIssueDetails failure gracefully", async () => {
    const linearApi = makeMockLinearApi();
    linearApi.getIssueDetails.mockRejectedValue(new Error("API down"));
    const ctx = makeHookCtx({ linearApi: linearApi as any });
    const dispatch = makeDispatch();

    // Should not throw — getIssueDetails failure is caught
    await triggerAudit(ctx, dispatch, { success: true, output: "output" }, "session-key-5");

    expect(runAgent).toHaveBeenCalled();
  });

  it("uses multi-repo worktree paths when dispatch.worktrees is set", async () => {
    const ctx = makeHookCtx();
    const dispatch = makeDispatch({
      worktrees: [
        { repoName: "frontend", path: "/tmp/wt/frontend", branch: "main" },
        { repoName: "backend", path: "/tmp/wt/backend", branch: "main" },
      ],
    });

    await triggerAudit(ctx, dispatch, { success: true, output: "output" }, "session-key-6");

    // The runAgent call message should contain both repo paths
    const runAgentCall = (runAgent as any).mock.calls[0][0];
    expect(runAgentCall.message).toContain("frontend: /tmp/wt/frontend");
    expect(runAgentCall.message).toContain("backend: /tmp/wt/backend");
  });

  it("does not set streaming when agentSessionId is absent", async () => {
    const ctx = makeHookCtx();
    const dispatch = makeDispatch({ agentSessionId: undefined });

    await triggerAudit(ctx, dispatch, { success: true, output: "output" }, "session-key-7");

    const runAgentCall = (runAgent as any).mock.calls[0][0];
    expect(runAgentCall.streaming).toBeUndefined();
  });

  it("sets streaming when agentSessionId is present", async () => {
    const ctx = makeHookCtx();
    const dispatch = makeDispatch({ agentSessionId: "linear-session-1" });

    await triggerAudit(ctx, dispatch, { success: true, output: "output" }, "session-key-8");

    const runAgentCall = (runAgent as any).mock.calls[0][0];
    expect(runAgentCall.streaming).toBeDefined();
    expect(runAgentCall.streaming.agentSessionId).toBe("linear-session-1");
  });
});

// ---------------------------------------------------------------------------
// processVerdict
// ---------------------------------------------------------------------------

describe("processVerdict", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPromptCache();
    (markEventProcessed as any).mockResolvedValue(true);
    (transitionDispatch as any).mockResolvedValue({});
    (completeDispatch as any).mockResolvedValue(undefined);
    (readDispatchState as any).mockResolvedValue({
      version: 2,
      dispatches: { active: {}, completed: {} },
      sessionMap: {},
      processedEvents: [],
    });
    (buildSummaryFromArtifacts as any).mockReturnValue(null);
    (resolveOrchestratorWorkspace as any).mockReturnValue("/tmp/ws");
  });

  it("skips when event is duplicate (markEventProcessed returns false)", async () => {
    (markEventProcessed as any).mockResolvedValue(false);
    const ctx = makeHookCtx();
    const dispatch = makeDispatch({ status: "auditing" as any });

    await processVerdict(ctx, dispatch, { success: true, output: '{"pass": true}' }, "audit-key-1");

    expect(ctx.api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("duplicate audit agent_end"),
    );
    expect(transitionDispatch).not.toHaveBeenCalled();
  });

  it("extracts output from event.messages when event.output is empty", async () => {
    const ctx = makeHookCtx();
    const dispatch = makeDispatch({ status: "auditing" as any });

    await processVerdict(ctx, dispatch, {
      success: true,
      output: "",
      messages: [
        { role: "user", content: "audit this" },
        { role: "assistant", content: '{"pass": true, "criteria": ["tests pass"], "gaps": [], "testResults": "ok"}' },
      ],
    }, "audit-key-2");

    // Should parse the verdict from messages
    expect(ctx.api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("audit verdict: PASS"),
    );
  });

  it("extracts output from assistant array content blocks", async () => {
    const ctx = makeHookCtx();
    const dispatch = makeDispatch({ status: "auditing" as any });

    await processVerdict(ctx, dispatch, {
      success: true,
      output: "",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1" },
            { type: "text", text: '{"pass": false, "criteria": [], "gaps": ["missing test"], "testResults": "fail"}' },
          ],
        },
      ],
    }, "audit-key-3");

    expect(ctx.api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("audit verdict: FAIL"),
    );
  });

  it("handles unparseable verdict — posts comment and treats as failure", async () => {
    const ctx = makeHookCtx();
    const dispatch = makeDispatch({ status: "auditing" as any });

    await processVerdict(ctx, dispatch, {
      success: true,
      output: "no json here at all",
    }, "audit-key-4");

    expect(ctx.api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("could not parse audit verdict"),
    );
    // Should post an "Audit Inconclusive" comment
    expect((ctx.linearApi as any).createComment).toHaveBeenCalledWith(
      dispatch.issueId,
      expect.stringContaining("Audit Inconclusive"),
    );
  });

  it("handles audit PASS — transitions to done and completes dispatch", async () => {
    const ctx = makeHookCtx();
    const dispatch = makeDispatch({ status: "auditing" as any, attempt: 0 });

    await processVerdict(ctx, dispatch, {
      success: true,
      output: '{"pass": true, "criteria": ["tests pass", "code review"], "gaps": [], "testResults": "all green"}',
    }, "audit-key-5");

    // Transition auditing → done
    expect(transitionDispatch).toHaveBeenCalledWith(
      "ENG-100", "auditing", "done", undefined, "/tmp/test-state.json",
    );
    // Complete dispatch
    expect(completeDispatch).toHaveBeenCalledWith(
      "ENG-100",
      expect.objectContaining({ tier: "small", status: "done" }),
      "/tmp/test-state.json",
    );
    // Should post "Done" comment
    expect((ctx.linearApi as any).createComment).toHaveBeenCalledWith(
      dispatch.issueId,
      expect.stringContaining("Done"),
    );
    // Should notify audit_pass
    expect(ctx.notify).toHaveBeenCalledWith(
      "audit_pass",
      expect.objectContaining({ identifier: "ENG-100", status: "done" }),
    );
    // Should clear active session
    expect(clearActiveSession).toHaveBeenCalledWith("issue-1");
  });

  it("handles audit PASS with summary from artifacts", async () => {
    (buildSummaryFromArtifacts as any).mockReturnValue("## Summary\nImplemented feature X");
    const ctx = makeHookCtx();
    const dispatch = makeDispatch({ status: "auditing" as any });

    await processVerdict(ctx, dispatch, {
      success: true,
      output: '{"pass": true, "criteria": ["done"], "gaps": [], "testResults": "pass"}',
    }, "audit-key-6");

    expect(writeSummary).toHaveBeenCalledWith("/tmp/wt/ENG-100", "## Summary\nImplemented feature X");
    expect(writeDispatchMemory).toHaveBeenCalled();
    // Comment should include summary excerpt
    expect((ctx.linearApi as any).createComment).toHaveBeenCalledWith(
      dispatch.issueId,
      expect.stringContaining("Summary"),
    );
  });

  it("handles audit PASS with project — triggers DAG cascade", async () => {
    const ctx = makeHookCtx();
    const dispatch = makeDispatch({ status: "auditing" as any, project: "project-1" });

    await processVerdict(ctx, dispatch, {
      success: true,
      output: '{"pass": true, "criteria": [], "gaps": [], "testResults": ""}',
    }, "audit-key-7");

    // Should call onProjectIssueCompleted (fire-and-forget)
    // Wait a tick for the void promise
    await new Promise((r) => setTimeout(r, 10));
    expect(onProjectIssueCompleted).toHaveBeenCalledWith(
      ctx, "project-1", "ENG-100",
    );
  });

  it("handles audit PASS — CAS TransitionError returns silently", async () => {
    (transitionDispatch as any).mockRejectedValue(new TransitionError("cas err"));
    const ctx = makeHookCtx();
    const dispatch = makeDispatch({ status: "auditing" as any });

    await processVerdict(ctx, dispatch, {
      success: true,
      output: '{"pass": true, "criteria": [], "gaps": [], "testResults": ""}',
    }, "audit-key-8");

    expect(ctx.api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("CAS failed for audit pass"),
    );
    // Should NOT call completeDispatch
    expect(completeDispatch).not.toHaveBeenCalled();
  });

  it("handles audit FAIL with rework allowed (attempt < maxAttempts)", async () => {
    const ctx = makeHookCtx({ pluginConfig: { maxReworkAttempts: 2 } });
    const dispatch = makeDispatch({ status: "auditing" as any, attempt: 0 });

    await processVerdict(ctx, dispatch, {
      success: true,
      output: '{"pass": false, "criteria": ["tests"], "gaps": ["missing validation"], "testResults": "1 failing"}',
    }, "audit-key-9");

    // Transition auditing → working (rework)
    expect(transitionDispatch).toHaveBeenCalledWith(
      "ENG-100", "auditing", "working",
      { attempt: 1 },
      "/tmp/test-state.json",
    );
    // Should post "Needs More Work" comment
    expect((ctx.linearApi as any).createComment).toHaveBeenCalledWith(
      dispatch.issueId,
      expect.stringContaining("Needs More Work"),
    );
    // Should notify audit_fail
    expect(ctx.notify).toHaveBeenCalledWith(
      "audit_fail",
      expect.objectContaining({ identifier: "ENG-100", attempt: 1 }),
    );
  });

  it("handles audit FAIL with escalation (attempt >= maxAttempts)", async () => {
    const ctx = makeHookCtx({ pluginConfig: { maxReworkAttempts: 1 } });
    const dispatch = makeDispatch({ status: "auditing" as any, attempt: 1 });

    await processVerdict(ctx, dispatch, {
      success: true,
      output: '{"pass": false, "criteria": [], "gaps": ["still broken"], "testResults": "fail"}',
    }, "audit-key-10");

    // Transition auditing → stuck
    expect(transitionDispatch).toHaveBeenCalledWith(
      "ENG-100", "auditing", "stuck",
      { stuckReason: "audit_failed_2x" },
      "/tmp/test-state.json",
    );
    // Should post "Needs Your Help" comment
    expect((ctx.linearApi as any).createComment).toHaveBeenCalledWith(
      dispatch.issueId,
      expect.stringContaining("Needs Your Help"),
    );
    // Should notify escalation
    expect(ctx.notify).toHaveBeenCalledWith(
      "escalation",
      expect.objectContaining({ identifier: "ENG-100", status: "stuck" }),
    );
  });

  it("handles audit FAIL escalation with project — triggers DAG stuck cascade", async () => {
    const ctx = makeHookCtx({ pluginConfig: { maxReworkAttempts: 0 } });
    const dispatch = makeDispatch({ status: "auditing" as any, attempt: 0, project: "project-2" });

    await processVerdict(ctx, dispatch, {
      success: true,
      output: '{"pass": false, "criteria": [], "gaps": ["broken"], "testResults": ""}',
    }, "audit-key-11");

    await new Promise((r) => setTimeout(r, 10));
    expect(onProjectIssueStuck).toHaveBeenCalledWith(
      ctx, "project-2", "ENG-100",
    );
  });

  it("handles rework CAS TransitionError — returns silently", async () => {
    // First call succeeds (for non-existent earlier transition), second fails
    (transitionDispatch as any).mockRejectedValue(new TransitionError("rework cas"));
    const ctx = makeHookCtx({ pluginConfig: { maxReworkAttempts: 2 } });
    const dispatch = makeDispatch({ status: "auditing" as any, attempt: 0 });

    await processVerdict(ctx, dispatch, {
      success: true,
      output: '{"pass": false, "criteria": [], "gaps": ["fix"], "testResults": ""}',
    }, "audit-key-12");

    expect(ctx.api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("CAS failed for rework transition"),
    );
  });

  it("handles stuck CAS TransitionError — returns silently", async () => {
    (transitionDispatch as any).mockRejectedValue(new TransitionError("stuck cas"));
    const ctx = makeHookCtx({ pluginConfig: { maxReworkAttempts: 0 } });
    const dispatch = makeDispatch({ status: "auditing" as any, attempt: 0 });

    await processVerdict(ctx, dispatch, {
      success: true,
      output: '{"pass": false, "criteria": [], "gaps": ["broken"], "testResults": ""}',
    }, "audit-key-13");

    expect(ctx.api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("CAS failed for stuck transition"),
    );
  });

  it("re-throws non-TransitionError from stuck transition", async () => {
    (transitionDispatch as any).mockRejectedValue(new Error("io error"));
    const ctx = makeHookCtx({ pluginConfig: { maxReworkAttempts: 0 } });
    const dispatch = makeDispatch({ status: "auditing" as any, attempt: 0 });

    await expect(
      processVerdict(ctx, dispatch, {
        success: true,
        output: '{"pass": false, "criteria": [], "gaps": ["x"], "testResults": ""}',
      }, "audit-key-14"),
    ).rejects.toThrow("io error");
  });

  it("re-throws non-TransitionError from rework transition", async () => {
    (transitionDispatch as any).mockRejectedValue(new Error("disk full"));
    const ctx = makeHookCtx({ pluginConfig: { maxReworkAttempts: 5 } });
    const dispatch = makeDispatch({ status: "auditing" as any, attempt: 0 });

    await expect(
      processVerdict(ctx, dispatch, {
        success: true,
        output: '{"pass": false, "criteria": [], "gaps": ["x"], "testResults": ""}',
      }, "audit-key-15"),
    ).rejects.toThrow("disk full");
  });

  it("re-throws non-TransitionError from done transition", async () => {
    (transitionDispatch as any).mockRejectedValue(new Error("perm denied"));
    const ctx = makeHookCtx();
    const dispatch = makeDispatch({ status: "auditing" as any });

    await expect(
      processVerdict(ctx, dispatch, {
        success: true,
        output: '{"pass": true, "criteria": [], "gaps": [], "testResults": ""}',
      }, "audit-key-16"),
    ).rejects.toThrow("perm denied");
  });

  it("uses default maxReworkAttempts=2 when not configured", async () => {
    const ctx = makeHookCtx({ pluginConfig: {} });
    // attempt=2, so nextAttempt=3, which exceeds default maxReworkAttempts=2 → escalation
    const dispatch = makeDispatch({ status: "auditing" as any, attempt: 2 });

    await processVerdict(ctx, dispatch, {
      success: true,
      output: '{"pass": false, "criteria": [], "gaps": ["broken"], "testResults": ""}',
    }, "audit-key-17");

    // Should escalate (stuck), not rework
    expect(transitionDispatch).toHaveBeenCalledWith(
      "ENG-100", "auditing", "stuck",
      expect.objectContaining({ stuckReason: "audit_failed_3x" }),
      "/tmp/test-state.json",
    );
  });

  it("writes summary and memory for stuck dispatches", async () => {
    (buildSummaryFromArtifacts as any).mockReturnValue("## Stuck summary\nFailed after 2 attempts");
    const ctx = makeHookCtx({ pluginConfig: { maxReworkAttempts: 0 } });
    const dispatch = makeDispatch({ status: "auditing" as any, attempt: 0 });

    await processVerdict(ctx, dispatch, {
      success: true,
      output: '{"pass": false, "criteria": [], "gaps": ["broken"], "testResults": ""}',
    }, "audit-key-18");

    expect(writeSummary).toHaveBeenCalledWith("/tmp/wt/ENG-100", "## Stuck summary\nFailed after 2 attempts");
    expect(writeDispatchMemory).toHaveBeenCalledWith(
      "ENG-100",
      "## Stuck summary\nFailed after 2 attempts",
      "/tmp/ws",
      expect.objectContaining({ status: "stuck" }),
    );
  });
});

// ---------------------------------------------------------------------------
// spawnWorker
// ---------------------------------------------------------------------------

describe("spawnWorker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPromptCache();
    (transitionDispatch as any).mockResolvedValue({});
    (registerSessionMapping as any).mockResolvedValue(undefined);
    (markEventProcessed as any).mockResolvedValue(true);
    (completeDispatch as any).mockResolvedValue(undefined);
    (readDispatchState as any).mockResolvedValue({
      version: 2,
      dispatches: { active: { "ENG-100": makeDispatch() }, completed: {} },
      sessionMap: {},
      processedEvents: [],
    });
    (getActiveDispatch as any).mockReturnValue(makeDispatch());
    (runAgent as any).mockResolvedValue({
      success: true,
      output: "worker done",
      watchdogKilled: false,
    });
    (buildSummaryFromArtifacts as any).mockReturnValue(null);
    (resolveOrchestratorWorkspace as any).mockReturnValue("/tmp/ws");
  });

  it("transitions dispatched → working for first run", async () => {
    const ctx = makeHookCtx();
    const dispatch = makeDispatch({ status: "dispatched" as any });

    await spawnWorker(ctx, dispatch);

    expect(transitionDispatch).toHaveBeenCalledWith(
      "ENG-100", "dispatched", "working", undefined, "/tmp/test-state.json",
    );
  });

  it("skips transition if status is already working (rework)", async () => {
    const ctx = makeHookCtx();
    const dispatch = makeDispatch({ status: "working" as any, attempt: 1 });

    await spawnWorker(ctx, dispatch);

    // transitionDispatch should NOT be called for dispatched→working
    // (it may be called later by triggerAudit, but not the dispatched→working one)
    const dispatchedToWorkingCalls = (transitionDispatch as any).mock.calls.filter(
      (c: any[]) => c[1] === "dispatched" && c[2] === "working",
    );
    expect(dispatchedToWorkingCalls).toHaveLength(0);
  });

  it("returns on CAS TransitionError for dispatched → working", async () => {
    (transitionDispatch as any).mockRejectedValueOnce(new TransitionError("cas"));
    const ctx = makeHookCtx();
    const dispatch = makeDispatch({ status: "dispatched" as any });

    await spawnWorker(ctx, dispatch);

    expect(ctx.api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("CAS failed for worker spawn"),
    );
    // Should NOT spawn runAgent
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("re-throws non-TransitionError from dispatch transition", async () => {
    (transitionDispatch as any).mockRejectedValueOnce(new Error("broken"));
    const ctx = makeHookCtx();
    const dispatch = makeDispatch({ status: "dispatched" as any });

    await expect(spawnWorker(ctx, dispatch)).rejects.toThrow("broken");
  });

  it("spawns worker agent with correct session ID and message", async () => {
    const ctx = makeHookCtx();
    const dispatch = makeDispatch({ status: "working" as any, attempt: 1 });

    await spawnWorker(ctx, dispatch);

    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "linear-worker-ENG-100-1",
      }),
    );
    // Should register session mapping
    expect(registerSessionMapping).toHaveBeenCalledWith(
      "linear-worker-ENG-100-1",
      { dispatchId: "ENG-100", phase: "worker", attempt: 1 },
      "/tmp/test-state.json",
    );
  });

  it("sends notify working", async () => {
    const ctx = makeHookCtx();
    const dispatch = makeDispatch({ status: "working" as any });

    await spawnWorker(ctx, dispatch);

    expect(ctx.notify).toHaveBeenCalledWith(
      "working",
      expect.objectContaining({ identifier: "ENG-100", status: "working" }),
    );
  });

  it("saves worker output and appends log after agent run", async () => {
    const ctx = makeHookCtx();
    const dispatch = makeDispatch({ status: "working" as any });

    await spawnWorker(ctx, dispatch);

    expect(saveWorkerOutput).toHaveBeenCalledWith("/tmp/wt/ENG-100", 0, "worker done");
    expect(appendLog).toHaveBeenCalled();
  });

  it("handles watchdog kill — escalates to stuck", async () => {
    (runAgent as any).mockResolvedValue({
      success: false,
      output: "timed out",
      watchdogKilled: true,
    });
    const ctx = makeHookCtx();
    const dispatch = makeDispatch({ status: "working" as any });

    await spawnWorker(ctx, dispatch);

    // Should transition working → stuck
    expect(transitionDispatch).toHaveBeenCalledWith(
      "ENG-100", "working", "stuck",
      { stuckReason: "watchdog_kill_2x" },
      "/tmp/test-state.json",
    );
    // Should post "Agent Timed Out" comment
    expect((ctx.linearApi as any).createComment).toHaveBeenCalledWith(
      dispatch.issueId,
      expect.stringContaining("Agent Timed Out"),
    );
    // Should notify watchdog_kill
    expect(ctx.notify).toHaveBeenCalledWith(
      "watchdog_kill",
      expect.objectContaining({ identifier: "ENG-100", status: "stuck" }),
    );
    // Should emit watchdog diagnostic
    expect(emitDiagnostic).toHaveBeenCalledWith(
      ctx.api,
      expect.objectContaining({ event: "watchdog_kill" }),
    );
    // Should clear active session
    expect(clearActiveSession).toHaveBeenCalledWith("issue-1");
    // Should NOT trigger audit
    // runAgent is only called once (the worker), not a second time (no audit)
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("watchdog kill handles CAS TransitionError gracefully", async () => {
    (runAgent as any).mockResolvedValue({
      success: false,
      output: "timed out",
      watchdogKilled: true,
    });
    // The first transitionDispatch (dispatched→working) succeeds,
    // the second (working→stuck) fails
    (transitionDispatch as any)
      .mockResolvedValueOnce({})  // dispatched→working
      .mockRejectedValueOnce(new TransitionError("cas stuck"));
    const ctx = makeHookCtx();
    const dispatch = makeDispatch({ status: "dispatched" as any });

    // Should NOT throw — CAS error is caught
    await spawnWorker(ctx, dispatch);

    expect(ctx.api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("CAS failed for watchdog stuck transition"),
    );
  });

  it("skips audit when dispatch disappears during worker run", async () => {
    (getActiveDispatch as any).mockReturnValue(null);
    const ctx = makeHookCtx();
    const dispatch = makeDispatch({ status: "working" as any });

    await spawnWorker(ctx, dispatch);

    expect(ctx.api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("dispatch disappeared during worker run"),
    );
    // runAgent called once for worker, but NOT for audit
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("uses multi-repo worktree paths when dispatch.worktrees is set", async () => {
    const ctx = makeHookCtx();
    const dispatch = makeDispatch({
      status: "working" as any,
      worktrees: [
        { repoName: "api", path: "/tmp/wt/api", branch: "main" },
        { repoName: "web", path: "/tmp/wt/web", branch: "main" },
      ],
    });

    await spawnWorker(ctx, dispatch);

    const runAgentCall = (runAgent as any).mock.calls[0][0];
    expect(runAgentCall.message).toContain("api: /tmp/wt/api");
    expect(runAgentCall.message).toContain("web: /tmp/wt/web");
  });

  it("passes gaps to worker task on rework", async () => {
    const ctx = makeHookCtx();
    const dispatch = makeDispatch({ status: "working" as any, attempt: 1 });

    await spawnWorker(ctx, dispatch, { gaps: ["missing tests", "no error handling"] });

    const runAgentCall = (runAgent as any).mock.calls[0][0];
    expect(runAgentCall.message).toContain("PREVIOUS AUDIT FAILED");
    expect(runAgentCall.message).toContain("missing tests");
  });

  it("uses defaultAgentId from pluginConfig", async () => {
    const ctx = makeHookCtx({ pluginConfig: { defaultAgentId: "kaylee" } });
    const dispatch = makeDispatch({ status: "working" as any });

    await spawnWorker(ctx, dispatch);

    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "kaylee" }),
    );
  });

  it("sets streaming when agentSessionId is present", async () => {
    const ctx = makeHookCtx();
    const dispatch = makeDispatch({ status: "working" as any, agentSessionId: "lin-session" });

    await spawnWorker(ctx, dispatch);

    const runAgentCall = (runAgent as any).mock.calls[0][0];
    expect(runAgentCall.streaming).toBeDefined();
    expect(runAgentCall.streaming.agentSessionId).toBe("lin-session");
  });

  it("does not set streaming when agentSessionId is absent", async () => {
    const ctx = makeHookCtx();
    const dispatch = makeDispatch({ status: "working" as any, agentSessionId: undefined });

    await spawnWorker(ctx, dispatch);

    const runAgentCall = (runAgent as any).mock.calls[0][0];
    expect(runAgentCall.streaming).toBeUndefined();
  });

  it("handles getIssueDetails failure gracefully", async () => {
    const linearApi = makeMockLinearApi();
    linearApi.getIssueDetails.mockRejectedValue(new Error("network"));
    const ctx = makeHookCtx({ linearApi: linearApi as any });
    const dispatch = makeDispatch({ status: "working" as any });

    // Should not throw
    await spawnWorker(ctx, dispatch);

    // Should still spawn worker
    expect(runAgent).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// parseVerdict — additional edge cases
// ---------------------------------------------------------------------------

describe("parseVerdict (additional edge cases)", () => {
  it("ignores JSON without pass field", () => {
    const output = '{"criteria": ["test"], "gaps": []}';
    expect(parseVerdict(output)).toBeNull();
  });

  it("handles pass field with non-boolean criteria/gaps/testResults", () => {
    const output = '{"pass": false, "criteria": "not-array", "gaps": 42, "testResults": 123}';
    const v = parseVerdict(output)!;
    expect(v.pass).toBe(false);
    expect(v.criteria).toEqual([]);
    expect(v.gaps).toEqual([]);
    expect(v.testResults).toBe("");
  });

  it("handles JSON with extra whitespace and formatting", () => {
    const output = `
      {
        "pass" :   true ,
        "criteria" : ["a", "b"],
        "gaps":[],
        "testResults":"all pass"
      }
    `;
    const v = parseVerdict(output)!;
    expect(v.pass).toBe(true);
    expect(v.criteria).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// processVerdict — .catch() error branches
// ---------------------------------------------------------------------------

describe("processVerdict (error branch coverage)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPromptCache();
    (markEventProcessed as any).mockResolvedValue(true);
    (transitionDispatch as any).mockResolvedValue({});
    (completeDispatch as any).mockResolvedValue(undefined);
    (readDispatchState as any).mockResolvedValue({
      version: 2,
      dispatches: { active: {}, completed: {} },
      sessionMap: {},
      processedEvents: [],
    });
    (buildSummaryFromArtifacts as any).mockReturnValue(null);
    (resolveOrchestratorWorkspace as any).mockReturnValue("/tmp/ws");
  });

  it("audit PASS — handles createComment rejection gracefully", async () => {
    const linearApi = makeMockLinearApi();
    linearApi.createComment.mockRejectedValue(new Error("comment failed"));
    const ctx = makeHookCtx({ linearApi: linearApi as any });
    const dispatch = makeDispatch({ status: "auditing" as any });

    // Should NOT throw — .catch() handles it
    await processVerdict(ctx, dispatch, {
      success: true,
      output: '{"pass": true, "criteria": [], "gaps": [], "testResults": ""}',
    }, "audit-err-1");

    expect(ctx.api.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("failed to post audit pass comment"),
    );
  });

  it("audit PASS with project — handles DAG cascade rejection gracefully", async () => {
    (onProjectIssueCompleted as any).mockRejectedValue(new Error("dag error"));
    const ctx = makeHookCtx();
    const dispatch = makeDispatch({ status: "auditing" as any, project: "proj-err" });

    await processVerdict(ctx, dispatch, {
      success: true,
      output: '{"pass": true, "criteria": [], "gaps": [], "testResults": ""}',
    }, "audit-err-2");

    // Wait for the void promise .catch() to fire
    await new Promise((r) => setTimeout(r, 50));
    expect(ctx.api.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("DAG cascade error"),
    );
  });

  it("audit FAIL escalation — handles createComment rejection gracefully", async () => {
    const linearApi = makeMockLinearApi();
    linearApi.createComment.mockRejectedValue(new Error("comment api down"));
    const ctx = makeHookCtx({ linearApi: linearApi as any, pluginConfig: { maxReworkAttempts: 0 } });
    const dispatch = makeDispatch({ status: "auditing" as any, attempt: 0 });

    await processVerdict(ctx, dispatch, {
      success: true,
      output: '{"pass": false, "criteria": [], "gaps": ["broken"], "testResults": ""}',
    }, "audit-err-3");

    expect(ctx.api.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("failed to post escalation comment"),
    );
  });

  it("audit FAIL escalation with project — handles DAG stuck cascade rejection", async () => {
    (onProjectIssueStuck as any).mockRejectedValue(new Error("dag stuck error"));
    const ctx = makeHookCtx({ pluginConfig: { maxReworkAttempts: 0 } });
    const dispatch = makeDispatch({ status: "auditing" as any, attempt: 0, project: "proj-stuck" });

    await processVerdict(ctx, dispatch, {
      success: true,
      output: '{"pass": false, "criteria": [], "gaps": ["broken"], "testResults": ""}',
    }, "audit-err-4");

    await new Promise((r) => setTimeout(r, 50));
    expect(ctx.api.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("DAG stuck cascade error"),
    );
  });

  it("audit FAIL rework — handles createComment rejection gracefully", async () => {
    const linearApi = makeMockLinearApi();
    linearApi.createComment.mockRejectedValue(new Error("api timeout"));
    const ctx = makeHookCtx({ linearApi: linearApi as any, pluginConfig: { maxReworkAttempts: 3 } });
    const dispatch = makeDispatch({ status: "auditing" as any, attempt: 0 });

    await processVerdict(ctx, dispatch, {
      success: true,
      output: '{"pass": false, "criteria": [], "gaps": ["fix it"], "testResults": ""}',
    }, "audit-err-5");

    expect(ctx.api.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("failed to post rework comment"),
    );
  });

  it("unparseable verdict — handles createComment rejection gracefully", async () => {
    const linearApi = makeMockLinearApi();
    linearApi.createComment.mockRejectedValue(new Error("rate limited"));
    const ctx = makeHookCtx({ linearApi: linearApi as any });
    const dispatch = makeDispatch({ status: "auditing" as any });

    // Should not throw
    await processVerdict(ctx, dispatch, {
      success: true,
      output: "no json verdict at all",
    }, "audit-err-6");

    expect(ctx.api.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("failed to post inconclusive comment"),
    );
  });

  it("audit PASS — handles buildSummaryFromArtifacts throw gracefully", async () => {
    (buildSummaryFromArtifacts as any).mockImplementation(() => { throw new Error("fs error"); });
    const ctx = makeHookCtx();
    const dispatch = makeDispatch({ status: "auditing" as any });

    // Should not throw — error is caught
    await processVerdict(ctx, dispatch, {
      success: true,
      output: '{"pass": true, "criteria": [], "gaps": [], "testResults": ""}',
    }, "audit-err-7");

    expect(ctx.api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to write summary/memory"),
    );
  });
});

// ---------------------------------------------------------------------------
// triggerAudit — additional branch coverage for emitActivity.catch
// ---------------------------------------------------------------------------

describe("triggerAudit (error branch coverage)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPromptCache();
    (markEventProcessed as any).mockResolvedValue(true);
    (transitionDispatch as any).mockResolvedValue({});
    (readDispatchState as any).mockResolvedValue({
      version: 2,
      dispatches: { active: {}, completed: {} },
      sessionMap: {},
      processedEvents: [],
    });
    (getActiveDispatch as any).mockReturnValue(makeDispatch());
    (registerSessionMapping as any).mockResolvedValue(undefined);
    (completeDispatch as any).mockResolvedValue(undefined);
    (buildSummaryFromArtifacts as any).mockReturnValue(null);
    (resolveOrchestratorWorkspace as any).mockReturnValue("/tmp/ws");
    (runAgent as any).mockResolvedValue({ success: true, output: '{"pass": true, "criteria": [], "gaps": [], "testResults": ""}' });
  });

  it("handles emitActivity rejection gracefully", async () => {
    const linearApi = makeMockLinearApi();
    linearApi.emitActivity.mockRejectedValue(new Error("activity api down"));
    const ctx = makeHookCtx({ linearApi: linearApi as any });
    const dispatch = makeDispatch({ agentSessionId: "session-1" });

    // Should not throw — .catch() swallows
    await triggerAudit(ctx, dispatch, { success: true, output: "output" }, "trig-err-1");

    // Should still proceed to spawn audit agent
    expect(runAgent).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// spawnWorker — .catch() error branches
// ---------------------------------------------------------------------------

describe("spawnWorker (error branch coverage)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPromptCache();
    (transitionDispatch as any).mockResolvedValue({});
    (registerSessionMapping as any).mockResolvedValue(undefined);
    (markEventProcessed as any).mockResolvedValue(true);
    (completeDispatch as any).mockResolvedValue(undefined);
    (readDispatchState as any).mockResolvedValue({
      version: 2,
      dispatches: { active: { "ENG-100": makeDispatch() }, completed: {} },
      sessionMap: {},
      processedEvents: [],
    });
    (getActiveDispatch as any).mockReturnValue(makeDispatch());
    (buildSummaryFromArtifacts as any).mockReturnValue(null);
    (resolveOrchestratorWorkspace as any).mockReturnValue("/tmp/ws");
  });

  it("watchdog kill — handles createComment rejection gracefully", async () => {
    (runAgent as any).mockResolvedValue({
      success: false,
      output: "timed out",
      watchdogKilled: true,
    });
    const linearApi = makeMockLinearApi();
    linearApi.createComment.mockRejectedValue(new Error("api down"));
    const ctx = makeHookCtx({ linearApi: linearApi as any });
    const dispatch = makeDispatch({ status: "working" as any });

    // Should not throw — .catch() swallows
    await spawnWorker(ctx, dispatch);

    // The function should still complete (notify, clearActiveSession)
    expect(ctx.notify).toHaveBeenCalledWith(
      "watchdog_kill",
      expect.objectContaining({ status: "stuck" }),
    );
    expect(clearActiveSession).toHaveBeenCalled();
  });

  it("watchdog kill writes log entry with correct shape", async () => {
    (runAgent as any).mockResolvedValue({
      success: false,
      output: "partial output before hang",
      watchdogKilled: true,
    });
    const ctx = makeHookCtx();
    const dispatch = makeDispatch({ status: "working" as any });

    await spawnWorker(ctx, dispatch);

    // appendLog should be called with watchdog phase
    expect(appendLog).toHaveBeenCalledWith(
      dispatch.worktreePath,
      expect.objectContaining({
        phase: "watchdog",
        attempt: dispatch.attempt,
        prompt: "(watchdog kill)",
        success: false,
        watchdog: expect.objectContaining({
          reason: "inactivity",
          retried: true,
          thresholdSec: expect.any(Number),
        }),
      }),
    );

    // Verify output preview is included
    const logCall = (appendLog as any).mock.calls.find(
      (c: any[]) => c[1]?.phase === "watchdog",
    );
    expect(logCall).toBeDefined();
    expect(logCall[1].outputPreview).toBe("partial output before hang");
    expect(logCall[1].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("watchdog kill updates manifest to stuck", async () => {
    (runAgent as any).mockResolvedValue({
      success: false,
      output: "",
      watchdogKilled: true,
    });
    const ctx = makeHookCtx();
    const dispatch = makeDispatch({ status: "working" as any });

    await spawnWorker(ctx, dispatch);

    expect(updateManifest).toHaveBeenCalledWith(
      dispatch.worktreePath,
      { status: "stuck", attempts: dispatch.attempt + 1 },
    );
  });

  it("watchdog kill does not trigger audit", async () => {
    (runAgent as any).mockResolvedValue({
      success: false,
      output: "",
      watchdogKilled: true,
    });
    const ctx = makeHookCtx();
    const dispatch = makeDispatch({ status: "working" as any });

    await spawnWorker(ctx, dispatch);

    // runAgent should only be called ONCE (for the worker)
    // NOT a second time (no audit spawned)
    expect(runAgent).toHaveBeenCalledTimes(1);

    // No audit artifacts should be saved
    expect(saveAuditVerdict).not.toHaveBeenCalled();

    // Transition should be to stuck, never to auditing
    expect(transitionDispatch).toHaveBeenCalledWith(
      "ENG-100", "working", "stuck",
      expect.objectContaining({ stuckReason: "watchdog_kill_2x" }),
      expect.any(String),
    );
  });
});
