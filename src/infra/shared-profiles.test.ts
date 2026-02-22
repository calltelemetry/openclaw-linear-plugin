import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockReadFileSync, mockWriteFileSync, mockMkdirSync, mockExistsSync } = vi.hoisted(() => ({
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockExistsSync: vi.fn().mockReturnValue(true),
}));

vi.mock("node:fs", () => ({
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  mkdirSync: mockMkdirSync,
  existsSync: mockExistsSync,
}));

// ---------------------------------------------------------------------------
// Imports (AFTER mocks)
// ---------------------------------------------------------------------------

import {
  loadAgentProfiles,
  buildMentionPattern,
  resolveAgentFromAlias,
  resolveDefaultAgent,
  createAgentProfilesFile,
  validateProfiles,
  PROFILES_PATH,
  _resetProfilesCacheForTesting,
  type AgentProfile,
} from "./shared-profiles.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROFILES_JSON = JSON.stringify({
  agents: {
    mal: {
      label: "Mal",
      mission: "Product owner",
      mentionAliases: ["mason", "mal"],
      appAliases: ["ctclaw"],
      isDefault: true,
      avatarUrl: "https://example.com/mal.png",
    },
    kaylee: {
      label: "Kaylee",
      mission: "Builder",
      mentionAliases: ["eureka", "kaylee"],
      avatarUrl: "https://example.com/kaylee.png",
    },
    inara: {
      label: "Inara",
      mission: "Content",
      mentionAliases: ["forge", "inara"],
    },
  },
});

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  _resetProfilesCacheForTesting();
  mockReadFileSync.mockReturnValue(PROFILES_JSON);
  mockExistsSync.mockReturnValue(true);
});

afterEach(() => {
  _resetProfilesCacheForTesting();
});

// ---------------------------------------------------------------------------
// loadAgentProfiles
// ---------------------------------------------------------------------------

describe("loadAgentProfiles", () => {
  it("loads and parses profiles from JSON file", () => {
    const profiles = loadAgentProfiles();

    expect(profiles).toHaveProperty("mal");
    expect(profiles).toHaveProperty("kaylee");
    expect(profiles).toHaveProperty("inara");
    expect(profiles.mal.label).toBe("Mal");
    expect(profiles.mal.isDefault).toBe(true);
  });

  it("caches profiles for 5 seconds", () => {
    loadAgentProfiles();
    loadAgentProfiles();
    loadAgentProfiles();

    // Should only read file once (subsequent calls hit cache)
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
  });

  it("reloads after cache expires", () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);

    loadAgentProfiles();
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);

    // Advance past TTL (5s)
    vi.spyOn(Date, "now").mockReturnValue(now + 6_000);

    loadAgentProfiles();
    expect(mockReadFileSync).toHaveBeenCalledTimes(2);

    vi.restoreAllMocks();
  });

  it("returns empty object when file is missing", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const profiles = loadAgentProfiles();
    expect(profiles).toEqual({});
  });

  it("returns empty object when JSON is invalid", () => {
    mockReadFileSync.mockReturnValue("not valid json{{{");

    const profiles = loadAgentProfiles();
    expect(profiles).toEqual({});
  });

  it("returns empty object when agents key is missing", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ version: 1 }));

    const profiles = loadAgentProfiles();
    expect(profiles).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// buildMentionPattern
// ---------------------------------------------------------------------------

