/**
 * Shared non-streaming AI IO. The provider abstraction only exposes a streaming
 * `generate()`; background judges (synopsis, extraction, canon-check) want a
 * single complete string and a tolerant JSON parse, so the collect+parse logic
 * lives here once instead of being hand-rolled per service.
 */

import { AiError } from './ai-error';
import type { AiProvider, ChatMessage, GenerateOpts } from './ai-provider';

/**
 * Drain a provider's streaming `generate()` into one string.
 *
 *   generate() ──stream chunks──▶ accumulate ──▶ full text
 *        │
 *        ├─ provider throws ──▶ AiError.fromThrown (kind preserved)
 *        └─ signal aborted  ──▶ throws AiError kind 'aborted'
 *
 * Abort throws (not returns-partial): a half-streamed JSON judgment is useless
 * to the caller, and the background queue needs to see preemption as an error.
 */
export async function collect(
  provider: AiProvider,
  messages: ChatMessage[],
  opts: GenerateOpts,
): Promise<string> {
  let out = '';
  try {
    for await (const chunk of provider.generate(messages, opts)) {
      out += chunk;
    }
  } catch (err) {
    throw AiError.fromThrown(err, opts.signal);
  }
  // Provider may complete without throwing even though the caller aborted
  // (e.g. abort landed between the last chunk and loop exit).
  if (opts.signal?.aborted) {
    throw new AiError('aborted', 'Generation stopped.');
  }
  return out;
}

/**
 * Parse a JSON value out of an LLM response that may wrap it in prose or a
 * ```json fence. Returns null on any failure (no JSON found, malformed, or the
 * type guard rejects it) so callers surface a visible "couldn't analyze" state
 * instead of throwing.
 */
export function parseJsonLoose<T>(
  text: string,
  guard: (value: unknown) => value is T,
): T | null {
  const span = firstJsonSpan(stripFences(text));
  if (span === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(span);
  } catch {
    return null;
  }
  return guard(parsed) ? parsed : null;
}

/** Unwrap a ```json ... ``` (or bare ``` ... ```) fenced block, if present. */
function stripFences(text: string): string {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  return fence ? fence[1] : text;
}

/**
 * Return the first balanced JSON object or array span in `text`, or null.
 *
 * Scans from the first `{`/`[`, counting only that delimiter's depth and
 * skipping string literals (so braces inside `"..."` don't unbalance the
 * count). Nested arrays inside an object (and vice-versa) are valid JSON and
 * stay balanced, so tracking the outer delimiter alone is sufficient.
 */
function firstJsonSpan(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start === -1) {
    return null;
  }
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}
