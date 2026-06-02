import { jsonResult } from "openclaw/plugin-sdk/core";
// ---------------------------------------------------------------------------
// Context injection (set before runAgent, cleared after)
// ---------------------------------------------------------------------------
let _activePlannerCtx = null;
export function setActivePlannerContext(ctx) {
    _activePlannerCtx = ctx;
}
export function clearActivePlannerContext() {
    _activePlannerCtx = null;
}
function requireContext() {
    if (!_activePlannerCtx) {
        throw new Error("No active planning session. This tool is only available during planning mode.");
    }
    return _activePlannerCtx;
}
// ---------------------------------------------------------------------------
// Identifier resolution
// ---------------------------------------------------------------------------
function buildIdentifierMap(issues) {
    const map = new Map();
    for (const issue of issues) {
        map.set(issue.identifier, issue.id);
    }
    return map;
}
function resolveId(idMap, identifier) {
    const id = idMap.get(identifier);
    if (!id)
        throw new Error(`Unknown issue identifier: ${identifier}. Use get_project_plan to see current issues.`);
    return id;
}
// ---------------------------------------------------------------------------
// DAG cycle detection (Kahn's algorithm)
// ---------------------------------------------------------------------------
export function detectCycles(issues) {
    // Build adjacency: "blocks" means an edge from blocker to blocked
    const identifiers = new Set(issues.map((i) => i.identifier));
    const inDegree = new Map();
    const adjacency = new Map();
    for (const id of identifiers) {
        inDegree.set(id, 0);
        adjacency.set(id, []);
    }
    for (const issue of issues) {
        for (const rel of issue.relations?.nodes ?? []) {
            const target = rel.relatedIssue?.identifier;
            if (!target || !identifiers.has(target))
                continue;
            if (rel.type === "blocks") {
                // issue blocks target → edge from issue to target
                adjacency.get(issue.identifier).push(target);
                inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
            }
            else if (rel.type === "blocked_by") {
                // issue is blocked by target → edge from target to issue
                adjacency.get(target).push(issue.identifier);
                inDegree.set(issue.identifier, (inDegree.get(issue.identifier) ?? 0) + 1);
            }
        }
    }
    // Kahn's algorithm
    const queue = [];
    for (const [id, deg] of inDegree) {
        if (deg === 0)
            queue.push(id);
    }
    let processed = 0;
    while (queue.length > 0) {
        const node = queue.shift();
        processed++;
        for (const neighbor of adjacency.get(node) ?? []) {
            const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
            inDegree.set(neighbor, newDeg);
            if (newDeg === 0)
                queue.push(neighbor);
        }
    }
    // Nodes not processed are in cycles
    if (processed === identifiers.size)
        return [];
    const cycleNodes = [];
    for (const [id, deg] of inDegree) {
        if (deg > 0)
            cycleNodes.push(id);
    }
    return cycleNodes;
}
// ---------------------------------------------------------------------------
// Audit logic
// ---------------------------------------------------------------------------
export function auditPlan(issues) {
    const problems = [];
    const warnings = [];
    for (const issue of issues) {
        const isEpic = issue.labels?.nodes?.some((l) => l.name.toLowerCase().includes("epic"));
        // Description check
        if (!issue.description || issue.description.trim().length < 50) {
            problems.push(`${issue.identifier} "${issue.title}": description missing or too short (min 50 chars)`);
        }
        // Non-epic checks
        if (!isEpic) {
            if (issue.estimate == null) {
                problems.push(`${issue.identifier} "${issue.title}": missing estimate`);
            }
            if (!issue.priority || issue.priority === 0) {
                problems.push(`${issue.identifier} "${issue.title}": missing priority`);
            }
            // Acceptance criteria check (warning, not failure)
            const acMarkers = /\b(given|when|then|as a|i want|so that|acceptance criteria|uat|test scenario)\b/i;
            if (issue.description && !acMarkers.test(issue.description)) {
                warnings.push(`${issue.identifier} "${issue.title}": no acceptance criteria or test scenarios found in description`);
            }
        }
    }
    // DAG cycle check
    const cycleNodes = detectCycles(issues);
    if (cycleNodes.length > 0) {
        problems.push(`Dependency cycle detected involving: ${cycleNodes.join(", ")}`);
    }
    // Orphan check: issues with no parent and no relations linking to the rest
    const hasParent = new Set(issues.filter((i) => i.parent).map((i) => i.identifier));
    const hasRelation = new Set();
    for (const issue of issues) {
        for (const rel of issue.relations?.nodes ?? []) {
            hasRelation.add(issue.identifier);
            if (rel.relatedIssue?.identifier)
                hasRelation.add(rel.relatedIssue.identifier);
        }
    }
    for (const issue of issues) {
        if (!hasParent.has(issue.identifier) && !hasRelation.has(issue.identifier)) {
            warnings.push(`${issue.identifier} "${issue.title}": orphan issue (no parent or dependency links)`);
        }
    }
    return {
        pass: problems.length === 0,
        problems,
        warnings,
    };
}
// ---------------------------------------------------------------------------
// Snapshot formatter
// ---------------------------------------------------------------------------
export function buildPlanSnapshot(issues) {
    if (issues.length === 0)
        return "_No issues created yet._";
    const lines = [];
    const childMap = new Map();
    const topLevel = [];
    for (const issue of issues) {
        if (issue.parent) {
            const siblings = childMap.get(issue.parent.identifier) ?? [];
            siblings.push(issue);
            childMap.set(issue.parent.identifier, siblings);
        }
        else {
            topLevel.push(issue);
        }
    }
    const priorityLabel = (p) => {
        if (p === 1)
            return "Urgent";
        if (p === 2)
            return "High";
        if (p === 3)
            return "Medium";
        if (p === 4)
            return "Low";
        return "None";
    };
    const formatRelations = (issue) => {
        const rels = issue.relations?.nodes ?? [];
        if (rels.length === 0)
            return "";
        return " " + rels.map((r) => `→ ${r.type} ${r.relatedIssue.identifier}`).join(", ");
    };
    const formatIssue = (issue, indent) => {
        const est = issue.estimate != null ? `est: ${issue.estimate}` : "est: -";
        const pri = `pri: ${priorityLabel(issue.priority)}`;
        const rels = formatRelations(issue);
        lines.push(`${indent}- ${issue.identifier} "${issue.title}" [${est}, ${pri}]${rels}`);
        const children = childMap.get(issue.identifier) ?? [];
        for (const child of children) {
            formatIssue(child, indent + "  ");
        }
    };
    // Separate epics from standalone issues
    const epics = topLevel.filter((i) => i.labels?.nodes?.some((l) => l.name.toLowerCase().includes("epic")));
    const standalone = topLevel.filter((i) => !i.labels?.nodes?.some((l) => l.name.toLowerCase().includes("epic")));
    if (epics.length > 0) {
        lines.push(`### Epics (${epics.length})`);
        for (const epic of epics)
            formatIssue(epic, "");
    }
    if (standalone.length > 0) {
        lines.push(`### Standalone issues (${standalone.length})`);
        for (const issue of standalone)
            formatIssue(issue, "");
    }
    return lines.join("\n");
}
// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------
export function createPlannerTools() {
    return [
        // ---- create_issue ----
        {
            name: "plan_create_issue",
            label: "Create Issue",
            description: "Create a new Linear issue in the current planning project. Use parentIdentifier to create sub-issues under an epic or parent issue.",
            parameters: {
                type: "object",
                properties: {
                    title: { type: "string", description: "Issue title" },
                    description: { type: "string", description: "Issue description including: user story (As a...), acceptance criteria (Given/When/Then), and at least one UAT test scenario (min 50 chars)" },
                    parentIdentifier: { type: "string", description: "Parent issue identifier (e.g. PROJ-2) to create as sub-issue" },
                    isEpic: { type: "boolean", description: "Mark as epic (high-level feature area)" },
                    priority: { type: "number", description: "Priority: 1=Urgent, 2=High, 3=Medium, 4=Low" },
                    estimate: { type: "number", description: "Story point estimate" },
                },
                required: ["title", "description"],
            },
            execute: async (_toolCallId, params) => {
                const { linearApi, projectId, teamId } = requireContext();
                const input = {
                    teamId,
                    projectId,
                    title: params.title,
                    description: params.description,
                };
                if (params.priority)
                    input.priority = params.priority;
                if (params.estimate != null)
                    input.estimate = params.estimate;
                // Resolve parent
                if (params.parentIdentifier) {
                    const issues = await linearApi.getProjectIssues(projectId);
                    const idMap = buildIdentifierMap(issues);
                    input.parentId = resolveId(idMap, params.parentIdentifier);
                }
                const result = await linearApi.createIssue(input);
                // If epic, try to add "Epic" label
                if (params.isEpic) {
                    try {
                        const labels = await linearApi.getTeamLabels(teamId);
                        const epicLabel = labels.find((l) => l.name.toLowerCase() === "epic");
                        if (epicLabel) {
                            await linearApi.updateIssueExtended(result.id, { labelIds: [epicLabel.id] });
                        }
                    }
                    catch { /* best-effort labeling */ }
                }
                return jsonResult({
                    id: result.id,
                    identifier: result.identifier,
                    title: params.title,
                    isEpic: params.isEpic ?? false,
                });
            },
        },
        // ---- link_issues ----
        {
            name: "plan_link_issues",
            label: "Link Issues",
            description: "Create a dependency relationship between two issues. Use 'blocks' to indicate ordering: if A must finish before B starts, A blocks B.",
            parameters: {
                type: "object",
                properties: {
                    fromIdentifier: { type: "string", description: "Source issue identifier (e.g. PROJ-2)" },
                    toIdentifier: { type: "string", description: "Target issue identifier (e.g. PROJ-3)" },
                    type: {
                        type: "string",
                        description: "Relationship type: 'blocks', 'blocked_by', or 'related'",
                    },
                },
                required: ["fromIdentifier", "toIdentifier", "type"],
            },
            execute: async (_toolCallId, params) => {
                const { linearApi, projectId } = requireContext();
                const issues = await linearApi.getProjectIssues(projectId);
                const idMap = buildIdentifierMap(issues);
                const fromId = resolveId(idMap, params.fromIdentifier);
                const toId = resolveId(idMap, params.toIdentifier);
                const result = await linearApi.createIssueRelation({
                    issueId: fromId,
                    relatedIssueId: toId,
                    type: params.type,
                });
                return jsonResult({
                    id: result.id,
                    from: params.fromIdentifier,
                    to: params.toIdentifier,
                    type: params.type,
                });
            },
        },
        // ---- get_project_plan ----
        {
            name: "plan_get_project",
            label: "Get Project Plan",
            description: "Retrieve the current project plan showing all issues organized by hierarchy with dependency relationships.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
            execute: async () => {
                const { linearApi, projectId } = requireContext();
                const issues = await linearApi.getProjectIssues(projectId);
                const snapshot = buildPlanSnapshot(issues);
                return jsonResult({
                    issueCount: issues.length,
                    plan: snapshot,
                });
            },
        },
        // ---- update_issue ----
        {
            name: "plan_update_issue",
            label: "Update Issue",
            description: "Update an existing issue's description, estimate, priority, or labels.",
            parameters: {
                type: "object",
                properties: {
                    identifier: { type: "string", description: "Issue identifier (e.g. PROJ-5)" },
                    description: { type: "string", description: "New description" },
                    estimate: { type: "number", description: "New estimate" },
                    priority: { type: "number", description: "New priority: 1=Urgent, 2=High, 3=Medium, 4=Low" },
                    labelIds: {
                        type: "array",
                        items: { type: "string" },
                        description: "Label IDs to set",
                    },
                },
                required: ["identifier"],
            },
            execute: async (_toolCallId, params) => {
                const { linearApi, projectId } = requireContext();
                const issues = await linearApi.getProjectIssues(projectId);
                const idMap = buildIdentifierMap(issues);
                const issueId = resolveId(idMap, params.identifier);
                const updates = {};
                if (params.description !== undefined)
                    updates.description = params.description;
                if (params.estimate !== undefined)
                    updates.estimate = params.estimate;
                if (params.priority !== undefined)
                    updates.priority = params.priority;
                if (params.labelIds !== undefined)
                    updates.labelIds = params.labelIds;
                const success = await linearApi.updateIssueExtended(issueId, updates);
                return jsonResult({ identifier: params.identifier, updated: success });
            },
        },
        // ---- audit_plan ----
        {
            name: "plan_audit",
            label: "Audit Plan",
            description: "Run a completeness audit on the current project plan. Checks descriptions, estimates, priorities, DAG validity, and orphan issues.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
            execute: async () => {
                const { linearApi, projectId } = requireContext();
                const issues = await linearApi.getProjectIssues(projectId);
                const result = auditPlan(issues);
                return jsonResult(result);
            },
        },
    ];
}
