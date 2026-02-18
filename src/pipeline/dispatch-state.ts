/**
 * dispatch-state.ts — File-backed persistent dispatch state (v2).
 *
 * Tracks active and completed dispatches across gateway restarts.
 * Uses file-level locking to prevent concurrent read-modify-write races.
 *
 * v2 additions:
 * - Atomic compare-and-swap (CAS) transitions
 * - Session-to-dispatch map for agent_end hook lookup
 * - Monotonic attempt counter for stale-event rejection
 * - "stuck" as terminal state with reason
 * - No separate "rework" state — rework is "working" with attempt > 0
 */
import fs from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Tier = "junior" | "medior" | "senior";

export type DispatchStatus =
  | "dispatched"
  | "working"
  | "auditing"
  | "done"
  | "failed"
  | "stuck";

/** Valid CAS transitions: from → allowed next states */
const VALID_TRANSITIONS: Record<DispatchStatus, DispatchStatus[]> = {
  dispatched: ["working", "failed", "stuck"],
  working: ["auditing", "failed", "stuck"],
  auditing: ["done", "working", "stuck"],  // working = rework (attempt++)
  done: [],                                 // terminal
  failed: [],                               // terminal
  stuck: [],                                // terminal
};

export interface ActiveDispatch {
  issueId: string;
  issueIdentifier: string;
  worktreePath: string;
  branch: string;
  tier: Tier;
  model: string;
  status: DispatchStatus;
  dispatchedAt: string;
  agentSessionId?: string;
  project?: string;

  // v2 fields
  attempt: number;              // monotonic: 0 on first run, increments on rework
  workerSessionKey?: string;    // session key for current worker sub-agent
  auditSessionKey?: string;     // session key for current audit sub-agent
  stuckReason?: string;         // only set when status === "stuck"
  issueTitle?: string;          // for artifact summaries and memory headings
}

export interface CompletedDispatch {
  issueIdentifier: string;
  tier: Tier;
  status: "done" | "failed";
  completedAt: string;
  prUrl?: string;
  project?: string;
  totalAttempts?: number;
}

/** Maps session keys to dispatch context for agent_end hook lookup */
export interface SessionMapping {
  dispatchId: string;   // issueIdentifier
  phase: "worker" | "audit";
  attempt: number;
}

export interface DispatchState {
  dispatches: {
    active: Record<string, ActiveDispatch>;
    completed: Record<string, CompletedDispatch>;
  };
  /** Session key → dispatch mapping for agent_end hook */
  sessionMap: Record<string, SessionMapping>;
  /** Set of processed event keys for idempotency */
  processedEvents: string[];
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_STATE_PATH = path.join(homedir(), ".openclaw", "linear-dispatch-state.json");
const MAX_PROCESSED_EVENTS = 200; // Keep last N events for dedup

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
  return {
    dispatches: { active: {}, completed: {} },
    sessionMap: {},
    processedEvents: [],
  };
}

/** Migrate v1 state (no sessionMap/processedEvents) to v2 */
function migrateState(raw: any): DispatchState {
  const state = raw as DispatchState;
  if (!state.sessionMap) state.sessionMap = {};
  if (!state.processedEvents) state.processedEvents = [];
  // Ensure all active dispatches have attempt field
  for (const d of Object.values(state.dispatches.active)) {
    if ((d as any).attempt === undefined) (d as any).attempt = 0;
  }
  // Migrate old status "running" → "working"
  for (const d of Object.values(state.dispatches.active)) {
    if ((d as any).status === "running") (d as any).status = "working";
  }
  return state;
}

export async function readDispatchState(configPath?: string): Promise<DispatchState> {
  const filePath = resolveStatePath(configPath);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return migrateState(JSON.parse(raw));
  } catch (err: any) {
    if (err.code === "ENOENT") return emptyState();
    throw err;
  }
}

