import { AiError } from './ai-error';

/**
 * Buffer-aware Server-Sent Events reader.
 *
 * Network chunks routinely split mid-frame (e.g. `data: {"te`), so we never
 * parse until a full `\n\n`-delimited event is in hand. Handles:
 *  - frames split across reads (carried in `buffer`)
 *  - `\r\n` line endings (normalized)
 *  - `:` keep-alive comment lines (ignored)
 *  - multiple `data:` lines per event (joined with `\n`, per the SSE spec)
 *  - the OpenAI `[DONE]` sentinel (ends the stream)
 *
 * Yields the raw `data` payload of each event. Always cancels and releases the
 * underlying reader on exit (including abort), so no fetch slot leaks.
 */
export async function* parseSseFrames(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) {
        throw new AiError('aborted', 'Generation stopped.');
      }

      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');

      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const data = extractData(block);
        if (data === null) {
          continue;
        }
        if (data === '[DONE]') {
          return;
        }
        yield data;
      }
    }

    // Flush a trailing event that arrived without a final blank line.
    const data = extractData(buffer);
    if (data !== null && data !== '[DONE]') {
      yield data;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Stream already closed/errored; nothing to cancel.
    }
    reader.releaseLock();
  }
}

/**
 * Extract the joined `data` payload from one event block, or null if the block
 * carries no data (blank or comment-only keep-alive).
 */
function extractData(block: string): string | null {
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) {
      continue; // blank or comment (keep-alive)
    }
    if (line.startsWith('data:')) {
      // Strip the field name and a single optional leading space.
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    // Other SSE fields (event:, id:, retry:) are irrelevant here.
  }
  return dataLines.length ? dataLines.join('\n') : null;
}
