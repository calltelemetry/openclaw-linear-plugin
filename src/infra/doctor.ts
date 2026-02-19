/**
 * doctor.ts — Comprehensive health checks for the Linear plugin.
 *
 * Usage: openclaw openclaw-linear doctor [--fix] [--json]
 */
import { existsSync, readFileSync, statSync, accessSync, unlinkSync, chmodSync, constants } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

import { resolveLinearToken, AUTH_PROFILES_PATH, LINEAR_GRAPHQL_URL } from "../api/linear-api.js";
import { readDispatchState, listActiveDispatches, listStaleDispatches, pruneCompleted, type DispatchState } from "../pipeline/dispatch-state.js";
import { loadPrompts, clearPromptCache } from "../pipeline/pipeline.js";
import { listWorktrees } from "./codex-worktree.js";
import { loadCodingConfig, type CodingBackend } from "../tools/code-tool.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CheckSeverity = "pass" | "warn" | "fail";

export interface CheckResult {
  label: string;
  severity: CheckSeverity;
  detail?: string;
  fixable?: boolean;
  /** User-facing guidance on how to resolve the issue */
  fix?: string;
}

export interface CheckSection {
  name: string;
  checks: CheckResult[];
}

export interface DoctorReport {
  sections: CheckSection[];
  summary: { passed: number; warnings: number; errors: number };
}

