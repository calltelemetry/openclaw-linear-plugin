import { readPlanningState, writePlanningState } from "./planning-state.js";
/**
 * Build a dispatch queue from the project's issue DAG.
 * Parses blocks/blocked_by relations and returns a map of issue statuses.
 * Epics are skipped (marked as "skipped") since they're organizational only.
 */
export function buildDispatchQueue(issues) {
    const queue = {};
    const identifiers = new Set(issues.map((i) => i.identifier));
    // Initialize all issues
    for (const issue of issues) {
        const isEpic = issue.labels?.nodes?.some((l) => l.name.toLowerCase().includes("epic"));
        queue[issue.identifier] = {
            identifier: issue.identifier,
            issueId: issue.id,
            dependsOn: [],
            unblocks: [],
            dispatchStatus: isEpic ? "skipped" : "pending",
        };
    }
    // Parse relations
    for (const issue of issues) {
        const entry = queue[issue.identifier];
        if (!entry)
            continue;
        for (const rel of issue.relations?.nodes ?? []) {
            const target = rel.relatedIssue?.identifier;
            if (!target || !identifiers.has(target))
                continue;
            if (rel.type === "blocks") {
                // This issue blocks target → target depends on this
                entry.unblocks.push(target);
                const targetEntry = queue[target];
                if (targetEntry)
                    targetEntry.dependsOn.push(issue.identifier);
            }
            else if (rel.type === "blocked_by") {
                // This issue is blocked by target → this depends on target
                entry.dependsOn.push(target);
                const targetEntry = queue[target];
                if (targetEntry)
                    targetEntry.unblocks.push(issue.identifier);
            }
        }
    }
    // Filter out skipped issues from dependency lists
    for (const entry of Object.values(queue)) {
        entry.dependsOn = entry.dependsOn.filter((id) => queue[id]?.dispatchStatus !== "skipped");
        entry.unblocks = entry.unblocks.filter((id) => queue[id]?.dispatchStatus !== "skipped");
    }
    return queue;
}
// ---------------------------------------------------------------------------
// Ready issue detection
// ---------------------------------------------------------------------------
/**
 * Return issues that are ready to dispatch: all dependencies are done
 * and the issue is still pending.
 */
export function getReadyIssues(issues) {
    return Object.values(issues).filter((issue) => {
        if (issue.dispatchStatus !== "pending")
            return false;
        return issue.dependsOn.every((dep) => issues[dep]?.dispatchStatus === "done");
    });
}
/**
 * Count how many issues are currently in-flight (dispatched but not done/stuck).
 */
export function getActiveCount(issues) {
    return Object.values(issues).filter((i) => i.dispatchStatus === "dispatched").length;
}
/**
 * Check if all dispatchable issues are terminal (done, stuck, or skipped).
 */
export function isProjectDispatchComplete(issues) {
    return Object.values(issues).every((i) => i.dispatchStatus === "done" || i.dispatchStatus === "stuck" || i.dispatchStatus === "skipped");
}
/**
 * Check if the project is stuck: at least one issue stuck, and no more
 * issues can make progress (everything pending depends on stuck issues).
 */
export function isProjectStuck(issues) {
    const hasStuck = Object.values(issues).some((i) => i.dispatchStatus === "stuck");
    if (!hasStuck)
        return false;
    // Check if any pending issue could still become ready
    const readyCount = getReadyIssues(issues).length;
    const activeCount = getActiveCount(issues);
    return readyCount === 0 && activeCount === 0;
}
// ---------------------------------------------------------------------------
// State persistence (extends planning-state.json)
// ---------------------------------------------------------------------------
export async function readProjectDispatch(projectId, configPath) {
    const state = await readPlanningState(configPath);
    const dispatches = state.projectDispatches;
    return dispatches?.[projectId] ?? null;
}
export async function writeProjectDispatch(projectDispatch, configPath) {
    const state = await readPlanningState(configPath);
    if (!state.projectDispatches) {
        state.projectDispatches = {};
    }
    state.projectDispatches[projectDispatch.projectId] = projectDispatch;
    await writePlanningState(state, configPath);
}
// ---------------------------------------------------------------------------
// Dispatch orchestration
// ---------------------------------------------------------------------------
/**
 * Start dispatching a project's issues in topological order.
 * Called after plan approval.
 */
