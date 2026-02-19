import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock dependencies so we can control runAgentOnce behavior
const mockRunEmbedded = vi.fn();
const mockRunSubprocess = vi.fn();
const mockGetExtensionAPI = vi.fn();
const mockResolveWatchdogConfig = vi.fn().mockReturnValue({
  inactivityMs: 120_000,
  maxTotalMs: 7_200_000,
  toolTimeoutMs: 600_000,
});

vi.mock("./watchdog.js", () => ({
  InactivityWatchdog: class {
    wasKilled = false;
    silenceMs = 0;
    start() {}
    tick() {}
    stop() {}
  },
  resolveWatchdogConfig: (...args: any[]) => mockResolveWatchdogConfig(...args),
}));

// We need to test the runAgent retry wrapper. Since runAgentOnce is internal,
// we test through runAgent by controlling the embedded/subprocess behavior.
// The simplest approach: mock the entire module internals via the extension API.

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn().mockReturnValue("{}"),
    mkdirSync: vi.fn(),
  };
});

import { runAgent } from "./agent.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

function createApi(): OpenClawPluginApi {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    runtime: {
      config: {
        loadConfig: vi.fn().mockReturnValue({ agents: { list: [] } }),
      },
      system: {
        runCommandWithTimeout: vi.fn().mockResolvedValue({
          code: 0,
          stdout: JSON.stringify({ result: { payloads: [{ text: "subprocess output" }] } }),
          stderr: "",
        }),
      },
    },
    pluginConfig: {},
  } as unknown as OpenClawPluginApi;
}

describe("runAgent subprocess", () => {
  it("extracts text from JSON payloads", async () => {
    const api = createApi();
    (api.runtime.system as any).runCommandWithTimeout = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ result: { payloads: [{ text: "hello" }, { text: "world" }] } }),
      stderr: "",
    });

    const result = await runAgent({
      api,
      agentId: "test-agent",
      sessionId: "session-1",
      message: "do something",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("hello");
    expect(result.output).toContain("world");
  });

  it("uses raw stdout when JSON parsing fails", async () => {
    const api = createApi();
    (api.runtime.system as any).runCommandWithTimeout = vi.fn().mockResolvedValue({
      code: 0,
      stdout: "plain text output",
      stderr: "",
    });

    const result = await runAgent({
      api,
      agentId: "test-agent",
      sessionId: "session-1",
      message: "do something",
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("plain text output");
  });

  it("uses stderr when command fails with no stdout", async () => {
    const api = createApi();
    (api.runtime.system as any).runCommandWithTimeout = vi.fn().mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "error from stderr",
    });

    const result = await runAgent({
      api,
      agentId: "test-agent",
      sessionId: "session-1",
      message: "do something",
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("error from stderr");
  });

  it("includes agentId in command arguments", async () => {
    const api = createApi();
    const runCmd = vi.fn().mockResolvedValue({
      code: 0,
      stdout: "ok",
      stderr: "",
    });
    (api.runtime.system as any).runCommandWithTimeout = runCmd;

    await runAgent({
      api,
      agentId: "my-agent",
      sessionId: "session-1",
      message: "test",
    });

    const args = runCmd.mock.calls[0][0];
    expect(args).toContain("my-agent");
    expect(args).toContain("--agent");
  });

  it("passes timeout in seconds to subprocess", async () => {
    const api = createApi();
    const runCmd = vi.fn().mockResolvedValue({
      code: 0,
      stdout: "ok",
      stderr: "",
    });
    (api.runtime.system as any).runCommandWithTimeout = runCmd;

    await runAgent({
      api,
      agentId: "test",
      sessionId: "session-1",
      message: "test",
      timeoutMs: 60_000,
    });

    const args: string[] = runCmd.mock.calls[0][0];
    const timeoutIdx = args.indexOf("--timeout");
    expect(timeoutIdx).toBeGreaterThan(-1);
    expect(args[timeoutIdx + 1]).toBe("60");
  });

  it("handles empty payloads array", async () => {
    const api = createApi();
    (api.runtime.system as any).runCommandWithTimeout = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ result: { payloads: [] } }),
      stderr: "",
    });

    const result = await runAgent({
      api,
      agentId: "test",
      sessionId: "s1",
      message: "test",
    });

    expect(result.success).toBe(true);
    // Falls back to raw stdout when no payload text
    expect(result.output).toBeTruthy();
  });

  it("handles null payloads text", async () => {
    const api = createApi();
    (api.runtime.system as any).runCommandWithTimeout = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ result: { payloads: [{ text: null }, { text: "real" }] } }),
      stderr: "",
    });

    const result = await runAgent({
      api,
      agentId: "test",
      sessionId: "s1",
      message: "test",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("real");
  });
});

describe("runAgent retry wrapper", () => {
  it("returns success on first attempt when no watchdog kill", async () => {
    const api = createApi();
    // Mock subprocess fallback (no streaming → uses subprocess)
    (api.runtime.system as any).runCommandWithTimeout = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ result: { payloads: [{ text: "done" }] } }),
      stderr: "",
    });

    const result = await runAgent({
      api,
      agentId: "test-agent",
      sessionId: "session-1",
      message: "do something",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("done");
    // Should only call once
    expect((api.runtime.system as any).runCommandWithTimeout).toHaveBeenCalledOnce();
  });

  it("returns failure without retry on normal (non-watchdog) failure", async () => {
    const api = createApi();
    (api.runtime.system as any).runCommandWithTimeout = vi.fn().mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "some error",
    });

    const result = await runAgent({
      api,
      agentId: "test-agent",
      sessionId: "session-1",
      message: "do something",
    });

    expect(result.success).toBe(false);
    expect(result.watchdogKilled).toBeUndefined();
    // Only one attempt — no retry for non-watchdog failures
    expect((api.runtime.system as any).runCommandWithTimeout).toHaveBeenCalledOnce();
  });

  it("does not retry on success", async () => {
    const api = createApi();
    const runCmd = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ result: { payloads: [{ text: "all good" }] } }),
      stderr: "",
    });
    (api.runtime.system as any).runCommandWithTimeout = runCmd;

    const result = await runAgent({
      api,
      agentId: "test-agent",
      sessionId: "session-1",
      message: "do something",
    });

    expect(result.success).toBe(true);
    expect(runCmd).toHaveBeenCalledOnce();
  });
});
