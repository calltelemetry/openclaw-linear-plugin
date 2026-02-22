/**
 * Linear workspace & team guidance extraction, caching, and formatting.
 *
 * Guidance is delivered via AgentSessionEvent webhook payloads (both the
 * top-level `guidance` field and embedded within `promptContext`). This
 * module extracts it, caches it per-team (so Comment webhook paths can
 * benefit), and formats it as a prompt appendix.
 *
 * @see https://linear.app/docs/agents-in-linear
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GuidanceContext {
  /** The raw guidance string (workspace + team merged by Linear) */
  guidance: string | null;
  /** Where the guidance came from */
  source: "webhook" | "promptContext" | null;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Extract guidance from an AgentSessionEvent webhook payload.
 * Priority: payload.guidance (string) > parsed from payload.promptContext > null.
 */
export function extractGuidance(payload: Record<string, unknown>): GuidanceContext {
  // 1. Top-level guidance field (clean string from Linear)
  const guidance = payload.guidance;
  if (typeof guidance === "string" && guidance.trim()) {
    return { guidance: guidance.trim(), source: "webhook" };
  }

  // 2. Try parsing from promptContext
  const pc = payload.promptContext;
  if (typeof pc === "string" && pc.trim()) {
    const extracted = extractGuidanceFromPromptContext(pc);
    if (extracted) {
      return { guidance: extracted, source: "promptContext" };
    }
  }

  return { guidance: null, source: null };
}

/**
 * Best-effort parse guidance from a promptContext string.
 * Linear's promptContext format may include guidance as XML-style tags
 * or markdown-headed sections.
 */
export function extractGuidanceFromPromptContext(promptContext: string): string | null {
  // Pattern 1: XML-style tags (e.g. <guidance>...</guidance>)
  const xmlMatch = promptContext.match(/<guidance>([\s\S]*?)<\/guidance>/i);
  if (xmlMatch?.[1]?.trim()) return xmlMatch[1].trim();

  // Pattern 2: Markdown heading "## Guidance" or "# Guidance"
  const mdMatch = promptContext.match(/#{1,3}\s*[Gg]uidance\s*\n([\s\S]*?)(?=\n#{1,3}\s|$)/);
  if (mdMatch?.[1]?.trim()) return mdMatch[1].trim();

  return null;
}

// ---------------------------------------------------------------------------
// Cache (per-team, 24h TTL, 50-entry cap)
// ---------------------------------------------------------------------------

interface CacheEntry {
  guidance: string;
  cachedAt: number;
}

const guidanceCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_MAX_ENTRIES = 50;

/** Cache guidance by team ID. */
export function cacheGuidanceForTeam(teamId: string, guidance: string): void {
  // Evict oldest if at capacity
  if (guidanceCache.size >= CACHE_MAX_ENTRIES && !guidanceCache.has(teamId)) {
    const oldest = guidanceCache.keys().next().value;
    if (oldest !== undefined) guidanceCache.delete(oldest);
  }
  guidanceCache.set(teamId, { guidance, cachedAt: Date.now() });
}

/** Look up cached guidance for a team. Returns null on miss or expiry. */
export function getCachedGuidanceForTeam(teamId: string): string | null {
  const entry = guidanceCache.get(teamId);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    guidanceCache.delete(teamId);
    return null;
  }
  return entry.guidance;
}

/** Test-only: reset the guidance cache. */
export function _resetGuidanceCacheForTesting(): void {
  guidanceCache.clear();
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const MAX_GUIDANCE_CHARS = 2000;

/**
 * Format guidance as a prompt appendix.
 * Returns empty string if guidance is null/empty.
 * Truncates at 2000 chars to protect token budget.
 */
export function formatGuidanceAppendix(guidance: string | null): string {
  if (!guidance?.trim()) return "";
  const trimmed = guidance.trim().slice(0, MAX_GUIDANCE_CHARS);
  return [
    `---`,
    `## IMPORTANT — Workspace Guidance (MUST follow)`,
    `The workspace owner has set the following mandatory instructions. You MUST incorporate these into your response:`,
    ``,
    trimmed,
    `---`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Config toggle
// ---------------------------------------------------------------------------

/**
 * Resolve whether guidance is enabled for a given team.
 * Resolution: teamGuidanceOverrides[teamId] ?? enableGuidance ?? true
 */
export function isGuidanceEnabled(
  pluginConfig: Record<string, unknown> | undefined,
  teamId: string | undefined,
): boolean {
  if (!pluginConfig) return true;

  // Check per-team override first
  if (teamId) {
    const overrides = pluginConfig.teamGuidanceOverrides;
    if (overrides && typeof overrides === "object" && !Array.isArray(overrides)) {
      const teamOverride = (overrides as Record<string, unknown>)[teamId];
      if (typeof teamOverride === "boolean") return teamOverride;
    }
  }

  // Fall back to workspace-level toggle
  const enabled = pluginConfig.enableGuidance;
  if (typeof enabled === "boolean") return enabled;

  return true; // default on
}