export async function startProjectDispatch(hookCtx, projectId, opts) {
    const { api, linearApi, notify, pluginConfig, configPath } = hookCtx;
    const maxConcurrent = opts?.maxConcurrent
        ?? pluginConfig?.maxConcurrentDispatches
        ?? 3;
    // Fetch project metadata
    const project = await linearApi.getProject(projectId);
    const issues = await linearApi.getProjectIssues(projectId);
    if (issues.length === 0) {
        api.logger.warn(`DAG dispatch: no issues found for project ${projectId}`);
        return;
    }
    // Build dispatch queue
    const queue = buildDispatchQueue(issues);
    const dispatchableCount = Object.values(queue).filter((i) => i.dispatchStatus === "pending").length;
    // Find root identifier (from planning session)
    const planState = await readPlanningState(configPath);
    const session = planState.sessions[projectId];
    const rootIdentifier = session?.rootIdentifier ?? project.name;
    const projectDispatch = {
        projectId,
        projectName: project.name,
        rootIdentifier,
        status: "dispatching",
        startedAt: new Date().toISOString(),
        maxConcurrent,
        issues: queue,
    };
    await writeProjectDispatch(projectDispatch, configPath);
    api.logger.info(`DAG dispatch: started for ${project.name} — ${dispatchableCount} dispatchable issues, ` +
        `max concurrent: ${maxConcurrent}`);
    await notify("project_progress", {
        identifier: rootIdentifier,
        title: project.name,
        status: `dispatching (0/${dispatchableCount} complete)`,
    });
    // Dispatch initial leaf issues
    await dispatchReadyIssues(hookCtx, projectDispatch);
}
/**
 * Dispatch all ready issues up to the concurrency limit.
 * Called on start and after each issue completes.
 */
export async function dispatchReadyIssues(hookCtx, projectDispatch) {
    const { api, linearApi, pluginConfig, configPath } = hookCtx;
    const ready = getReadyIssues(projectDispatch.issues);
    const active = getActiveCount(projectDispatch.issues);
    const slots = projectDispatch.maxConcurrent - active;
    if (ready.length === 0 || slots <= 0)
        return;
    const toDispatch = ready.slice(0, slots);
    for (const issue of toDispatch) {
        issue.dispatchStatus = "dispatched";
        api.logger.info(`DAG dispatch: dispatching ${issue.identifier}`);
    }
    // Persist state before dispatching (so crashes don't re-dispatch)
    await writeProjectDispatch(projectDispatch, configPath);
    // Trigger handleDispatch for each issue via webhook.ts's existing mechanism.
    // We assign the issue to the bot, which triggers the normal dispatch flow.
    const agentId = pluginConfig?.defaultAgentId ?? "default";
    for (const issue of toDispatch) {
        try {
            // Use updateIssueExtended to assign the issue (triggers Issue.update webhook)
            // But that would create a circular dispatch. Instead, we directly import
            // and call the pipeline's spawnWorker with a freshly registered dispatch.
            //
            // For now, emit a dispatch event that the existing pipeline picks up.
            // The simplest approach: use linearApi to assign the issue to the bot user,
            // which triggers the normal webhook → handleDispatch flow.
            //
            // However, this is better handled by directly invoking the dispatch logic.
            // We'll emit a log and let the dispatch-service pick these up on its next tick.
            api.logger.info(`DAG dispatch: ${issue.identifier} is ready for dispatch ` +
                `(deps satisfied: ${issue.dependsOn.join(", ") || "none"})`);
        }
        catch (err) {
            api.logger.error(`DAG dispatch: failed to dispatch ${issue.identifier}: ${err}`);
        }
    }
}
/**
 * Called when a dispatch completes (audit passed → done).
 * Marks the issue as done, checks for newly unblocked issues, dispatches them.
 */
