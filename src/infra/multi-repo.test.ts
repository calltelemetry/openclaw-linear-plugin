import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveRepos, isMultiRepo, validateRepoPath, type RepoResolution } from "./multi-repo.ts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
    statSync: vi.fn(),
  };
});

import { existsSync, statSync } from "node:fs";
const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;
const mockStatSync = statSync as ReturnType<typeof vi.fn>;

describe("resolveRepos", () => {
  it("parses <!-- repos: api, frontend --> from description", () => {
    const result = resolveRepos(
      "Fix the bug\n<!-- repos: api, frontend -->",
      [],
    );
    expect(result.source).toBe("issue_body");
    expect(result.repos).toHaveLength(2);
    expect(result.repos[0].name).toBe("api");
    expect(result.repos[1].name).toBe("frontend");
  });

  it("parses [repos: web, worker] from description", () => {
    const result = resolveRepos(
      "Some issue\n[repos: web, worker]",
      [],
    );
    expect(result.source).toBe("issue_body");
    expect(result.repos).toHaveLength(2);
    expect(result.repos[0].name).toBe("web");
    expect(result.repos[1].name).toBe("worker");
  });

  it("extracts from repo:api and repo:frontend labels", () => {
    const result = resolveRepos("No markers here", ["repo:api", "repo:frontend"]);
    expect(result.source).toBe("labels");
    expect(result.repos).toHaveLength(2);
    expect(result.repos[0].name).toBe("api");
    expect(result.repos[1].name).toBe("frontend");
  });

  it("falls back to config repos when no markers/labels", () => {
    const config = { codexBaseRepo: "/home/claw/myproject" };
    const result = resolveRepos("Plain description", [], config);
    expect(result.source).toBe("config_default");
    expect(result.repos).toHaveLength(1);
    expect(result.repos[0].name).toBe("default");
    expect(result.repos[0].path).toBe("/home/claw/myproject");
  });

  it("body markers take priority over labels", () => {
    const result = resolveRepos(
      "<!-- repos: api -->",
      ["repo:frontend"],
    );
    expect(result.source).toBe("issue_body");
    expect(result.repos).toHaveLength(1);
    expect(result.repos[0].name).toBe("api");
  });

  it("returns single repo from codexBaseRepo when no repos config", () => {
    const result = resolveRepos("Nothing special", []);
    expect(result.source).toBe("config_default");
    expect(result.repos).toHaveLength(1);
    expect(result.repos[0].name).toBe("default");
    expect(result.repos[0].path).toBe("/home/claw/ai-workspace");
  });

  it("handles empty description + no labels (single repo fallback)", () => {
    const result = resolveRepos("", []);
    expect(result.source).toBe("config_default");
    expect(result.repos).toHaveLength(1);
    expect(result.repos[0].name).toBe("default");
  });

  it("trims whitespace in repo names from markers", () => {
    const result = resolveRepos(
      "<!-- repos:  api ,  frontend  -->",
      [],
    );
    expect(result.source).toBe("issue_body");
    expect(result.repos[0].name).toBe("api");
    expect(result.repos[1].name).toBe("frontend");
  });

  it("handles null/undefined description", () => {
    const resultNull = resolveRepos(null, []);
    expect(resultNull.source).toBe("config_default");
    expect(resultNull.repos).toHaveLength(1);

    const resultUndefined = resolveRepos(undefined, []);
    expect(resultUndefined.source).toBe("config_default");
    expect(resultUndefined.repos).toHaveLength(1);
  });
});

describe("isMultiRepo", () => {
  it("returns true for 2+ repos", () => {
    const resolution: RepoResolution = {
      repos: [
        { name: "api", path: "/home/claw/api" },
        { name: "frontend", path: "/home/claw/frontend" },
      ],
      source: "issue_body",
    };
    expect(isMultiRepo(resolution)).toBe(true);
  });

  it("returns false for 1 repo", () => {
    const resolution: RepoResolution = {
      repos: [{ name: "default", path: "/home/claw/ai-workspace" }],
      source: "config_default",
    };
    expect(isMultiRepo(resolution)).toBe(false);
  });

  it("returns false for empty result", () => {
    const resolution: RepoResolution = {
      repos: [],
      source: "config_default",
    };
    expect(isMultiRepo(resolution)).toBe(false);
  });
});

describe("validateRepoPath", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns exists:false for missing path", () => {
    mockExistsSync.mockReturnValue(false);
    const result = validateRepoPath("/no/such/path");
    expect(result).toEqual({ exists: false, isGitRepo: false, isSubmodule: false });
  });

  it("returns isGitRepo:true, isSubmodule:false for normal repo (.git is directory)", () => {
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ isFile: () => false, isDirectory: () => true });
    const result = validateRepoPath("/home/claw/repos/api");
    expect(result).toEqual({ exists: true, isGitRepo: true, isSubmodule: false });
  });

  it("returns isGitRepo:true, isSubmodule:true for submodule (.git is file)", () => {
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ isFile: () => true, isDirectory: () => false });
    const result = validateRepoPath("/home/claw/workspace/submod");
    expect(result).toEqual({ exists: true, isGitRepo: true, isSubmodule: true });
  });

  it("returns isGitRepo:false for directory without .git", () => {
    // First call: path exists. Second call: .git does not exist
    mockExistsSync.mockImplementation((p: string) => !String(p).endsWith(".git"));
    const result = validateRepoPath("/home/claw/not-a-repo");
    expect(result).toEqual({ exists: true, isGitRepo: false, isSubmodule: false });
  });
});