export interface DoctorOptions {
  fix: boolean;
  json: boolean;
  pluginConfig?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AGENT_PROFILES_PATH = join(homedir(), ".openclaw", "agent-profiles.json");
const VALID_BACKENDS: readonly string[] = ["claude", "codex", "gemini"];
const CLI_BINS: [string, string][] = [
  ["codex", "/home/claw/.npm-global/bin/codex"],
  ["claude", "/home/claw/.npm-global/bin/claude"],
  ["gemini", "/home/claw/.npm-global/bin/gemini"],
];
const STALE_DISPATCH_MS = 2 * 60 * 60_000; // 2 hours
const OLD_COMPLETED_MS = 7 * 24 * 60 * 60_000; // 7 days
const LOCK_STALE_MS = 30_000; // 30 seconds

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pass(label: string, detail?: string): CheckResult {
  return { label, severity: "pass", detail };
}

function warn(label: string, detail?: string, opts?: { fixable?: boolean; fix?: string }): CheckResult {
  return { label, severity: "warn", detail, fixable: opts?.fixable || undefined, fix: opts?.fix };
}

function fail(label: string, detail?: string, fix?: string): CheckResult {
  return { label, severity: "fail", detail, fix };
}

function resolveDispatchStatePath(pluginConfig?: Record<string, unknown>): string {
  const custom = pluginConfig?.dispatchStatePath as string | undefined;
  if (!custom) return join(homedir(), ".openclaw", "linear-dispatch-state.json");
  if (custom.startsWith("~/")) return custom.replace("~", homedir());
  return custom;
}

function resolveWorktreeBaseDir(pluginConfig?: Record<string, unknown>): string {
  const custom = pluginConfig?.worktreeBaseDir as string | undefined;
  if (!custom) return join(homedir(), ".openclaw", "worktrees");
  if (custom.startsWith("~/")) return custom.replace("~", homedir());
  return custom;
}

function resolveBaseRepo(pluginConfig?: Record<string, unknown>): string {
  return (pluginConfig?.codexBaseRepo as string) ?? "/home/claw/ai-workspace";
}

interface AgentProfile {
  label?: string;
  mentionAliases?: string[];
  isDefault?: boolean;
  [key: string]: unknown;
}

function loadAgentProfiles(): Record<string, AgentProfile> {
  try {
    const raw = readFileSync(AGENT_PROFILES_PATH, "utf8");
    return JSON.parse(raw).agents ?? {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Section 1: Authentication & Tokens
// ---------------------------------------------------------------------------

interface AuthContext {
  viewer?: { name: string };
  organization?: { name: string; urlKey: string };
}

export async function checkAuth(pluginConfig?: Record<string, unknown>): Promise<{ checks: CheckResult[]; ctx: AuthContext }> {
  const checks: CheckResult[] = [];
  const ctx: AuthContext = {};

  // Token existence
  const tokenInfo = resolveLinearToken(pluginConfig);
  if (tokenInfo.accessToken) {
    checks.push(pass(`Access token found (source: ${tokenInfo.source})`));
  } else {
    checks.push(fail("No access token found", undefined, "Run: openclaw openclaw-linear auth"));
    // Can't check further without token
    return { checks, ctx };
  }

  // Token expiry
  if (tokenInfo.expiresAt) {
    const remaining = tokenInfo.expiresAt - Date.now();
    if (remaining <= 0) {
      checks.push(warn("Token expired", undefined, { fix: "Run: openclaw openclaw-linear auth" }));
    } else {
      const hours = Math.floor(remaining / 3_600_000);
      const mins = Math.floor((remaining % 3_600_000) / 60_000);
      if (remaining < 3_600_000) {
        checks.push(warn(`Token expires soon (${mins}m remaining)`, undefined, { fix: "Restart the gateway to trigger auto-refresh, or run: openclaw openclaw-linear auth" }));
      } else {
        checks.push(pass(`Token not expired (${hours}h ${mins}m remaining)`));
      }
    }
  }

  // API connectivity
  try {
    const authHeader = tokenInfo.refreshToken
      ? `Bearer ${tokenInfo.accessToken}`
      : tokenInfo.accessToken;

    const res = await fetch(LINEAR_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body: JSON.stringify({
        query: `{ viewer { id name } organization { name urlKey } }`,
      }),
    });

    if (!res.ok) {
      checks.push(fail(`API returned ${res.status} ${res.statusText}`));
    } else {
      const payload = await res.json() as any;
      if (payload.errors?.length) {
        checks.push(fail(`API error: ${payload.errors[0].message}`));
      } else {
        const { viewer, organization } = payload.data;
        ctx.viewer = viewer;
        ctx.organization = organization;
        checks.push(pass(`API connectivity (user: ${viewer.name}, workspace: ${organization.name})`));
      }
    }
  } catch (err) {
    checks.push(fail(`API unreachable: ${err instanceof Error ? err.message : String(err)}`));
  }

  // auth-profiles.json permissions
  try {
    const stat = statSync(AUTH_PROFILES_PATH);
    const mode = stat.mode & 0o777;
    if (mode === 0o600) {
      checks.push(pass("auth-profiles.json permissions (600)"));
    } else {
      checks.push(warn(
        `auth-profiles.json permissions (${mode.toString(8)}, expected 600)`,
        undefined,
        { fixable: true, fix: "Run: chmod 600 ~/.openclaw/auth-profiles.json" },
      ));
    }
  } catch {
    if (tokenInfo.source === "profile") {
      checks.push(warn("auth-profiles.json not found (but token resolved from profile?)"));
    }
    // If token is from config/env, no auth-profiles.json is fine
  }

  // OAuth credentials
  const clientId = (pluginConfig?.clientId as string) ?? process.env.LINEAR_CLIENT_ID;
  const clientSecret = (pluginConfig?.clientSecret as string) ?? process.env.LINEAR_CLIENT_SECRET;
  if (clientId && clientSecret) {
    checks.push(pass("OAuth credentials configured"));
  } else {
    checks.push(warn(
      "OAuth credentials not configured",
      "Set LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET env vars or plugin config",
    ));
  }

  return { checks, ctx };
}

// ---------------------------------------------------------------------------
// Section 2: Agent Configuration
// ---------------------------------------------------------------------------

export function checkAgentConfig(pluginConfig?: Record<string, unknown>): CheckResult[] {
  const checks: CheckResult[] = [];

  // Load profiles
  let profiles: Record<string, AgentProfile>;
  try {
    if (!existsSync(AGENT_PROFILES_PATH)) {
      checks.push(fail(
        "agent-profiles.json not found",
        `Expected at: ${AGENT_PROFILES_PATH}`,
      ));
      return checks;
    }
    const raw = readFileSync(AGENT_PROFILES_PATH, "utf8");
    const parsed = JSON.parse(raw);
    profiles = parsed.agents ?? {};
  } catch (err) {
    checks.push(fail(
      "agent-profiles.json invalid JSON",
      err instanceof Error ? err.message : String(err),
    ));
    return checks;
  }

  const agentCount = Object.keys(profiles).length;
  if (agentCount === 0) {
    checks.push(fail("agent-profiles.json has no agents", undefined, "Add at least one agent to ~/.openclaw/agent-profiles.json"));
    return checks;
  }
  checks.push(pass(`agent-profiles.json loaded (${agentCount} agent${agentCount > 1 ? "s" : ""})`));

  // Default agent
  const defaultEntry = Object.entries(profiles).find(([, p]) => p.isDefault);
  if (defaultEntry) {
    checks.push(pass(`Default agent: ${defaultEntry[0]}`));
  } else {
    checks.push(warn("No agent has isDefault: true", undefined, { fix: "Add \"isDefault\": true to one agent in ~/.openclaw/agent-profiles.json" }));
  }

  // Required fields
  const missing: string[] = [];
  for (const [id, profile] of Object.entries(profiles)) {
    if (!profile.label) missing.push(`${id}: missing label`);
    if (!Array.isArray(profile.mentionAliases) || profile.mentionAliases.length === 0) {
      missing.push(`${id}: missing or empty mentionAliases`);
    }
  }
  if (missing.length === 0) {
    checks.push(pass("All agents have required fields"));
  } else {
    checks.push(fail(`Agent field issues: ${missing.join("; ")}`, undefined, "Each agent needs at least a \"label\" and \"mentionAliases\" array in agent-profiles.json"));
  }

  // defaultAgentId match
  const configAgentId = pluginConfig?.defaultAgentId as string | undefined;
  if (configAgentId) {
    if (profiles[configAgentId]) {
      checks.push(pass(`defaultAgentId "${configAgentId}" matches a profile`));
    } else {
      checks.push(warn(
        `defaultAgentId "${configAgentId}" not found in agent-profiles.json`,
        `Available: ${Object.keys(profiles).join(", ")}`,
      ));
    }
  }

  // Duplicate aliases
  const aliasMap = new Map<string, string>();
  const dupes: string[] = [];
  for (const [id, profile] of Object.entries(profiles)) {
    for (const alias of profile.mentionAliases ?? []) {
      const lower = alias.toLowerCase();
      if (aliasMap.has(lower)) {
        dupes.push(`"${alias}" (${aliasMap.get(lower)} and ${id})`);
      } else {
        aliasMap.set(lower, id);
      }
    }
  }
  if (dupes.length === 0) {
    checks.push(pass("No duplicate mention aliases"));
  } else {
    checks.push(warn(`Duplicate aliases: ${dupes.join(", ")}`));
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Section 3: Coding Tools
// ---------------------------------------------------------------------------

export function checkCodingTools(): CheckResult[] {
  const checks: CheckResult[] = [];

  // Load config
  const config = loadCodingConfig();
  const hasConfig = !!config.codingTool || !!config.backends;
  if (hasConfig) {
    checks.push(pass(`coding-tools.json loaded (default: ${config.codingTool ?? "claude"})`));
  } else {
    checks.push(warn("coding-tools.json not found or empty (using defaults)", undefined, { fix: "Create coding-tools.json in the plugin root — see README for format" }));
  }

  // Validate default backend
  const defaultBackend = config.codingTool ?? "claude";
  if (VALID_BACKENDS.includes(defaultBackend)) {
    // already reported in the line above
  } else {
    checks.push(fail(`Unknown default backend: "${defaultBackend}" (valid: ${VALID_BACKENDS.join(", ")})`));
  }

  // Validate per-agent overrides
  if (config.agentCodingTools) {
    for (const [agentId, backend] of Object.entries(config.agentCodingTools)) {
      if (!VALID_BACKENDS.includes(backend)) {
        checks.push(warn(`Agent "${agentId}" override "${backend}" is not a valid backend`));
      }
    }
  }

  // CLI availability
  for (const [name, bin] of CLI_BINS) {
    try {
      const raw = execFileSync(bin, ["--version"], {
        encoding: "utf8",
        timeout: 15_000,
        env: { ...process.env, CLAUDECODE: undefined } as any,
      }).trim();
      checks.push(pass(`${name}: ${raw || "installed"}`));
    } catch {
      try {
        accessSync(bin, constants.X_OK);
        checks.push(pass(`${name}: installed (version check skipped)`));
      } catch {
        checks.push(warn(`${name}: not found at ${bin}`, undefined, { fix: `Install ${name} or check that it's in your PATH` }));
      }
    }
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Section 4: Files & Directories
// ---------------------------------------------------------------------------

export async function checkFilesAndDirs(pluginConfig?: Record<string, unknown>, fix = false): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];

  // Dispatch state
  const statePath = resolveDispatchStatePath(pluginConfig);
  let dispatchState: DispatchState | null = null;
  if (existsSync(statePath)) {
    try {
      dispatchState = await readDispatchState(pluginConfig?.dispatchStatePath as string | undefined);
      const activeCount = Object.keys(dispatchState.dispatches.active).length;
      const completedCount = Object.keys(dispatchState.dispatches.completed).length;
      checks.push(pass(`Dispatch state: ${activeCount} active, ${completedCount} completed`));
    } catch (err) {
      checks.push(fail(
        "Dispatch state corrupt",
        err instanceof Error ? err.message : String(err),
      ));
    }
  } else {
    checks.push(pass("Dispatch state: no file yet (will be created on first dispatch)"));
  }

  // Stale lock files
  const lockPath = statePath + ".lock";
  if (existsSync(lockPath)) {
    try {
      const lockStat = statSync(lockPath);
      const lockAge = Date.now() - lockStat.mtimeMs;
      if (lockAge > LOCK_STALE_MS) {
        if (fix) {
          unlinkSync(lockPath);
          checks.push(pass("Stale lock file removed (--fix)"));
        } else {
          checks.push(warn(
            `Stale lock file (${Math.round(lockAge / 1000)}s old)`,
            undefined,
            { fixable: true, fix: "Run: openclaw openclaw-linear doctor --fix to remove" },
          ));
        }
      } else {
        checks.push(warn(`Lock file active (${Math.round(lockAge / 1000)}s old, may be in use)`));
      }
    } catch {
      checks.push(pass("No stale lock files"));
    }
  } else {
    checks.push(pass("No stale lock files"));
  }

  // Worktree base dir
  const wtBaseDir = resolveWorktreeBaseDir(pluginConfig);
  if (existsSync(wtBaseDir)) {
    try {
      accessSync(wtBaseDir, constants.W_OK);
      checks.push(pass("Worktree base dir writable"));
    } catch {
      checks.push(fail(`Worktree base dir not writable: ${wtBaseDir}`));
    }
  } else {
    checks.push(warn(`Worktree base dir does not exist: ${wtBaseDir}`, "Will be created on first dispatch"));
  }

  // Base git repo
  const baseRepo = resolveBaseRepo(pluginConfig);
  if (existsSync(baseRepo)) {
    try {
      execFileSync("git", ["rev-parse", "--git-dir"], {
        cwd: baseRepo,
        encoding: "utf8",
        timeout: 5_000,
      });
      checks.push(pass("Base repo is valid git repo"));
    } catch {
      checks.push(fail(`Base repo is not a git repo: ${baseRepo}`, undefined, "Run: git init in the base repo directory, or set codexBaseRepo to a different path"));
    }
  } else {
    checks.push(fail(`Base repo does not exist: ${baseRepo}`, undefined, "Set codexBaseRepo in plugin config to your git repository path"));
  }

  // Prompts
  try {
    clearPromptCache();
    const loaded = loadPrompts(pluginConfig);
    const errors: string[] = [];

    const sections = [
      ["worker.system", loaded.worker?.system],
      ["worker.task", loaded.worker?.task],
      ["audit.system", loaded.audit?.system],
      ["audit.task", loaded.audit?.task],
      ["rework.addendum", loaded.rework?.addendum],
    ] as const;

    let sectionCount = 0;
    for (const [name, value] of sections) {
      if (value) sectionCount++;
      else errors.push(`Missing ${name}`);
    }

    const requiredVars = ["{{identifier}}", "{{title}}", "{{description}}", "{{worktreePath}}"];
    let varCount = 0;
    for (const v of requiredVars) {
      const inWorker = loaded.worker?.task?.includes(v);
      const inAudit = loaded.audit?.task?.includes(v);
      if (inWorker && inAudit) {
        varCount++;
      } else {
        if (!inWorker) errors.push(`worker.task missing ${v}`);
        if (!inAudit) errors.push(`audit.task missing ${v}`);
      }
    }

    if (errors.length === 0) {
      checks.push(pass(`Prompts valid (${sectionCount}/5 sections, ${varCount}/4 variables)`));
    } else {
      checks.push(fail(`Prompt issues: ${errors.join("; ")}`, undefined, "Run: openclaw openclaw-linear prompts validate for details"));
    }
  } catch (err) {
    checks.push(fail(
      "Failed to load prompts",
      err instanceof Error ? err.message : String(err),
    ));
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Section 5: Connectivity
// ---------------------------------------------------------------------------

export async function checkConnectivity(pluginConfig?: Record<string, unknown>, authCtx?: AuthContext): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];

  // Linear API (share result from auth check if available)
  if (authCtx?.viewer) {
    checks.push(pass("Linear API: connected"));
  } else {
    // Re-check if auth context wasn't passed
    const tokenInfo = resolveLinearToken(pluginConfig);
    if (tokenInfo.accessToken) {
      try {
        const authHeader = tokenInfo.refreshToken
          ? `Bearer ${tokenInfo.accessToken}`
          : tokenInfo.accessToken;
        const res = await fetch(LINEAR_GRAPHQL_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: authHeader },
          body: JSON.stringify({ query: `{ viewer { id } }` }),
        });
        if (res.ok) {
          checks.push(pass("Linear API: connected"));
        } else {
          checks.push(fail(`Linear API: ${res.status} ${res.statusText}`));
        }
      } catch (err) {
        checks.push(fail(`Linear API: unreachable (${err instanceof Error ? err.message : String(err)})`));
      }
    } else {
      checks.push(fail("Linear API: no token available", undefined, "Run: openclaw openclaw-linear auth"));
    }
  }

  // Notification targets
  const notifRaw = pluginConfig?.notifications as { targets?: { channel: string; target: string }[] } | undefined;
  const notifTargets = notifRaw?.targets ?? [];
  if (notifTargets.length === 0) {
    checks.push(pass("Notifications: not configured (skipped)"));
  } else {
    for (const t of notifTargets) {
      checks.push(pass(`Notifications: ${t.channel} → ${t.target}`));
    }
  }

  // Webhook self-test
  const gatewayPort = process.env.OPENCLAW_GATEWAY_PORT ?? "18789";
  try {
    const res = await fetch(`http://localhost:${gatewayPort}/linear/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "test", action: "ping" }),
    });
    const body = await res.text();
    if (res.ok && body === "ok") {
      checks.push(pass("Webhook self-test: responds OK"));
    } else {
      checks.push(warn(`Webhook self-test: ${res.status} — ${body.slice(0, 100)}`));
    }
  } catch {
    checks.push(warn(`Webhook self-test: skipped (gateway not detected on :${gatewayPort})`));
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Section 6: Dispatch Health
// ---------------------------------------------------------------------------

export async function checkDispatchHealth(pluginConfig?: Record<string, unknown>, fix = false): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];

  const statePath = resolveDispatchStatePath(pluginConfig);
  let state: DispatchState;
  try {
    state = await readDispatchState(pluginConfig?.dispatchStatePath as string | undefined);
  } catch {
    checks.push(pass("Dispatch health: no state file (nothing to check)"));
    return checks;
  }

  // Active dispatches by status
  const active = listActiveDispatches(state);
  if (active.length === 0) {
    checks.push(pass("No active dispatches"));
  } else {
    const byStatus = new Map<string, number>();
    for (const d of active) {
      byStatus.set(d.status, (byStatus.get(d.status) ?? 0) + 1);
    }
    const parts = Array.from(byStatus.entries()).map(([s, n]) => `${n} ${s}`);
    const hasStuck = byStatus.has("stuck");
    if (hasStuck) {
      checks.push(warn(`Active dispatches: ${parts.join(", ")}`));
    } else {
      checks.push(pass(`Active dispatches: ${parts.join(", ")}`));
    }
  }

  // Stale dispatches
  const stale = listStaleDispatches(state, STALE_DISPATCH_MS);
  if (stale.length === 0) {
    checks.push(pass("No stale dispatches"));
  } else {
    const ids = stale.map((d) => d.issueIdentifier).join(", ");
    checks.push(warn(`${stale.length} stale dispatch${stale.length > 1 ? "es" : ""}: ${ids}`, undefined, { fix: "Re-assign the issue to retry, or run: openclaw openclaw-linear doctor --fix to clean up" }));
  }

  // Orphaned worktrees
  try {
    const worktrees = listWorktrees({ baseDir: resolveWorktreeBaseDir(pluginConfig) });
    const activeIds = new Set(Object.keys(state.dispatches.active));
    const orphaned = worktrees.filter((wt) => !activeIds.has(wt.issueIdentifier));
    if (orphaned.length === 0) {
      checks.push(pass("No orphaned worktrees"));
    } else {
      checks.push(warn(
        `${orphaned.length} orphaned worktree${orphaned.length > 1 ? "s" : ""} (not in active dispatches)`,
        orphaned.map((w) => w.path).join(", "),
      ));
    }
  } catch {
    // Worktree listing may fail if dir doesn't exist — that's fine
  }

  // Old completed dispatches
  const completed = Object.values(state.dispatches.completed);
  const now = Date.now();
  const old = completed.filter((c) => {
    const age = now - new Date(c.completedAt).getTime();
    return age > OLD_COMPLETED_MS;
  });

  if (old.length === 0) {
    checks.push(pass("No old completed dispatches"));
  } else {
    if (fix) {
      const pruned = await pruneCompleted(OLD_COMPLETED_MS, pluginConfig?.dispatchStatePath as string | undefined);
      checks.push(pass(`Pruned ${pruned} old completed dispatch${pruned > 1 ? "es" : ""} (--fix)`));
    } else {
      checks.push(warn(
        `${old.length} completed dispatch${old.length > 1 ? "es" : ""} older than 7 days`,
        undefined,
        { fixable: true, fix: "Run: openclaw openclaw-linear doctor --fix to clean up old entries" },
      ));
    }
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runDoctor(opts: DoctorOptions): Promise<DoctorReport> {
  const sections: CheckSection[] = [];

  // 1. Auth (also captures context for connectivity)
  const auth = await checkAuth(opts.pluginConfig);
  sections.push({ name: "Authentication & Tokens", checks: auth.checks });

  // 2. Agent config
  sections.push({ name: "Agent Configuration", checks: checkAgentConfig(opts.pluginConfig) });

  // 3. Coding tools
  sections.push({ name: "Coding Tools", checks: checkCodingTools() });

  // 4. Files & dirs
  sections.push({
    name: "Files & Directories",
    checks: await checkFilesAndDirs(opts.pluginConfig, opts.fix),
  });

  // 5. Connectivity (pass auth context to avoid double API call)
  sections.push({
    name: "Connectivity",
    checks: await checkConnectivity(opts.pluginConfig, auth.ctx),
  });

  // 6. Dispatch health
  sections.push({
    name: "Dispatch Health",
    checks: await checkDispatchHealth(opts.pluginConfig, opts.fix),
  });

  // Fix: chmod auth-profiles.json if needed
  if (opts.fix) {
    const permCheck = auth.checks.find((c) => c.fixable && c.label.includes("permissions"));
    if (permCheck) {
      try {
        chmodSync(AUTH_PROFILES_PATH, 0o600);
        permCheck.severity = "pass";
        permCheck.label = "auth-profiles.json permissions fixed to 600 (--fix)";
        permCheck.fixable = undefined;
      } catch { /* best effort */ }
    }
  }

  // Build summary
  let passed = 0, warnings = 0, errors = 0;
  for (const section of sections) {
    for (const check of section.checks) {
      switch (check.severity) {
        case "pass": passed++; break;
        case "warn": warnings++; break;
        case "fail": errors++; break;
      }
    }
  }

  return { sections, summary: { passed, warnings, errors } };
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function icon(severity: CheckSeverity): string {
  const isTTY = process.stdout?.isTTY;
  switch (severity) {
    case "pass": return isTTY ? "\x1b[32m✓\x1b[0m" : "✓";
    case "warn": return isTTY ? "\x1b[33m⚠\x1b[0m" : "⚠";
    case "fail": return isTTY ? "\x1b[31m✗\x1b[0m" : "✗";
  }
}

export function formatReport(report: DoctorReport): string {
  const lines: string[] = [];
  const bar = "═".repeat(40);

  lines.push("");
  lines.push("Linear Plugin Doctor");
  lines.push(bar);

  for (const section of report.sections) {
    lines.push("");
    lines.push(section.name);
    for (const check of section.checks) {
      lines.push(`  ${icon(check.severity)} ${check.label}`);
      if (check.fix && check.severity !== "pass") {
        lines.push(`    → ${check.fix}`);
      }
    }
  }

  lines.push("");
  lines.push(bar);

  const { passed, warnings, errors } = report.summary;
  const parts: string[] = [];
  parts.push(`${passed} passed`);
  if (warnings > 0) parts.push(`${warnings} warning${warnings > 1 ? "s" : ""}`);
  if (errors > 0) parts.push(`${errors} error${errors > 1 ? "s" : ""}`);
  lines.push(`Results: ${parts.join(", ")}`);
  lines.push("");

  return lines.join("\n");
}

export function formatReportJson(report: DoctorReport): string {
  return JSON.stringify(report, null, 2);
}
