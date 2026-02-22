import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  extractGuidance,
  extractGuidanceFromPromptContext,
  cacheGuidanceForTeam,
  getCachedGuidanceForTeam,
  formatGuidanceAppendix,
  isGuidanceEnabled,
  _resetGuidanceCacheForTesting,
} from "./guidance.js";

beforeEach(() => {
  _resetGuidanceCacheForTesting();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// extractGuidance
// ---------------------------------------------------------------------------

describe("extractGuidance", () => {
  it("extracts from top-level guidance field", () => {
    const result = extractGuidance({ guidance: "Always use main branch." });
    expect(result.guidance).toBe("Always use main branch.");
    expect(result.source).toBe("webhook");
  });

  it("falls back to promptContext when guidance is missing", () => {
    const result = extractGuidance({
      promptContext: "## Guidance\nUse TypeScript.\n\n## Issue\nENG-123",
    });
    expect(result.guidance).toBe("Use TypeScript.");
    expect(result.source).toBe("promptContext");
  });

  it("prefers top-level guidance over promptContext", () => {
    const result = extractGuidance({
      guidance: "From top-level",
      promptContext: "## Guidance\nFrom promptContext",
    });
    expect(result.guidance).toBe("From top-level");
    expect(result.source).toBe("webhook");
  });

  it("returns null when neither field exists", () => {
    const result = extractGuidance({});
    expect(result.guidance).toBeNull();
    expect(result.source).toBeNull();
  });

  it("ignores empty/whitespace guidance", () => {
    const result = extractGuidance({ guidance: "   " });
    expect(result.guidance).toBeNull();
    expect(result.source).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractGuidanceFromPromptContext
// ---------------------------------------------------------------------------

describe("extractGuidanceFromPromptContext", () => {
  it("extracts from XML-style <guidance> tags", () => {
    const pc = "Some preamble.\n<guidance>Use Go for API work.\nAlways add tests.</guidance>\nMore stuff.";
    expect(extractGuidanceFromPromptContext(pc)).toBe("Use Go for API work.\nAlways add tests.");
  });

  it("extracts from markdown ## Guidance heading", () => {
    const pc = "## Issue\nENG-123\n\n## Guidance\nCommit messages must reference JIRA.\n\n## Comments\nSome comments.";
    expect(extractGuidanceFromPromptContext(pc)).toBe("Commit messages must reference JIRA.");
  });

  it("extracts from markdown # Guidance heading", () => {
    const pc = "# Guidance\nRun make test.\n\n# Issue\nENG-456";
    expect(extractGuidanceFromPromptContext(pc)).toBe("Run make test.");
  });

  it("returns null when no guidance section found", () => {
    const pc = "## Issue\nENG-123\n\n## Description\nSome text.";
    expect(extractGuidanceFromPromptContext(pc)).toBeNull();
  });

  it("handles guidance at end of string (no trailing heading)", () => {
    const pc = "## Guidance\nAlways use TypeScript.";
    expect(extractGuidanceFromPromptContext(pc)).toBe("Always use TypeScript.");
  });
});

// ---------------------------------------------------------------------------
// formatGuidanceAppendix
// ---------------------------------------------------------------------------

describe("formatGuidanceAppendix", () => {
  it("formats guidance as appendix block", () => {
    const result = formatGuidanceAppendix("Use main branch.");
    expect(result).toContain("## IMPORTANT — Workspace Guidance");
    expect(result).toContain("Use main branch.");
    expect(result).toMatch(/^---\n/);
    expect(result).toMatch(/\n---$/);
  });

  it("returns empty string for null", () => {
    expect(formatGuidanceAppendix(null)).toBe("");
  });

  it("returns empty string for empty string", () => {
    expect(formatGuidanceAppendix("")).toBe("");
  });

  it("returns empty string for whitespace-only", () => {
    expect(formatGuidanceAppendix("   \n  ")).toBe("");
  });

  it("truncates at 2000 chars", () => {
    const long = "x".repeat(3000);
    const result = formatGuidanceAppendix(long);
    // 2000 x's + the framing text
    expect(result).toContain("x".repeat(2000));
    expect(result).not.toContain("x".repeat(2001));
  });
});

// ---------------------------------------------------------------------------
// Cache: cacheGuidanceForTeam / getCachedGuidanceForTeam
// ---------------------------------------------------------------------------

describe("guidance cache", () => {
  it("stores and retrieves guidance by team ID", () => {
    cacheGuidanceForTeam("team-1", "Use TypeScript.");
    expect(getCachedGuidanceForTeam("team-1")).toBe("Use TypeScript.");
  });

  it("returns null for unknown team", () => {
    expect(getCachedGuidanceForTeam("team-unknown")).toBeNull();
  });

  it("returns null after TTL expiry", () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    cacheGuidanceForTeam("team-1", "guidance");

    // Advance 25 hours
    vi.spyOn(Date, "now").mockReturnValue(now + 25 * 60 * 60 * 1000);
    expect(getCachedGuidanceForTeam("team-1")).toBeNull();
  });

  it("evicts oldest entry when at capacity", () => {
    // Fill cache to 50 entries
    for (let i = 0; i < 50; i++) {
      cacheGuidanceForTeam(`team-${i}`, `guidance-${i}`);
    }
    expect(getCachedGuidanceForTeam("team-0")).toBe("guidance-0");

    // Adding one more should evict team-0 (oldest)
    cacheGuidanceForTeam("team-new", "new guidance");
    expect(getCachedGuidanceForTeam("team-0")).toBeNull();
    expect(getCachedGuidanceForTeam("team-new")).toBe("new guidance");
  });

  it("updates existing entry without eviction", () => {
    cacheGuidanceForTeam("team-1", "old");
    cacheGuidanceForTeam("team-1", "new");
    expect(getCachedGuidanceForTeam("team-1")).toBe("new");
  });

  it("clears on _resetGuidanceCacheForTesting", () => {
    cacheGuidanceForTeam("team-1", "guidance");
    _resetGuidanceCacheForTesting();
    expect(getCachedGuidanceForTeam("team-1")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isGuidanceEnabled
// ---------------------------------------------------------------------------

describe("isGuidanceEnabled", () => {
  it("returns true by default (no config)", () => {
    expect(isGuidanceEnabled(undefined, "team-1")).toBe(true);
  });

  it("returns true when enableGuidance not set", () => {
    expect(isGuidanceEnabled({}, "team-1")).toBe(true);
  });

  it("returns false when enableGuidance is false", () => {
    expect(isGuidanceEnabled({ enableGuidance: false }, "team-1")).toBe(false);
  });

  it("returns true when enableGuidance is true", () => {
    expect(isGuidanceEnabled({ enableGuidance: true }, "team-1")).toBe(true);
  });

  it("team override true overrides workspace false", () => {
    const config = {
      enableGuidance: false,
      teamGuidanceOverrides: { "team-1": true },
    };
    expect(isGuidanceEnabled(config, "team-1")).toBe(true);
  });

  it("team override false overrides workspace true", () => {
    const config = {
      enableGuidance: true,
      teamGuidanceOverrides: { "team-1": false },
    };
    expect(isGuidanceEnabled(config, "team-1")).toBe(false);
  });

  it("unset team inherits workspace setting", () => {
    const config = {
      enableGuidance: false,
      teamGuidanceOverrides: { "team-other": true },
    };
    expect(isGuidanceEnabled(config, "team-1")).toBe(false);
  });

  it("works with undefined teamId", () => {
    expect(isGuidanceEnabled({ enableGuidance: false }, undefined)).toBe(false);
    expect(isGuidanceEnabled({ enableGuidance: true }, undefined)).toBe(true);
  });
});
