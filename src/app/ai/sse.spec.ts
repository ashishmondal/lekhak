import { describe, expect, it } from 'vitest';

import { AiError } from './ai-error';
import { parseSseFrames } from './sse';

/** Build a ReadableStream that emits the given string chunks as UTF-8 bytes. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]));
      } else {
        controller.close();
      }
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const out: string[] = [];
  for await (const data of parseSseFrames(stream, signal)) {
    out.push(data);
  }
  return out;
}

describe('parseSseFrames', () => {
  it('yields data payloads from well-formed frames', async () => {
    const out = await collect(
      streamOf(['data: {"a":1}\n\n', 'data: {"b":2}\n\n', 'data: [DONE]\n\n']),
    );
    expect(out).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('reassembles a frame split across reads', async () => {
    const out = await collect(
      streamOf(['data: {"te', 'xt":"hi"}', '\n\ndata: [DONE]\n\n']),
    );
    expect(out).toEqual(['{"text":"hi"}']);
  });

  it('stops at the [DONE] sentinel and ignores anything after', async () => {
    const out = await collect(
      streamOf(['data: 1\n\n', 'data: [DONE]\n\n', 'data: 2\n\n']),
    );
    expect(out).toEqual(['1']);
  });

  it('ignores keep-alive comment lines', async () => {
    const out = await collect(
      streamOf([': keep-alive\n\n', 'data: ok\n\n', 'data: [DONE]\n\n']),
    );
    expect(out).toEqual(['ok']);
  });

  it('joins multiple data lines in one frame with a newline', async () => {
    const out = await collect(streamOf(['data: line1\ndata: line2\n\n']));
    expect(out).toEqual(['line1\nline2']);
  });

  it('normalizes CRLF line endings', async () => {
    const out = await collect(streamOf(['data: x\r\n\r\n']));
    expect(out).toEqual(['x']);
  });

  it('flushes a trailing frame that has no final blank line', async () => {
    const out = await collect(streamOf(['data: tail']));
    expect(out).toEqual(['tail']);
  });

  it('throws AiError(aborted) when the signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(collect(streamOf(['data: x\n\n']), ctrl.signal)).rejects.toMatchObject({
      kind: 'aborted',
    });
  });
});

describe('AiError.fromStatus', () => {
  it('maps 401/403 to auth (not retryable)', () => {
    expect(AiError.fromStatus(401)).toMatchObject({ kind: 'auth', retryable: false });
    expect(AiError.fromStatus(403).kind).toBe('auth');
  });

  it('maps 429 to rate_limit (retryable)', () => {
    expect(AiError.fromStatus(429)).toMatchObject({ kind: 'rate_limit', retryable: true });
  });

  it('maps 400 context-length bodies to overflow', () => {
    const e = AiError.fromStatus(400, '{"error":{"code":"context_length_exceeded"}}');
    expect(e.kind).toBe('overflow');
  });

  it('maps a plain 400 to unknown', () => {
    expect(AiError.fromStatus(400, 'bad request').kind).toBe('unknown');
  });

  it('maps 5xx to unknown but retryable', () => {
    expect(AiError.fromStatus(503)).toMatchObject({ kind: 'unknown', retryable: true });
  });
});

describe('AiError.fromThrown', () => {
  it('classifies an AbortError as aborted', () => {
    const err = new DOMException('aborted', 'AbortError');
    expect(AiError.fromThrown(err).kind).toBe('aborted');
  });

  it('classifies a generic error as network', () => {
    expect(AiError.fromThrown(new TypeError('failed to fetch')).kind).toBe('network');
  });

  it('passes an existing AiError through unchanged', () => {
    const original = new AiError('overflow', 'too long');
    expect(AiError.fromThrown(original)).toBe(original);
  });
});
