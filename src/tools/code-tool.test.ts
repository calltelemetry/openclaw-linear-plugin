import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock node:fs so loadCodingConfig can be tested
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

// Mock heavy runner dependencies — we only test resolution/config logic
vi.mock("./codex-tool.js", () => ({
  runCodex: vi.fn(),
}));
vi.mock("./claude-tool.js", () => ({
  runClaude: vi.fn(),
}));
vi.mock("./gemini-tool.js", () => ({
  runGemini: vi.fn(),
}));
vi.mock("../pipeline/active-session.js", () => ({
  getCurrentSession: vi.fn(() => null),
}));
vi.mock("openclaw/plugin-sdk", () => ({
  jsonResult: vi.fn((v: unknown) => v),
}));

import { readFileSync } from "node:fs";
import type { CodingToolsConfig } from "./code-tool.js";
import { loadCodingConfig, resolveCodingBackend } from "./code-tool.js";

// buildAliasMap and resolveAlias are not exported, so we test them indirectly
// through the module's behaviour. However, for direct testing we can re-derive
// the same logic here with a small helper that mirrors the source (or just
// test through resolveCodingBackend / createCodeTool).
//
// Since buildAliasMap and resolveAlias are private, we import the module source
// and test their effects through the public API. For unit-level tests we
// replicate the minimal logic inline.

// Inline copies of the private helpers, matching the source exactly.
// This lets us unit-test alias mapping without exporting internals.
type CodingBackend = "claude" | "codex" | "gemini";

const BACKEND_IDS: CodingBackend[] = ["claude", "codex", "gemini"];

function buildAliasMap(config: CodingToolsConfig): Map<string, CodingBackend> {
  const map = new Map<string, CodingBackend>();
  for (const backendId of BACKEND_IDS) {
    map.set(backendId, backendId);
    const aliases = config.backends?.[backendId]?.aliases;
    if (aliases) {
      for (const alias of aliases) {
        map.set(alias.toLowerCase(), backendId);
      }
    }
  }
  return map;
}

function resolveAlias(
  aliasMap: Map<string, CodingBackend>,
  input: string,
): CodingBackend | undefined {
  return aliasMap.get(input.toLowerCase());
}

const mockedReadFileSync = vi.mocked(readFileSync);

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// loadCodingConfig
// ---------------------------------------------------------------------------
describe("loadCodingConfig", () => {
  it("loads valid coding-tools.json", () => {
    const validConfig: CodingToolsConfig = {
      codingTool: "gemini",
      agentCodingTools: { kaylee: "codex" },
      backends: {
        gemini: { aliases: ["gem"] },
      },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(validConfig));

    const result = loadCodingConfig();
    expect(result).toEqual(validConfig);
  });

  it("returns defaults when file not found", () => {
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });

    const result = loadCodingConfig();
    expect(result).toEqual({});
  });

  it("returns defaults for invalid JSON", () => {
    mockedReadFileSync.mockReturnValue("{ not valid json !!!");

    const result = loadCodingConfig();
    expect(result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// buildAliasMap
// ---------------------------------------------------------------------------
describe("buildAliasMap", () => {
  it("maps backend IDs as aliases", () => {
    const map = buildAliasMap({});

    expect(map.get("claude")).toBe("claude");
    expect(map.get("codex")).toBe("codex");
    expect(map.get("gemini")).toBe("gemini");
  });

  it("includes configured aliases from backends", () => {
    const config: CodingToolsConfig = {
      backends: {
        claude: { aliases: ["CC", "anthropic"] },
        gemini: { aliases: ["Gem", "Google"] },
      },
    };

    const map = buildAliasMap(config);

    // Aliases should be lowercased
    expect(map.get("cc")).toBe("claude");
    expect(map.get("anthropic")).toBe("claude");
    expect(map.get("gem")).toBe("gemini");
    expect(map.get("google")).toBe("gemini");

    // Backend IDs still present
    expect(map.get("claude")).toBe("claude");
    expect(map.get("gemini")).toBe("gemini");
    expect(map.get("codex")).toBe("codex");
  });
});

// ---------------------------------------------------------------------------
// resolveAlias
// ---------------------------------------------------------------------------
describe("resolveAlias", () => {
  const config: CodingToolsConfig = {
    backends: {
      codex: { aliases: ["OpenAI", "ox"] },
    },
  };
  const aliasMap = buildAliasMap(config);

  it("finds match case-insensitively", () => {
    expect(resolveAlias(aliasMap, "OPENAI")).toBe("codex");
    expect(resolveAlias(aliasMap, "openai")).toBe("codex");
    expect(resolveAlias(aliasMap, "OX")).toBe("codex");
    expect(resolveAlias(aliasMap, "Claude")).toBe("claude");
    expect(resolveAlias(aliasMap, "GEMINI")).toBe("gemini");
  });

  it("returns undefined for unknown alias", () => {
    expect(resolveAlias(aliasMap, "unknown-backend")).toBeUndefined();
    expect(resolveAlias(aliasMap, "gpt")).toBeUndefined();
    expect(resolveAlias(aliasMap, "")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveCodingBackend
// ---------------------------------------------------------------------------
describe("resolveCodingBackend", () => {
  it("uses explicit backend parameter (per-agent override)", () => {
    const config: CodingToolsConfig = {
      codingTool: "gemini",
      agentCodingTools: { kaylee: "codex" },
    };

    // Even though global says gemini, kaylee has codex
    expect(resolveCodingBackend(config, "kaylee")).toBe("codex");
  });

  it("uses per-agent override from agentCodingTools", () => {
    const config: CodingToolsConfig = {
      codingTool: "claude",
      agentCodingTools: {
        inara: "gemini",
        mal: "codex",
      },
    };

    expect(resolveCodingBackend(config, "inara")).toBe("gemini");
    expect(resolveCodingBackend(config, "mal")).toBe("codex");
  });

  it("falls back to global codingTool default", () => {
    const config: CodingToolsConfig = {
      codingTool: "gemini",
      agentCodingTools: { kaylee: "codex" },
    };

    // Agent "mal" has no override, so global "gemini" is used
    expect(resolveCodingBackend(config, "mal")).toBe("gemini");
    // No agent ID at all
    expect(resolveCodingBackend(config)).toBe("gemini");
  });

  it("falls back to codex when no config provided", () => {
    expect(resolveCodingBackend({})).toBe("codex");
    expect(resolveCodingBackend({}, "anyAgent")).toBe("codex");
  });
});
