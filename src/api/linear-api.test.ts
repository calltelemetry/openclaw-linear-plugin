import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { resolveLinearToken, LinearAgentApi, AUTH_PROFILES_PATH } from "./linear-api.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("./auth.js", () => ({
  refreshLinearToken: vi.fn(),
}));

vi.mock("../infra/resilience.js", () => ({
  withResilience: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

import { readFileSync, writeFileSync } from "node:fs";
import { refreshLinearToken } from "./auth.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockReadFileSync = readFileSync as Mock;
const mockWriteFileSync = writeFileSync as Mock;
const mockRefreshLinearToken = refreshLinearToken as Mock;

/** Build a minimal successful fetch Response. */
function okResponse(data: unknown, status = 200): Response {
  return {
    ok: true,
    status,
    json: () => Promise.resolve({ data }),
    text: () => Promise.resolve(JSON.stringify({ data })),
    headers: new Headers(),
  } as unknown as Response;
}

/** Build a failing fetch Response. */
function errorResponse(status: number, body = "error"): Response {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({ errors: [{ message: body }] }),
    text: () => Promise.resolve(body),
    headers: new Headers(),
  } as unknown as Response;
}

/** Build a response that carries GraphQL-level errors. */
function gqlErrorResponse(errors: Array<{ message: string }>): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ errors }),
    text: () => Promise.resolve(JSON.stringify({ errors })),
    headers: new Headers(),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let fetchMock: Mock;

beforeEach(() => {
  vi.restoreAllMocks();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  // Default: readFileSync throws (no profile file)
  mockReadFileSync.mockImplementation(() => {
    throw new Error("ENOENT");
  });

  // Clear env vars that could leak between tests
  delete process.env.LINEAR_ACCESS_TOKEN;
  delete process.env.LINEAR_API_KEY;
});

// ===========================================================================
// resolveLinearToken
// ===========================================================================

describe("resolveLinearToken", () => {
  it("returns token from pluginConfig.accessToken (source: config)", () => {
    const result = resolveLinearToken({ accessToken: "cfg-token-123" });
    expect(result).toEqual({ accessToken: "cfg-token-123", source: "config" });
  });

  it("returns token from auth profile store when config is empty (source: profile)", () => {
    const profileStore = {
      profiles: {
        "linear:default": {
          accessToken: "oauth-tok",
          refreshToken: "oauth-refresh",
          expiresAt: 9999999999999,
        },
      },
    };
    mockReadFileSync.mockReturnValue(JSON.stringify(profileStore));

    const result = resolveLinearToken();
    expect(result).toEqual({
      accessToken: "oauth-tok",
      refreshToken: "oauth-refresh",
      expiresAt: 9999999999999,
      source: "profile",
    });
    expect(mockReadFileSync).toHaveBeenCalledWith(AUTH_PROFILES_PATH, "utf8");
  });

  it("returns token from env var LINEAR_ACCESS_TOKEN when config and profile are empty (source: env)", () => {
    process.env.LINEAR_ACCESS_TOKEN = "env-token-abc";

    const result = resolveLinearToken();
    expect(result).toEqual({ accessToken: "env-token-abc", source: "env" });
  });

  it("returns token from env var LINEAR_API_KEY as fallback", () => {
    process.env.LINEAR_API_KEY = "api-key-xyz";

    const result = resolveLinearToken();
    expect(result).toEqual({ accessToken: "api-key-xyz", source: "env" });
  });

  it("returns null with source 'none' when nothing is configured", () => {
    const result = resolveLinearToken();
    expect(result).toEqual({ accessToken: null, source: "none" });
  });

  it("respects priority: config > profile > env", () => {
    // Set up all three sources
    const profileStore = {
      profiles: {
        "linear:default": {
          accessToken: "profile-tok",
          refreshToken: "profile-refresh",
        },
      },
    };
    mockReadFileSync.mockReturnValue(JSON.stringify(profileStore));
    process.env.LINEAR_ACCESS_TOKEN = "env-tok";

    // Config wins when present
    const r1 = resolveLinearToken({ accessToken: "config-tok" });
    expect(r1.source).toBe("config");
    expect(r1.accessToken).toBe("config-tok");

    // Profile wins over env when config is absent
    const r2 = resolveLinearToken();
    expect(r2.source).toBe("profile");
    expect(r2.accessToken).toBe("profile-tok");

    // Env is used when profile file is unreadable and no config
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const r3 = resolveLinearToken();
    expect(r3.source).toBe("env");
    expect(r3.accessToken).toBe("env-tok");
  });
});

// ===========================================================================
// LinearAgentApi
// ===========================================================================

