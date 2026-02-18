/**
 * notify.ts — Simple notification function for dispatch lifecycle events.
 *
 * One concrete Discord implementation + noop fallback.
 * No abstract class — add provider abstraction only when a second
 * backend (Slack, email) actually exists.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NotifyKind =
  | "dispatch"       // issue dispatched to worker
  | "working"        // worker started
  | "auditing"       // audit triggered
  | "audit_pass"     // audit passed → done
  | "audit_fail"     // audit failed → rework
  | "escalation"     // 2x fail or stale → stuck
  | "stuck";         // stale detection

export interface NotifyPayload {
  identifier: string;
  title: string;
  status: string;
  attempt?: number;
  reason?: string;
  verdict?: { pass: boolean; gaps?: string[] };
}

export type NotifyFn = (kind: NotifyKind, payload: NotifyPayload) => Promise<void>;

// ---------------------------------------------------------------------------
// Discord implementation
// ---------------------------------------------------------------------------

const DISCORD_API = "https://discord.com/api/v10";

function formatDiscordMessage(kind: NotifyKind, payload: NotifyPayload): string {
  const prefix = `**${payload.identifier}**`;
  switch (kind) {
    case "dispatch":
      return `${prefix} dispatched — ${payload.title}`;
    case "working":
      return `${prefix} worker started (attempt ${payload.attempt ?? 0})`;
    case "auditing":
      return `${prefix} audit in progress`;
    case "audit_pass":
      return `${prefix} passed audit. PR ready.`;
    case "audit_fail": {
      const gaps = payload.verdict?.gaps?.join(", ") ?? "unspecified";
      return `${prefix} failed audit (attempt ${payload.attempt ?? 0}). Gaps: ${gaps}`;
    }
    case "escalation":
      return `🚨 ${prefix} needs human review — ${payload.reason ?? "audit failed 2x"}`;
    case "stuck":
      return `⏰ ${prefix} stuck — ${payload.reason ?? "stale 2h"}`;
    default:
      return `${prefix} — ${kind}: ${payload.status}`;
  }
}

export function createDiscordNotifier(botToken: string, channelId: string): NotifyFn {
  return async (kind, payload) => {
    const message = formatDiscordMessage(kind, payload);
    try {
      const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bot ${botToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: message }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(`Discord notify failed (${res.status}): ${body}`);
      }
    } catch (err) {
      console.error("Discord notify error:", err);
    }
  };
}

// ---------------------------------------------------------------------------
// Noop fallback
// ---------------------------------------------------------------------------

export function createNoopNotifier(): NotifyFn {
  return async () => {};
}
