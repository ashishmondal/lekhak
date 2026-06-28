import { AiError } from './ai-error';
import {
  isTurboStory,
  type AiProvider,
  type ChatMessage,
  type GenerateOpts,
} from './ai-provider';

export interface FakeProviderOptions {
  /** Tokens to stream, in order. */
  chunks?: string[];
  /** Throw this error. With `errorAfter` unset, it throws after streaming. */
  error?: AiError;
  /** Throw `error` (or a default) once this many chunks have been yielded. */
  errorAfter?: number;
  /** Optional per-chunk delay, to exercise abort timing. */
  delayMs?: number;
  /** testConnection result; defaults to true unless an `error` is set. */
  connects?: boolean;
}

const DEFAULT_CHUNKS = ['Once ', 'upon ', 'a ', 'time.'];

/**
 * Deterministic in-memory provider for tests. Streams `chunks`, honours
 * AbortSignal between chunks, and can simulate mid-stream or terminal failures.
 */
export class FakeProvider implements AiProvider {
  readonly id = 'fake';
  /** Messages captured from the most recent generate call, for assertions. */
  lastMessages: ChatMessage[] = [];
  /** Opts captured from the most recent generate call, for assertions. */
  lastOpts: GenerateOpts | null = null;
  /** Turbo mode for the current run, derived from the story name. Used later. */
  turbo = false;

  constructor(private readonly opts: FakeProviderOptions = {}) {}

  async *generate(
    messages: ChatMessage[],
    opts: GenerateOpts,
  ): AsyncIterable<string> {
    this.lastMessages = messages;
    this.lastOpts = opts;
    this.turbo = isTurboStory(opts.storyName);
    const chunks = this.opts.chunks ?? DEFAULT_CHUNKS;

    let yielded = 0;
    for (const chunk of chunks) {
      if (opts.signal?.aborted) {
        throw new AiError('aborted', 'Generation stopped.');
      }
      if (this.opts.errorAfter !== undefined && yielded === this.opts.errorAfter) {
        throw this.opts.error ?? new AiError('unknown', 'Simulated stream failure.');
      }
      if (this.opts.delayMs) {
        await delay(this.opts.delayMs);
      }
      yield chunk;
      yielded++;
    }

    if (this.opts.error && this.opts.errorAfter === undefined) {
      throw this.opts.error;
    }
  }

  async testConnection(): Promise<boolean> {
    return this.opts.connects ?? !this.opts.error;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
