import { describe, it, expect, vi } from "vitest";
import { emitDiagnostic, type DiagnosticPayload } from "./observability.ts";

function makeApi(infoFn = vi.fn()) {
  return { logger: { info: infoFn } } as any;
}

describe("emitDiagnostic", () => {
  it("emits JSON with [linear:diagnostic] prefix via api.logger.info", () => {
    const info = vi.fn();
    const api = makeApi(info);
    emitDiagnostic(api, { event: "webhook_received", identifier: "ISS-42" });
    expect(info).toHaveBeenCalledOnce();
    const line = info.mock.calls[0][0] as string;
    expect(line).toMatch(/^\[linear:diagnostic\] \{/);
    const json = JSON.parse(line.replace("[linear:diagnostic] ", ""));
    expect(json.event).toBe("webhook_received");
    expect(json.identifier).toBe("ISS-42");
  });

  it("includes all payload fields in JSON output", () => {
    const info = vi.fn();
    const api = makeApi(info);
    const payload: DiagnosticPayload = {
      event: "dispatch_started",
      identifier: "ISS-99",
      issueId: "abc-123",
      phase: "planning",
      from: "triage",
      to: "execution",
      attempt: 2,
      tier: "gold",
      webhookType: "Comment",
      webhookAction: "create",
      channel: "discord",
      target: "kaylee",
      error: "none",
      durationMs: 1234,
    };
    emitDiagnostic(api, payload);
    const json = JSON.parse((info.mock.calls[0][0] as string).replace("[linear:diagnostic] ", ""));
    expect(json).toMatchObject(payload);
  });

  it("works with partial payload (only event + identifier)", () => {
    const info = vi.fn();
    const api = makeApi(info);
    emitDiagnostic(api, { event: "health_check" });
    const json = JSON.parse((info.mock.calls[0][0] as string).replace("[linear:diagnostic] ", ""));
    expect(json.event).toBe("health_check");
    expect(json.identifier).toBeUndefined();
  });

  it("never throws even if logger throws", () => {
    const api = makeApi(() => { throw new Error("logger exploded"); });
    expect(() => {
      emitDiagnostic(api, { event: "notify_failed", identifier: "ISS-1" });
    }).not.toThrow();
  });

  it("includes timestamp-relevant fields — payload is faithfully serialized", () => {
    const info = vi.fn();
    const api = makeApi(info);
    const now = Date.now();
    emitDiagnostic(api, { event: "phase_transition", identifier: "ISS-7", timestamp: now } as any);
    const json = JSON.parse((info.mock.calls[0][0] as string).replace("[linear:diagnostic] ", ""));
    expect(json.timestamp).toBe(now);
  });

  it("handles payload with special characters", () => {
    const info = vi.fn();
    const api = makeApi(info);
    emitDiagnostic(api, {
      event: "notify_sent",
      identifier: 'ISS-"special"',
      error: "line1\nline2\ttab",
      channel: "<script>alert('xss')</script>",
    });
    expect(info).toHaveBeenCalledOnce();
    const json = JSON.parse((info.mock.calls[0][0] as string).replace("[linear:diagnostic] ", ""));
    expect(json.identifier).toBe('ISS-"special"');
    expect(json.error).toBe("line1\nline2\ttab");
    expect(json.channel).toBe("<script>alert('xss')</script>");
  });
});
