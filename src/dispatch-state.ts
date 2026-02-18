/**
 * dispatch-state.ts — File-backed persistent dispatch state.
 *
 * Tracks active and completed dispatches across gateway restarts.
 * Uses file-level locking to prevent concurrent read-modify-write races.
 *
 * Pattern borrowed from DevClaw's projects.ts — atomic writes with
 * exclusive lock, stale lock detection, retry loop.
 */
import fs from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Tier = "junior" | "medior" | "senior";

export interface ActiveDispatch {
  issueId: string;
  issueIdentifier: string;
  worktreePath: string;
  branch: string;
  tier: Tier;
  model: string;
  status: "dispatched" | "running" | "failed";
  dispatchedAt: string;
  agentSessionId?: string;
  project?: string;
}

export interface CompletedDispatch {
  issueIdentifier: string;
  tier: Tier;
  status: "done" | "failed";
  completedAt: string;
  prUrl?: string;
  project?: string;
}

export interface DispatchState {
  dispatches: {
    active: Record<string, ActiveDispatch>;
    completed: Record<string, CompletedDispatch>;
  };
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_STATE_PATH = path.join(homedir(), ".openclaw", "linear-dispatch-state.json");

function resolveStatePath(configPath?: string): string {
  if (!configPath) return DEFAULT_STATE_PATH;
  if (configPath.startsWith("~/")) return configPath.replace("~", homedir());
  return configPath;
}

// ---------------------------------------------------------------------------
// File locking
// ---------------------------------------------------------------------------

const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 10_000;

function lockPath(statePath: string): string {
  return statePath + ".lock";
}

async function acquireLock(statePath: string): Promise<void> {
  const lock = lockPath(statePath);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      await fs.writeFile(lock, String(Date.now()), { flag: "wx" });
      return;
    } catch (err: any) {
      if (err.code !== "EEXIST") throw err;

      // Check for stale lock
      try {
        const content = await fs.readFile(lock, "utf-8");
        const lockTime = Number(content);
        if (Date.now() - lockTime > LOCK_STALE_MS) {
          try { await fs.unlink(lock); } catch { /* race */ }
          continue;
        }
      } catch { /* lock disappeared — retry */ }

      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }

  // Last resort: force remove potentially stale lock
  try { await fs.unlink(lockPath(statePath)); } catch { /* ignore */ }
  await fs.writeFile(lock, String(Date.now()), { flag: "wx" });
}

async function releaseLock(statePath: string): Promise<void> {
  try { await fs.unlink(lockPath(statePath)); } catch { /* already removed */ }
}

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

function emptyState(): DispatchState {
  return { dispatches: { active: {}, completed: {} } };
}

export async function readDispatchState(configPath?: string): Promise<DispatchState> {
  const filePath = resolveStatePath(configPath);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as DispatchState;
  } catch (err: any) {
    if (err.code === "ENOENT") return emptyState();
    throw err;
  }
}

async function writeDispatchState(filePath: string, data: DispatchState): Promise<void> {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = filePath + ".tmp";
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  await fs.rename(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// Operations (all use file locking)
// ---------------------------------------------------------------------------

export async function registerDispatch(
  issueIdentifier: string,
  dispatch: ActiveDispatch,
  configPath?: string,
): Promise<void> {
  const filePath = resolveStatePath(configPath);
  await acquireLock(filePath);
  try {
    const data = await readDispatchState(configPath);
    data.dispatches.active[issueIdentifier] = dispatch;
    await writeDispatchState(filePath, data);
  } finally {
    await releaseLock(filePath);
  }
}

export async function completeDispatch(
  issueIdentifier: string,
  result: Omit<CompletedDispatch, "issueIdentifier">,
  configPath?: string,
): Promise<void> {
  const filePath = resolveStatePath(configPath);
  await acquireLock(filePath);
  try {
    const data = await readDispatchState(configPath);
    const active = data.dispatches.active[issueIdentifier];
    delete data.dispatches.active[issueIdentifier];
    data.dispatches.completed[issueIdentifier] = {
      issueIdentifier,
      tier: active?.tier ?? result.tier,
      status: result.status,
      completedAt: result.completedAt,
      prUrl: result.prUrl,
      project: active?.project ?? result.project,
    };
    await writeDispatchState(filePath, data);
  } finally {
    await releaseLock(filePath);
  }
}

export async function updateDispatchStatus(
  issueIdentifier: string,
  status: ActiveDispatch["status"],
  configPath?: string,
): Promise<void> {
  const filePath = resolveStatePath(configPath);
  await acquireLock(filePath);
  try {
    const data = await readDispatchState(configPath);
    const dispatch = data.dispatches.active[issueIdentifier];
    if (dispatch) {
      dispatch.status = status;
      await writeDispatchState(filePath, data);
    }
  } finally {
    await releaseLock(filePath);
  }
}

export function getActiveDispatch(
  state: DispatchState,
  issueIdentifier: string,
): ActiveDispatch | null {
  return state.dispatches.active[issueIdentifier] ?? null;
}

export function listActiveDispatches(state: DispatchState): ActiveDispatch[] {
  return Object.values(state.dispatches.active);
}

export function listStaleDispatches(
  state: DispatchState,
  maxAgeMs: number,
): ActiveDispatch[] {
  const now = Date.now();
  return Object.values(state.dispatches.active).filter((d) => {
    const age = now - new Date(d.dispatchedAt).getTime();
    return age > maxAgeMs;
  });
}

/**
 * Remove completed dispatches older than maxAgeMs.
 * Returns the number of entries pruned.
 */
export async function pruneCompleted(
  maxAgeMs: number,
  configPath?: string,
): Promise<number> {
  const filePath = resolveStatePath(configPath);
  await acquireLock(filePath);
  try {
    const data = await readDispatchState(configPath);
    const now = Date.now();
    let pruned = 0;
    for (const [key, entry] of Object.entries(data.dispatches.completed)) {
      const age = now - new Date(entry.completedAt).getTime();
      if (age > maxAgeMs) {
        delete data.dispatches.completed[key];
        pruned++;
      }
    }
    if (pruned > 0) await writeDispatchState(filePath, data);
    return pruned;
  } finally {
    await releaseLock(filePath);
  }
}

/**
 * Remove an active dispatch (e.g. when worktree is gone and branch is gone).
 */
export async function removeActiveDispatch(
  issueIdentifier: string,
  configPath?: string,
): Promise<void> {
  const filePath = resolveStatePath(configPath);
  await acquireLock(filePath);
  try {
    const data = await readDispatchState(configPath);
    delete data.dispatches.active[issueIdentifier];
    await writeDispatchState(filePath, data);
  } finally {
    await releaseLock(filePath);
  }
}
