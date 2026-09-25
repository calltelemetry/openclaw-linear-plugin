/**
 * observability.ts — Structured diagnostic event logging.
 *
 * Emits structured JSON log lines via api.logger for lifecycle telemetry.
 * Consumers (log aggregators, monitoring) can parse these for dashboards.
 *
 * Pattern: `[linear:diagnostic] {...json...}`
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

export type DiagnosticEvent =
  | "webhook_received"
  | "dispatch_started"
  | "phase_transition"
  | "audit_triggered"
  | "verdict_processed"
  | "watchdog_kill"
  | "notify_sent"
  | "notify_failed"
  | "health_check";

export interface DiagnosticPayload {
  event: DiagnosticEvent;
  identifier?: string;
  issueId?: string;
  agentId?: string;
  phase?: string;
  from?: string;
  to?: string;
  attempt?: number;
  tier?: string;
  webhookType?: string;
  webhookAction?: string;
  channel?: string;
  target?: string;
  error?: string;
  durationMs?: number;
  [key: string]: unknown;
}

const PREFIX = "[linear:diagnostic]";

export function emitDiagnostic(api: OpenClawPluginApi, payload: DiagnosticPayload): void {
  try {
    api.logger.info(`${PREFIX} ${JSON.stringify(payload)}`);
  } catch {
    // Never throw from telemetry
  }
}
