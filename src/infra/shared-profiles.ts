/**
 * shared-profiles.ts — Shared agent profile loader with TTL cache.
 *
 * Consolidates the duplicate loadAgentProfiles() / buildMentionPattern() /
 * resolveAgentFromAlias() implementations that were previously in
 * webhook.ts, intent-classify.ts, and tier-assess.ts.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
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

export const PROFILES_PATH = join(homedir(), ".openclaw", "agent-profiles.json");

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
// Profile validation — returns a user-facing error string or null if OK.
// ---------------------------------------------------------------------------

/**
 * Validate that agent-profiles.json exists, is parseable, and has at least
 * one agent.  Returns a human-readable error string suitable for posting
 * back to Linear, or null when everything looks good.
 */
export function validateProfiles(): string | null {
  if (!existsSync(PROFILES_PATH)) {
    return (
      `**Critical setup error:** \`agent-profiles.json\` not found.\n\n` +
      `The Linear plugin requires this file to route messages to your agent.\n\n` +
      `**Create it now:**\n` +
      "```\n" +
      `cat > ${PROFILES_PATH} << 'EOF'\n` +
      `{\n` +
      `  "agents": {\n` +
      `    "my-agent": {\n` +
      `      "label": "My Agent",\n` +
      `      "mission": "AI assistant",\n` +
      `      "isDefault": true,\n` +
      `      "mentionAliases": ["my-agent"]\n` +
      `    }\n` +
      `  }\n` +
      `}\n` +
      `EOF\n` +
      "```\n\n" +
      `Then restart the gateway: \`systemctl --user restart openclaw-gateway\`\n\n` +
      `Or run the guided setup: \`openclaw openclaw-linear setup\``
    );
  }

  let profiles: Record<string, unknown>;
  try {
    const raw = readFileSync(PROFILES_PATH, "utf8");
    profiles = JSON.parse(raw).agents ?? {};
  } catch (err) {
    return (
      `**Critical setup error:** \`agent-profiles.json\` exists but could not be parsed.\n\n` +
      `Error: ${err instanceof Error ? err.message : String(err)}\n\n` +
      `Fix the JSON syntax in \`${PROFILES_PATH}\` and restart the gateway.\n` +
      `Run \`openclaw openclaw-linear doctor\` to verify.`
    );
  }

  if (Object.keys(profiles).length === 0) {
    return (
      `**Critical setup error:** \`agent-profiles.json\` has no agents configured.\n\n` +
      `Add at least one agent entry to the \`"agents"\` object in \`${PROFILES_PATH}\`.\n` +
      `Run \`openclaw openclaw-linear setup\` for guided setup.`
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Profile creation (setup wizard / doctor --fix)
// ---------------------------------------------------------------------------

export interface CreateProfileOpts {
  agentId: string;
  label: string;
  mentionAliases: string[];
  mission?: string;
}

/**
 * Create `agent-profiles.json` with a single default agent.
 * Creates the parent directory if needed. Throws on write failure.
 */
export function createAgentProfilesFile(opts: CreateProfileOpts): void {
  const data = {
    agents: {
      [opts.agentId]: {
        label: opts.label,
        mission: opts.mission ?? "AI assistant for Linear issues",
        isDefault: true,
        mentionAliases: opts.mentionAliases,
      },
    },
  };
  mkdirSync(dirname(PROFILES_PATH), { recursive: true });
  writeFileSync(PROFILES_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");
  // Bust the cache so the next load picks up the new file
  profilesCache = null;
}

// ---------------------------------------------------------------------------
// Test-only: reset cache
// ---------------------------------------------------------------------------

/** @internal — test-only; clears the profiles cache. */
export function _resetProfilesCacheForTesting(): void {
  profilesCache = null;
}
