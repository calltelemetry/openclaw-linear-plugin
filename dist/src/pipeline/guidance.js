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
// Extraction
// ---------------------------------------------------------------------------
/**
 * Extract guidance from an AgentSessionEvent webhook payload.
 * Priority: payload.guidance (string) > parsed from payload.promptContext > null.
 */
export function extractGuidance(payload) {
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
export function extractGuidanceFromPromptContext(promptContext) {
    // Pattern 1: XML-style tags (e.g. <guidance>...</guidance>)
    const xmlMatch = promptContext.match(/<guidance>([\s\S]*?)<\/guidance>/i);
    if (xmlMatch?.[1]?.trim())
        return xmlMatch[1].trim();
    // Pattern 2: Markdown heading "## Guidance" or "# Guidance"
    const mdMatch = promptContext.match(/#{1,3}\s*[Gg]uidance\s*\n([\s\S]*?)(?=\n#{1,3}\s|$)/);
    if (mdMatch?.[1]?.trim())
        return mdMatch[1].trim();
    return null;
}
const guidanceCache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_MAX_ENTRIES = 50;
/** Cache guidance by team ID. */
export function cacheGuidanceForTeam(teamId, guidance) {
    // Evict oldest if at capacity
    if (guidanceCache.size >= CACHE_MAX_ENTRIES && !guidanceCache.has(teamId)) {
        const oldest = guidanceCache.keys().next().value;
        if (oldest !== undefined)
            guidanceCache.delete(oldest);
    }
    guidanceCache.set(teamId, { guidance, cachedAt: Date.now() });
}
/** Look up cached guidance for a team. Returns null on miss or expiry. */
export function getCachedGuidanceForTeam(teamId) {
    const entry = guidanceCache.get(teamId);
    if (!entry)
        return null;
    if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
        guidanceCache.delete(teamId);
        return null;
    }
    return entry.guidance;
}
/** Test-only: reset the guidance cache. */
export function _resetGuidanceCacheForTesting() {
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
export function formatGuidanceAppendix(guidance) {
    if (!guidance?.trim())
        return "";
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
// Proactive resolution (webhook → cache → null)
// ---------------------------------------------------------------------------
/**
 * Resolve guidance for a team through all available sources.
 * Chain: webhook payload → cache → null
 *
 * This replaces ad-hoc cache lookups with a single resolution function.
 * When the cache expires and no webhook guidance is available, returns null.
 */
export function resolveGuidance(teamId, payload, pluginConfig) {
    // Check if guidance is enabled for this team
    if (!isGuidanceEnabled(pluginConfig, teamId))
        return null;
    // 1. Try extracting from webhook payload (freshest source)
    if (payload) {
        const extracted = extractGuidance(payload);
        if (extracted.guidance) {
            // Cache for future Comment webhook paths
            if (teamId)
                cacheGuidanceForTeam(teamId, extracted.guidance);
            return extracted.guidance;
        }
    }
    // 2. Try cache
    if (teamId) {
        const cached = getCachedGuidanceForTeam(teamId);
        if (cached)
            return cached;
    }
    return null;
}
// ---------------------------------------------------------------------------
// Config toggle
// ---------------------------------------------------------------------------
/**
 * Resolve whether guidance is enabled for a given team.
 * Resolution: teamGuidanceOverrides[teamId] ?? enableGuidance ?? true
 */
export function isGuidanceEnabled(pluginConfig, teamId) {
    if (!pluginConfig)
        return true;
    // Check per-team override first
    if (teamId) {
        const overrides = pluginConfig.teamGuidanceOverrides;
        if (overrides && typeof overrides === "object" && !Array.isArray(overrides)) {
            const teamOverride = overrides[teamId];
            if (typeof teamOverride === "boolean")
                return teamOverride;
        }
    }
    // Fall back to workspace-level toggle
    const enabled = pluginConfig.enableGuidance;
    if (typeof enabled === "boolean")
        return enabled;
    return true; // default on
}
