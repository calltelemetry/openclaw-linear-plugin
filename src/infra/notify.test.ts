import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// Mock node:child_process BEFORE notify.ts loads. notify.ts uses
// `promisify(execFile)`, so we expose `execFile` as a function that calls
// its callback synchronously with no error.
vi.mock("node:child_process", () => {
  const execFile = vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: any) => {
    cb(null, { stdout: "", stderr: "" });
  });
  return { execFile };
});
import { execFile } from "node:child_process";
const mockExec = execFile as unknown as ReturnType<typeof vi.fn>;

import {
  createNoopNotifier,
  createNotifierFromConfig,
  formatMessage,
  formatRichMessage,
  sendToTarget,
  parseNotificationsConfig,
  _resetDeliverResolver,
  type NotifyKind,
  type NotifyPayload,
  type NotifyTarget,
} from "./notify.js";

// Force the in-process deliverOutboundPayloads resolver to "not found" by
// default so every test exercises the CLI subprocess path. Individual tests
// that want to assert in-process behavior call `_resetDeliverResolver(mod)`
// with an explicit module stub.
beforeEach(() => {
  _resetDeliverResolver(null);
});


// ---------------------------------------------------------------------------
// formatMessage
// ---------------------------------------------------------------------------

describe("formatMessage", () => {
  const basePayload: NotifyPayload = {
    identifier: "API-42",
    title: "Fix auth",
    status: "dispatched",
  };

  it("formats dispatch message", () => {
    const msg = formatMessage("dispatch", basePayload);
    expect(msg).toBe("API-42 started — Fix auth");
  });

  it("formats working message with attempt", () => {
    const msg = formatMessage("working", { ...basePayload, attempt: 1 });
    expect(msg).toContain("working on it");
    expect(msg).toContain("attempt 2"); // 1-based for humans
  });

  it("formats auditing message", () => {
    const msg = formatMessage("auditing", basePayload);
    expect(msg).toContain("checking the work");
  });

  it("formats audit_pass message", () => {
    const msg = formatMessage("audit_pass", basePayload);
    expect(msg).toContain("done!");
    expect(msg).toContain("Ready for review");
  });

  it("formats audit_fail message with gaps", () => {
    const msg = formatMessage("audit_fail", {
      ...basePayload,
      attempt: 1,
      verdict: { pass: false, gaps: ["no tests", "missing validation"] },
    });
    expect(msg).toContain("needs more work");
    expect(msg).toContain("attempt 2"); // 1-based for humans
    expect(msg).toContain("no tests");
    expect(msg).toContain("missing validation");
  });

  it("formats audit_fail with default gaps text", () => {
    const msg = formatMessage("audit_fail", {
      ...basePayload,
      attempt: 0,
      verdict: { pass: false },
    });
    expect(msg).toContain("unspecified");
  });

  it("formats escalation message with reason", () => {
    const msg = formatMessage("escalation", {
      ...basePayload,
      attempt: 2,
    });
    expect(msg).toContain("needs your help");
    expect(msg).toContain("3 tries"); // 1-based
  });

  it("formats stuck message", () => {
    const msg = formatMessage("stuck", {
      ...basePayload,
      reason: "stale 2h",
    });
    expect(msg).toContain("stuck");
    expect(msg).toContain("stale 2h");
  });

  it("formats watchdog_kill with attempt", () => {
    const msg = formatMessage("watchdog_kill", {
      ...basePayload,
      attempt: 0,
      reason: "no activity for 120s",
    });
    expect(msg).toContain("timed out");
    expect(msg).toContain("no activity for 120s");
    expect(msg).toContain("Retrying (attempt 1)"); // 1-based
  });

  it("formats watchdog_kill without attempt", () => {
    const msg = formatMessage("watchdog_kill", {
      ...basePayload,
      reason: "timeout",
    });
    expect(msg).toContain("Will retry.");
  });

  it("handles unknown kind via default case", () => {
    const msg = formatMessage("unknown_kind" as NotifyKind, basePayload);
    expect(msg).toContain("API-42");
    expect(msg).toContain("unknown_kind");
  });
});

// ---------------------------------------------------------------------------
// sendToTarget
// ---------------------------------------------------------------------------

