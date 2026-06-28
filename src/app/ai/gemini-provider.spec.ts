import { afterEach, describe, expect, it, vi } from 'vitest';

import { GeminiProvider, toGeminiRequest } from './gemini-provider';
import type { ChatMessage, GenerateOpts } from './ai-provider';

const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
const opts: GenerateOpts = { model: 'gemini-2.5-flash' };

function sseResponse(body: string, init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, ...init });
}

async function drain(provider: GeminiProvider): Promise<string> {
  let text = '';
  for await (const delta of provider.generate(messages, opts)) {
    text += delta;
  }
  return text;
}

function deltaFrame(text: string): string {
  return (
    'data: ' +
    JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }) +
    '\n\n'
  );
}

describe('GeminiProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('concatenates streamed candidate text parts', async () => {
    const body = deltaFrame('Hello') + deltaFrame(', world');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(body)));

    const provider = new GeminiProvider({ apiKey: 'k' });
    expect(await drain(provider)).toBe('Hello, world');
  });

  it('skips keep-alive frames with no candidate text', async () => {
    const body = 'data: {"candidates":[{}]}\n\n' + deltaFrame('ok');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(body)));

    const provider = new GeminiProvider({ apiKey: 'k' });
    expect(await drain(provider)).toBe('ok');
  });

  it('maps a 401 response to AiError(auth)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('no key', { status: 401 })),
    );
    const provider = new GeminiProvider({ apiKey: 'bad' });
    await expect(drain(provider)).rejects.toMatchObject({ kind: 'auth' });
  });

  it('maps a 429 response to AiError(rate_limit)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('slow down', { status: 429 })),
    );
    const provider = new GeminiProvider({ apiKey: 'k' });
    await expect(drain(provider)).rejects.toMatchObject({
      kind: 'rate_limit',
      retryable: true,
    });
  });

  it('maps a fetch rejection (abort) to AiError(aborted)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError')),
    );
    const provider = new GeminiProvider({ apiKey: 'k' });
    await expect(drain(provider)).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('streams to :streamGenerateContent with the key header and temperature', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(deltaFrame('x')));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new GeminiProvider({ apiKey: 'secret' });
    await drain(provider);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/models/gemini-2.5-flash:streamGenerateContent');
    expect(url).toContain('alt=sse');
    expect(init.headers['x-goog-api-key']).toBe('secret');
    const sent = JSON.parse(init.body);
    expect(sent.generationConfig.temperature).toBe(0.8);
    expect(sent.contents).toEqual([
      { role: 'user', parts: [{ text: 'hi' }] },
    ]);
  });

  it('testConnection returns true on an OK models response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { status: 200 })),
    );
    const provider = new GeminiProvider({ apiKey: 'k' });
    expect(await provider.testConnection('gemini-2.5-flash')).toBe(true);
  });

  it('testConnection returns false on a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    const provider = new GeminiProvider({ apiKey: 'k' });
    expect(await provider.testConnection('gemini-2.5-flash')).toBe(false);
  });
});

describe('toGeminiRequest', () => {
  it('lifts system turns into a single systemInstruction', () => {
    const { contents, systemInstruction } = toGeminiRequest([
      { role: 'system', content: 'Be terse.' },
      { role: 'system', content: 'No filler.' },
      { role: 'user', content: 'go' },
    ]);

    expect(systemInstruction).toEqual({
      parts: [{ text: 'Be terse.\n\nNo filler.' }],
    });
    expect(contents).toEqual([{ role: 'user', parts: [{ text: 'go' }] }]);
  });

  it('maps assistant turns to the model role', () => {
    const { contents, systemInstruction } = toGeminiRequest([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'three' },
    ]);

    expect(systemInstruction).toBeUndefined();
    expect(contents).toEqual([
      { role: 'user', parts: [{ text: 'one' }] },
      { role: 'model', parts: [{ text: 'two' }] },
      { role: 'user', parts: [{ text: 'three' }] },
    ]);
  });
});
