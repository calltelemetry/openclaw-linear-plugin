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
/** Valid CAS transitions: from → allowed next states */
const VALID_TRANSITIONS = {
    dispatched: ["working", "failed", "stuck"],
    working: ["auditing", "failed", "stuck"],
    auditing: ["done", "working", "stuck"], // working = rework (attempt++)
    done: [], // terminal
    failed: [], // terminal
    stuck: [], // terminal
};
// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------
const DEFAULT_STATE_PATH = path.join(homedir(), ".openclaw", "linear-dispatch-state.json");
const MAX_PROCESSED_EVENTS = 200; // Keep last N events for dedup
function resolveStatePath(configPath) {
    if (!configPath)
        return DEFAULT_STATE_PATH;
    if (configPath.startsWith("~/"))
        return configPath.replace("~", homedir());
    return configPath;
}
// ---------------------------------------------------------------------------
// File locking (shared utility)
// ---------------------------------------------------------------------------
import { acquireLock, releaseLock } from "../infra/file-lock.js";
// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------
function emptyState() {
    return {
        version: 2,
        dispatches: { active: {}, completed: {} },
        sessionMap: {},
        processedEvents: [],
    };
}
/** Migrate state from any known version to the current version (2). */
function migrateState(raw) {
    const version = raw?.version ?? 1;
    switch (version) {
        case 1: {
            // v1 → v2: add sessionMap, processedEvents, attempt defaults, status rename
            const state = raw;
            if (!state.sessionMap)
                state.sessionMap = {};
            if (!state.processedEvents)
                state.processedEvents = [];
            // Ensure all active dispatches have attempt field
            for (const d of Object.values(state.dispatches.active)) {
                if (d.attempt === undefined)
                    d.attempt = 0;
            }
            // Migrate old status "running" → "working"
            for (const d of Object.values(state.dispatches.active)) {
                if (d.status === "running")
                    d.status = "working";
            }
            state.version = 2;
            return state;
        }
        case 2:
            return raw;
        default:
            throw new Error(`Unknown dispatch state version: ${version}`);
    }
}
export async function readDispatchState(configPath) {
    const filePath = resolveStatePath(configPath);
    try {
        const raw = await fs.readFile(filePath, "utf-8");
        return migrateState(JSON.parse(raw));
    }
    catch (err) {
        if (err.code === "ENOENT")
            return emptyState();
        if (err instanceof SyntaxError) {
            // State file corrupted — log and recover
            console.error(`Dispatch state corrupted at ${filePath}: ${err.message}. Starting fresh.`);
            // Rename corrupted file for forensics
            try {
                await fs.rename(filePath, `${filePath}.corrupted.${Date.now()}`);
            }
            catch { /* best-effort */ }
            return emptyState();
        }
        throw err;
    }
}
async function writeDispatchState(filePath, data) {
    const dir = path.dirname(filePath);
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
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
    dispatchId;
    fromStatus;
    toStatus;
    actualStatus;
    constructor(dispatchId, fromStatus, toStatus, actualStatus) {
        super(`CAS transition failed for ${dispatchId}: ` +
            `expected ${fromStatus} → ${toStatus}, but current status is ${actualStatus}`);
        this.dispatchId = dispatchId;
        this.fromStatus = fromStatus;
        this.toStatus = toStatus;
        this.actualStatus = actualStatus;
        this.name = "TransitionError";
    }
}
/**
 * Atomic compare-and-swap status transition.
 * Rejects if current status doesn't match `fromStatus`.
 * Returns the updated dispatch.
 */
