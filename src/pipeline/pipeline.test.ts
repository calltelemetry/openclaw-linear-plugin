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
  resolveOrchestratorWorkspace: vi.fn(),
}));
vi.mock("../agent/watchdog.js", () => ({
  resolveWatchdogConfig: vi.fn(() => ({
    inactivityMs: 120000,
    maxTotalMs: 7200000,
    toolTimeoutMs: 600000,
  })),
}));

import {
  parseVerdict,
  buildWorkerTask,
  buildAuditTask,
  loadPrompts,
  clearPromptCache,
  type IssueContext,
} from "./pipeline.js";

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
});
