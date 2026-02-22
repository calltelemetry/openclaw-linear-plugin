/**
 * shared-profiles.ts — Shared agent profile loader with TTL cache.
 *
 * Consolidates the duplicate loadAgentProfiles() / buildMentionPattern() /
 * resolveAgentFromAlias() implementations that were previously in
 * webhook.ts, intent-classify.ts, and tier-assess.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentProfile {
  label: string;
  mission: string;
  mentionAliases: string[];
  appAliases?: string[];
  isDefault?: boolean;
  avatarUrl?: string;
}

// ---------------------------------------------------------------------------
// Cached profile loader (5s TTL)
// ---------------------------------------------------------------------------

const PROFILES_PATH = join(homedir(), ".openclaw", "agent-profiles.json");

let profilesCache: { data: Record<string, AgentProfile>; loadedAt: number } | null = null;
const PROFILES_CACHE_TTL_MS = 5_000;

export function loadAgentProfiles(): Record<string, AgentProfile> {
  const now = Date.now();
  if (profilesCache && now - profilesCache.loadedAt < PROFILES_CACHE_TTL_MS) {
    return profilesCache.data;
  }
  try {
    const raw = readFileSync(PROFILES_PATH, "utf8");
    const data = JSON.parse(raw).agents ?? {};
    profilesCache = { data, loadedAt: now };
    return data;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Mention pattern builder
// ---------------------------------------------------------------------------

/**
 * Build a regex that matches @mentions for all agent mentionAliases.
 * appAliases are excluded — those trigger AgentSessionEvent instead.
 */
export function buildMentionPattern(profiles: Record<string, AgentProfile>): RegExp | null {
  const aliases: string[] = [];
  for (const [, profile] of Object.entries(profiles)) {
    aliases.push(...profile.mentionAliases);
  }
  if (aliases.length === 0) return null;
  const escaped = aliases.map(a => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`@(${escaped.join("|")})`, "gi");
}

// ---------------------------------------------------------------------------
// Agent resolver
// ---------------------------------------------------------------------------

/**
 * Given a mention alias string (e.g. "kaylee"), resolve which agent it
 * belongs to. Returns { agentId, label } or null if no match.
 */
export function resolveAgentFromAlias(
  alias: string,
  profiles: Record<string, AgentProfile>,
): { agentId: string; label: string } | null {
  const lower = alias.toLowerCase();
  for (const [agentId, profile] of Object.entries(profiles)) {
    if (profile.mentionAliases.some(a => a.toLowerCase() === lower)) {
      return { agentId, label: profile.label };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Default agent resolver (shared helper for intent-classify / tier-assess)
// ---------------------------------------------------------------------------

/**
 * Resolve the default agent ID from plugin config or agent profiles.
 * Falls back to "default" if nothing is configured.
 */
export function resolveDefaultAgent(api: { pluginConfig?: Record<string, unknown> }): string {
  const fromConfig = (api as any).pluginConfig?.defaultAgentId;
  if (typeof fromConfig === "string" && fromConfig) return fromConfig;

  try {
    const raw = readFileSync(PROFILES_PATH, "utf8");
    const profiles = JSON.parse(raw).agents ?? {};
    const defaultAgent = Object.entries(profiles).find(([, p]: [string, any]) => p.isDefault);
    if (defaultAgent) return defaultAgent[0];
  } catch { /* fall through */ }

  return "default";
}

// ---------------------------------------------------------------------------
// Test-only: reset cache
// ---------------------------------------------------------------------------

/** @internal — test-only; clears the profiles cache. */
export function _resetProfilesCacheForTesting(): void {
  profilesCache = null;
}
