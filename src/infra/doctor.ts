/**
 * doctor.ts — Comprehensive health checks for the Linear plugin.
 *
 * Usage: openclaw openclaw-linear doctor [--fix] [--json]
 */
import { existsSync, readFileSync, statSync, accessSync, unlinkSync, chmodSync, constants } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";

import { resolveLinearToken, LinearAgentApi, AUTH_PROFILES_PATH, LINEAR_GRAPHQL_URL } from "../api/linear-api.js";
import { readDispatchState, listActiveDispatches, listStaleDispatches, pruneCompleted, type DispatchState } from "../pipeline/dispatch-state.js";
import { loadPrompts, clearPromptCache } from "../pipeline/pipeline.js";
import { listWorktrees } from "./codex-worktree.js";
import { loadCodingConfig, resolveCodingBackend, type CodingBackend } from "../tools/code-tool.js";
import { getWebhookStatus, provisionWebhook, REQUIRED_RESOURCE_TYPES } from "./webhook-provision.js";
import { createAgentProfilesFile } from "./shared-profiles.js";

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
const DEFAULT_BIN_DIR = join(process.env.HOME ?? homedir(), ".npm-global", "bin");

function resolveCliBins(pluginConfig?: Record<string, unknown>): [string, string][] {
  return [
    ["codex", (pluginConfig?.codexBin as string) ?? join(DEFAULT_BIN_DIR, "codex")],
    ["claude", (pluginConfig?.claudeBin as string) ?? join(DEFAULT_BIN_DIR, "claude")],
    ["gemini", (pluginConfig?.geminiBin as string) ?? join(DEFAULT_BIN_DIR, "gemini")],
  ];
}
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
  return (pluginConfig?.codexBaseRepo as string) ?? join(process.env.HOME ?? homedir(), "ai-workspace");
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

