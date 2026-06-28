/**
 * Provider abstraction. One concrete implementation (OpenAiProvider) in v1;
 * FakeProvider backs the tests. The interface is the single place that
 * per-provider knowledge (CORS, wire format) lives.
 */

export type Role = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface GenerateOpts {
  model: string;
  /** Default 0.8 for prose. */
  temperature?: number;
  maxTokens?: number;
  /**
   * The active story's title. Providers read this to decide whether to run in
   * turbo mode (see {@link isTurboStory}); it is not sent to the model.
   */
  storyName?: string;
  /** For cancel + mid-stream abort. */
  signal?: AbortSignal;
}

export interface AiProvider {
  readonly id: string;
  /** Streams text deltas. Throws an AiError on failure. */
  generate(messages: ChatMessage[], opts: GenerateOpts): AsyncIterable<string>;
  testConnection(model: string): Promise<boolean>;
}

/** Default sampling temperature for prose generation. */
export const DEFAULT_TEMPERATURE = 0.8;

/** Fallback model id until Settings provides one. */
export const DEFAULT_MODEL = 'gpt-4o-mini';

/** A story whose title ends with this marker opts into turbo mode. */
export const TURBO_SUFFIX = '_AKM_';

/**
 * Whether a story name opts into turbo mode. Shared by the providers (which set
 * a `turbo` flag from it) and the UI (which shows a subtle indicator), so the
 * rule lives in exactly one place.
 */
export function isTurboStory(name: string | undefined): boolean {
  return !!name && name.trimEnd().endsWith(TURBO_SUFFIX);
}
