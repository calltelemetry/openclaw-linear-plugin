import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock pipeline.js to break the import chain: artifacts → pipeline → agent → extensionAPI
vi.mock("./pipeline.js", () => ({}));

import {
  ensureClawDir,
  ensureGitignore,
  writeManifest,
  readManifest,
  updateManifest,
  saveWorkerOutput,
  savePlan,
  saveAuditVerdict,
  appendLog,
  writeSummary,
  buildSummaryFromArtifacts,
  writeDispatchMemory,
  resolveOrchestratorWorkspace,
  type ClawManifest,
  type LogEntry,
} from "./artifacts.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "claw-test-"));
}

function makeManifest(overrides?: Partial<ClawManifest>): ClawManifest {
  return {
    issueIdentifier: "API-100",
    issueTitle: "Fix login bug",
    issueId: "id-123",
    tier: "junior",
    model: "test-model",
    dispatchedAt: "2026-01-01T00:00:00Z",
    worktreePath: "/tmp/test",
    branch: "codex/API-100",
    attempts: 0,
    status: "dispatched",
    plugin: "linear",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ensureClawDir
// ---------------------------------------------------------------------------

describe("ensureClawDir", () => {
  it("creates .claw/ directory and returns path", () => {
    const tmp = makeTmpDir();
    const result = ensureClawDir(tmp);
    expect(result).toBe(join(tmp, ".claw"));
    expect(existsSync(result)).toBe(true);
  });

  it("is idempotent", () => {
    const tmp = makeTmpDir();
    const first = ensureClawDir(tmp);
    const second = ensureClawDir(tmp);
    expect(first).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// ensureGitignore
// ---------------------------------------------------------------------------

describe("ensureGitignore", () => {
  it("creates .gitignore with .claw/ entry", () => {
    const tmp = makeTmpDir();
    ensureGitignore(tmp);
    const content = readFileSync(join(tmp, ".gitignore"), "utf-8");
    expect(content).toContain(".claw/");
  });

  it("appends to existing .gitignore", () => {
    const tmp = makeTmpDir();
    writeFileSync(join(tmp, ".gitignore"), "node_modules/\n", "utf-8");
    ensureGitignore(tmp);
    const content = readFileSync(join(tmp, ".gitignore"), "utf-8");
    expect(content).toContain("node_modules/");
    expect(content).toContain(".claw/");
  });

  it("does not duplicate entry", () => {
    const tmp = makeTmpDir();
    ensureGitignore(tmp);
    ensureGitignore(tmp);
    const content = readFileSync(join(tmp, ".gitignore"), "utf-8");
    const matches = content.match(/\.claw\//g);
    expect(matches).toHaveLength(1);
  });

  it("handles file without trailing newline", () => {
    const tmp = makeTmpDir();
    writeFileSync(join(tmp, ".gitignore"), "node_modules/", "utf-8"); // no trailing \n
    ensureGitignore(tmp);
    const content = readFileSync(join(tmp, ".gitignore"), "utf-8");
    expect(content).toBe("node_modules/\n.claw/\n");
  });
});

// ---------------------------------------------------------------------------
// Manifest CRUD
// ---------------------------------------------------------------------------

describe("manifest", () => {
  it("write + read round-trip", () => {
    const tmp = makeTmpDir();
    const manifest = makeManifest({ worktreePath: tmp });
    writeManifest(tmp, manifest);
    const read = readManifest(tmp);
    expect(read).toEqual(manifest);
  });

  it("readManifest returns null when missing", () => {
    const tmp = makeTmpDir();
    expect(readManifest(tmp)).toBeNull();
  });

  it("updateManifest merges partial updates", () => {
    const tmp = makeTmpDir();
    writeManifest(tmp, makeManifest({ worktreePath: tmp }));
    updateManifest(tmp, { status: "working", attempts: 1 });
    const read = readManifest(tmp);
    expect(read!.status).toBe("working");
    expect(read!.attempts).toBe(1);
    expect(read!.issueIdentifier).toBe("API-100"); // preserved
  });

  it("updateManifest no-op when no manifest", () => {
    const tmp = makeTmpDir();
    // Should not throw
    updateManifest(tmp, { status: "done" });
    expect(readManifest(tmp)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Phase artifacts
// ---------------------------------------------------------------------------

describe("saveWorkerOutput", () => {
  it("writes worker-{N}.md", () => {
    const tmp = makeTmpDir();
    saveWorkerOutput(tmp, 0, "hello world");
    const content = readFileSync(join(tmp, ".claw", "worker-0.md"), "utf-8");
    expect(content).toBe("hello world");
  });

  it("truncates at 8192 bytes", () => {
    const tmp = makeTmpDir();
    const longOutput = "x".repeat(10000);
    saveWorkerOutput(tmp, 1, longOutput);
    const content = readFileSync(join(tmp, ".claw", "worker-1.md"), "utf-8");
    expect(content.length).toBeLessThan(10000);
    expect(content).toContain("--- truncated ---");
  });

  it("does not truncate under limit", () => {
    const tmp = makeTmpDir();
    const shortOutput = "y".repeat(100);
    saveWorkerOutput(tmp, 2, shortOutput);
    const content = readFileSync(join(tmp, ".claw", "worker-2.md"), "utf-8");
    expect(content).toBe(shortOutput);
  });
});

describe("savePlan", () => {
  it("writes plan.md", () => {
    const tmp = makeTmpDir();
    savePlan(tmp, "# My Plan\n\nStep 1...");
    const content = readFileSync(join(tmp, ".claw", "plan.md"), "utf-8");
    expect(content).toBe("# My Plan\n\nStep 1...");
  });
});

describe("saveAuditVerdict", () => {
  it("writes audit-{N}.json with correct JSON", () => {
    const tmp = makeTmpDir();
    const verdict = { pass: true, criteria: ["tests pass"], gaps: [], testResults: "all green" };
    saveAuditVerdict(tmp, 0, verdict);
    const raw = readFileSync(join(tmp, ".claw", "audit-0.json"), "utf-8");
    expect(JSON.parse(raw)).toEqual(verdict);
  });
});

// ---------------------------------------------------------------------------
// Interaction log
// ---------------------------------------------------------------------------

describe("appendLog", () => {
  function makeEntry(overrides?: Partial<LogEntry>): LogEntry {
    return {
      ts: "2026-01-01T00:00:00Z",
      phase: "worker",
      attempt: 0,
      agent: "zoe",
      prompt: "do the thing",
      outputPreview: "done",
      success: true,
      ...overrides,
    };
  }

  it("creates log.jsonl and writes entry", () => {
    const tmp = makeTmpDir();
    appendLog(tmp, makeEntry());
    const content = readFileSync(join(tmp, ".claw", "log.jsonl"), "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.phase).toBe("worker");
    expect(parsed.success).toBe(true);
  });

  it("appends multiple entries as JSONL", () => {
    const tmp = makeTmpDir();
    appendLog(tmp, makeEntry({ attempt: 0 }));
    appendLog(tmp, makeEntry({ attempt: 1, phase: "audit" }));
    const lines = readFileSync(join(tmp, ".claw", "log.jsonl"), "utf-8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]).phase).toBe("audit");
  });

  it("truncates prompt to 200 chars", () => {
    const tmp = makeTmpDir();
    appendLog(tmp, makeEntry({ prompt: "x".repeat(500) }));
    const content = readFileSync(join(tmp, ".claw", "log.jsonl"), "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.prompt.length).toBe(200);
  });

  it("truncates outputPreview to 500 chars", () => {
    const tmp = makeTmpDir();
    appendLog(tmp, makeEntry({ outputPreview: "y".repeat(1000) }));
    const content = readFileSync(join(tmp, ".claw", "log.jsonl"), "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.outputPreview.length).toBe(500);
  });

  it("preserves watchdog detail when phase=watchdog", () => {
    const tmp = makeTmpDir();
    appendLog(tmp, makeEntry({
      phase: "watchdog",
      watchdog: { reason: "inactivity", silenceSec: 120, thresholdSec: 120, retried: true },
    }));
    const content = readFileSync(join(tmp, ".claw", "log.jsonl"), "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.phase).toBe("watchdog");
    expect(parsed.watchdog).toEqual({
      reason: "inactivity",
      silenceSec: 120,
      thresholdSec: 120,
      retried: true,
    });
  });

  it("omits watchdog field when undefined", () => {
    const tmp = makeTmpDir();
    appendLog(tmp, makeEntry());
    const content = readFileSync(join(tmp, ".claw", "log.jsonl"), "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.watchdog).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

describe("writeSummary", () => {
  it("writes summary.md", () => {
    const tmp = makeTmpDir();
    writeSummary(tmp, "# Summary\nAll done.");
    const content = readFileSync(join(tmp, ".claw", "summary.md"), "utf-8");
    expect(content).toBe("# Summary\nAll done.");
  });
});

describe("buildSummaryFromArtifacts", () => {
  it("returns null with no manifest", () => {
    const tmp = makeTmpDir();
    expect(buildSummaryFromArtifacts(tmp)).toBeNull();
  });

  it("builds markdown with header", () => {
    const tmp = makeTmpDir();
    writeManifest(tmp, makeManifest({ worktreePath: tmp }));
    const summary = buildSummaryFromArtifacts(tmp)!;
    expect(summary).toContain("# Dispatch: API-100");
    expect(summary).toContain("Fix login bug");
  });

  it("includes plan section when plan exists", () => {
    const tmp = makeTmpDir();
    writeManifest(tmp, makeManifest({ worktreePath: tmp }));
    savePlan(tmp, "Step 1: do stuff");
    const summary = buildSummaryFromArtifacts(tmp)!;
    expect(summary).toContain("## Plan");
    expect(summary).toContain("Step 1: do stuff");
  });

  it("includes worker+audit per attempt", () => {
    const tmp = makeTmpDir();
    writeManifest(tmp, makeManifest({ worktreePath: tmp, attempts: 2 }));
    saveWorkerOutput(tmp, 0, "attempt 0 output");
    saveAuditVerdict(tmp, 0, { pass: false, criteria: ["c1"], gaps: ["g1"], testResults: "fail" });
    saveWorkerOutput(tmp, 1, "attempt 1 output");
    saveAuditVerdict(tmp, 1, { pass: true, criteria: ["c2"], gaps: [], testResults: "pass" });

    const summary = buildSummaryFromArtifacts(tmp)!;
    expect(summary).toContain("## Attempt 0");
    expect(summary).toContain("attempt 0 output");
    expect(summary).toContain("FAIL");
    expect(summary).toContain("g1");
    expect(summary).toContain("## Attempt 1");
    expect(summary).toContain("attempt 1 output");
    expect(summary).toContain("PASS");
  });

  it("handles missing artifact files gracefully", () => {
    const tmp = makeTmpDir();
    writeManifest(tmp, makeManifest({ worktreePath: tmp, attempts: 1 }));
    // No worker or audit files — should not throw
    const summary = buildSummaryFromArtifacts(tmp)!;
    expect(summary).toContain("## Attempt 0");
  });
});

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

describe("writeDispatchMemory", () => {
  it("creates memory/ dir and writes file", () => {
    const tmp = makeTmpDir();
    writeDispatchMemory("API-100", "summary content", tmp);
    const content = readFileSync(join(tmp, "memory", "dispatch-API-100.md"), "utf-8");
    expect(content).toBe("summary content");
  });

  it("overwrites on second call", () => {
    const tmp = makeTmpDir();
    writeDispatchMemory("API-100", "first", tmp);
    writeDispatchMemory("API-100", "second", tmp);
    const content = readFileSync(join(tmp, "memory", "dispatch-API-100.md"), "utf-8");
    expect(content).toBe("second");
  });
});

// ---------------------------------------------------------------------------
// Orchestrator workspace
// ---------------------------------------------------------------------------

describe("resolveOrchestratorWorkspace", () => {
  it("falls back to default on error", () => {
    const api = { runtime: { config: { loadConfig: () => { throw new Error("no config"); } } } };
    const result = resolveOrchestratorWorkspace(api);
    expect(result).toContain(".openclaw");
    expect(result).toContain("workspace");
  });

  it("returns workspace from config", () => {
    const api = {
      runtime: {
        config: {
          loadConfig: () => ({
            agents: {
              list: [{ id: "default", workspace: "/custom/ws" }],
            },
          }),
        },
      },
    };
    const result = resolveOrchestratorWorkspace(api);
    expect(result).toBe("/custom/ws");
  });
});
