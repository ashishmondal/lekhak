/**
 * The single failure taxonomy for generation. Providers map every failure
 * (HTTP status, abort, fetch rejection, bad stream) to one of these `kind`s so
 * the UI and tests `switch` on `kind` instead of string-matching messages.
 */

export type AiErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'network'
  | 'aborted'
  | 'overflow'
  | 'unknown'
  | 'content_prohibited';

interface AiErrorOptions {
  retryable?: boolean;
  cause?: unknown;
}

/** Sensible retry defaults per kind; an explicit option always wins. */
const RETRYABLE_BY_KIND: Record<AiErrorKind, boolean> = {
  auth: false,
  rate_limit: true,
  network: true,
  aborted: false,
  overflow: false,
  unknown: false,
  content_prohibited: false,
};

export class AiError extends Error {
  readonly kind: AiErrorKind;
  readonly retryable: boolean;

  constructor(kind: AiErrorKind, message: string, options: AiErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'AiError';
    this.kind = kind;
    this.retryable = options.retryable ?? RETRYABLE_BY_KIND[kind];
  }

  /** Map a non-OK HTTP response to a typed error. `body` is the raw response text. */
  static fromStatus(status: number, body = ''): AiError {
    if (status === 401 || status === 403) {
      return new AiError('auth', 'Invalid or missing API key. Check Settings.');
    }
    if (status === 429) {
      return new AiError('rate_limit', 'Rate limited. Wait a moment and retry.');
    }
    if (status === 400 && /context[_ ]length|maximum context|too many tokens/i.test(body)) {
      return new AiError('overflow', 'The story is too long for this model. Trim and retry.');
    }
    if (status === 403 && /content[_ ]prohibited/i.test(body)) {
      return new AiError('content_prohibited', 'The request was blocked by safety filters.');
    }
    if (status >= 500) {
      return new AiError('unknown', `Provider error (${status}). Retry shortly.`, {
        retryable: true,
      });
    }
    return new AiError('unknown', `Request failed (${status}).`);
  }

  /** Map a thrown fetch/stream error. Abort wins over generic network failure. */
  static fromThrown(err: unknown, signal?: AbortSignal): AiError {
    if (err instanceof AiError) {
      return err;
    }
    const isAbort =
      signal?.aborted ||
      (err instanceof DOMException && err.name === 'AbortError') ||
      (err instanceof Error && err.name === 'AbortError');
    if (isAbort) {
      return new AiError('aborted', 'Generation stopped.', { cause: err });
    }
    return new AiError('network', 'Network error. Check your connection and retry.', {
      cause: err,
    });
  }
}
