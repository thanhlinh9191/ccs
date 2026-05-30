/**
 * Retry Strategy Utility
 *
 * Reusable exponential-backoff retry wrapper extracted from
 * scattered retry logic in glmt-proxy and binary/downloader.
 *
 * Usage:
 *   const data = await withRetry(() => fetch(url), { maxRetries: 3, baseDelayMs: 100 });
 */

import { RetryableError, isRecoverableError } from '../errors/error-types';

/** Configuration options for retry behavior */
export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries: number;
  /** Base delay in ms for the first retry (default: 1000) */
  baseDelayMs: number;
  /** Upper bound for the computed backoff delay. Note: server-provided `retryAfter` (from RetryableError) takes precedence and may exceed this cap. */
  maxDelayMs?: number;
  /** Multiplier applied per attempt (default: 2). Values <1 produce degrowth. */
  backoffMultiplier?: number;
  /** Override the default retryability check */
  retryableCheck?: (error: unknown) => boolean;
  /** Callback fired before each retry. Errors thrown by this callback are swallowed to prevent aborting the retry loop. */
  onRetry?: (error: Error, attempt: number) => void;
}

const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_MULTIPLIER = 2;
const JITTER_RATIO = 0.2; // 20% of delay as random jitter

/**
 * Check whether an unknown thrown value is retryable.
 * Uses CCSError.recoverable flag and RetryableError instance check.
 */
function defaultRetryableCheck(error: unknown): boolean {
  if (error instanceof RetryableError) {
    return true;
  }
  if (isRecoverableError(error)) {
    return true;
  }
  return false;
}

/**
 * Compute backoff delay: base * multiplier^attempt + jitter, capped at maxDelay.
 * Jitter is applied before the final cap to ensure the result never exceeds maxDelayMs.
 */
function computeDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  multiplier: number,
  retryAfter?: number
): number {
  const exponentialDelay = Math.min(baseDelayMs * Math.pow(multiplier, attempt), maxDelayMs);
  const jitter = exponentialDelay * JITTER_RATIO * Math.random();
  const delay = Math.min(exponentialDelay + jitter, maxDelayMs);
  if (retryAfter !== undefined && retryAfter > 0) {
    return Math.max(delay, retryAfter);
  }
  return delay;
}

/**
 * Sleep for the specified number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute `fn` with automatic retries on retryable failures.
 *
 * Retryability defaults to checking for `RetryableError` instances
 * and CCSError with `recoverable === true`. Override with `retryableCheck`.
 *
 * @param fn - The async function to execute
 * @param options - Retry configuration
 * @returns The resolved value from `fn`
 * @throws The last error encountered after exhausting retries
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const {
    maxRetries,
    baseDelayMs,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    backoffMultiplier = DEFAULT_MULTIPLIER,
    retryableCheck = defaultRetryableCheck,
    onRetry,
  } = options;

  if (maxRetries < 0) {
    throw new Error('withRetry: maxRetries must be >= 0');
  }
  if (baseDelayMs < 0) {
    throw new Error('withRetry: baseDelayMs must be >= 0');
  }

  const isRetryable = retryableCheck ?? defaultRetryableCheck;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // No more retries left
      if (attempt >= maxRetries) {
        break;
      }

      // Check retryability
      if (!isRetryable(error)) {
        break;
      }

      const err = error instanceof Error ? error : new Error(String(error));
      try {
        onRetry?.(err, attempt + 1);
      } catch {
        // Swallow callback errors — retry decision is already made
      }

      const retryAfter = error instanceof RetryableError ? error.retryAfter : undefined;
      const delay = computeDelay(attempt, baseDelayMs, maxDelayMs, backoffMultiplier, retryAfter);
      await sleep(delay);
    }
  }

  throw lastError;
}
