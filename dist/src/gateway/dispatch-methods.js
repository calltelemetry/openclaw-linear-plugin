/**
 * dispatch-methods.ts — Gateway RPC methods for dispatch operations.
 *
 * Registers methods on the OpenClaw gateway that allow clients (UI, CLI, other
 * plugins) to inspect and manage the dispatch pipeline via the standard
 * gateway request/respond protocol.
 *
 * Methods:
 *   dispatch.list      — List active + completed dispatches (filterable)
 *   dispatch.get       — Full details for a single dispatch
 *   dispatch.retry     — Re-dispatch a stuck issue
 *   dispatch.escalate  — Force a working/auditing dispatch into stuck
 *   dispatch.cancel    — Remove an active dispatch entirely
 *   dispatch.stats     — Aggregate counts by status and tier
 */
import { readDispatchState, getActiveDispatch, listActiveDispatches, transitionDispatch, removeActiveDispatch, registerDispatch, TransitionError, } from "../pipeline/dispatch-state.js";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function ok(data = {}) {
    return { ok: true, ...data };
}
function fail(error) {
    return { ok: false, error };
}
// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------
export function registerDispatchMethods(api) {
    const pluginConfig = api.pluginConfig;
    const statePath = pluginConfig?.dispatchStatePath;
    // ---- dispatch.list -------------------------------------------------------
    api.registerGatewayMethod("dispatch.list", async ({ params, respond }) => {
        try {
            const statusFilter = params.status;
            const tierFilter = params.tier;
            const state = await readDispatchState(statePath);
            let active = listActiveDispatches(state);
            if (statusFilter) {
                active = active.filter((d) => d.status === statusFilter);
            }
            if (tierFilter) {
                active = active.filter((d) => d.tier === tierFilter);
            }
            const completed = Object.values(state.dispatches.completed);
            respond(true, ok({ active, completed }));
        }
        catch (err) {
            respond(true, fail(err.message ?? String(err)));
        }
    });
    // ---- dispatch.get --------------------------------------------------------
    api.registerGatewayMethod("dispatch.get", async ({ params, respond }) => {
        try {
            const identifier = params.identifier;
            if (!identifier) {
                respond(true, fail("Missing required param: identifier"));
                return;
            }
            const state = await readDispatchState(statePath);
            const active = getActiveDispatch(state, identifier);
            if (active) {
                respond(true, ok({ dispatch: active, source: "active" }));
                return;
            }
            const completed = state.dispatches.completed[identifier];
            if (completed) {
                respond(true, ok({ dispatch: completed, source: "completed" }));
                return;
            }
            respond(true, fail(`No dispatch found for identifier: ${identifier}`));
        }
        catch (err) {
            respond(true, fail(err.message ?? String(err)));
        }
    });
    // ---- dispatch.retry ------------------------------------------------------
    // Stuck dispatches are terminal in VALID_TRANSITIONS, so we cannot use
    // transitionDispatch. Instead, remove the active dispatch and re-register
    // it with status reset to "dispatched" and an incremented attempt counter.
    api.registerGatewayMethod("dispatch.retry", async ({ params, respond }) => {
        try {
            const identifier = params.identifier;
            if (!identifier) {
                respond(true, fail("Missing required param: identifier"));
                return;
            }
            const state = await readDispatchState(statePath);
            const dispatch = getActiveDispatch(state, identifier);
            if (!dispatch) {
                respond(true, fail(`No active dispatch for identifier: ${identifier}`));
                return;
            }
            if (dispatch.status !== "stuck") {
                respond(true, fail(`Cannot retry dispatch in status "${dispatch.status}" — only "stuck" dispatches can be retried`));
                return;
            }
            // Capture current state, remove, then re-register with reset status
            const retryDispatch = {
                ...dispatch,
                status: "dispatched",
                attempt: dispatch.attempt + 1,
                stuckReason: undefined,
                workerSessionKey: undefined,
                auditSessionKey: undefined,
            };
            await removeActiveDispatch(identifier, statePath);
            await registerDispatch(identifier, retryDispatch, statePath);
            api.logger.info(`dispatch.retry: ${identifier} re-dispatched (attempt ${retryDispatch.attempt})`);
            respond(true, ok({ dispatch: retryDispatch }));
        }
        catch (err) {
            respond(true, fail(err.message ?? String(err)));
        }
    });
    // ---- dispatch.escalate ---------------------------------------------------
    api.registerGatewayMethod("dispatch.escalate", async ({ params, respond }) => {
        try {
            const identifier = params.identifier;
            if (!identifier) {
                respond(true, fail("Missing required param: identifier"));
                return;
            }
            const reason = params.reason || "Manually escalated via gateway";
            const state = await readDispatchState(statePath);
            const dispatch = getActiveDispatch(state, identifier);
            if (!dispatch) {
                respond(true, fail(`No active dispatch for identifier: ${identifier}`));
                return;
            }
            if (dispatch.status !== "working" && dispatch.status !== "auditing") {
                respond(true, fail(`Cannot escalate dispatch in status "${dispatch.status}" — only "working" or "auditing" dispatches can be escalated`));
                return;
            }
            const updated = await transitionDispatch(identifier, dispatch.status, "stuck", { stuckReason: reason }, statePath);
            api.logger.info(`dispatch.escalate: ${identifier} escalated to stuck (was ${dispatch.status}, reason: ${reason})`);
            respond(true, ok({ dispatch: updated }));
        }
        catch (err) {
            if (err instanceof TransitionError) {
                respond(true, fail(`Transition conflict: ${err.message}`));
                return;
            }
            respond(true, fail(err.message ?? String(err)));
        }
    });
    // ---- dispatch.cancel -----------------------------------------------------
    api.registerGatewayMethod("dispatch.cancel", async ({ params, respond }) => {
        try {
            const identifier = params.identifier;
            if (!identifier) {
                respond(true, fail("Missing required param: identifier"));
                return;
            }
            const state = await readDispatchState(statePath);
            const dispatch = getActiveDispatch(state, identifier);
            if (!dispatch) {
                respond(true, fail(`No active dispatch for identifier: ${identifier}`));
                return;
            }
            await removeActiveDispatch(identifier, statePath);
            api.logger.info(`dispatch.cancel: ${identifier} removed (was ${dispatch.status})`);
            respond(true, ok({ cancelled: identifier, previousStatus: dispatch.status }));
        }
        catch (err) {
            respond(true, fail(err.message ?? String(err)));
        }
    });
    // ---- dispatch.stats ------------------------------------------------------
    api.registerGatewayMethod("dispatch.stats", async ({ params, respond }) => {
        try {
            const state = await readDispatchState(statePath);
            const active = listActiveDispatches(state);
            const byStatus = {};
            const byTier = {};
            for (const d of active) {
                byStatus[d.status] = (byStatus[d.status] ?? 0) + 1;
                byTier[d.tier] = (byTier[d.tier] ?? 0) + 1;
            }
            const completedCount = Object.keys(state.dispatches.completed).length;
            respond(true, ok({
                activeCount: active.length,
                completedCount,
                byStatus,
                byTier,
            }));
        }
        catch (err) {
            respond(true, fail(err.message ?? String(err)));
        }
    });
    api.logger.info("Dispatch gateway methods registered (dispatch.list, dispatch.get, dispatch.retry, dispatch.escalate, dispatch.cancel, dispatch.stats)");
}