describe("LinearAgentApi", () => {
  const TOKEN = "test-access-token";

  // -------------------------------------------------------------------------
  // gql — tested indirectly via public methods
  // -------------------------------------------------------------------------

  describe("gql (via public methods)", () => {
    it("sends correct headers and body", async () => {
      fetchMock.mockResolvedValueOnce(
        okResponse({ commentCreate: { success: true, comment: { id: "c1" } } }),
      );

      const api = new LinearAgentApi(TOKEN);
      await api.createComment("issue-1", "hello");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://api.linear.app/graphql");
      expect(init.method).toBe("POST");
      expect(init.headers["Content-Type"]).toBe("application/json");
      expect(init.headers["Authorization"]).toBe(TOKEN); // no Bearer — no refreshToken

      const body = JSON.parse(init.body);
      expect(body.query).toContain("CommentCreate");
      expect(body.variables.input.issueId).toBe("issue-1");
      expect(body.variables.input.body).toBe("hello");
    });

    it("returns data on success", async () => {
      fetchMock.mockResolvedValueOnce(
        okResponse({
          issueUpdate: { success: true },
        }),
      );

      const api = new LinearAgentApi(TOKEN);
      const result = await api.updateIssue("i1", { estimate: 3 });
      expect(result).toBe(true);
    });

    it("throws on non-ok response", async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(500, "Internal Server Error"));

      const api = new LinearAgentApi(TOKEN);
      await expect(api.updateIssue("i1", { estimate: 1 })).rejects.toThrow(
        /Linear API 500/,
      );
    });

    it("throws on GraphQL errors", async () => {
      fetchMock.mockResolvedValueOnce(
        gqlErrorResponse([{ message: "Field 'foo' not found" }]),
      );

      const api = new LinearAgentApi(TOKEN);
      await expect(api.updateIssue("i1", { estimate: 1 })).rejects.toThrow(
        /Linear GraphQL/,
      );
    });

    it("retries on 401 when refresh token is available", async () => {
      // First call (via withResilience): 401
      fetchMock.mockResolvedValueOnce(errorResponse(401, "Unauthorized"));
      // Retry (direct fetch, not through withResilience): succeeds
      fetchMock.mockResolvedValueOnce(
        okResponse({ issueUpdate: { success: true } }),
      );

      mockRefreshLinearToken.mockResolvedValueOnce({
        access_token: "new-token",
        refresh_token: "new-refresh",
        expires_in: 3600,
      });

      // readFileSync/writeFileSync for persistToken
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          profiles: { "linear:default": { accessToken: "old" } },
        }),
      );

      // Use expiresAt = 1 (truthy but in the past) so ensureValidToken triggers
      // the refresh on the 401 path when expiresAt is set to 0... actually
      // the code sets expiresAt=0 which is falsy, so ensureValidToken bails.
      // But the retry still happens — let's verify the retry occurs.
      const api = new LinearAgentApi(TOKEN, {
        refreshToken: "refresh-tok",
        expiresAt: Date.now() + 100_000,
        clientId: "cid",
        clientSecret: "csecret",
      });

      const result = await api.updateIssue("i1", { estimate: 2 });
      expect(result).toBe(true);

      // Two fetch calls: original (401) + retry after 401 handling
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // The retry request uses Bearer prefix (refreshToken is still set)
      const retryInit = fetchMock.mock.calls[1][1];
      expect(retryInit.headers["Authorization"]).toContain("Bearer");
    });

    it("throws after 401 refresh also fails", async () => {
      // First call: 401
      fetchMock.mockResolvedValueOnce(errorResponse(401, "Unauthorized"));
      // After refresh, retry still fails
      fetchMock.mockResolvedValueOnce(errorResponse(403, "Forbidden"));

      mockRefreshLinearToken.mockResolvedValueOnce({
        access_token: "refreshed-tok",
        expires_in: 3600,
      });

      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          profiles: { "linear:default": { accessToken: "old" } },
        }),
      );

      const api = new LinearAgentApi(TOKEN, {
        refreshToken: "r-tok",
        expiresAt: Date.now() + 100_000,
        clientId: "cid",
        clientSecret: "csecret",
      });

      await expect(api.updateIssue("i1", { estimate: 1 })).rejects.toThrow(
        /Linear API authentication failed/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // authHeader
  // -------------------------------------------------------------------------

  describe("authHeader (via request headers)", () => {
    it("uses 'Bearer' prefix when refreshToken is set", async () => {
      fetchMock.mockResolvedValueOnce(
        okResponse({ issueUpdate: { success: true } }),
      );

      const api = new LinearAgentApi(TOKEN, {
        refreshToken: "r-tok",
        expiresAt: Date.now() + 600_000, // far future — no refresh triggered
      });
      await api.updateIssue("i1", { estimate: 1 });

      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    });

    it("uses raw token when refreshToken is not set", async () => {
      fetchMock.mockResolvedValueOnce(
        okResponse({ issueUpdate: { success: true } }),
      );

      const api = new LinearAgentApi(TOKEN);
      await api.updateIssue("i1", { estimate: 1 });

      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers["Authorization"]).toBe(TOKEN);
    });
  });

  // -------------------------------------------------------------------------
  // Public methods
  // -------------------------------------------------------------------------

  describe("emitActivity", () => {
    it("calls the correct mutation with content payload", async () => {
      fetchMock.mockResolvedValueOnce(
        okResponse({ agentActivityCreate: { success: true } }),
      );

      const api = new LinearAgentApi(TOKEN);
      await api.emitActivity("session-1", { type: "thought", body: "thinking..." });

      const [, init] = fetchMock.mock.calls[0];
      const body = JSON.parse(init.body);
      expect(body.query).toContain("agentActivityCreate");
      expect(body.variables.input).toEqual({
        agentSessionId: "session-1",
        content: { type: "thought", body: "thinking..." },
      });
    });
  });

  describe("createComment", () => {
    it("sends correct input and returns comment id", async () => {
      fetchMock.mockResolvedValueOnce(
        okResponse({
          commentCreate: { success: true, comment: { id: "comment-abc" } },
        }),
      );

      const api = new LinearAgentApi(TOKEN);
      const id = await api.createComment("issue-99", "Test comment body", {
        createAsUser: "user-1",
        displayIconUrl: "https://example.com/icon.png",
      });

      expect(id).toBe("comment-abc");

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.variables.input).toEqual({
        issueId: "issue-99",
        body: "Test comment body",
        createAsUser: "user-1",
        displayIconUrl: "https://example.com/icon.png",
      });
    });
  });

  describe("getIssueDetails", () => {
    it("returns expected shape", async () => {
      const issueData = {
        id: "iss-1",
        identifier: "CT-123",
        title: "Fix the bug",
        description: "Something is broken",
        estimate: 3,
        state: { name: "In Progress" },
        assignee: { name: "Alice" },
        labels: { nodes: [{ id: "l1", name: "bug" }] },
        team: { id: "t1", name: "Engineering", issueEstimationType: "fibonacci" },
        comments: {
          nodes: [
            { body: "Looking into it", user: { name: "Bob" }, createdAt: "2026-01-01T00:00:00Z" },
          ],
        },
        project: { id: "p1", name: "Q1 Sprint" },
        parent: null,
        relations: { nodes: [] },
      };

      fetchMock.mockResolvedValueOnce(okResponse({ issue: issueData }));

      const api = new LinearAgentApi(TOKEN);
      const result = await api.getIssueDetails("iss-1");

      expect(result.id).toBe("iss-1");
      expect(result.identifier).toBe("CT-123");
      expect(result.title).toBe("Fix the bug");
      expect(result.description).toBe("Something is broken");
      expect(result.estimate).toBe(3);
      expect(result.state.name).toBe("In Progress");
      expect(result.assignee?.name).toBe("Alice");
      expect(result.labels.nodes).toHaveLength(1);
      expect(result.team.issueEstimationType).toBe("fibonacci");
      expect(result.comments.nodes).toHaveLength(1);
      expect(result.project?.name).toBe("Q1 Sprint");
      expect(result.parent).toBeNull();
      expect(result.relations.nodes).toHaveLength(0);

      // Verify variables sent
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.variables).toEqual({ id: "iss-1" });
    });
  });

  describe("updateIssue", () => {
    it("calls mutation and returns success boolean", async () => {
      fetchMock.mockResolvedValueOnce(
        okResponse({ issueUpdate: { success: true } }),
      );

      const api = new LinearAgentApi(TOKEN);
      const success = await api.updateIssue("iss-42", {
        estimate: 5,
        labelIds: ["l1", "l2"],
        stateId: "s1",
        priority: 2,
      });

      expect(success).toBe(true);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.query).toContain("issueUpdate");
      expect(body.variables).toEqual({
        id: "iss-42",
        input: {
          estimate: 5,
          labelIds: ["l1", "l2"],
          stateId: "s1",
          priority: 2,
        },
      });
    });
  });

  describe("createSessionOnIssue", () => {
    it("returns sessionId on success", async () => {
      fetchMock.mockResolvedValueOnce(
        okResponse({
          agentSessionCreateOnIssue: {
            success: true,
            agentSession: { id: "sess-new" },
          },
        }),
      );

      const api = new LinearAgentApi(TOKEN);
      const result = await api.createSessionOnIssue("iss-1");
      expect(result).toEqual({ sessionId: "sess-new" });
    });

    it("returns error on failure", async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(500, "Server Error"));

      const api = new LinearAgentApi(TOKEN);
      const result = await api.createSessionOnIssue("iss-bad");

      expect(result.sessionId).toBeNull();
      expect(result.error).toBeDefined();
      expect(result.error).toContain("Linear API 500");
    });
  });
});
