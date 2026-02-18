/**
 * dispatch-service.ts — Background service for dispatch health monitoring.
 *
 * Registered via api.registerService(). Runs on a 5-minute interval.
 * Zero LLM tokens — all logic is deterministic code.
 *
 * Responsibilities:
 * - Hydrate active sessions from dispatch-state.json on startup
 * - Detect stale dispatches (active >2h with no progress)
 * - Verify worktree health for active dispatches
 * - Prune completed dispatches older than 7 days
 */
import { existsSync } from "node:fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { hydrateFromDispatchState } from "./active-session.js";
import {
  readDispatchState,
  listStaleDispatches,
  listRecoverableDispatches,
  transitionDispatch,
  TransitionError,
  removeActiveDispatch,
  pruneCompleted,
} from "./dispatch-state.js";
import { getWorktreeStatus } from "./codex-worktree.js";

const INTERVAL_MS = 5 * 60_000; // 5 minutes
const STALE_THRESHOLD_MS = 2 * 60 * 60_000; // 2 hours
const COMPLETED_MAX_AGE_MS = 7 * 24 * 60 * 60_000; // 7 days

type ServiceContext = {
  logger: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
};

export function createDispatchService(api: OpenClawPluginApi) {
  let intervalId: ReturnType<typeof setInterval> | null = null;

  const pluginConfig = (api as any).pluginConfig as Record<string, unknown> | undefined;
  const statePath = pluginConfig?.dispatchStatePath as string | undefined;

  return {
    id: "linear-dispatch-monitor",

    start: async (ctx: ServiceContext) => {
      // Hydrate active sessions on startup
      try {
        const restored = await hydrateFromDispatchState(statePath);
        if (restored > 0) {
          ctx.logger.info(`linear-dispatch: hydrated ${restored} active session(s) from dispatch state`);
        }
      } catch (err) {
        ctx.logger.warn(`linear-dispatch: hydration failed: ${err}`);
      }

      // Recovery scan: find dispatches stuck in "working" with a workerSessionKey
      // but no auditSessionKey (worker completed but audit wasn't triggered before crash)
      try {
        const state = await readDispatchState(statePath);
        const recoverable = listRecoverableDispatches(state);
        for (const d of recoverable) {
          ctx.logger.warn(
            `linear-dispatch: recoverable dispatch ${d.issueIdentifier} ` +
            `(status: ${d.status}, attempt: ${d.attempt}, workerKey: ${d.workerSessionKey}, auditKey: ${d.auditSessionKey ?? "none"})`,
          );
          // Mark as stuck for manual review — automated recovery requires
          // re-triggering audit which needs the full HookContext (Linear API, notifier).
          // The dispatch monitor logs a warning; operator can re-dispatch.
        }
        if (recoverable.length > 0) {
          ctx.logger.warn(`linear-dispatch: ${recoverable.length} dispatch(es) need recovery — consider re-dispatching`);
        }
      } catch (err) {
        ctx.logger.warn(`linear-dispatch: recovery scan failed: ${err}`);
      }

      ctx.logger.info(`linear-dispatch: service started (interval: ${INTERVAL_MS / 1000}s)`);

      intervalId = setInterval(() => runTick(ctx), INTERVAL_MS);
    },

    stop: async (ctx: ServiceContext) => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
        ctx.logger.info("linear-dispatch: service stopped");
      }
    },
  };

  async function runTick(ctx: ServiceContext): Promise<void> {
    try {
      const state = await readDispatchState(statePath);
      const activeCount = Object.keys(state.dispatches.active).length;

      // Skip tick if nothing to do
      if (activeCount === 0 && Object.keys(state.dispatches.completed).length === 0) return;

      // 1. Stale dispatch detection — transition truly stale dispatches to "stuck"
      const stale = listStaleDispatches(state, STALE_THRESHOLD_MS);
      for (const dispatch of stale) {
        // Skip terminal states
        if (dispatch.status === "done" || dispatch.status === "failed" || dispatch.status === "stuck") {
          continue;
        }

        // Check if worktree still exists and has progress
        if (existsSync(dispatch.worktreePath)) {
          const status = getWorktreeStatus(dispatch.worktreePath);
          if (status.hasUncommitted || status.lastCommit) {
            // Worktree has activity — not truly stale, just slow
            continue;
          }
        }

        ctx.logger.warn(
          `linear-dispatch: stale dispatch ${dispatch.issueIdentifier} ` +
          `(dispatched ${dispatch.dispatchedAt}, status: ${dispatch.status}) — transitioning to stuck`,
        );

        // Try to transition to stuck
        try {
          await transitionDispatch(
            dispatch.issueIdentifier,
            dispatch.status,
            "stuck",
            { stuckReason: `stale_${Math.round((Date.now() - new Date(dispatch.dispatchedAt).getTime()) / 3_600_000)}h` },
            statePath,
          );
          ctx.logger.info(`linear-dispatch: ${dispatch.issueIdentifier} marked as stuck`);
        } catch (err) {
          if (err instanceof TransitionError) {
            ctx.logger.info(`linear-dispatch: CAS failed for stale transition: ${(err as TransitionError).message}`);
          } else {
            ctx.logger.error(`linear-dispatch: stale transition error: ${err}`);
          }
        }
      }

      // 2. Worktree health — verify active dispatches have valid worktrees
      for (const [id, dispatch] of Object.entries(state.dispatches.active)) {
        if (!existsSync(dispatch.worktreePath)) {
          ctx.logger.warn(
            `linear-dispatch: worktree missing for ${id} at ${dispatch.worktreePath}`
          );
        }
      }

      // 3. Prune old completed entries
      const pruned = await pruneCompleted(COMPLETED_MAX_AGE_MS, statePath);
      if (pruned > 0) {
        ctx.logger.info(`linear-dispatch: pruned ${pruned} old completed dispatch(es)`);
      }

      if (activeCount > 0) {
        ctx.logger.info(`linear-dispatch: tick — ${activeCount} active, ${stale.length} stale`);
      }
    } catch (err) {
      ctx.logger.error(`linear-dispatch: tick failed: ${err}`);
    }
  }
}
