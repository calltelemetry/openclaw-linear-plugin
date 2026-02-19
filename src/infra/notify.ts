/**
 * notify.ts — Unified notification provider for dispatch lifecycle events.
 *
 * Uses OpenClaw's native runtime channel API for all providers (Discord, Slack,
 * Telegram, Signal, etc). One formatter, one send function, config-driven
 * fan-out with per-event-type toggles.
 *
 * Modeled on DevClaw's notify.ts pattern — the runtime handles token resolution,
 * formatting differences (markdown vs mrkdwn), and delivery per channel.
 */
import type { PluginRuntime, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emitDiagnostic } from "./observability.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NotifyKind =
  | "dispatch"          // issue dispatched to worker
  | "working"           // worker started
  | "auditing"          // audit triggered
  | "audit_pass"        // audit passed → done
  | "audit_fail"        // audit failed → rework
  | "escalation"        // 2x fail or stale → stuck
  | "stuck"             // stale detection
  | "watchdog_kill"     // agent killed by inactivity watchdog
  | "project_progress"  // DAG dispatch progress update
  | "project_complete"; // all project issues dispatched

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
// Provider config
// ---------------------------------------------------------------------------

export interface NotifyTarget {
  /** OpenClaw channel name: "discord", "slack", "telegram", "signal", etc. */
  channel: string;
  /** Channel/group/user ID to send to */
  target: string;
  /** Optional account ID for multi-account channel setups */
  accountId?: string;
}

export interface NotificationsConfig {
  targets?: NotifyTarget[];
  events?: Partial<Record<NotifyKind, boolean>>;
  /** Opt-in: send rich embeds (Discord) and HTML (Telegram) instead of plain text. */
  richFormat?: boolean;
}

// ---------------------------------------------------------------------------
// Rich message types (Discord embeds + Telegram HTML)
// ---------------------------------------------------------------------------

export interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
}

export interface RichMessage {
  text: string;
  discord?: { embeds: DiscordEmbed[] };
  telegram?: { html: string };
}

// ---------------------------------------------------------------------------
// Unified message formatter
// ---------------------------------------------------------------------------

export function formatMessage(kind: NotifyKind, payload: NotifyPayload): string {
  const id = payload.identifier;
  const attempt = (payload.attempt ?? 0) + 1; // 1-based for humans
  switch (kind) {
    case "dispatch":
      return `${id} started — ${payload.title}`;
    case "working":
      return `${id} working on it (attempt ${attempt})`;
    case "auditing":
      return `${id} checking the work...`;
    case "audit_pass":
      return `✅ ${id} done! Ready for review.`;
    case "audit_fail": {
      const issues = payload.verdict?.gaps?.join(", ") ?? "unspecified";
      return `${id} needs more work (attempt ${attempt}). Issues: ${issues}`;
    }
    case "escalation":
      return `🚨 ${id} needs your help — couldn't fix it after ${attempt} ${attempt === 1 ? "try" : "tries"}`;
    case "stuck":
      return `⏰ ${id} stuck — ${payload.reason ?? "inactive for 2h"}`;
    case "watchdog_kill":
      return `⚡ ${id} timed out (${payload.reason ?? "no activity for 120s"}). ${
        payload.attempt != null ? `Retrying (attempt ${attempt}).` : "Will retry."
      }`;
    case "project_progress":
      return `📊 ${payload.title} (${id}): ${payload.status}`;
    case "project_complete":
      return `✅ ${payload.title} (${id}): ${payload.status}`;
    default:
      return `${id} — ${kind}: ${payload.status}`;
  }
}

// ---------------------------------------------------------------------------
// Rich message formatter (Discord embeds + Telegram HTML)
// ---------------------------------------------------------------------------

const EVENT_COLORS: Record<string, number> = {
  dispatch: 0x3498db,       // blue
  working: 0x3498db,        // blue
  auditing: 0xf39c12,       // yellow
  audit_pass: 0x2ecc71,     // green
  audit_fail: 0xe74c3c,     // red
  escalation: 0xe74c3c,     // red
  stuck: 0xe67e22,          // orange
  watchdog_kill: 0x9b59b6,  // purple
  project_progress: 0x3498db,
  project_complete: 0x2ecc71,
};

