import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createNoopNotifier,
  createDiscordNotifier,
  type NotifyPayload,
} from "./notify.js";

// ---------------------------------------------------------------------------
// Noop notifier
// ---------------------------------------------------------------------------

describe("createNoopNotifier", () => {
  it("returns function that resolves without error", async () => {
    const notify = createNoopNotifier();
    await expect(notify("dispatch", {
      identifier: "API-1",
      title: "test",
      status: "dispatched",
    })).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Discord notifier
// ---------------------------------------------------------------------------

describe("createDiscordNotifier", () => {
  const botToken = "test-bot-token";
  const channelId = "123456";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stubFetch(): { getCalls: () => { url: string; body: any }[] } {
    const calls: { url: string; body: any }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, opts: any) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, status: 200 } as Response;
    }));
    return { getCalls: () => calls };
  }

  const basePayload: NotifyPayload = {
    identifier: "API-42",
    title: "Fix auth",
    status: "dispatched",
  };

  it("formats dispatch message", async () => {
    const { getCalls } = stubFetch();
    const notify = createDiscordNotifier(botToken, channelId);
    await notify("dispatch", basePayload);
    expect(getCalls()).toHaveLength(1);
    const msg = getCalls()[0].body.content;
    expect(msg).toContain("**API-42**");
    expect(msg).toContain("dispatched");
    expect(msg).toContain("Fix auth");
  });

  it("formats working message with attempt", async () => {
    const { getCalls } = stubFetch();
    const notify = createDiscordNotifier(botToken, channelId);
    await notify("working", { ...basePayload, status: "working", attempt: 1 });
    const msg = getCalls()[0].body.content;
    expect(msg).toContain("worker started");
    expect(msg).toContain("attempt 1");
  });

  it("formats audit_pass message", async () => {
    const { getCalls } = stubFetch();
    const notify = createDiscordNotifier(botToken, channelId);
    await notify("audit_pass", { ...basePayload, status: "done", verdict: { pass: true } });
    const msg = getCalls()[0].body.content;
    expect(msg).toContain("passed audit");
    expect(msg).toContain("PR ready");
  });

  it("formats audit_fail message with gaps", async () => {
    const { getCalls } = stubFetch();
    const notify = createDiscordNotifier(botToken, channelId);
    await notify("audit_fail", {
      ...basePayload,
      status: "working",
      attempt: 1,
      verdict: { pass: false, gaps: ["no tests", "missing validation"] },
    });
    const msg = getCalls()[0].body.content;
    expect(msg).toContain("failed audit");
    expect(msg).toContain("no tests");
    expect(msg).toContain("missing validation");
  });

  it("formats escalation message", async () => {
    const { getCalls } = stubFetch();
    const notify = createDiscordNotifier(botToken, channelId);
    await notify("escalation", {
      ...basePayload,
      status: "stuck",
      reason: "audit failed 3x",
    });
    const msg = getCalls()[0].body.content;
    expect(msg).toContain("needs human review");
    expect(msg).toContain("audit failed 3x");
  });

  it("formats watchdog_kill message", async () => {
    const { getCalls } = stubFetch();
    const notify = createDiscordNotifier(botToken, channelId);
    await notify("watchdog_kill", {
      ...basePayload,
      status: "stuck",
      attempt: 0,
      reason: "no I/O for 120s",
    });
    const msg = getCalls()[0].body.content;
    expect(msg).toContain("killed by watchdog");
    expect(msg).toContain("no I/O for 120s");
    expect(msg).toContain("attempt 0");
  });

  it("handles fetch failure gracefully", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network error");
    }));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const notify = createDiscordNotifier(botToken, channelId);
    // Should not throw
    await expect(notify("dispatch", basePayload)).resolves.toBeUndefined();
    consoleSpy.mockRestore();
  });

  it("sends to correct Discord API URL", async () => {
    const { getCalls } = stubFetch();
    const notify = createDiscordNotifier(botToken, channelId);
    await notify("dispatch", basePayload);
    expect(getCalls()[0].url).toContain(`/channels/${channelId}/messages`);
  });

  it("formats auditing message", async () => {
    const { getCalls } = stubFetch();
    const notify = createDiscordNotifier(botToken, channelId);
    await notify("auditing", { ...basePayload, status: "auditing" });
    const msg = getCalls()[0].body.content;
    expect(msg).toContain("audit in progress");
  });

  it("formats stuck message", async () => {
    const { getCalls } = stubFetch();
    const notify = createDiscordNotifier(botToken, channelId);
    await notify("stuck", { ...basePayload, status: "stuck", reason: "stale 2h" });
    const msg = getCalls()[0].body.content;
    expect(msg).toContain("stuck");
    expect(msg).toContain("stale 2h");
  });

  it("handles non-ok response gracefully", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    })));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const notify = createDiscordNotifier(botToken, channelId);
    await expect(notify("dispatch", basePayload)).resolves.toBeUndefined();
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
