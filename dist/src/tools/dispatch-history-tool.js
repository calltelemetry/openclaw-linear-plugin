/**
 * dispatch-history-tool.ts — Agent tool for searching dispatch history.
 *
 * Searches dispatch state + memory files to provide context about
 * past dispatches. Useful for agents to understand what work has
 * been done on related issues.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { jsonResult } from "openclaw/plugin-sdk/core";
import { readDispatchState, listActiveDispatches } from "../pipeline/dispatch-state.js";
import { resolveOrchestratorWorkspace } from "../pipeline/artifacts.js";
export function createDispatchHistoryTool(api, pluginConfig) {
    const statePath = pluginConfig?.dispatchStatePath;
    return {
        name: "dispatch_history",
        label: "Dispatch History",
        description: "Search dispatch history for past and active Linear issue dispatches. " +
            "Returns issue identifier, tier, status, attempts, and summary excerpts.",
        parameters: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Issue identifier (e.g. 'CT-123') or keyword to search in summaries.",
                },
                tier: {
                    type: "string",
                    enum: ["small", "medium", "high"],
                    description: "Filter by tier.",
                },
                status: {
                    type: "string",
                    enum: ["dispatched", "working", "auditing", "done", "failed", "stuck"],
                    description: "Filter by status.",
                },
                limit: {
                    type: "number",
                    description: "Max results to return (default: 10).",
                },
            },
        },
        execute: async (_toolCallId, params) => {
            const maxResults = params.limit ?? 10;
            const results = [];
            // Search active dispatches
            const state = await readDispatchState(statePath);
            const active = listActiveDispatches(state);
            for (const d of active) {
                if (matchesFilters(d.issueIdentifier, d.tier, d.status, params)) {
                    results.push({
                        identifier: d.issueIdentifier,
                        tier: d.tier,
                        status: d.status,
                        attempts: d.attempt,
                        active: true,
                        taskFlowId: d.taskFlowId,
                    });
                }
            }
            // Search completed dispatches
            for (const [id, d] of Object.entries(state.dispatches.completed)) {
                if (matchesFilters(id, d.tier, d.status, params)) {
                    results.push({
                        identifier: id,
                        tier: d.tier,
                        status: d.status,
                        attempts: d.totalAttempts ?? 0,
                        active: false,
                    });
                }
            }
            // Search memory files for richer context
            try {
                const wsDir = resolveOrchestratorWorkspace(api, pluginConfig);
                const memDir = join(wsDir, "memory");
                const files = readdirSync(memDir).filter(f => f.startsWith("dispatch-") && f.endsWith(".md"));
                for (const file of files) {
                    const id = file.replace("dispatch-", "").replace(".md", "");
                    // Skip if already in results
                    if (results.some(r => r.identifier === id)) {
                        // Enrich with summary
                        const existing = results.find(r => r.identifier === id);
                        if (existing && !existing.summary) {
                            try {
                                const content = readFileSync(join(memDir, file), "utf-8");
                                existing.summary = extractSummaryExcerpt(content, params.query);
                            }
                            catch { }
                        }
                        continue;
                    }
                    // Check if memory file matches query
                    if (params.query) {
                        try {
                            const content = readFileSync(join(memDir, file), "utf-8");
                            if (id.toLowerCase().includes(params.query.toLowerCase()) ||
                                content.toLowerCase().includes(params.query.toLowerCase())) {
                                const meta = parseFrontmatter(content);
                                if (matchesFilters(id, meta.tier, meta.status, params)) {
                                    results.push({
                                        identifier: id,
                                        tier: meta.tier ?? "unknown",
                                        status: meta.status ?? "completed",
                                        attempts: meta.attempts ?? 0,
                                        summary: extractSummaryExcerpt(content, params.query),
                                        active: false,
                                    });
                                }
                            }
                        }
                        catch { }
                    }
                }
            }
            catch { }
            const limited = results.slice(0, maxResults);
            if (limited.length === 0) {
                return jsonResult({ message: "No dispatch history found matching the criteria.", results: [] });
            }
            const formatted = limited.map(r => {
                const parts = [`**${r.identifier}** — ${r.status} (${r.tier}, ${r.attempts} attempts)${r.active ? " [ACTIVE]" : ""}`];
                if (r.summary)
                    parts.push(`  ${r.summary}`);
                return parts.join("\n");
            }).join("\n\n");
            return jsonResult({
                message: `Found ${limited.length} dispatch(es):\n\n${formatted}`,
                results: limited,
            });
        },
    };
}
function matchesFilters(identifier, tier, status, params) {
    if (params.tier && tier !== params.tier)
        return false;
    if (params.status && status !== params.status)
        return false;
    if (params.query && !identifier.toLowerCase().includes(params.query.toLowerCase()))
        return false;
    return true;
}
function parseFrontmatter(content) {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match)
        return {};
    const result = {};
    for (const line of match[1].split("\n")) {
        const [key, ...rest] = line.split(": ");
        if (key && rest.length > 0) {
            let value = rest.join(": ").trim();
            if (value.startsWith('"') && value.endsWith('"'))
                value = value.slice(1, -1);
            else if (!isNaN(Number(value)))
                value = Number(value);
            result[key.trim()] = value;
        }
    }
    return result;
}
function extractSummaryExcerpt(content, query) {
    // Remove frontmatter
    const body = content.replace(/^---[\s\S]*?---\n?/, "").trim();
    if (!query)
        return body.slice(0, 200);
    // Find the query in the body and return surrounding context
    const lower = body.toLowerCase();
    const idx = lower.indexOf(query.toLowerCase());
    if (idx === -1)
        return body.slice(0, 200);
    const start = Math.max(0, idx - 50);
    const end = Math.min(body.length, idx + query.length + 150);
    return (start > 0 ? "..." : "") + body.slice(start, end) + (end < body.length ? "..." : "");
}
