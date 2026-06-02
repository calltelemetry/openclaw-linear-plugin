/**
 * validation.ts — Shared validation utilities for Linear IDs and prompt text.
 *
 * Used by linear-issues-tool.ts to validate input before making API calls,
 * and by pipeline components to sanitize text before embedding in prompts.
 */
// ---------------------------------------------------------------------------
// UUID validation
// ---------------------------------------------------------------------------
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isValidUuid(id) {
    return UUID_REGEX.test(id);
}
// ---------------------------------------------------------------------------
// Linear issue ID validation
// ---------------------------------------------------------------------------
/**
 * Linear issue IDs are either short identifiers like "ENG-123" or UUIDs.
 */
const ISSUE_ID_REGEX = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
export function isValidIssueId(id) {
    return ISSUE_ID_REGEX.test(id) || isValidUuid(id);
}
// ---------------------------------------------------------------------------
// Team ID validation
// ---------------------------------------------------------------------------
export function isValidTeamId(id) {
    return isValidUuid(id);
}
// ---------------------------------------------------------------------------
// Prompt sanitization
// ---------------------------------------------------------------------------
/**
 * Sanitize text before embedding in agent prompts.
 * Truncates to prevent token budget abuse and escapes template patterns
 * so user-supplied text cannot inject {{variable}} placeholders.
 */
export function sanitizeForPrompt(text, maxLength = 4000) {
    return text
        .replace(/\{\{.*?\}\}/g, "{ {escaped} }")
        .slice(0, maxLength);
}