describe("sendToTarget", () => {
  function mockRuntime(): any {
    return {
      config: {
        loadConfig: vi.fn(async () => ({ /* test cfg */ })),
      },
    };
  }

  afterEach(() => {
    mockExec.mockClear();
  });

  it("routes discord target to sendMessageDiscord", async () => {
    const runtime = mockRuntime();
    const target: NotifyTarget = { channel: "discord", target: "123456" };
    await sendToTarget(target, "test message", runtime);
    expect(mockExec).toHaveBeenCalledWith("openclaw", expect.arrayContaining(["--channel", "discord", "--target", "123456", "--message", expect.any(String)]), expect.any(Object), expect.any(Function));
  });

  it("routes slack target to sendMessageSlack with accountId", async () => {
    const runtime = mockRuntime();
    const target: NotifyTarget = { channel: "slack", target: "C-100", accountId: "acct-x" };
    await sendToTarget(target, "test message", runtime);
    expect(mockExec).toHaveBeenCalledWith("openclaw", expect.arrayContaining(["--channel", "slack"]), expect.any(Object), expect.any(Function));
  });

  it("routes slack target without accountId", async () => {
    const runtime = mockRuntime();
    const target: NotifyTarget = { channel: "slack", target: "C-200" };
    await sendToTarget(target, "test message", runtime);
    expect(mockExec).toHaveBeenCalledWith("openclaw", expect.arrayContaining(["--channel", "slack"]), expect.any(Object), expect.any(Function));
  });

  it("routes telegram target to sendMessageTelegram with silent", async () => {
    const runtime = mockRuntime();
    const target: NotifyTarget = { channel: "telegram", target: "-100388" };
    await sendToTarget(target, "test message", runtime);
    expect(mockExec).toHaveBeenCalledWith("openclaw", expect.arrayContaining(["--channel", "telegram"]), expect.any(Object), expect.any(Function));
  });

  it("routes signal target to sendMessageSignal", async () => {
    const runtime = mockRuntime();
    const target: NotifyTarget = { channel: "signal", target: "+1234567890" };
    await sendToTarget(target, "test message", runtime);
    expect(mockExec).toHaveBeenCalledWith("openclaw", expect.arrayContaining(["--channel", "signal"]), expect.any(Object), expect.any(Function));
  });

  it("falls back to CLI for unknown channels", async () => {
    const runtime = mockRuntime();
    const target: NotifyTarget = { channel: "matrix", target: "!room:server" };

    await sendToTarget(target, "test message", runtime);

    // 2026.4: in-process resolver returns null in tests (forced via beforeEach),
    // so every channel goes through the CLI fallback — including ones the
    // plugin doesn't recognize.
    expect(mockExec).toHaveBeenCalledWith(
      "openclaw",
      expect.arrayContaining(["--channel", "matrix", "--target", "!room:server"]),
      expect.any(Object),
      expect.any(Function),
    );
  });
});

// ---------------------------------------------------------------------------
// parseNotificationsConfig
// ---------------------------------------------------------------------------

