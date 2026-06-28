import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpenAiProvider } from './openai-provider';
import type { ChatMessage, GenerateOpts } from './ai-provider';

const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
const opts: GenerateOpts = { model: 'gpt-x' };

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

async function drain(provider: OpenAiProvider): Promise<string> {
  let text = '';
  for await (const delta of provider.generate(messages, opts)) {
    text += delta;
  }
  return text;
}

describe('OpenAiProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('concatenates streamed content deltas', async () => {
    const body =
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":", world"}}]}\n\n' +
      'data: [DONE]\n\n';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(body)));

    const provider = new OpenAiProvider({ apiKey: 'k' });
    expect(await drain(provider)).toBe('Hello, world');
  });

  it('maps a 401 response to AiError(auth)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('no key', { status: 401 })),
    );
    const provider = new OpenAiProvider({ apiKey: 'bad' });
    await expect(drain(provider)).rejects.toMatchObject({ kind: 'auth' });
  });

  it('maps a 429 response to AiError(rate_limit)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('slow down', { status: 429 })),
    );
    const provider = new OpenAiProvider({ apiKey: 'k' });
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
    const provider = new OpenAiProvider({ apiKey: 'k' });
    await expect(drain(provider)).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('sends temperature, stream:true and the bearer key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse('data: [DONE]\n\n'));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAiProvider({ apiKey: 'secret' });
    await drain(provider);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer secret');
    const sent = JSON.parse(init.body);
    expect(sent).toMatchObject({ model: 'gpt-x', stream: true, temperature: 0.8 });
  });

  it('testConnection returns true on an OK models response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const provider = new OpenAiProvider({ apiKey: 'k' });
    expect(await provider.testConnection('gpt-x')).toBe(true);
  });

  it('testConnection returns false on a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    const provider = new OpenAiProvider({ apiKey: 'k' });
    expect(await provider.testConnection('gpt-x')).toBe(false);
  });

  it('sets turbo mode when the story name ends with the marker', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse('data: [DONE]\n\n')));
    const provider = new OpenAiProvider({ apiKey: 'k' });

    for await (const _ of provider.generate(messages, {
      model: 'gpt-x',
      storyName: 'Midnight Heist_AKM_',
    })) {
      // drain
    }
    expect(provider.turbo).toBe(true);

    for await (const _ of provider.generate(messages, {
      model: 'gpt-x',
      storyName: 'Midnight Heist',
    })) {
      // drain
    }
    expect(provider.turbo).toBe(false);
  });
});
