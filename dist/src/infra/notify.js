/**
 * notify.ts — Unified notification provider for dispatch lifecycle events.
 *
 * Routes through OpenClaw's outbound delivery for all providers (Discord,
 * Slack, Telegram, Signal, etc). Two delivery paths:
 *
 *   1. **In-process** — calls `deliverOutboundPayloads` from the gateway's
 *      bundled outbound runtime. Fast (no subprocess), supports Telegram
 *      HTML and Discord channelData embeds. Resolved lazily at first call by
 *      scanning `openclaw/dist/deliver-*.js` for the matching export, since
 *      the bundle file name carries a build-time hash and is not in
 *      package.json `exports`.
 *
 *   2. **CLI subprocess fallback** — `openclaw message send …` via async
 *      `execFile`. Used when the in-process resolver can't find a matching
 *      `deliver-*.js` (e.g. an openclaw upgrade renamed bundles in a way the
 *      regex doesn't catch) or when the in-process call throws.
 *
 * 2026.4 dropped the per-channel `runtime.channel.<id>.sendMessage*` surface
 * and the public `plugin-sdk` does not re-export `deliverOutboundPayloads`,
 * so the only stable entrypoint is the CLI fallback. The in-process path is
 * a best-effort optimization that gracefully degrades.
 */
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { emitDiagnostic } from "./observability.js";
const execFileAsync = promisify(execFile);
// ---------------------------------------------------------------------------
// Unified message formatter
// ---------------------------------------------------------------------------
export function formatMessage(kind, payload) {
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
            return `⚡ ${id} timed out (${payload.reason ?? "no activity for 120s"}). ${payload.attempt != null ? `Retrying (attempt ${attempt}).` : "Will retry."}`;
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
const EVENT_COLORS = {
    dispatch: 0x3498db, // blue
    working: 0x3498db, // blue
    auditing: 0xf39c12, // yellow
    audit_pass: 0x2ecc71, // green
    audit_fail: 0xe74c3c, // red
    escalation: 0xe74c3c, // red
    stuck: 0xe67e22, // orange
    watchdog_kill: 0x9b59b6, // purple
    project_progress: 0x3498db,
    project_complete: 0x2ecc71,
};
export function formatRichMessage(kind, payload) {
    const text = formatMessage(kind, payload);
    const color = EVENT_COLORS[kind] ?? 0x95a5a6;
    // Discord embed
    const fields = [];
    if (payload.attempt != null)
        fields.push({ name: "Attempt", value: String((payload.attempt ?? 0) + 1), inline: true });
    if (payload.status)
        fields.push({ name: "Status", value: payload.status, inline: true });
    if (payload.verdict?.gaps?.length) {
        fields.push({ name: "Issues to fix", value: payload.verdict.gaps.join("\n").slice(0, 1024) });
    }
    if (payload.reason)
        fields.push({ name: "Reason", value: payload.reason });
    const embed = {
        title: `${payload.identifier} — ${kind.replace(/_/g, " ")}`,
        description: payload.title,
        color,
        fields: fields.length > 0 ? fields : undefined,
        footer: { text: `Linear Agent • ${kind}` },
    };
    // Telegram HTML
    const htmlParts = [
        `<b>${escapeHtml(payload.identifier)}</b> — ${escapeHtml(kind.replace(/_/g, " "))}`,
        `<i>${escapeHtml(payload.title)}</i>`,
    ];
    if (payload.attempt != null)
        htmlParts.push(`Attempt: <code>${(payload.attempt ?? 0) + 1}</code>`);
    if (payload.status)
        htmlParts.push(`Status: <code>${escapeHtml(payload.status)}</code>`);
    if (payload.verdict?.gaps?.length) {
        htmlParts.push(`Issues to fix:\n${payload.verdict.gaps.map(g => `• ${escapeHtml(g)}`).join("\n")}`);
    }
    if (payload.reason)
        htmlParts.push(`Reason: ${escapeHtml(payload.reason)}`);
    return {
        text,
        discord: { embeds: [embed] },
        telegram: { html: htmlParts.join("\n") },
    };
}
function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
let _deliverModulePromise = null;
/**
 * Test seam: reset the cached resolver so unit tests get a fresh probe.
 * Pass an explicit resolved value to skip the readdir scan entirely (used
 * by tests that want to force one path or the other).
 */
export function _resetDeliverResolver(forceResult) {
    if (forceResult === undefined) {
        _deliverModulePromise = null;
    }
    else {
        _deliverModulePromise = Promise.resolve(forceResult);
    }
}
async function resolveInProcessDeliver() {
    if (_deliverModulePromise)
        return _deliverModulePromise;
    _deliverModulePromise = (async () => {
        try {
            const _require = createRequire(import.meta.url);
            const mainEntry = _require.resolve("openclaw");
            const distDir = dirname(mainEntry);
            const files = await readdir(distDir);
            const candidates = files.filter((f) => /^deliver-[A-Za-z0-9_-]+\.js$/.test(f));
            for (const file of candidates) {
                try {
                    const url = pathToFileURL(join(distDir, file)).href;
                    const mod = (await import(url));
                    if (typeof mod.deliverOutboundPayloads === "function") {
                        return mod;
                    }
                }
                catch {
                    // try next candidate
                }
            }
            return null;
        }
        catch {
            return null;
        }
    })();
    return _deliverModulePromise;
}
/** Build a ReplyPayload from a notify message + target. */
function buildPayload(target, message) {
    if (typeof message === "string") {
        return { text: message };
    }
    // Rich message — encode per-channel envelopes into channelData. The
    // outbound adapters consume these:
    //   • Telegram: `sendTelegramPayloadMessages` reads `channelData.telegram`
    //     for buttons/quoteText; the adapter hardcodes `textMode: "html"` so
    //     passing HTML in `text` is rendered with `parse_mode: "HTML"`.
    //   • Discord: `deliverDiscordInteractionReply` reads
    //     `channelData.discord.components` for components-V2 envelopes.
    if (target.channel === "telegram" && message.telegram?.html) {
        return { text: message.telegram.html };
    }
    if (target.channel === "discord" && message.discord?.embeds) {
        return {
            text: message.text,
            channelData: {
                discord: { embeds: message.discord.embeds },
            },
        };
    }
    return { text: message.text };
}
// ---------------------------------------------------------------------------
// Unified send
// ---------------------------------------------------------------------------
export async function sendToTarget(target, message, runtime) {
    const ch = target.channel;
    const isSilent = ch === "telegram" || ch === "discord";
    // Try in-process delivery first. Falls through to subprocess on any error.
    const mod = await resolveInProcessDeliver();
    if (mod) {
        try {
            const cfg = await runtime.config.loadConfig();
            await mod.deliverOutboundPayloads({
                cfg,
                channel: ch,
                to: target.target,
                accountId: target.accountId,
                payloads: [buildPayload(target, message)],
                silent: isSilent,
            });
            return;
        }
        catch {
            // Fall through to subprocess on any in-process failure (signature
            // change, missing channel adapter, etc.). Errors during the actual
            // send will surface through the subprocess path and the caller's
            // sanitizer.
        }
    }
    // CLI subprocess fallback
    const isRich = typeof message !== "string";
    const plainText = isRich ? message.text : message;
    const argv = ["message", "send", "--channel", ch, "--target", target.target, "--message", plainText, "--json"];
    if (target.accountId)
        argv.push("--account", target.accountId);
    if (isSilent)
        argv.push("--silent");
    if (isRich && ch === "discord" && message.discord?.embeds) {
        // Discord components-V2 envelope is the only public CLI route for
        // embeds; the adapter consumes `params.components` via the action runner.
        argv.push("--components", JSON.stringify({ embeds: message.discord.embeds }));
    }
    // CLI cannot pass telegram parse_mode — RichMessage.telegram.html
    // collapses to plain text on this path. The in-process branch above is
    // the only way to render Telegram HTML today.
    await execFileAsync("openclaw", argv, { timeout: 30_000 });
}
// ---------------------------------------------------------------------------
// Config-driven factory
// ---------------------------------------------------------------------------
/**
 * Parse notification config from plugin config.
 */
export function parseNotificationsConfig(pluginConfig) {
    const raw = pluginConfig?.notifications;
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
export function createNotifierFromConfig(pluginConfig, runtime, api) {
    const config = parseNotificationsConfig(pluginConfig);
    if (!config.targets?.length)
        return createNoopNotifier();
    const useRich = config.richFormat === true;
    return async (kind, payload) => {
        // Check event toggle — default is enabled (true)
        if (config.events?.[kind] === false)
            return;
        const message = useRich ? formatRichMessage(kind, payload) : formatMessage(kind, payload);
        await Promise.allSettled(config.targets.map(async (target) => {
            try {
                await sendToTarget(target, message, runtime);
            }
            catch (err) {
                const safeError = err instanceof Error ? err.message : "Unknown error";
                // Strip potential URLs/tokens from error messages to prevent secret leakage
                const sanitizedError = safeError
                    .replace(/https?:\/\/[^\s]+/g, "[URL]")
                    .replace(/[A-Za-z0-9_-]{20,}/g, "[TOKEN]");
                console.error(`Notify error (${target.channel}:${target.target}): ${sanitizedError}`);
                if (api) {
                    emitDiagnostic(api, {
                        event: "notify_failed",
                        identifier: payload.identifier,
                        phase: kind,
                        error: sanitizedError,
                    });
                }
            }
        }));
    };
}
// ---------------------------------------------------------------------------
// Noop fallback
// ---------------------------------------------------------------------------
export function createNoopNotifier() {
    return async () => { };
}