export async function transitionDispatch(issueIdentifier, fromStatus, toStatus, updates, configPath) {
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
            if (updates.workerSessionKey !== undefined)
                dispatch.workerSessionKey = updates.workerSessionKey;
            if (updates.auditSessionKey !== undefined)
                dispatch.auditSessionKey = updates.auditSessionKey;
            if (updates.stuckReason !== undefined)
                dispatch.stuckReason = updates.stuckReason;
            if (updates.attempt !== undefined)
                dispatch.attempt = updates.attempt;
        }
        await writeDispatchState(filePath, data);
        return dispatch;
    }
    finally {
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
export async function registerSessionMapping(sessionKey, mapping, configPath) {
    const filePath = resolveStatePath(configPath);
    await acquireLock(filePath);
    try {
        const data = await readDispatchState(configPath);
        data.sessionMap[sessionKey] = mapping;
        await writeDispatchState(filePath, data);
    }
    finally {
        await releaseLock(filePath);
    }
}
/**
 * Lookup a session key in the map.
 * Used by agent_end hook to identify dispatch context.
 */
export function lookupSessionMapping(state, sessionKey) {
    return state.sessionMap[sessionKey] ?? null;
}
/**
 * Remove a session mapping (cleanup after processing).
 */
export async function removeSessionMapping(sessionKey, configPath) {
    const filePath = resolveStatePath(configPath);
    await acquireLock(filePath);
    try {
        const data = await readDispatchState(configPath);
        delete data.sessionMap[sessionKey];
        await writeDispatchState(filePath, data);
    }
    finally {
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
export async function markEventProcessed(eventKey, configPath) {
    const filePath = resolveStatePath(configPath);
    await acquireLock(filePath);
    try {
        const data = await readDispatchState(configPath);
        if (data.processedEvents.includes(eventKey))
            return false;
        data.processedEvents.push(eventKey);
        await writeDispatchState(filePath, data);
        return true;
    }
    finally {
        await releaseLock(filePath);
    }
}
// ---------------------------------------------------------------------------
// Legacy-compatible operations (still used by existing code)
// ---------------------------------------------------------------------------
export async function registerDispatch(issueIdentifier, dispatch, configPath) {
    const filePath = resolveStatePath(configPath);
    await acquireLock(filePath);
    try {
        const data = await readDispatchState(configPath);
        // Ensure v2 fields have defaults
        if (dispatch.attempt === undefined)
            dispatch.attempt = 0;
        data.dispatches.active[issueIdentifier] = dispatch;
        await writeDispatchState(filePath, data);
    }
    finally {
        await releaseLock(filePath);
    }
}
export async function completeDispatch(issueIdentifier, result, configPath) {
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
            worktreePath: active?.worktreePath,
        };
        await writeDispatchState(filePath, data);
    }
    finally {
        await releaseLock(filePath);
    }
}
export async function updateDispatchStatus(issueIdentifier, status, configPath) {
    const filePath = resolveStatePath(configPath);
    await acquireLock(filePath);
    try {
        const data = await readDispatchState(configPath);
        const dispatch = data.dispatches.active[issueIdentifier];
        if (dispatch) {
            dispatch.status = status;
            await writeDispatchState(filePath, data);
        }
    }
    finally {
        await releaseLock(filePath);
    }
}
/**
 * Persist a new task-flow revision back to the active dispatch record so
 * subsequent bridge calls see the up-to-date `expectedRevision`. Best-effort:
 * silently no-ops when the dispatch is no longer active or has no flow id.
 */
export async function updateDispatchTaskFlowRevision(issueIdentifier, revision, configPath) {
    const filePath = resolveStatePath(configPath);
    await acquireLock(filePath);
    try {
        const data = await readDispatchState(configPath);
        const dispatch = data.dispatches.active[issueIdentifier];
        if (dispatch && dispatch.taskFlowId) {
            dispatch.taskFlowRevision = revision;
            await writeDispatchState(filePath, data);
        }
    }
    finally {
        await releaseLock(filePath);
    }
}
export function getActiveDispatch(state, issueIdentifier) {
    return state.dispatches.active[issueIdentifier] ?? null;
}
export function listActiveDispatches(state) {
    return Object.values(state.dispatches.active);
}
export function listStaleDispatches(state, maxAgeMs) {
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
export function listRecoverableDispatches(state) {
    return Object.values(state.dispatches.active).filter((d) => d.status === "working" && d.workerSessionKey && !d.auditSessionKey);
}
/**
 * Remove completed dispatches older than maxAgeMs.
 * Returns the number of entries pruned.
 */
export async function pruneCompleted(maxAgeMs, configPath) {
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
        if (pruned > 0)
            await writeDispatchState(filePath, data);
        return pruned;
    }
    finally {
        await releaseLock(filePath);
    }
}
/**
 * Garbage-collect completed dispatches older than maxAgeMs.
 * Convenience wrapper with a 7-day default.
 * Returns the count of pruned entries.
 */
export async function pruneCompletedDispatches(maxAgeMs = 7 * 24 * 60 * 60_000, configPath) {
    return pruneCompleted(maxAgeMs, configPath);
}
/**
 * Remove an active dispatch (e.g. when worktree is gone and branch is gone).
 */
export async function removeActiveDispatch(issueIdentifier, configPath) {
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
    }
    finally {
        await releaseLock(filePath);
    }
}
