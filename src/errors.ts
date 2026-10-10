/**
 * Typed errors.
 *
 * Errors crossing a module boundary carry a `code` so callers can branch on
 * cause without string-matching messages (AGENT.md, error handling).
 */

export type ErrorCode =
  /** A configured capability is absent (e.g. no vision adapter). Not fatal. */
  | 'capability_unavailable'
  /** An operation exceeded its time budget. */
  | 'timeout'
  /** Model/native memory budget exceeded (C4). */
  | 'resource_budget'
  /** Malformed input from the caller. */
  | 'invalid_input'
  /** A file the indexer expected is gone or unreadable. */
  | 'not_found'
  /** Upstream dependency failed. */
  | 'upstream_failure'
  /** Indexing was interrupted; resumable (IMPLEMENTATION.md P1). */
  | 'interrupted';

export class AppError extends Error {
  override readonly name: string = 'AppError';
  readonly code: ErrorCode;
  // `cause` is already declared on Error (ES2022 lib), so redeclaring it needs
  // `override`. Passing it to super() is what actually sets Error.cause.
  override readonly cause?: unknown;

  constructor(code: ErrorCode, message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.code = code;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

/** Narrow an unknown thrown value to a message, for logging. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return String(e);
}