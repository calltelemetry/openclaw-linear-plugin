import { execFileSync } from "node:child_process";
import { existsSync, statSync, readdirSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ensureGitignore } from "../pipeline/artifacts.js";

const DEFAULT_BASE_REPO = "/home/claw/ai-workspace";
const DEFAULT_WORKTREE_BASE_DIR = path.join(homedir(), ".openclaw", "worktrees");

export interface WorktreeInfo {
  path: string;
  branch: string;
  /** True if the worktree already existed and was resumed, not freshly created. */
  resumed: boolean;
}

export interface WorktreeStatus {
  filesChanged: string[];
  hasUncommitted: boolean;
  lastCommit: string | null;
}

export interface WorktreeOptions {
  /** Base git repo to create worktrees from. Default: /home/claw/ai-workspace */
  baseRepo?: string;
  /** Directory under which worktrees are created. Default: ~/.openclaw/worktrees */
  baseDir?: string;
}

function resolveBaseDir(baseDir?: string): string {
  if (!baseDir) return DEFAULT_WORKTREE_BASE_DIR;
  if (baseDir.startsWith("~/")) return baseDir.replace("~", homedir());
  return baseDir;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
  }).trim();
}

function gitLong(args: string[], cwd: string, timeout = 120_000): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout,
  }).trim();
}

/**
 * Create a git worktree for isolated work on a Linear issue.
 *
 * Path: {baseDir}/{issueIdentifier}/ — deterministic, persistent.
 * Branch: codex/{issueIdentifier}
 *
 * Idempotent: if the worktree already exists, returns it without recreating.
 * If the branch exists but the worktree is gone, recreates the worktree from
 * the existing branch (resume scenario).
 */
export function createWorktree(
  issueIdentifier: string,
  opts?: WorktreeOptions,
): WorktreeInfo {
  const repo = opts?.baseRepo ?? DEFAULT_BASE_REPO;
  const baseDir = resolveBaseDir(opts?.baseDir);

  if (!existsSync(repo)) {
    throw new Error(`Base repo not found: ${repo}`);
  }

  // Ensure base directory exists
  if (!existsSync(baseDir)) {
    mkdirSync(baseDir, { recursive: true });
  }

  const branch = `codex/${issueIdentifier}`;
  const worktreePath = path.join(baseDir, issueIdentifier);

  // Fetch latest from origin (best effort) — do this early so both
  // resume and fresh paths have up-to-date refs.
  try {
    git(["fetch", "origin"], repo);
  } catch {
    // Offline or no remote — continue with local state
  }

  // Idempotent: if worktree already exists, return it
  if (existsSync(worktreePath)) {
    try {
      // Verify it's a valid git worktree
      git(["rev-parse", "--git-dir"], worktreePath);
      ensureGitignore(worktreePath);
      return { path: worktreePath, branch, resumed: true };
    } catch {
      // Directory exists but isn't a valid worktree — remove and recreate
      try {
        git(["worktree", "remove", "--force", worktreePath], repo);
      } catch { /* best effort */ }
    }
  }

  // Check if branch already exists (resume scenario)
  const branchExists = branchExistsInRepo(branch, repo);

  if (branchExists) {
    // Recreate worktree from existing branch — preserves previous work
    git(["worktree", "add", worktreePath, branch], repo);
    ensureGitignore(worktreePath);
    return { path: worktreePath, branch, resumed: true };
  }

  // Fresh start: new branch off HEAD
  git(["worktree", "add", "-b", branch, worktreePath], repo);
  ensureGitignore(worktreePath);
  return { path: worktreePath, branch, resumed: false };
}

/**
 * Check if a branch exists in the repo.
 */