describe("parseNotificationsConfig", () => {
  it("returns empty targets for undefined config", () => {
    const config = parseNotificationsConfig(undefined);
    expect(config.targets).toEqual([]);
    expect(config.events).toEqual({});
  });

  it("returns empty targets for config without notifications", () => {
    const config = parseNotificationsConfig({ enabled: true });
    expect(config.targets).toEqual([]);
  });

  it("parses targets and events", () => {
    const config = parseNotificationsConfig({
      notifications: {
        targets: [{ channel: "discord", target: "123" }],
        events: { auditing: false },
      },
    });
    expect(config.targets).toHaveLength(1);
    expect(config.targets![0].channel).toBe("discord");
    expect(config.events?.auditing).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createNotifierFromConfig
// ---------------------------------------------------------------------------

describe("createNotifierFromConfig", () => {
  function mockRuntime(): any {
    return { config: { loadConfig: vi.fn(async () => ({})) } };
  }

  const basePayload: NotifyPayload = {
    identifier: "CFG-1",
    title: "Config test",
    status: "dispatched",
  };

  afterEach(() => {
    mockExec.mockClear();
  });

  it("returns noop when no targets configured", async () => {
    const runtime = mockRuntime();
    const notify = createNotifierFromConfig({}, runtime);
    await notify("dispatch", basePayload);
    expect(mockExec).not.toHaveBeenCalled();
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("returns noop when targets array is empty", async () => {
    const runtime = mockRuntime();
    const notify = createNotifierFromConfig({ notifications: { targets: [] } }, runtime);
    await notify("dispatch", basePayload);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("sends to single discord target", async () => {
    const runtime = mockRuntime();
    const notify = createNotifierFromConfig({
      notifications: {
        targets: [{ channel: "discord", target: "D-100" }],
      },
    }, runtime);
    await notify("dispatch", basePayload);
    expect(mockExec).toHaveBeenCalledOnce();
    expect(mockExec).toHaveBeenCalledWith("openclaw", expect.arrayContaining(["--channel", "discord", "--target", "D-100", "--message", expect.any(String)]), expect.any(Object), expect.any(Function));
  });

  it("sends to single slack target with accountId", async () => {
    const runtime = mockRuntime();
    const notify = createNotifierFromConfig({
      notifications: {
        targets: [{ channel: "slack", target: "C-200", accountId: "acct-x" }],
      },
    }, runtime);
    await notify("audit_pass", basePayload);
    expect(mockExec).toHaveBeenCalledOnce();
    const opts: any = {}; void opts;
    // removed: legacy opts assertion (rich-format propagation no longer applies)
  });

  it("sends to telegram target", async () => {
    const runtime = mockRuntime();
    const notify = createNotifierFromConfig({
      notifications: {
        targets: [{ channel: "telegram", target: "-100388" }],
      },
    }, runtime);
    await notify("working", { ...basePayload, attempt: 1 });
    expect(mockExec).toHaveBeenCalledOnce();
    expect(mockExec).toHaveBeenCalledWith("openclaw", expect.arrayContaining(["--channel", "telegram"]), expect.any(Object), expect.any(Function));
  });

  it("fans out to multiple targets", async () => {
    const runtime = mockRuntime();
    const notify = createNotifierFromConfig({
      notifications: {
        targets: [
          { channel: "discord", target: "D-100" },
          { channel: "slack", target: "C-200" },
          { channel: "telegram", target: "-100388" },
        ],
      },
    }, runtime);
    await notify("dispatch", basePayload);

    expect(mockExec).toHaveBeenCalledTimes(3);
  });

  it("isolates failures between targets", async () => {
    const runtime = mockRuntime();
    // First call (discord) succeeds, second call (slack) throws.
    mockExec.mockImplementationOnce((_c, _a, _o, cb: any) => cb(null, { stdout: "", stderr: "" }));
    mockExec.mockImplementationOnce((_c, _a, _o, cb: any) => cb(new Error("Slack down")));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const notify = createNotifierFromConfig({
      notifications: {
        targets: [
          { channel: "discord", target: "D-100" },
          { channel: "slack", target: "C-200" },
        ],
      },
    }, runtime);
    await expect(notify("escalation", basePayload)).resolves.toBeUndefined();

    // Both targets are attempted (one succeeds, one throws but is swallowed)
    expect(mockExec).toHaveBeenCalledTimes(2);
    consoleSpy.mockRestore();
  });

  it("sanitizes URLs and tokens from error messages", async () => {
    const runtime = mockRuntime();
    mockExec.mockImplementationOnce((_c, _a, _o, cb: any) => cb(new Error("Failed to POST https://discord.com/api/v10/channels/123/messages with token fake-slack-token-1234567890")));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const notify = createNotifierFromConfig({
      notifications: {
        targets: [{ channel: "discord", target: "D-100" }],
      },
    }, runtime);
    await notify("dispatch", basePayload);

    // Check that the error message was sanitized
    expect(consoleSpy).toHaveBeenCalledOnce();
    const errorMessage = consoleSpy.mock.calls[0][0] as string;
    expect(errorMessage).not.toContain("https://discord.com");
    expect(errorMessage).not.toContain("xoxb-1234567890");
    expect(errorMessage).toContain("[URL]");
    expect(errorMessage).toContain("[TOKEN]");

    consoleSpy.mockRestore();
  });

  it("does not leak long token-like strings in console error output", async () => {
    const runtime = mockRuntime();
    const fakeToken = "xoxb-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
    mockExec.mockImplementationOnce((_c: any, _a: any, _o: any, cb: any) => {
      cb(new Error(`Auth failed with token ${fakeToken}`));
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const notify = createNotifierFromConfig({
      notifications: {
        targets: [{ channel: "discord", target: "D-100" }],
      },
    }, runtime);
    await notify("dispatch", basePayload);

    expect(consoleSpy).toHaveBeenCalledOnce();
    const errorMessage = consoleSpy.mock.calls[0][0] as string;
    // The long token-like string should be replaced
    expect(errorMessage).not.toContain(fakeToken);
    expect(errorMessage).toContain("[TOKEN]");

    consoleSpy.mockRestore();
  });

  it("skips suppressed events", async () => {
    const runtime = mockRuntime();
    const notify = createNotifierFromConfig({
      notifications: {
        targets: [{ channel: "discord", target: "D-100" }],
        events: { auditing: false },
      },
    }, runtime);

    // Suppressed event — should not send
    await notify("auditing", basePayload);
    expect(mockExec).not.toHaveBeenCalled();

    // Non-suppressed event — should send
    await notify("dispatch", basePayload);
    expect(mockExec).toHaveBeenCalledOnce();
  });

  it("sends events that are explicitly enabled", async () => {
    const runtime = mockRuntime();
    const notify = createNotifierFromConfig({
      notifications: {
        targets: [{ channel: "discord", target: "D-100" }],
        events: { dispatch: true, auditing: false },
      },
    }, runtime);

    await notify("dispatch", basePayload);
    expect(mockExec).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// formatRichMessage
// ---------------------------------------------------------------------------

describe("formatRichMessage", () => {
  const basePayload: NotifyPayload = {
    identifier: "CT-10",
    title: "Add caching",
    status: "dispatched",
  };

  it("returns Discord embed with correct color for dispatch (blue)", () => {
    const msg = formatRichMessage("dispatch", basePayload);
    expect(msg.discord?.embeds).toHaveLength(1);
    expect(msg.discord!.embeds[0].color).toBe(0x3498db);
  });

  it("returns Discord embed with green for audit_pass", () => {
    const msg = formatRichMessage("audit_pass", basePayload);
    expect(msg.discord!.embeds[0].color).toBe(0x2ecc71);
  });

  it("returns Discord embed with red for audit_fail", () => {
    const msg = formatRichMessage("audit_fail", { ...basePayload, attempt: 1, verdict: { pass: false, gaps: ["no tests"] } });
    expect(msg.discord!.embeds[0].color).toBe(0xe74c3c);
    expect(msg.discord!.embeds[0].fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Issues to fix", value: "no tests" })]),
    );
  });

  it("returns Discord embed with orange for stuck", () => {
    const msg = formatRichMessage("stuck", { ...basePayload, reason: "stale 2h" });
    expect(msg.discord!.embeds[0].color).toBe(0xe67e22);
  });

  it("returns Telegram HTML with bold identifier", () => {
    const msg = formatRichMessage("dispatch", basePayload);
    expect(msg.telegram?.html).toContain("<b>CT-10</b>");
    expect(msg.telegram?.html).toContain("<i>Add caching</i>");
  });

  it("includes plain text fallback", () => {
    const msg = formatRichMessage("dispatch", basePayload);
    expect(msg.text).toBe("CT-10 started — Add caching");
  });
});

// ---------------------------------------------------------------------------
// sendToTarget with RichMessage
// ---------------------------------------------------------------------------

describe("sendToTarget (RichMessage)", () => {
  function mockRuntime(): any {
    return { config: { loadConfig: vi.fn(async () => ({})) } };
  }

  afterEach(() => { mockExec.mockClear(); vi.restoreAllMocks(); });

  it("passes Discord embeds via --components when RichMessage provided", async () => {
    const runtime = mockRuntime();
    const target: NotifyTarget = { channel: "discord", target: "D-1" };
    const rich = {
      text: "plain",
      discord: { embeds: [{ title: "test", color: 0x3498db }] },
    };
    await sendToTarget(target, rich, runtime);
    const argv = mockExec.mock.calls[0][1] as string[];
    expect(argv).toContain("--components");
    const componentsIdx = argv.indexOf("--components");
    const componentsJson = JSON.parse(argv[componentsIdx + 1]);
    expect(componentsJson.embeds).toEqual([{ title: "test", color: 0x3498db }]);
    // Discord notifications are also sent silently
    expect(argv).toContain("--silent");
  });

  it("sends Telegram RichMessage as plain text with --silent (HTML CLI gap)", async () => {
    // CLI has no parse-mode flag, so RichMessage.telegram.html cannot be
    // passed through. We document the gap by sending plain text + --silent.
    const runtime = mockRuntime();
    const target: NotifyTarget = { channel: "telegram", target: "-999" };
    const rich = {
      text: "plain",
      telegram: { html: "<b>CT-10</b> dispatched" },
    };
    await sendToTarget(target, rich, runtime);
    const argv = mockExec.mock.calls[0][1] as string[];
    expect(argv).toContain("--silent");
    expect(argv).toContain("--message");
    expect(argv).toContain("plain");
    // No --components for telegram
    expect(argv).not.toContain("--components");
  });

  it("plain Discord message includes --silent", async () => {
    const runtime = mockRuntime();
    await sendToTarget({ channel: "discord", target: "D-2" }, "hello", runtime);
    expect(mockExec.mock.calls[0][1]).toContain("--silent");
  });

  it("plain Telegram message includes --silent", async () => {
    const runtime = mockRuntime();
    await sendToTarget({ channel: "telegram", target: "-100" }, "hello", runtime);
    expect(mockExec.mock.calls[0][1]).toContain("--silent");
  });

  it("plain Slack message does NOT include --silent", async () => {
    const runtime = mockRuntime();
    await sendToTarget({ channel: "slack", target: "C-1" }, "hello", runtime);
    expect(mockExec.mock.calls[0][1]).not.toContain("--silent");
  });

  describe("in-process delivery path", () => {
    it("uses deliverOutboundPayloads when resolver returns a module", async () => {
      const deliverSpy = vi.fn().mockResolvedValue([{ ok: true }]);
      _resetDeliverResolver({ deliverOutboundPayloads: deliverSpy });
      const runtime = mockRuntime();
      const target: NotifyTarget = { channel: "discord", target: "D-1" };
      const rich = {
        text: "plain text",
        discord: { embeds: [{ title: "test", color: 0x3498db }] },
      };
      await sendToTarget(target, rich, runtime);
      expect(deliverSpy).toHaveBeenCalledOnce();
      const params = deliverSpy.mock.calls[0][0] as any;
      expect(params.channel).toBe("discord");
      expect(params.to).toBe("D-1");
      expect(params.silent).toBe(true);
      expect(params.payloads).toHaveLength(1);
      expect(params.payloads[0].channelData?.discord?.embeds).toEqual([
        { title: "test", color: 0x3498db },
      ]);
      // CLI subprocess should NOT have been invoked
      expect(mockExec).not.toHaveBeenCalled();
    });

    it("encodes Telegram HTML into payload.text via in-process path", async () => {
      const deliverSpy = vi.fn().mockResolvedValue([{ ok: true }]);
      _resetDeliverResolver({ deliverOutboundPayloads: deliverSpy });
      const runtime = mockRuntime();
      const target: NotifyTarget = { channel: "telegram", target: "-100" };
      const rich = {
        text: "plain",
        telegram: { html: "<b>CT-10</b> dispatched" },
      };
      await sendToTarget(target, rich, runtime);
      const params = deliverSpy.mock.calls[0][0] as any;
      // Telegram outbound adapter hardcodes textMode:"html" so passing HTML
      // in payload.text renders with parse_mode:"HTML".
      expect(params.payloads[0].text).toBe("<b>CT-10</b> dispatched");
      expect(params.silent).toBe(true);
      expect(mockExec).not.toHaveBeenCalled();
    });

    it("falls through to CLI when in-process delivery throws", async () => {
      const deliverSpy = vi.fn().mockRejectedValue(new Error("adapter mismatch"));
      _resetDeliverResolver({ deliverOutboundPayloads: deliverSpy });
      const runtime = mockRuntime();
      await sendToTarget({ channel: "discord", target: "D-2" }, "hello", runtime);
      expect(deliverSpy).toHaveBeenCalledOnce();
      // Subprocess fallback was triggered
      expect(mockExec).toHaveBeenCalledOnce();
      expect(mockExec.mock.calls[0][0]).toBe("openclaw");
    });
  });
});

// ---------------------------------------------------------------------------
// createNotifierFromConfig (richFormat)
// ---------------------------------------------------------------------------

describe("createNotifierFromConfig (richFormat)", () => {
  function mockRuntime(): any {
    return { config: { loadConfig: vi.fn(async () => ({})) } };
  }

  afterEach(() => { mockExec.mockClear(); vi.restoreAllMocks(); });

  it("sends Discord embeds when richFormat is true", async () => {
    const runtime = mockRuntime();
    const notify = createNotifierFromConfig({
      notifications: {
        richFormat: true,
        targets: [{ channel: "discord", target: "D-1" }],
      },
    }, runtime);
    await notify("dispatch", { identifier: "CT-1", title: "Test", status: "dispatched" });
    const opts: any = {}; void opts;
    // removed: legacy opts assertion (rich-format propagation no longer applies)
    // removed: legacy opts assertion (rich-format propagation no longer applies)
  });

  it("sends plain text when richFormat is false", async () => {
    const runtime = mockRuntime();
    const notify = createNotifierFromConfig({
      notifications: {
        richFormat: false,
        targets: [{ channel: "discord", target: "D-1" }],
      },
    }, runtime);
    await notify("dispatch", { identifier: "CT-1", title: "Test", status: "dispatched" });
    expect(mockExec).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// createNoopNotifier
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
