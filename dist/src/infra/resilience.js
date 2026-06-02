/**
 * resilience.ts — Retry + circuit breaker for external API calls.
 *
 * Wraps functions with exponential backoff retry and a circuit breaker
 * that opens after consecutive failures to prevent cascading overload.
 */
import { retry, handleAll, ExponentialBackoff, circuitBreaker, ConsecutiveBreaker, wrap, } from "cockatiel";
// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_BACKOFF = { initialDelay: 500, maxDelay: 5_000 };
/**
 * Create a retry policy with exponential backoff.
 */
export function createRetryPolicy(opts) {
    const attempts = opts?.attempts ?? DEFAULT_RETRY_ATTEMPTS;
    const initialDelay = opts?.initialDelay ?? DEFAULT_BACKOFF.initialDelay;
    const maxDelay = opts?.maxDelay ?? DEFAULT_BACKOFF.maxDelay;
    return retry(handleAll, {
        maxAttempts: attempts,
        backoff: new ExponentialBackoff({
            initialDelay,
            maxDelay,
        }),
    });
}
// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------
const DEFAULT_BREAKER_THRESHOLD = 5;
const DEFAULT_HALF_OPEN_AFTER = 30_000;
/**
 * Create a circuit breaker that opens after consecutive failures.
 */
export function createCircuitBreaker(opts) {
    const threshold = opts?.threshold ?? DEFAULT_BREAKER_THRESHOLD;
    const halfOpenAfter = opts?.halfOpenAfter ?? DEFAULT_HALF_OPEN_AFTER;
    return circuitBreaker(handleAll, {
        breaker: new ConsecutiveBreaker(threshold),
        halfOpenAfter,
    });
}
// ---------------------------------------------------------------------------
// Combined policy
// ---------------------------------------------------------------------------
let _defaultPolicy = null;
/**
 * Get the default combined retry + circuit breaker policy (singleton).
 * 3 retries with exponential backoff (500ms → 5s) + circuit breaker
 * (opens after 5 consecutive failures, half-opens after 30s).
 */
export function getDefaultPolicy() {
    if (!_defaultPolicy) {
        const retryPolicy = createRetryPolicy();
        const breaker = createCircuitBreaker();
        _defaultPolicy = wrap(retryPolicy, breaker);
    }
    return _defaultPolicy;
}
/**
 * Execute a function with the default retry + circuit breaker policy.
 */
export async function withResilience(fn) {
    return getDefaultPolicy().execute(fn);
}
/**
 * Reset the default policy singleton (for testing).
 */
export function resetDefaultPolicy() {
    _defaultPolicy = null;
}