describe("buildMentionPattern", () => {
  it("builds regex matching all mention aliases", () => {
    const profiles = loadAgentProfiles();
    const pattern = buildMentionPattern(profiles);

    expect(pattern).not.toBeNull();
    // Use .match() instead of .test() to avoid global regex lastIndex statefulness
    expect("@mason".match(pattern!)).not.toBeNull();
    expect("@mal".match(pattern!)).not.toBeNull();
    expect("@eureka".match(pattern!)).not.toBeNull();
    expect("@kaylee".match(pattern!)).not.toBeNull();
    expect("@forge".match(pattern!)).not.toBeNull();
    expect("@inara".match(pattern!)).not.toBeNull();
  });

  it("does NOT match appAliases", () => {
    const profiles = loadAgentProfiles();
    const pattern = buildMentionPattern(profiles);

    // appAliases like "ctclaw" should not be in the mention pattern
    expect("@ctclaw".match(pattern!)).toBeNull();
  });

  it("is case-insensitive", () => {
    const profiles = loadAgentProfiles();
    const pattern = buildMentionPattern(profiles);

    expect("@Mason".match(pattern!)).not.toBeNull();
    expect("@KAYLEE".match(pattern!)).not.toBeNull();
  });

  it("returns null when no profiles have aliases", () => {
    const pattern = buildMentionPattern({});
    expect(pattern).toBeNull();
  });

  it("returns null when all aliases are empty arrays", () => {
    const pattern = buildMentionPattern({
      agent1: { label: "A", mission: "test", mentionAliases: [] },
    });
    expect(pattern).toBeNull();
  });

  it("escapes regex special chars in aliases", () => {
    const profiles: Record<string, AgentProfile> = {
      test: {
        label: "Test",
        mission: "test",
        mentionAliases: ["agent.name", "agent+plus"],
      },
    };
    const pattern = buildMentionPattern(profiles);
    expect(pattern).not.toBeNull();
    // Should match literal dot, not "any char"
    expect(pattern!.test("@agent.name")).toBe(true);
    expect(pattern!.test("@agentXname")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveAgentFromAlias
// ---------------------------------------------------------------------------

describe("resolveAgentFromAlias", () => {
  it("resolves known alias to agent", () => {
    const profiles = loadAgentProfiles();
    const result = resolveAgentFromAlias("mason", profiles);

    expect(result).toEqual({ agentId: "mal", label: "Mal" });
  });

  it("resolves case-insensitively", () => {
    const profiles = loadAgentProfiles();
    const result = resolveAgentFromAlias("EUREKA", profiles);

    expect(result).toEqual({ agentId: "kaylee", label: "Kaylee" });
  });

  it("returns null for unknown alias", () => {
    const profiles = loadAgentProfiles();
    const result = resolveAgentFromAlias("wash", profiles);

    expect(result).toBeNull();
  });

  it("returns null for empty profiles", () => {
    const result = resolveAgentFromAlias("anything", {});
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveDefaultAgent
// ---------------------------------------------------------------------------

describe("resolveDefaultAgent", () => {
  it("returns defaultAgentId from pluginConfig when set", () => {
    const api = { pluginConfig: { defaultAgentId: "kaylee" } } as any;
    const result = resolveDefaultAgent(api);
    expect(result).toBe("kaylee");
  });

  it("falls back to isDefault profile when no config", () => {
    const api = { pluginConfig: {} } as any;
    const result = resolveDefaultAgent(api);
    expect(result).toBe("mal");
  });

  it("returns 'default' when no config and no profiles", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const api = { pluginConfig: {} } as any;
    const result = resolveDefaultAgent(api);
    expect(result).toBe("default");
  });

  it("ignores empty string in pluginConfig", () => {
    const api = { pluginConfig: { defaultAgentId: "" } } as any;
    const result = resolveDefaultAgent(api);
    // Should fall through to profile default
    expect(result).toBe("mal");
  });
});

// ---------------------------------------------------------------------------
// createAgentProfilesFile
// ---------------------------------------------------------------------------

describe("createAgentProfilesFile", () => {
  it("writes correct JSON structure to PROFILES_PATH", () => {
    createAgentProfilesFile({
      agentId: "bobbin",
      label: "Bobbin",
      mentionAliases: ["bobbin", "bob"],
    });

    expect(mockMkdirSync).toHaveBeenCalledTimes(1);
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);

    const [path, content] = mockWriteFileSync.mock.calls[0];
    expect(path).toBe(PROFILES_PATH);

    const parsed = JSON.parse(content);
    expect(parsed.agents.bobbin).toEqual({
      label: "Bobbin",
      mission: "AI assistant for Linear issues",
      isDefault: true,
      mentionAliases: ["bobbin", "bob"],
    });
  });

  it("uses custom mission when provided", () => {
    createAgentProfilesFile({
      agentId: "claw",
      label: "The Claw",
      mentionAliases: ["claw"],
      mission: "Code review specialist",
    });

    const [, content] = mockWriteFileSync.mock.calls[0];
    const parsed = JSON.parse(content);
    expect(parsed.agents.claw.mission).toBe("Code review specialist");
  });

  it("creates parent directory recursively", () => {
    createAgentProfilesFile({
      agentId: "test",
      label: "Test",
      mentionAliases: ["test"],
    });

    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.any(String),
      { recursive: true },
    );
  });

  it("busts the profile cache", () => {
    // Load to populate cache
    loadAgentProfiles();
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);

    // Create a new profile — should bust cache
    createAgentProfilesFile({
      agentId: "fresh",
      label: "Fresh",
      mentionAliases: ["fresh"],
    });

    // Next load should re-read from disk (cache was busted)
    loadAgentProfiles();
    expect(mockReadFileSync).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// validateProfiles
// ---------------------------------------------------------------------------

describe("validateProfiles", () => {
  it("returns error when file is missing", () => {
    mockExistsSync.mockReturnValue(false);

    const result = validateProfiles();
    expect(result).not.toBeNull();
    expect(result).toContain("not found");
    expect(result).toContain("openclaw openclaw-linear setup");
  });

  it("returns null when file is valid with agents", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(PROFILES_JSON);

    const result = validateProfiles();
    expect(result).toBeNull();
  });

  it("returns error when JSON is invalid", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => { throw new SyntaxError("Unexpected token"); });

    const result = validateProfiles();
    expect(result).not.toBeNull();
    expect(result).toContain("could not be parsed");
  });

  it("returns error when agents object is empty", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ agents: {} }));

    const result = validateProfiles();
    expect(result).not.toBeNull();
    expect(result).toContain("no agents configured");
  });
});