export function formatRichMessage(kind: NotifyKind, payload: NotifyPayload): RichMessage {
  const text = formatMessage(kind, payload);
  const color = EVENT_COLORS[kind] ?? 0x95a5a6;

  // Discord embed
  const fields: DiscordEmbed["fields"] = [];
  if (payload.attempt != null) fields.push({ name: "Attempt", value: String((payload.attempt ?? 0) + 1), inline: true });
  if (payload.status) fields.push({ name: "Status", value: payload.status, inline: true });
  if (payload.verdict?.gaps?.length) {
    fields.push({ name: "Issues to fix", value: payload.verdict.gaps.join("\n").slice(0, 1024) });
  }
  if (payload.reason) fields.push({ name: "Reason", value: payload.reason });

  const embed: DiscordEmbed = {
    title: `${payload.identifier} — ${kind.replace(/_/g, " ")}`,
    description: payload.title,
    color,
    fields: fields.length > 0 ? fields : undefined,
    footer: { text: `Linear Agent • ${kind}` },
  };

  // Telegram HTML
  const htmlParts: string[] = [
    `<b>${escapeHtml(payload.identifier)}</b> — ${escapeHtml(kind.replace(/_/g, " "))}`,
    `<i>${escapeHtml(payload.title)}</i>`,
  ];
  if (payload.attempt != null) htmlParts.push(`Attempt: <code>${(payload.attempt ?? 0) + 1}</code>`);
  if (payload.status) htmlParts.push(`Status: <code>${escapeHtml(payload.status)}</code>`);
  if (payload.verdict?.gaps?.length) {
    htmlParts.push(`Issues to fix:\n${payload.verdict.gaps.map(g => `• ${escapeHtml(g)}`).join("\n")}`);
  }
  if (payload.reason) htmlParts.push(`Reason: ${escapeHtml(payload.reason)}`);

  return {
    text,
    discord: { embeds: [embed] },
    telegram: { html: htmlParts.join("\n") },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Unified send — routes to OpenClaw runtime channel API
// ---------------------------------------------------------------------------

export async function sendToTarget(
  target: NotifyTarget,
  message: string | RichMessage,
  runtime: PluginRuntime,
): Promise<void> {
  const ch = target.channel;
  const to = target.target;
  const isRich = typeof message !== "string";
  const plainText = isRich ? message.text : message;

  if (ch === "discord") {
    if (isRich && message.discord) {
      await runtime.channel.discord.sendMessageDiscord(to, plainText, { embeds: message.discord.embeds });
    } else {
      await runtime.channel.discord.sendMessageDiscord(to, plainText);
    }
  } else if (ch === "slack") {
    await runtime.channel.slack.sendMessageSlack(to, plainText, {
      accountId: target.accountId,
    });
  } else if (ch === "telegram") {
    if (isRich && message.telegram) {
      await runtime.channel.telegram.sendMessageTelegram(to, message.telegram.html, { silent: true, textMode: "html" });
    } else {
      await runtime.channel.telegram.sendMessageTelegram(to, plainText, { silent: true });
    }
  } else if (ch === "signal") {
    await runtime.channel.signal.sendMessageSignal(to, plainText);
  } else {
    // Fallback: use CLI for any channel the runtime doesn't expose directly
    const { execFileSync } = await import("node:child_process");
    execFileSync("openclaw", ["message", "send", "--channel", ch, "--target", to, "--message", plainText, "--json"], {
      timeout: 30_000,
      stdio: "ignore",
    });
  }
}

// ---------------------------------------------------------------------------
// Config-driven factory
// ---------------------------------------------------------------------------

/**
 * Parse notification config from plugin config.
 */
export function parseNotificationsConfig(
  pluginConfig: Record<string, unknown> | undefined,
): NotificationsConfig {
  const raw = pluginConfig?.notifications as NotificationsConfig | undefined;
  return {
    targets: raw?.targets ?? [],
    events: raw?.events ?? {},
    richFormat: raw?.richFormat ?? false,
  };
}

/**
 * Create a notifier from plugin config. Returns a NotifyFn that:
 * 1. Checks event toggles (skip suppressed events)
 * 2. Formats the message
 * 3. Fans out to all configured targets (failures isolated via Promise.allSettled)
 */
export function createNotifierFromConfig(
  pluginConfig: Record<string, unknown> | undefined,
  runtime: PluginRuntime,
  api?: OpenClawPluginApi,
): NotifyFn {
  const config = parseNotificationsConfig(pluginConfig);

  if (!config.targets?.length) return createNoopNotifier();

  const useRich = config.richFormat === true;

  return async (kind, payload) => {
    // Check event toggle — default is enabled (true)
    if (config.events?.[kind] === false) return;

    const message = useRich ? formatRichMessage(kind, payload) : formatMessage(kind, payload);

    await Promise.allSettled(
      config.targets!.map(async (target) => {
        try {
          await sendToTarget(target, message, runtime);
        } catch (err) {
          console.error(`Notify error (${target.channel}:${target.target}):`, err);
          if (api) {
            emitDiagnostic(api, {
              event: "notify_failed",
              identifier: payload.identifier,
              phase: kind,
              error: String(err),
            });
          }
        }
      }),
    );
  };
}

// ---------------------------------------------------------------------------
// Noop fallback
// ---------------------------------------------------------------------------

export function createNoopNotifier(): NotifyFn {
  return async () => {};
}
