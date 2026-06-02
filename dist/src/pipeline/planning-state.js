/**
 * planning-state.ts — File-backed persistent planning session state.
 *
 * Tracks active planning sessions across gateway restarts.
 * Uses file-level locking to prevent concurrent read-modify-write races.
 * Mirrors the dispatch-state.ts pattern.
 */
import fs from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------
const DEFAULT_STATE_PATH = path.join(homedir(), ".openclaw", "linear-planning-state.json");
const MAX_PROCESSED_EVENTS = 200;
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
    return { sessions: {}, processedEvents: [] };
}
export async function readPlanningState(configPath) {
    const filePath = resolveStatePath(configPath);
    try {
        const raw = await fs.readFile(filePath, "utf-8");
        const parsed = JSON.parse(raw);
        if (!parsed.sessions)
            parsed.sessions = {};
        if (!parsed.processedEvents)
            parsed.processedEvents = [];
        return parsed;
    }
    catch (err) {
        if (err.code === "ENOENT")
            return emptyState();
        if (err instanceof SyntaxError) {
            // State file corrupted — log and recover
            console.error(`Planning state corrupted at ${filePath}: ${err.message}. Starting fresh.`);
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
export async function writePlanningState(data, configPath) {
    const filePath = resolveStatePath(configPath);
    const dir = path.dirname(filePath);
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    if (data.processedEvents.length > MAX_PROCESSED_EVENTS) {
        data.processedEvents = data.processedEvents.slice(-MAX_PROCESSED_EVENTS);
    }
    const tmpPath = filePath + ".tmp";
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
    await fs.rename(tmpPath, filePath);
}
// ---------------------------------------------------------------------------
// Session operations
// ---------------------------------------------------------------------------
export async function registerPlanningSession(projectId, session, configPath) {
    const filePath = resolveStatePath(configPath);
    await acquireLock(filePath);
    try {
        const data = await readPlanningState(configPath);
        data.sessions[projectId] = session;
        await writePlanningState(data, configPath);
    }
    finally {
        await releaseLock(filePath);
    }
}
export async function updatePlanningSession(projectId, updates, configPath) {
    const filePath = resolveStatePath(configPath);
    await acquireLock(filePath);
    try {
        const data = await readPlanningState(configPath);
        const session = data.sessions[projectId];
        if (!session)
            throw new Error(`No planning session for project ${projectId}`);
        Object.assign(session, updates);
        await writePlanningState(data, configPath);
        return session;
    }
    finally {
        await releaseLock(filePath);
    }
}
export function getPlanningSession(state, projectId) {
    return state.sessions[projectId] ?? null;
}
export async function endPlanningSession(projectId, status, configPath) {
    const filePath = resolveStatePath(configPath);
    await acquireLock(filePath);
    try {
        const data = await readPlanningState(configPath);
        const session = data.sessions[projectId];
        if (session) {
            session.status = status;
            await writePlanningState(data, configPath);
        }
        clearPlanningCache(projectId);
    }
    finally {
        await releaseLock(filePath);
    }
}
export function isInPlanningMode(state, projectId) {
    const session = state.sessions[projectId];
    if (!session)
        return false;
    return session.status === "interviewing" || session.status === "plan_review";
}
// ---------------------------------------------------------------------------
// In-memory cache for fast webhook routing
// ---------------------------------------------------------------------------
const planningCache = new Map();
export function setPlanningCache(session) {
    planningCache.set(session.projectId, session);
}
export function clearPlanningCache(projectId) {
    planningCache.delete(projectId);
}
export function getActivePlanningByProjectId(projectId) {
    return planningCache.get(projectId) ?? null;
}