async function writeDispatchState(filePath: string, data: DispatchState): Promise<void> {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Trim processedEvents to avoid unbounded growth
  if (data.processedEvents.length > MAX_PROCESSED_EVENTS) {
    data.processedEvents = data.processedEvents.slice(-MAX_PROCESSED_EVENTS);
  }
  const tmpPath = filePath + ".tmp";
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  await fs.rename(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// Atomic transitions (CAS)
// ---------------------------------------------------------------------------

export class TransitionError extends Error {
  constructor(
    public dispatchId: string,
    public fromStatus: DispatchStatus,
    public toStatus: DispatchStatus,
    public actualStatus: DispatchStatus,
  ) {
    super(
      `CAS transition failed for ${dispatchId}: ` +
      `expected ${fromStatus} → ${toStatus}, but current status is ${actualStatus}`,
    );
    this.name = "TransitionError";
  }
}

/**
 * Atomic compare-and-swap status transition.
 * Rejects if current status doesn't match `fromStatus`.
 * Returns the updated dispatch.
 */
export async function transitionDispatch(
  issueIdentifier: string,
  fromStatus: DispatchStatus,
  toStatus: DispatchStatus,
  updates?: Partial<Pick<ActiveDispatch, "workerSessionKey" | "auditSessionKey" | "stuckReason" | "attempt">>,
  configPath?: string,
): Promise<ActiveDispatch> {
  const filePath = resolveStatePath(configPath);
  await acquireLock(filePath);
  try {
    const data = await readDispatchState(configPath);
    const dispatch = data.dispatches.active[issueIdentifier];
    if (!dispatch) {
      throw new Error(`No active dispatch for ${issueIdentifier}`);
    }
    if (dispatch.status !== fromStatus) {
      throw new TransitionError(issueIdentifier, fromStatus, toStatus, dispatch.status);
    }
    const allowed = VALID_TRANSITIONS[fromStatus];
    if (!allowed.includes(toStatus)) {
      throw new Error(`Invalid transition: ${fromStatus} → ${toStatus}`);
    }

    dispatch.status = toStatus;
    if (updates) {
      if (updates.workerSessionKey !== undefined) dispatch.workerSessionKey = updates.workerSessionKey;
      if (updates.auditSessionKey !== undefined) dispatch.auditSessionKey = updates.auditSessionKey;
      if (updates.stuckReason !== undefined) dispatch.stuckReason = updates.stuckReason;
      if (updates.attempt !== undefined) dispatch.attempt = updates.attempt;
    }

    await writeDispatchState(filePath, data);
    return dispatch;
  } finally {
    await releaseLock(filePath);
  }
}

// ---------------------------------------------------------------------------
// Session map operations
// ---------------------------------------------------------------------------

/**
 * Register a session key → dispatch mapping.
 * Called when spawning a worker or audit sub-agent.
 */
export async function registerSessionMapping(
  sessionKey: string,
  mapping: SessionMapping,
  configPath?: string,
): Promise<void> {
  const filePath = resolveStatePath(configPath);
  await acquireLock(filePath);
  try {
    const data = await readDispatchState(configPath);
    data.sessionMap[sessionKey] = mapping;
    await writeDispatchState(filePath, data);
  } finally {
    await releaseLock(filePath);
  }
}

/**
 * Lookup a session key in the map.
 * Used by agent_end hook to identify dispatch context.
 */
export function lookupSessionMapping(
  state: DispatchState,
  sessionKey: string,
): SessionMapping | null {
  return state.sessionMap[sessionKey] ?? null;
}

/**
 * Remove a session mapping (cleanup after processing).
 */
export async function removeSessionMapping(
  sessionKey: string,
  configPath?: string,
): Promise<void> {
  const filePath = resolveStatePath(configPath);
  await acquireLock(filePath);
  try {
    const data = await readDispatchState(configPath);
    delete data.sessionMap[sessionKey];
    await writeDispatchState(filePath, data);
  } finally {
    await releaseLock(filePath);
  }
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/**
 * Check if an event has already been processed. If not, mark it.
 * Returns true if the event is NEW (should be processed).
 * Returns false if it's a duplicate (skip).
 */
export async function markEventProcessed(
  eventKey: string,
  configPath?: string,
): Promise<boolean> {
  const filePath = resolveStatePath(configPath);
  await acquireLock(filePath);
  try {
    const data = await readDispatchState(configPath);
    if (data.processedEvents.includes(eventKey)) return false;
    data.processedEvents.push(eventKey);
    await writeDispatchState(filePath, data);
    return true;
  } finally {
    await releaseLock(filePath);
  }
}

// ---------------------------------------------------------------------------
// Legacy-compatible operations (still used by existing code)
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
    // Ensure v2 fields have defaults
    if (dispatch.attempt === undefined) dispatch.attempt = 0;
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
    // Clean up session mappings for this dispatch
    for (const [key, mapping] of Object.entries(data.sessionMap)) {
      if (mapping.dispatchId === issueIdentifier) {
        delete data.sessionMap[key];
      }
    }
    delete data.dispatches.active[issueIdentifier];
    data.dispatches.completed[issueIdentifier] = {
      issueIdentifier,
      tier: active?.tier ?? result.tier,
      status: result.status,
      completedAt: result.completedAt,
      prUrl: result.prUrl,
      project: active?.project ?? result.project,
      totalAttempts: active?.attempt ?? 0,
    };
    await writeDispatchState(filePath, data);
  } finally {
    await releaseLock(filePath);
  }
}

export async function updateDispatchStatus(
  issueIdentifier: string,
  status: DispatchStatus,
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
 * Find dispatches that need recovery after restart:
 * - Status "working" with a workerSessionKey but no auditSessionKey
 *   (worker completed but audit wasn't triggered before crash)
 */
export function listRecoverableDispatches(state: DispatchState): ActiveDispatch[] {
  return Object.values(state.dispatches.active).filter((d) =>
    d.status === "working" && d.workerSessionKey && !d.auditSessionKey,
  );
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
    // Clean up session mappings for this dispatch
    for (const [key, mapping] of Object.entries(data.sessionMap)) {
      if (mapping.dispatchId === issueIdentifier) {
        delete data.sessionMap[key];
      }
    }
    delete data.dispatches.active[issueIdentifier];
    await writeDispatchState(filePath, data);
  } finally {
    await releaseLock(filePath);
  }
}
