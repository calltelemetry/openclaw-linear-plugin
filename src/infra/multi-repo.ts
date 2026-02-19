/**
 * multi-repo.ts — Multi-repo resolution for dispatches spanning multiple git repos.
 *
 * Three-tier resolution:
 * 1. Issue body markers: <!-- repos: api, frontend --> or [repos: api, frontend]
 * 2. Linear labels: repo:api, repo:frontend
 * 3. Config default: Falls back to single codexBaseRepo
 */

import { existsSync, statSync } from "node:fs";
import path from "node:path";

export interface RepoConfig {
  name: string;
  path: string;
}

export interface RepoResolution {
  repos: RepoConfig[];
  source: "issue_body" | "labels" | "config_default";
}

/**
 * Resolve which repos a dispatch should work with.
 */
export function resolveRepos(
  description: string | null | undefined,
  labels: string[],
  pluginConfig?: Record<string, unknown>,
): RepoResolution {
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

  // 3. Config default: single repo
  const baseRepo = (pluginConfig?.codexBaseRepo as string) ?? "/home/claw/ai-workspace";
  return {
    repos: [{ name: "default", path: baseRepo }],
    source: "config_default",
  };
}

function getRepoMap(pluginConfig?: Record<string, unknown>): Record<string, string> {
  const repos = pluginConfig?.repos as Record<string, string> | undefined;
  return repos ?? {};
}

function resolveRepoPath(name: string, pluginConfig?: Record<string, unknown>): string {
  // Convention: {parentDir}/{name}
  const baseRepo = (pluginConfig?.codexBaseRepo as string) ?? "/home/claw/ai-workspace";
  const parentDir = path.dirname(baseRepo);
  return path.join(parentDir, name);
}

export function isMultiRepo(resolution: RepoResolution): boolean {
  return resolution.repos.length > 1;
}

/**
 * Validate a repo path: exists, is a git repo, and whether it's a submodule.
 * Submodules have a `.git` *file* (not directory) that points to the parent's
 * `.git/modules/` — `git worktree add` won't work on them.
 */
export function validateRepoPath(repoPath: string): {
  exists: boolean;
  isGitRepo: boolean;
  isSubmodule: boolean;
} {
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