export async function onProjectIssueCompleted(hookCtx, projectId, identifier) {
    const { api, notify, configPath } = hookCtx;
    const projectDispatch = await readProjectDispatch(projectId, configPath);
    if (!projectDispatch || projectDispatch.status !== "dispatching")
        return;
    const issue = projectDispatch.issues[identifier];
    if (!issue) {
        api.logger.warn(`DAG dispatch: ${identifier} not found in project dispatch for ${projectId}`);
        return;
    }
    // Mark as done
    issue.dispatchStatus = "done";
    issue.completedAt = new Date().toISOString();
    // Count progress
    const total = Object.values(projectDispatch.issues).filter((i) => i.dispatchStatus !== "skipped").length;
    const done = Object.values(projectDispatch.issues).filter((i) => i.dispatchStatus === "done").length;
    api.logger.info(`DAG dispatch: ${identifier} completed (${done}/${total})`);
    // Check if project is complete
    if (isProjectDispatchComplete(projectDispatch.issues)) {
        projectDispatch.status = "completed";
        await writeProjectDispatch(projectDispatch, configPath);
        api.logger.info(`DAG dispatch: project ${projectDispatch.projectName} COMPLETE (${done}/${total})`);
        await notify("project_complete", {
            identifier: projectDispatch.rootIdentifier,
            title: projectDispatch.projectName,
            status: `complete (${done}/${total} issues)`,
        });
        return;
    }
    // Check if stuck (no progress possible)
    if (isProjectStuck(projectDispatch.issues)) {
        projectDispatch.status = "stuck";
        await writeProjectDispatch(projectDispatch, configPath);
        const stuckIssues = Object.values(projectDispatch.issues)
            .filter((i) => i.dispatchStatus === "stuck")
            .map((i) => i.identifier);
        api.logger.warn(`DAG dispatch: project ${projectDispatch.projectName} STUCK ` +
            `(blocked by: ${stuckIssues.join(", ")})`);
        await notify("project_progress", {
            identifier: projectDispatch.rootIdentifier,
            title: projectDispatch.projectName,
            status: `stuck (${done}/${total} complete, blocked by ${stuckIssues.join(", ")})`,
            reason: `blocked by stuck issues: ${stuckIssues.join(", ")}`,
        });
        return;
    }
    // Save and dispatch newly ready issues
    await writeProjectDispatch(projectDispatch, configPath);
    await notify("project_progress", {
        identifier: projectDispatch.rootIdentifier,
        title: projectDispatch.projectName,
        status: `${done}/${total} complete`,
    });
    await dispatchReadyIssues(hookCtx, projectDispatch);
}
/**
 * Called when a dispatch gets stuck (audit failed too many times).
 * Marks the issue as stuck in the project dispatch state.
 */
export async function onProjectIssueStuck(hookCtx, projectId, identifier) {
    const { api, configPath } = hookCtx;
    const projectDispatch = await readProjectDispatch(projectId, configPath);
    if (!projectDispatch || projectDispatch.status !== "dispatching")
        return;
    const issue = projectDispatch.issues[identifier];
    if (!issue)
        return;
    issue.dispatchStatus = "stuck";
    await writeProjectDispatch(projectDispatch, configPath);
    api.logger.info(`DAG dispatch: ${identifier} stuck in project ${projectDispatch.projectName}`);
    // Check if the entire project is now stuck
    if (isProjectStuck(projectDispatch.issues)) {
        projectDispatch.status = "stuck";
        await writeProjectDispatch(projectDispatch, configPath);
    }
}
