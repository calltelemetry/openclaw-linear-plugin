/**
 * artifacts.ts — .claw/ per-worktree artifact convention.
 *
 * Provides a standard directory structure for storing artifacts during
 * the lifecycle of a dispatched issue. Any OpenClaw plugin that works
 * with a worktree can write to {worktreePath}/.claw/.
 *
 * Structure:
 *   .claw/
 *     manifest.json     — issue metadata + lifecycle timestamps
 *     plan.md           — implementation plan
 *     worker-{N}.md     — worker output per attempt (truncated)
 *     audit-{N}.json    — audit verdict per attempt
 *     log.jsonl         — append-only interaction log
 *     summary.md        — agent-curated final summary
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { AuditVerdict } from "./pipeline.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ARTIFACT_SIZE = 8192; // 8KB per output file
const MAX_PREVIEW_SIZE = 500;   // For log entry previews
const MAX_PROMPT_PREVIEW = 200; // For log entry prompt previews

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClawManifest {
  issueIdentifier: string;
  issueTitle: string;
  issueId: string;
  tier: string;
  model: string;
  dispatchedAt: string;
  worktreePath: string;
  branch: string;
  attempts: number;
  status: string;
  plugin: string;
}

export interface WatchdogLogDetail {
  reason: "inactivity";
  silenceSec: number;
  thresholdSec: number;
  retried: boolean;
}

export interface LogEntry {
  ts: string;
  phase: "worker" | "audit" | "verdict" | "dispatch" | "watchdog";
  attempt: number;
  agent: string;
  prompt: string;
  outputPreview: string;
  success: boolean;
  durationMs?: number;
  watchdog?: WatchdogLogDetail;
}

// ---------------------------------------------------------------------------
// Directory setup
// ---------------------------------------------------------------------------

function clawDir(worktreePath: string): string {
  return join(worktreePath, ".claw");
}

/** Creates .claw/ directory. Returns the path. */
export function ensureClawDir(worktreePath: string): string {
  const dir = clawDir(worktreePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Ensure .claw/ is in .gitignore at the worktree root.
 * Appends if not already present. Idempotent.
 */
export function ensureGitignore(worktreePath: string): void {
  const gitignorePath = join(worktreePath, ".gitignore");
  try {
    const content = existsSync(gitignorePath)
      ? readFileSync(gitignorePath, "utf-8")
      : "";
    if (!content.split("\n").some((line) => line.trim() === ".claw" || line.trim() === ".claw/")) {
      const nl = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
      appendFileSync(gitignorePath, `${nl}.claw/\n`, "utf-8");
    }
  } catch {
    // Best effort — don't block pipeline
  }
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export function writeManifest(worktreePath: string, manifest: ClawManifest): void {
  const dir = ensureClawDir(worktreePath);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}

export function readManifest(worktreePath: string): ClawManifest | null {
  try {
    const raw = readFileSync(join(clawDir(worktreePath), "manifest.json"), "utf-8");
    return JSON.parse(raw) as ClawManifest;
  } catch {
    return null;
  }
}

export function updateManifest(worktreePath: string, updates: Partial<ClawManifest>): void {
  const current = readManifest(worktreePath);
  if (!current) return;
  writeManifest(worktreePath, { ...current, ...updates });
}

// ---------------------------------------------------------------------------
// Phase artifacts
// ---------------------------------------------------------------------------

/** Save worker output for a given attempt. Truncated to MAX_ARTIFACT_SIZE. */
export function saveWorkerOutput(worktreePath: string, attempt: number, output: string): void {
  const dir = ensureClawDir(worktreePath);
  const truncated = output.length > MAX_ARTIFACT_SIZE
    ? output.slice(0, MAX_ARTIFACT_SIZE) + "\n\n--- truncated ---"
    : output;
  writeFileSync(join(dir, `worker-${attempt}.md`), truncated, "utf-8");
}

/** Save a plan (extracted from worker output or provided directly). */
export function savePlan(worktreePath: string, plan: string): void {
  const dir = ensureClawDir(worktreePath);
  writeFileSync(join(dir, "plan.md"), plan, "utf-8");
}

/** Save audit verdict for a given attempt. */
export function saveAuditVerdict(worktreePath: string, attempt: number, verdict: AuditVerdict): void {
  const dir = ensureClawDir(worktreePath);
  writeFileSync(join(dir, `audit-${attempt}.json`), JSON.stringify(verdict, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Interaction log
// ---------------------------------------------------------------------------

/** Append a structured log entry to .claw/log.jsonl. */
export function appendLog(worktreePath: string, entry: LogEntry): void {
  const dir = ensureClawDir(worktreePath);
  const truncated: LogEntry = {
    ...entry,
    prompt: entry.prompt.slice(0, MAX_PROMPT_PREVIEW),
    outputPreview: entry.outputPreview.slice(0, MAX_PREVIEW_SIZE),
  };
  appendFileSync(join(dir, "log.jsonl"), JSON.stringify(truncated) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/** Write the final curated summary. */
export function writeSummary(worktreePath: string, summary: string): void {
  const dir = ensureClawDir(worktreePath);
  writeFileSync(join(dir, "summary.md"), summary, "utf-8");
}

/**
 * Build a markdown summary from all .claw/ artifacts.
 * Used at issue completion to generate a memory-friendly summary.
 */
export function buildSummaryFromArtifacts(worktreePath: string): string | null {
  const manifest = readManifest(worktreePath);
  if (!manifest) return null;

  const parts: string[] = [];
  parts.push(`# Dispatch: ${manifest.issueIdentifier} — ${manifest.issueTitle}`);
  parts.push(`**Tier:** ${manifest.tier} | **Status:** ${manifest.status} | **Attempts:** ${manifest.attempts}`);
  parts.push("");

  // Include plan if exists
  try {
    const plan = readFileSync(join(clawDir(worktreePath), "plan.md"), "utf-8");
    parts.push("## Plan");
    parts.push(plan.slice(0, 2000));
    parts.push("");
  } catch { /* no plan */ }

  // Include each attempt's worker + audit
  for (let i = 0; i < manifest.attempts; i++) {
    parts.push(`## Attempt ${i}`);

    // Worker output preview
    try {
      const worker = readFileSync(join(clawDir(worktreePath), `worker-${i}.md`), "utf-8");
      parts.push("### Worker Output");
      parts.push(worker.slice(0, 1500));
      parts.push("");
    } catch { /* no worker output */ }

    // Audit verdict
    try {
      const raw = readFileSync(join(clawDir(worktreePath), `audit-${i}.json`), "utf-8");
      const verdict = JSON.parse(raw) as AuditVerdict;
      parts.push(`### Audit: ${verdict.pass ? "PASS" : "FAIL"}`);
      if (verdict.criteria.length) parts.push(`**Criteria:** ${verdict.criteria.join(", ")}`);
      if (verdict.gaps.length) parts.push(`**Gaps:** ${verdict.gaps.join(", ")}`);
      if (verdict.testResults) parts.push(`**Tests:** ${verdict.testResults}`);
      parts.push("");
    } catch { /* no audit */ }
  }

  parts.push("---");
  parts.push(`*Artifacts: ${worktreePath}/.claw/*`);

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Memory integration
// ---------------------------------------------------------------------------

export interface DispatchMemoryMetadata {
  type: "dispatch";
  issue: string;
  title: string;
  tier: string;
  status: string;
  project?: string;
  attempts: number;
  model: string;
  date: string;
}

/**
 * Write dispatch summary to the orchestrator's memory directory
 * with YAML frontmatter for searchable metadata.
 * Auto-indexed by OpenClaw's sqlite+embeddings memory system.
 */
export function writeDispatchMemory(
  issueIdentifier: string,
  summary: string,
  workspaceDir: string,
  metadata?: Partial<DispatchMemoryMetadata>,
): void {
  const memDir = join(workspaceDir, "memory");
  if (!existsSync(memDir)) {
    mkdirSync(memDir, { recursive: true });
  }

  const fm: DispatchMemoryMetadata = {
    type: "dispatch",
    issue: issueIdentifier,
    title: metadata?.title ?? issueIdentifier,
    tier: metadata?.tier ?? "unknown",
    status: metadata?.status ?? "unknown",
    project: metadata?.project,
    attempts: metadata?.attempts ?? 0,
    model: metadata?.model ?? "unknown",
    date: metadata?.date ?? new Date().toISOString().slice(0, 10),
  };

  const frontmatter = [
    "---",
    ...Object.entries(fm)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}: ${typeof v === "string" ? `"${v}"` : v}`),
    "---",
    "",
  ].join("\n");

  writeFileSync(
    join(memDir, `dispatch-${issueIdentifier}.md`),
    frontmatter + summary,
    "utf-8",
  );
}

/**
 * Resolve the orchestrator agent's workspace directory from config.
 * Same config-based approach as resolveAgentDirs in agent.ts.
 */
export function resolveOrchestratorWorkspace(
  api: any,
  pluginConfig?: Record<string, unknown>,
): string {
  const home = homedir();
  const agentId = (pluginConfig?.defaultAgentId as string) ?? "default";

  try {
    const config = api.runtime.config.loadConfig() as Record<string, any>;
    const agentList = config?.agents?.list as Array<Record<string, any>> | undefined;
    const agentEntry = agentList?.find((a: any) => a.id === agentId);
    return agentEntry?.workspace
      ?? config?.agents?.defaults?.workspace
      ?? join(home, ".openclaw", "workspace");
  } catch {
    return join(home, ".openclaw", "workspace");
  }
}
