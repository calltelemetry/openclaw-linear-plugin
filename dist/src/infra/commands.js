import { readDispatchState, getActiveDispatch, listActiveDispatches, removeActiveDispatch, transitionDispatch, TransitionError, registerDispatch, } from "../pipeline/dispatch-state.js";
export function registerDispatchCommands(api) {
    const pluginConfig = api.pluginConfig;
    const statePath = pluginConfig?.dispatchStatePath;
    api.registerCommand({
        name: "dispatch",
        description: "Manage dispatches: list, status <id>, retry <id>, escalate <id>",
        acceptsArgs: true,
        handler: async (ctx) => {
            const args = (ctx.args ?? "").trim().split(/\s+/);
            const sub = args[0]?.toLowerCase();
            const id = args[1];
            if (!sub || sub === "list") {
                return await handleList(statePath);
            }
            if (sub === "status" && id) {
                return await handleStatus(id, statePath);
            }
            if (sub === "retry" && id) {
                return await handleRetry(id, statePath, api);
            }
            if (sub === "escalate" && id) {
                const reason = args.slice(2).join(" ") || "manual escalation";
                return await handleEscalate(id, reason, statePath, api);
            }
            return {
                text: [
                    "**Dispatch Commands:**",
                    "`/dispatch list` — show active dispatches",
                    "`/dispatch status <id>` — phase/attempt details",
                    "`/dispatch retry <id>` — reset stuck → dispatched",
                    "`/dispatch escalate <id> [reason]` — force to stuck",
                ].join("\n"),
            };
        },
    });
}
async function handleList(statePath) {
    const state = await readDispatchState(statePath);
    const active = listActiveDispatches(state);
    if (active.length === 0) {
        return { text: "No active dispatches." };
    }
    const lines = active.map((d) => {
        const age = Math.round((Date.now() - new Date(d.dispatchedAt).getTime()) / 60_000);
        return `**${d.issueIdentifier}** — ${d.status} (${d.tier}, attempt ${d.attempt}, ${age}m)`;
    });
    return { text: `**Active Dispatches (${active.length})**\n${lines.join("\n")}` };
}
async function handleStatus(id, statePath) {
    const state = await readDispatchState(statePath);
    const d = getActiveDispatch(state, id);
    if (!d) {
        const completed = state.dispatches.completed[id];
        if (completed) {
            return {
                text: `**${id}** — completed (${completed.status}, ${completed.tier}, ${completed.totalAttempts ?? 0} attempts)`,
            };
        }
        return { text: `No dispatch found for ${id}.` };
    }
    const age = Math.round((Date.now() - new Date(d.dispatchedAt).getTime()) / 60_000);
    const lines = [
        `**${d.issueIdentifier}** — ${d.issueTitle ?? d.issueIdentifier}`,
        `Status: ${d.status} | Tier: ${d.tier} | Attempt: ${d.attempt}`,
        `Age: ${age}m | Worktree: \`${d.worktreePath}\``,
        d.stuckReason ? `Stuck reason: ${d.stuckReason}` : "",
        d.agentSessionId ? `Session: ${d.agentSessionId}` : "",
    ].filter(Boolean);
    return { text: lines.join("\n") };
}
async function handleRetry(id, statePath, api) {
    const state = await readDispatchState(statePath);
    const d = getActiveDispatch(state, id);
    if (!d) {
        return { text: `No active dispatch found for ${id}.` };
    }
    if (d.status !== "stuck") {
        return { text: `Cannot retry ${id} — status is ${d.status} (must be stuck).` };
    }
    // Remove and re-register with reset status
    await removeActiveDispatch(id, statePath);
    const retryDispatch = {
        ...d,
        status: "dispatched",
        stuckReason: undefined,
        workerSessionKey: undefined,
        auditSessionKey: undefined,
        dispatchedAt: new Date().toISOString(),
    };
    await registerDispatch(id, retryDispatch, statePath);
    api.logger.info(`/dispatch retry: ${id} reset from stuck → dispatched`);
    return { text: `**${id}** reset to dispatched. Will be picked up by next dispatch cycle.` };
}
async function handleEscalate(id, reason, statePath, api) {
    const state = await readDispatchState(statePath);
    const d = getActiveDispatch(state, id);
    if (!d) {
        return { text: `No active dispatch found for ${id}.` };
    }
    if (d.status === "stuck" || d.status === "done" || d.status === "failed") {
        return { text: `Cannot escalate ${id} — already in terminal state: ${d.status}.` };
    }
    try {
        await transitionDispatch(id, d.status, "stuck", { stuckReason: reason }, statePath);
        api.logger.info(`/dispatch escalate: ${id} → stuck (${reason})`);
        return { text: `**${id}** escalated to stuck: ${reason}` };
    }
    catch (err) {
        if (err instanceof TransitionError) {
            return { text: `CAS conflict: ${err.message}` };
        }
        return { text: `Error: ${String(err)}` };
    }
}
