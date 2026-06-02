/**
 * file-lock.ts — Shared file-level locking for state files.
 *
 * Used by dispatch-state.ts and planning-state.ts to prevent
 * concurrent read-modify-write races on JSON state files.
 */
import fs from "node:fs/promises";
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 10_000;
function lockPath(statePath) {
    return statePath + ".lock";
}
export async function acquireLock(statePath) {
    const lock = lockPath(statePath);
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (Date.now() < deadline) {
        try {
            await fs.writeFile(lock, String(Date.now()), { flag: "wx" });
            return;
        }
        catch (err) {
            if (err.code !== "EEXIST")
                throw err;
            // Check for stale lock
            try {
                const content = await fs.readFile(lock, "utf-8");
                const lockTime = Number(content);
                if (Date.now() - lockTime > LOCK_STALE_MS) {
                    try {
                        await fs.unlink(lock);
                    }
                    catch { /* race */ }
                    continue;
                }
            }
            catch { /* lock disappeared — retry */ }
            await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
        }
    }
    // Last resort: force remove potentially stale lock
    try {
        await fs.unlink(lockPath(statePath));
    }
    catch { /* ignore */ }
    await fs.writeFile(lock, String(Date.now()), { flag: "wx" });
}
export async function releaseLock(statePath) {
    try {
        await fs.unlink(lockPath(statePath));
    }
    catch { /* already removed */ }
}
