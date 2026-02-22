/**
 * watchdog.ts — I/O inactivity watchdog for agent sessions.
 *
 * Resets a countdown timer on every tick(). If no tick arrives within
 * the inactivity threshold, fires onKill(). Also provides a config
 * resolver that reads per-agent timeouts from agent-profiles.json.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Defaults (seconds — matches config units)
// ---------------------------------------------------------------------------

export const DEFAULT_INACTIVITY_SEC = 120;     // 2 min
export const DEFAULT_MAX_TOTAL_SEC = 7200;     // 2 hrs
export const DEFAULT_TOOL_TIMEOUT_SEC = 600;   // 10 min

// ---------------------------------------------------------------------------
// Watchdog
// ---------------------------------------------------------------------------

export type WatchdogKillReason = "inactivity";

export interface WatchdogOptions {
  /** Inactivity threshold in ms. */
  inactivityMs: number;
  /** Label for logging (e.g. "embedded:zoe:session-123"). */
  label: string;
  /** Logger interface. */
  logger: { info(msg: string): void; warn(msg: string): void };
  /** Called when inactivity timeout fires. Must kill the process/abort. */
  onKill: (reason: WatchdogKillReason) => void | Promise<void>;
}

export class InactivityWatchdog {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly inactivityMs: number;
  private readonly label: string;
  private readonly logger: WatchdogOptions["logger"];
  private readonly onKill: WatchdogOptions["onKill"];
  private lastActivityAt: number = Date.now();
  private killed = false;
  private started = false;

  constructor(opts: WatchdogOptions) {
    this.inactivityMs = opts.inactivityMs;
    this.label = opts.label;
    this.logger = opts.logger;
    this.onKill = opts.onKill;
  }

  /** Start the watchdog. Call after the process/run is launched. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.lastActivityAt = Date.now();
    this.scheduleCheck();
    this.logger.info(`Watchdog started: ${this.label} (inactivity=${this.inactivityMs}ms)`);
  }

  /** Record an I/O activity tick. Resets the inactivity countdown. */
  tick(): void {
    this.lastActivityAt = Date.now();
  }

  /** Stop the watchdog (normal completion). */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.started = false;
  }

  /** Whether the watchdog triggered a kill. */
  get wasKilled(): boolean {
    return this.killed;
  }

  /** Milliseconds since last activity. */
  get silenceMs(): number {
    return Date.now() - this.lastActivityAt;
  }

  private scheduleCheck(): void {
    const remaining = Math.max(1000, this.inactivityMs - (Date.now() - this.lastActivityAt));
    this.timer = setTimeout(() => {
      if (this.killed || !this.started) return;

      const silence = Date.now() - this.lastActivityAt;
      if (silence >= this.inactivityMs) {
        this.killed = true;
        this.logger.warn(
          `Watchdog KILL: ${this.label} — no I/O for ${Math.round(silence / 1000)}s ` +
          `(threshold: ${this.inactivityMs / 1000}s)`,
        );
        try {
          const result = this.onKill("inactivity");
          if (result && typeof (result as Promise<void>).catch === "function") {
            (result as Promise<void>).catch((err) => {
              this.logger.warn(`Watchdog onKill error: ${err}`);
            });
          }
        } catch (err) {
          this.logger.warn(`Watchdog onKill error: ${err}`);
        }
      } else {
        // Activity happened during the wait — reschedule for remaining time
        this.scheduleCheck();
      }
    }, remaining);
  }
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

export interface WatchdogConfig {
  inactivityMs: number;
  maxTotalMs: number;
  toolTimeoutMs: number;
}

interface AgentProfileWatchdog {
  inactivitySec?: number;
  maxTotalSec?: number;
  toolTimeoutSec?: number;
}

const PROFILES_PATH = join(homedir(), ".openclaw", "agent-profiles.json");

function loadProfileWatchdog(agentId: string): AgentProfileWatchdog | null {
  try {
    const raw = readFileSync(PROFILES_PATH, "utf8");
    const profiles = JSON.parse(raw).agents ?? {};
    return profiles[agentId]?.watchdog ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve watchdog config for an agent.
 *
 * Priority: agent-profiles.json → plugin config → hardcoded defaults.
 * All config values are in seconds; output is in ms.
 */
export function resolveWatchdogConfig(
  agentId: string,
  pluginConfig?: Record<string, unknown>,
): WatchdogConfig {
  const profile = loadProfileWatchdog(agentId);

  const inactivitySec =
    profile?.inactivitySec ??
    (pluginConfig?.inactivitySec as number | undefined) ??
    DEFAULT_INACTIVITY_SEC;

  const maxTotalSec =
    profile?.maxTotalSec ??
    (pluginConfig?.maxTotalSec as number | undefined) ??
    DEFAULT_MAX_TOTAL_SEC;

  const toolTimeoutSec =
    profile?.toolTimeoutSec ??
    (pluginConfig?.toolTimeoutSec as number | undefined) ??
    DEFAULT_TOOL_TIMEOUT_SEC;

  return {
    inactivityMs: inactivitySec * 1000,
    maxTotalMs: maxTotalSec * 1000,
    toolTimeoutMs: toolTimeoutSec * 1000,
  };
}