export function checkAgentConfig(pluginConfig?: Record<string, unknown>, fix = false): CheckResult[] {
  const checks: CheckResult[] = [];

  // Load profiles
  let profiles: Record<string, AgentProfile>;
  try {
    if (!existsSync(AGENT_PROFILES_PATH)) {
      if (fix) {
        try {
          createAgentProfilesFile({
            agentId: "my-agent",
            label: "My Agent",
            mentionAliases: ["my-agent"],
          });
          checks.push(pass('agent-profiles.json created with default "my-agent" profile (--fix)'));
          checks.push(warn(
            'Customize your agent profile',
            undefined,
            { fix: `Edit ${AGENT_PROFILES_PATH} to set your agent's name and aliases, or run: openclaw openclaw-linear setup` },
          ));
          // Reload after creation
          const raw = readFileSync(AGENT_PROFILES_PATH, "utf8");
          profiles = JSON.parse(raw).agents ?? {};
          // Continue to remaining checks below
        } catch (err) {
          checks.push(fail(
            "Failed to create agent-profiles.json",
            err instanceof Error ? err.message : String(err),
            "Run: openclaw openclaw-linear setup",
          ));
          return checks;
        }
      } else {
        checks.push(fail(
          "agent-profiles.json not found",
          `Expected at: ${AGENT_PROFILES_PATH}`,
          "Run: openclaw openclaw-linear setup",
        ));
        return checks;
      }
    } else {
      const raw = readFileSync(AGENT_PROFILES_PATH, "utf8");
      const parsed = JSON.parse(raw);
      profiles = parsed.agents ?? {};
    }
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

export function checkCodingTools(pluginConfig?: Record<string, unknown>): CheckResult[] {
  const checks: CheckResult[] = [];

  // Load config
  const config = loadCodingConfig();
  const hasConfig = !!config.codingTool || !!config.backends;
  if (hasConfig) {
    checks.push(pass(`coding-tools.json loaded (default: ${config.codingTool ?? "codex"})`));
  } else {
    checks.push(warn("coding-tools.json not found or empty (using defaults)", undefined, { fix: "Create coding-tools.json in the plugin root — see README for format" }));
  }

  // Validate default backend
  const defaultBackend = config.codingTool ?? "codex";
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
  const cliBins = resolveCliBins(pluginConfig);
  for (const [name, bin] of cliBins) {
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
// Section 7: Webhook Configuration
// ---------------------------------------------------------------------------

export async function checkWebhooks(pluginConfig?: Record<string, unknown>, fix = false): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];

  const tokenInfo = resolveLinearToken(pluginConfig);
  if (!tokenInfo.accessToken) {
    checks.push(warn("Webhook check skipped (no Linear token)"));
    return checks;
  }

  const linearApi = new LinearAgentApi(tokenInfo.accessToken, {
    refreshToken: tokenInfo.refreshToken,
    expiresAt: tokenInfo.expiresAt,
  });

  const webhookUrl = (pluginConfig?.webhookUrl as string)
    ?? "https://linear.calltelemetry.com/linear/webhook";

  try {
    const status = await getWebhookStatus(linearApi, webhookUrl);

    if (!status) {
      if (fix) {
        const result = await provisionWebhook(linearApi, webhookUrl, { allPublicTeams: true });
        checks.push(pass(`Workspace webhook created (${result.webhookId}) (--fix)`));
      } else {
        checks.push(fail(
          `No workspace webhook found for ${webhookUrl}`,
          undefined,
          'Run: openclaw openclaw-linear webhooks setup',
        ));
      }
      return checks;
    }

    if (status.issues.length === 0) {
      checks.push(pass(`Workspace webhook OK (${[...REQUIRED_RESOURCE_TYPES].join(", ")})`));
    } else {
      if (fix) {
        const result = await provisionWebhook(linearApi, webhookUrl);
        const changes = result.changes?.join(", ") ?? "fixed";
        checks.push(pass(`Workspace webhook fixed: ${changes} (--fix)`));
      } else {
        for (const issue of status.issues) {
          checks.push(warn(
            `Webhook issue: ${issue}`,
            undefined,
            { fixable: true, fix: 'Run: openclaw openclaw-linear webhooks setup' },
          ));
        }
      }
    }
  } catch (err) {
    checks.push(warn(`Webhook check failed: ${err instanceof Error ? err.message : String(err)}`));
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
  sections.push({ name: "Agent Configuration", checks: checkAgentConfig(opts.pluginConfig, opts.fix) });

  // 3. Coding tools
  sections.push({ name: "Coding Tools", checks: checkCodingTools(opts.pluginConfig) });

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

  // 7. Webhook configuration (auto-fix if --fix)
  sections.push({
    name: "Webhook Configuration",
    checks: await checkWebhooks(opts.pluginConfig, opts.fix),
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

  return { sections, summary: buildSummary(sections) };
}

// ---------------------------------------------------------------------------
// Code Run Deep Checks
// ---------------------------------------------------------------------------

interface BackendSpec {
  id: CodingBackend;
  label: string;
  bin: string;
  /** CLI args for a minimal live invocation test */
  testArgs: string[];
  /** Environment variable names that provide an API key */
  envKeys: string[];
  /** Plugin config key for API key (if any) */
  configKey?: string;
  /** Env vars to unset before spawning (e.g. CLAUDECODE) */
  unsetEnv?: string[];
}

function resolveBackendSpecs(pluginConfig?: Record<string, unknown>): BackendSpec[] {
  const binDir = join(process.env.HOME ?? homedir(), ".npm-global", "bin");
  return [
    {
      id: "claude",
      label: "Claude Code (Anthropic)",
      bin: (pluginConfig?.claudeBin as string) ?? join(binDir, "claude"),
      testArgs: ["--print", "-p", "Respond with the single word hello", "--output-format", "stream-json", "--max-turns", "1", "--dangerously-skip-permissions"],
      envKeys: ["ANTHROPIC_API_KEY"],
      configKey: "claudeApiKey",
      unsetEnv: ["CLAUDECODE"],
    },
    {
      id: "codex",
      label: "Codex (OpenAI)",
      bin: (pluginConfig?.codexBin as string) ?? join(binDir, "codex"),
      testArgs: ["exec", "--json", "--ephemeral", "--full-auto", "echo hello"],
      envKeys: ["OPENAI_API_KEY"],
    },
    {
      id: "gemini",
      label: "Gemini CLI (Google)",
      bin: (pluginConfig?.geminiBin as string) ?? join(binDir, "gemini"),
      testArgs: ["-p", "Respond with the single word hello", "-o", "stream-json", "--yolo"],
      envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY"],
    },
  ];
}

function checkBackendBinary(spec: BackendSpec): { installed: boolean; checks: CheckResult[] } {
  const checks: CheckResult[] = [];

  // Binary existence
  try {
    accessSync(spec.bin, constants.X_OK);
  } catch {
    checks.push(fail(
      `Binary: not found at ${spec.bin}`,
      undefined,
      `Install ${spec.id}: npm install -g <package>`,
    ));
    return { installed: false, checks };
  }

  // Version check
  try {
    const env = { ...process.env } as Record<string, string | undefined>;
    for (const key of spec.unsetEnv ?? []) delete env[key];
    const raw = execFileSync(spec.bin, ["--version"], {
      encoding: "utf8",
      timeout: 15_000,
      env: env as NodeJS.ProcessEnv,
    }).trim();
    checks.push(pass(`Binary: ${raw || "installed"} (${spec.bin})`));
  } catch {
    checks.push(pass(`Binary: installed (${spec.bin})`));
  }

  return { installed: true, checks };
}

function checkBackendApiKey(spec: BackendSpec, pluginConfig?: Record<string, unknown>): CheckResult {
  // Check plugin config first
  if (spec.configKey) {
    const configVal = pluginConfig?.[spec.configKey];
    if (typeof configVal === "string" && configVal) {
      return pass(`API key: configured (${spec.configKey} in plugin config)`);
    }
  }

  // Check env vars
  for (const envKey of spec.envKeys) {
    if (process.env[envKey]) {
      return pass(`API key: configured (${envKey})`);
    }
  }

  return warn(
    `API key: not found`,
    `Checked: ${spec.envKeys.join(", ")}${spec.configKey ? `, pluginConfig.${spec.configKey}` : ""}`,
    { fix: `Set ${spec.envKeys[0]} environment variable or configure in plugin config` },
  );
}

function checkBackendLive(spec: BackendSpec, pluginConfig?: Record<string, unknown>): CheckResult {
  const env = { ...process.env } as Record<string, string | undefined>;
  for (const key of spec.unsetEnv ?? []) delete env[key];

  // Pass API key from plugin config if available (Claude-specific)
  if (spec.configKey) {
    const configVal = pluginConfig?.[spec.configKey] as string | undefined;
    if (configVal && spec.envKeys[0]) {
      env[spec.envKeys[0]] = configVal;
    }
  }

  const start = Date.now();
  try {
    const result = spawnSync(spec.bin, spec.testArgs, {
      encoding: "utf8",
      timeout: 30_000,
      env: env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    if (result.error) {
      const msg = result.error.message ?? String(result.error);
      if (msg.includes("ETIMEDOUT") || msg.includes("timed out")) {
        return warn(`Live test: timed out after 30s`);
      }
      return warn(`Live test: spawn error — ${msg.slice(0, 200)}`);
    }

    if (result.status === 0) {
      return pass(`Live test: responded in ${elapsed}s`);
    }

    // Non-zero exit
    const stderr = (result.stderr ?? "").trim().slice(0, 200);
    const stdout = (result.stdout ?? "").trim().slice(0, 200);
    const detail = stderr || stdout || "(no output)";
    return warn(`Live test: exit code ${result.status} (${elapsed}s) — ${detail}`);
  } catch (err) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    return warn(`Live test: error (${elapsed}s) — ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
  }
}

/**
 * Deep health checks for coding tool backends.
 *
 * Verifies binary installation, API key configuration, and live callability
 * for each backend (Claude, Codex, Gemini). Also shows agent routing.
 *
 * Usage: openclaw openclaw-linear code-run doctor [--json]
 */
export async function checkCodeRunDeep(
  pluginConfig?: Record<string, unknown>,
): Promise<CheckSection[]> {
  const sections: CheckSection[] = [];
  const config = loadCodingConfig();
  let callableCount = 0;
  const backendSpecs = resolveBackendSpecs(pluginConfig);

  for (const spec of backendSpecs) {
    const checks: CheckResult[] = [];

    // 1. Binary check
    const { installed, checks: binChecks } = checkBackendBinary(spec);
    checks.push(...binChecks);

    if (installed) {
      // 2. API key check
      checks.push(checkBackendApiKey(spec, pluginConfig));

      // 3. Live invocation test
      const liveResult = checkBackendLive(spec, pluginConfig);
      checks.push(liveResult);

      if (liveResult.severity === "pass") callableCount++;
    }

    sections.push({ name: `Code Run: ${spec.label}`, checks });
  }

  // Routing summary section
  const routingChecks: CheckResult[] = [];
  const defaultBackend = resolveCodingBackend(config);
  routingChecks.push(pass(`Default backend: ${defaultBackend}`));

  const profiles = loadAgentProfiles();
  for (const [agentId, profile] of Object.entries(profiles)) {
    const resolved = resolveCodingBackend(config, agentId);
    const isOverride = config.agentCodingTools?.[agentId] != null;
    const label = profile.label ?? agentId;
    routingChecks.push(pass(
      `${label} → ${resolved}${isOverride ? " (override)" : " (default)"}`,
    ));
  }

  routingChecks.push(pass(`Callable backends: ${callableCount}/${backendSpecs.length}`));
  sections.push({ name: "Code Run: Routing", checks: routingChecks });

  return sections;
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

/** Build a summary by counting pass/warn/fail across sections. */
export function buildSummary(sections: CheckSection[]): { passed: number; warnings: number; errors: number } {
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
  return { passed, warnings, errors };
}
