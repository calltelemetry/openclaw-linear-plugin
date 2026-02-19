import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the active-session module
vi.mock("../pipeline/active-session.js", () => ({
  getCurrentSession: vi.fn(() => null),
  getActiveSessionByIdentifier: vi.fn(() => null),
}));

// Mock the linear-api module — LinearAgentApi must be a class (used with `new`)
vi.mock("../api/linear-api.js", () => {
  const MockClass = vi.fn(function (this: any) {
    return this;
  });
  return {
    resolveLinearToken: vi.fn(() => ({ accessToken: null, source: "none" })),
    LinearAgentApi: MockClass,
  };
});

// Mock the watchdog module (re-exported constants)
vi.mock("../agent/watchdog.js", () => ({
  DEFAULT_INACTIVITY_SEC: 120,
  DEFAULT_MAX_TOTAL_SEC: 7200,
  DEFAULT_TOOL_TIMEOUT_SEC: 600,
}));

import { getCurrentSession, getActiveSessionByIdentifier } from "../pipeline/active-session.js";
import { resolveLinearToken, LinearAgentApi } from "../api/linear-api.js";
import { extractPrompt, resolveSession, buildLinearApi } from "./cli-shared.js";
import type { CliToolParams } from "./cli-shared.js";

const mockedGetCurrentSession = vi.mocked(getCurrentSession);
const mockedGetActiveByIdentifier = vi.mocked(getActiveSessionByIdentifier);
const mockedResolveLinearToken = vi.mocked(resolveLinearToken);
const MockedLinearAgentApi = vi.mocked(LinearAgentApi);

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// extractPrompt
// ---------------------------------------------------------------------------
describe("extractPrompt", () => {
  it("returns prompt field when present", () => {
    const params: CliToolParams = { prompt: "do the thing" };
    expect(extractPrompt(params)).toBe("do the thing");
  });

  it("falls back to text field", () => {
    const params = { text: "text fallback" } as unknown as CliToolParams;
    expect(extractPrompt(params)).toBe("text fallback");
  });

  it("falls back to message field", () => {
    const params = { message: "message fallback" } as unknown as CliToolParams;
    expect(extractPrompt(params)).toBe("message fallback");
  });

  it("falls back to task field", () => {
    const params = { task: "task fallback" } as unknown as CliToolParams;
    expect(extractPrompt(params)).toBe("task fallback");
  });

  it("returns undefined when no fields present", () => {
    const params = {} as unknown as CliToolParams;
    expect(extractPrompt(params)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveSession
// ---------------------------------------------------------------------------
describe("resolveSession", () => {
  it("uses explicit session params when provided", () => {
    const params: CliToolParams = {
      prompt: "test",
      agentSessionId: "sess-123",
      issueIdentifier: "API-42",
    };

    const result = resolveSession(params);
    expect(result.agentSessionId).toBe("sess-123");
    expect(result.issueIdentifier).toBe("API-42");
    // Should not consult the registry at all
    expect(mockedGetCurrentSession).not.toHaveBeenCalled();
    expect(mockedGetActiveByIdentifier).not.toHaveBeenCalled();
  });

  it("falls back to active session registry", () => {
    mockedGetCurrentSession.mockReturnValue({
      agentSessionId: "active-sess-456",
      issueIdentifier: "API-99",
      issueId: "issue-id-99",
      startedAt: Date.now(),
    });

    const params: CliToolParams = { prompt: "test" };
    const result = resolveSession(params);

    expect(result.agentSessionId).toBe("active-sess-456");
    expect(result.issueIdentifier).toBe("API-99");
    expect(mockedGetCurrentSession).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// buildLinearApi
// ---------------------------------------------------------------------------
describe("buildLinearApi", () => {
  it("returns null when no agentSessionId provided", () => {
    const api = { pluginConfig: {} } as any;
    expect(buildLinearApi(api)).toBeNull();
    expect(buildLinearApi(api, undefined)).toBeNull();
  });

  it("returns null when no token available", () => {
    mockedResolveLinearToken.mockReturnValue({
      accessToken: null,
      source: "none",
    });

    const api = { pluginConfig: {} } as any;
    expect(buildLinearApi(api, "sess-123")).toBeNull();
  });

  it("creates a LinearAgentApi when token is available", () => {
    mockedResolveLinearToken.mockReturnValue({
      accessToken: "lin_tok_abc",
      refreshToken: "refresh_xyz",
      expiresAt: 9999999999,
      source: "profile",
    });
    MockedLinearAgentApi.mockImplementation(function (this: any) {
      this.fake = true;
      return this;
    } as any);

    const api = {
      pluginConfig: {
        clientId: "cid",
        clientSecret: "csecret",
      },
    } as any;

    const result = buildLinearApi(api, "sess-123");
    expect(result).not.toBeNull();
    expect(MockedLinearAgentApi).toHaveBeenCalledWith("lin_tok_abc", {
      refreshToken: "refresh_xyz",
      expiresAt: 9999999999,
      clientId: "cid",
      clientSecret: "csecret",
    });
  });
});
