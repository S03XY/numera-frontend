import type { ApiErrorBody } from './types';

/** Normalized API failure. `status === 0` means the request never reached the server. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: string[];

  constructor(status: number, code: string, message: string, details: string[] = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  get isNetworkError(): boolean {
    return this.status === 0;
  }
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
  get isForbidden(): boolean {
    return this.status === 403;
  }
  get isNotFound(): boolean {
    return this.status === 404;
  }
  get isRateLimited(): boolean {
    return this.status === 429;
  }

  /** Message safe to show a user — never leaks internals on a 5xx. */
  get userMessage(): string {
    if (this.isNetworkError) return 'Cannot reach the server. Check your connection.';
    if (this.isUnauthorized) return 'Your session expired. Please sign in again.';
    if (this.isForbidden) return 'You do not have permission to do that.';
    if (this.isNotFound) return 'Not found.';
    if (this.isRateLimited) return 'Too many requests. Please slow down.';
    if (this.status >= 500) return 'Something went wrong on our end. Please try again.';
    return this.message;
  }
}

/** Build an ApiError from a non-OK response body. */
export function apiErrorFromBody(status: number, body: unknown): ApiError {
  const b = body as Partial<ApiErrorBody> | null;
  const rawMessage = b?.message;
  const details = Array.isArray(rawMessage) ? rawMessage : rawMessage ? [rawMessage] : [];
  const message = details[0] ?? b?.error ?? `Request failed with status ${status}`;
  return new ApiError(status, b?.error ?? 'HttpError', message, details);
}