function branchExistsInRepo(branch: string, repo: string): boolean {
  try {
    const result = git(["branch", "--list", branch], repo);
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Get the status of a worktree: changed files, uncommitted work, last commit.
 */
export function getWorktreeStatus(worktreePath: string): WorktreeStatus {
  if (!existsSync(worktreePath)) {
    return { filesChanged: [], hasUncommitted: false, lastCommit: null };
  }

  const diffOutput = git(
    ["diff", "--name-only", "HEAD"],
    worktreePath,
  );
  const stagedOutput = git(
    ["diff", "--name-only", "--cached"],
    worktreePath,
  );
  const untrackedOutput = git(
    ["ls-files", "--others", "--exclude-standard"],
    worktreePath,
  );

  const allFiles = new Set<string>();
  for (const line of [...diffOutput.split("\n"), ...stagedOutput.split("\n"), ...untrackedOutput.split("\n")]) {
    const trimmed = line.trim();
    if (trimmed) allFiles.add(trimmed);
  }

  const hasUncommitted = allFiles.size > 0;

  let lastCommit: string | null = null;
  try {
    lastCommit = git(["log", "-1", "--oneline"], worktreePath);
  } catch {
    // No commits yet
  }

  return {
    filesChanged: [...allFiles],
    hasUncommitted,
    lastCommit,
  };
}

/**
 * Remove a worktree and optionally delete its branch.
 */
export function removeWorktree(
  worktreePath: string,
  opts?: { deleteBranch?: boolean; baseRepo?: string },
): void {
  const repo = opts?.baseRepo ?? DEFAULT_BASE_REPO;

  if (existsSync(worktreePath)) {
    git(["worktree", "remove", "--force", worktreePath], repo);
  }

  if (opts?.deleteBranch) {
    // Extract issue identifier from worktree path to find matching branch
    const dirName = path.basename(worktreePath);
    const branch = `codex/${dirName}`;
    try {
      git(["branch", "-D", branch], repo);
    } catch {
      // Branch doesn't exist or already deleted
    }
  }
}

/**
 * Push the worktree branch and create a GitHub PR via `gh`.
 */
export function createPullRequest(
  worktreePath: string,
  title: string,
  body: string,
): { prUrl: string } {
  // Commit any uncommitted changes first
  const status = getWorktreeStatus(worktreePath);
  if (status.hasUncommitted) {
    git(["add", "-A"], worktreePath);
    git(
      [
        "-c", "user.name=claw",
        "-c", "user.email=claw@calltelemetry.com",
        "commit", "-m", title,
      ],
      worktreePath,
    );
  }

  // Get branch name
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath);

  // Push branch
  git(["push", "-u", "origin", branch], worktreePath);

  // Create PR via gh CLI
  const prUrl = execFileSync(
    "gh",
    ["pr", "create", "--title", title, "--body", body, "--head", branch],
    { cwd: worktreePath, encoding: "utf8", timeout: 30_000 },
  ).trim();

  return { prUrl };
}

export interface WorktreeEntry {
  path: string;
  branch: string;
  issueIdentifier: string;
  ageMs: number;
  hasChanges: boolean;
}

/**
 * List all worktrees in the configured base directory.
 */
export function listWorktrees(opts?: WorktreeOptions): WorktreeEntry[] {
  const baseDir = resolveBaseDir(opts?.baseDir);
  const entries: WorktreeEntry[] = [];

  if (!existsSync(baseDir)) return [];

  let dirs: string[];
  try {
    dirs = readdirSync(baseDir).map((d) => path.join(baseDir, d));
  } catch {
    return [];
  }

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      const stat = statSync(dir);
      if (!stat.isDirectory()) continue;

      // Verify it's a git worktree
      try {
        git(["rev-parse", "--git-dir"], dir);
      } catch {
        continue; // Not a git worktree
      }

      let branch = "unknown";
      try {
        branch = git(["rev-parse", "--abbrev-ref", "HEAD"], dir);
      } catch {}

      let hasChanges = false;
      try {
        const status = getWorktreeStatus(dir);
        hasChanges = status.hasUncommitted;
      } catch {}

      entries.push({
        path: dir,
        branch,
        issueIdentifier: path.basename(dir),
        ageMs: Date.now() - stat.mtimeMs,
        hasChanges,
      });
    } catch {
      // Skip unreadable dirs
    }
  }

  return entries.sort((a, b) => b.ageMs - a.ageMs);
}

export interface PrepareResult {
  pulled: boolean;
  pullOutput?: string;
  submodulesInitialized: boolean;
  submoduleOutput?: string;
  errors: string[];
}

/**
 * Prepare a worktree for a code run:
 *   1. Pull latest from origin for the issue branch (fast-forward only)
 *   2. Initialize and update all git submodules recursively
 *
 * Safe to call on every run — idempotent. Failures are non-fatal;
 * the code run proceeds even if pull or submodule init fails.
 */
export function prepareWorkspace(worktreePath: string, branch: string): PrepareResult {
  const errors: string[] = [];
  let pulled = false;
  let pullOutput: string | undefined;
  let submodulesInitialized = false;
  let submoduleOutput: string | undefined;

  // 1. Pull latest from origin (ff-only to avoid merge conflicts)
  try {
    // Check if remote branch exists before pulling
    const remoteBranch = `origin/${branch}`;
    try {
      git(["rev-parse", "--verify", remoteBranch], worktreePath);
      // Remote branch exists — pull latest
      pullOutput = git(["pull", "--ff-only", "origin", branch], worktreePath);
      pulled = true;
    } catch {
      // Remote branch doesn't exist yet (fresh issue branch) — nothing to pull
      pullOutput = "remote branch not found, skipping pull";
    }
  } catch (err) {
    const msg = `pull failed: ${err}`;
    errors.push(msg);
    pullOutput = msg;
  }

  // 2. Initialize and update all submodules recursively
  try {
    submoduleOutput = gitLong(
      ["submodule", "update", "--init", "--recursive"],
      worktreePath,
      120_000, // submodule clone can take a while
    );
    submodulesInitialized = true;
  } catch (err) {
    const msg = `submodule init failed: ${err}`;
    errors.push(msg);
    submoduleOutput = msg;
  }

  return { pulled, pullOutput, submodulesInitialized, submoduleOutput, errors };
}

/**
 * Remove worktrees older than maxAgeMs.
 * Returns list of removed paths.
 */
export function pruneStaleWorktrees(
  maxAgeMs: number = 24 * 60 * 60_000,
  opts?: WorktreeOptions & { dryRun?: boolean },
): { removed: string[]; skipped: string[]; errors: string[] } {
  const worktrees = listWorktrees(opts);
  const repo = opts?.baseRepo ?? DEFAULT_BASE_REPO;
  const removed: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  for (const wt of worktrees) {
    if (wt.ageMs < maxAgeMs) {
      skipped.push(wt.path);
      continue;
    }

    if (opts?.dryRun) {
      removed.push(wt.path);
      continue;
    }

    try {
      removeWorktree(wt.path, { deleteBranch: true, baseRepo: repo });
      removed.push(wt.path);
    } catch (err) {
      errors.push(`${wt.path}: ${err}`);
    }
  }

  return { removed, skipped, errors };
}
