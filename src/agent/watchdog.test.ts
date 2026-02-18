import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoist the mock for readFileSync so resolveWatchdogConfig tests can control it
const { mockReadFileSync } = vi.hoisted(() => ({
  mockReadFileSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (...args: any[]) => mockReadFileSync(...args),
  };
});

import { InactivityWatchdog, resolveWatchdogConfig, DEFAULT_INACTIVITY_SEC, DEFAULT_MAX_TOTAL_SEC, DEFAULT_TOOL_TIMEOUT_SEC } from "./watchdog.js";

// ---------------------------------------------------------------------------
// InactivityWatchdog
// ---------------------------------------------------------------------------

describe("InactivityWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const makeLogger = () => ({
    info: vi.fn(),
    warn: vi.fn(),
  });

  it("fires onKill after inactivity threshold", () => {
    const onKill = vi.fn();
    const wd = new InactivityWatchdog({
      inactivityMs: 5_000,
      label: "test",
      logger: makeLogger(),
      onKill,
    });

    wd.start();
    vi.advanceTimersByTime(6_000);

    expect(onKill).toHaveBeenCalledOnce();
    expect(onKill).toHaveBeenCalledWith("inactivity");
    expect(wd.wasKilled).toBe(true);

    wd.stop();
  });

  it("tick() resets the timer", () => {
    const onKill = vi.fn();
    const wd = new InactivityWatchdog({
      inactivityMs: 5_000,
      label: "test",
      logger: makeLogger(),
      onKill,
    });

    wd.start();
    vi.advanceTimersByTime(4_000);
    expect(onKill).not.toHaveBeenCalled();

    wd.tick(); // reset at 4s

    vi.advanceTimersByTime(4_000); // now at 8s total, 4s since tick
    expect(onKill).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2_000); // now 6s since tick → should fire
    expect(onKill).toHaveBeenCalledOnce();

    wd.stop();
  });

  it("stop() prevents kill", () => {
    const onKill = vi.fn();
    const wd = new InactivityWatchdog({
      inactivityMs: 5_000,
      label: "test",
      logger: makeLogger(),
      onKill,
    });

    wd.start();
    vi.advanceTimersByTime(2_000);
    wd.stop();

    vi.advanceTimersByTime(10_000);
    expect(onKill).not.toHaveBeenCalled();
    expect(wd.wasKilled).toBe(false);
  });

  it("wasKilled is true after kill", () => {
    const onKill = vi.fn();
    const wd = new InactivityWatchdog({
      inactivityMs: 2_000,
      label: "test",
      logger: makeLogger(),
      onKill,
    });

    wd.start();
    expect(wd.wasKilled).toBe(false);

    vi.advanceTimersByTime(3_000);
    expect(wd.wasKilled).toBe(true);

    wd.stop();
  });

  it("silenceMs tracks time since last activity", () => {
    const onKill = vi.fn();
    const wd = new InactivityWatchdog({
      inactivityMs: 60_000,
      label: "test",
      logger: makeLogger(),
      onKill,
    });

    wd.start();
    vi.advanceTimersByTime(3_000);

    // silenceMs should be roughly 3000 (fake timers keep Date.now in sync)
    expect(wd.silenceMs).toBeGreaterThanOrEqual(3_000);

    wd.tick();
    expect(wd.silenceMs).toBeLessThan(100); // just ticked

    wd.stop();
  });

  it("start() is idempotent", () => {
    const onKill = vi.fn();
    const wd = new InactivityWatchdog({
      inactivityMs: 5_000,
      label: "test",
      logger: makeLogger(),
      onKill,
    });

    wd.start();
    wd.start(); // second call should be no-op
    wd.start(); // third call

    vi.advanceTimersByTime(6_000);
    // Should only fire once, not multiple times from duplicate timers
    expect(onKill).toHaveBeenCalledOnce();

    wd.stop();
  });

  it("handles async onKill errors gracefully", () => {
    const onKill = vi.fn().mockRejectedValue(new Error("kill failed"));
    const logger = makeLogger();
    const wd = new InactivityWatchdog({
      inactivityMs: 2_000,
      label: "test",
      logger,
      onKill,
    });

    wd.start();
    vi.advanceTimersByTime(3_000);

    expect(onKill).toHaveBeenCalledOnce();
    expect(wd.wasKilled).toBe(true);
    // Error is caught and logged, not thrown
    expect(logger.warn).toHaveBeenCalled();

    wd.stop();
  });

  it("handles sync onKill errors gracefully", () => {
    const onKill = vi.fn().mockImplementation(() => {
      throw new Error("sync kill error");
    });
    const logger = makeLogger();
    const wd = new InactivityWatchdog({
      inactivityMs: 2_000,
      label: "test",
      logger,
      onKill,
    });

    wd.start();
    // Should not throw
    vi.advanceTimersByTime(3_000);

    expect(onKill).toHaveBeenCalledOnce();
    expect(wd.wasKilled).toBe(true);
    expect(logger.warn).toHaveBeenCalled();

    wd.stop();
  });
});

// ---------------------------------------------------------------------------
// resolveWatchdogConfig
// ---------------------------------------------------------------------------

describe("resolveWatchdogConfig", () => {
  afterEach(() => {
    mockReadFileSync.mockReset();
  });

  it("reads from agent-profiles.json", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      agents: {
        zoe: {
          watchdog: { inactivitySec: 180, maxTotalSec: 7200, toolTimeoutSec: 900 },
        },
      },
    }));

    const config = resolveWatchdogConfig("zoe");
    expect(config.inactivityMs).toBe(180_000);
    expect(config.maxTotalMs).toBe(7_200_000);
    expect(config.toolTimeoutMs).toBe(900_000);
  });

  it("falls back to plugin config when agent profile not found", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("file not found");
    });

    const config = resolveWatchdogConfig("unknown-agent", {
      inactivitySec: 60,
      maxTotalSec: 3600,
      toolTimeoutSec: 300,
    });

    expect(config.inactivityMs).toBe(60_000);
    expect(config.maxTotalMs).toBe(3_600_000);
    expect(config.toolTimeoutMs).toBe(300_000);
  });

  it("falls back to defaults when no config available", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("file not found");
    });

    const config = resolveWatchdogConfig("nonexistent");
    expect(config.inactivityMs).toBe(DEFAULT_INACTIVITY_SEC * 1000);
    expect(config.maxTotalMs).toBe(DEFAULT_MAX_TOTAL_SEC * 1000);
    expect(config.toolTimeoutMs).toBe(DEFAULT_TOOL_TIMEOUT_SEC * 1000);
  });

  it("converts seconds to ms", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      agents: {
        mal: {
          watchdog: { inactivitySec: 60, maxTotalSec: 600, toolTimeoutSec: 300 },
        },
      },
    }));

    const config = resolveWatchdogConfig("mal");
    expect(config.inactivityMs).toBe(60 * 1000);
    expect(config.maxTotalMs).toBe(600 * 1000);
    expect(config.toolTimeoutMs).toBe(300 * 1000);
  });
});
