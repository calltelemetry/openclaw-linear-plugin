/**
 * multi-repo.ts — Multi-repo resolution for dispatches spanning multiple git repos.
 *
 * Four-tier resolution:
 * 1. Issue body markers: <!-- repos: api, frontend --> or [repos: api, frontend]
 * 2. Linear labels: repo:api, repo:frontend
 * 3. Team mapping: teamMappings[teamKey].repos from plugin config
 * 4. Config default: Falls back to single codexBaseRepo
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
/**
 * Parse the repos config, normalizing both string and object formats.
 * String values become { path: value }, objects pass through.
 */
export function getRepoEntries(pluginConfig) {
    const repos = pluginConfig?.repos;
    if (!repos)
        return {};
    const result = {};
    for (const [name, value] of Object.entries(repos)) {
        if (typeof value === "string") {
            result[name] = { path: value };
        }
        else if (value && typeof value === "object") {
            result[name] = {
                path: value.path,
                github: value.github,
                hostname: value.hostname,
            };
        }
    }
    return result;
}
/**
 * Build candidate repositories for Linear's issueRepositorySuggestions API.
 * Extracts GitHub identity from enriched repo entries.
 */
export function buildCandidateRepositories(pluginConfig) {
    const entries = getRepoEntries(pluginConfig);
    return Object.values(entries)
        .filter(e => e.github)
        .map(e => ({
        hostname: e.hostname ?? "github.com",
        repositoryFullName: e.github,
    }));
}
/**
 * Resolve which repos a dispatch should work with.
 */
export function resolveRepos(description, labels, pluginConfig, teamKey) {
    // 1. Check issue body for repo markers
    // Match: <!-- repos: name1, name2 --> or [repos: name1, name2]
    const htmlComment = description?.match(/<!--\s*repos:\s*([^>]+?)\s*-->/i);
    const bracketMatch = description?.match(/\[repos:\s*([^\]]+)\]/i);
    const bodyMatch = htmlComment?.[1] ?? bracketMatch?.[1];
    if (bodyMatch) {
        const names = bodyMatch.split(",").map(s => s.trim()).filter(Boolean);
        if (names.length > 0) {
            const repoMap = getRepoMap(pluginConfig);
            const repos = names.map(name => ({
                name,
                path: repoMap[name] ?? resolveRepoPath(name, pluginConfig),
            }));
            return { repos, source: "issue_body" };
        }
    }
    // 2. Check labels for repo: prefix
    const repoLabels = labels
        .filter(l => l.startsWith("repo:"))
        .map(l => l.slice(5).trim())
        .filter(Boolean);
    if (repoLabels.length > 0) {
        const repoMap = getRepoMap(pluginConfig);
        const repos = repoLabels.map(name => ({
            name,
            path: repoMap[name] ?? resolveRepoPath(name, pluginConfig),
        }));
        return { repos, source: "labels" };
    }
    // 3. Team mapping: teamMappings[teamKey].repos
    if (teamKey) {
        const teamMappings = pluginConfig?.teamMappings;
        const teamRepoNames = teamMappings?.[teamKey]?.repos;
        if (teamRepoNames && teamRepoNames.length > 0) {
            const repoMap = getRepoMap(pluginConfig);
            const repos = teamRepoNames.map(name => ({
                name,
                path: repoMap[name] ?? resolveRepoPath(name, pluginConfig),
            }));
            return { repos, source: "team_mapping" };
        }
    }
    // 4. Config default: single repo
    const baseRepo = pluginConfig?.codexBaseRepo ?? path.join(homedir(), "ai-workspace");
    return {
        repos: [{ name: "default", path: baseRepo }],
        source: "config_default",
    };
}
function getRepoMap(pluginConfig) {
    const entries = getRepoEntries(pluginConfig);
    const result = {};
    for (const [name, entry] of Object.entries(entries)) {
        result[name] = entry.path;
    }
    return result;
}
function resolveRepoPath(name, pluginConfig) {
    // Convention: {parentDir}/{name}
    const baseRepo = pluginConfig?.codexBaseRepo ?? path.join(homedir(), "ai-workspace");
    const parentDir = path.dirname(baseRepo);
    return path.join(parentDir, name);
}
export function isMultiRepo(resolution) {
    return resolution.repos.length > 1;
}
/**
 * Validate a repo path: exists, is a git repo, and whether it's a submodule.
 * Submodules have a `.git` *file* (not directory) that points to the parent's
 * `.git/modules/` — `git worktree add` won't work on them.
 */
export function validateRepoPath(repoPath) {
    if (!existsSync(repoPath)) {
        return { exists: false, isGitRepo: false, isSubmodule: false };
    }
    const gitPath = path.join(repoPath, ".git");
    if (!existsSync(gitPath)) {
        return { exists: true, isGitRepo: false, isSubmodule: false };
    }
    const stat = statSync(gitPath);
    if (stat.isFile()) {
        // .git is a file → submodule (points to parent's .git/modules/)
        return { exists: true, isGitRepo: true, isSubmodule: true };
    }
    return { exists: true, isGitRepo: true, isSubmodule: false };
}
