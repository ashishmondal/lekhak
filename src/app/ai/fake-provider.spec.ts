import { describe, expect, it } from 'vitest';

import { AiError } from './ai-error';
import { FakeProvider } from './fake-provider';
import type { ChatMessage, GenerateOpts } from './ai-provider';

const messages: ChatMessage[] = [{ role: 'user', content: 'go' }];
const opts: GenerateOpts = { model: 'fake' };

async function drain(
  provider: FakeProvider,
  o: GenerateOpts = opts,
): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of provider.generate(messages, o)) {
    out.push(chunk);
  }
  return out;
}

describe('FakeProvider', () => {
  it('streams the configured chunks in order', async () => {
    const provider = new FakeProvider({ chunks: ['a', 'b', 'c'] });
    expect(await drain(provider)).toEqual(['a', 'b', 'c']);
  });

  it('captures the messages it was called with', async () => {
    const provider = new FakeProvider({ chunks: ['x'] });
    await drain(provider);
    expect(provider.lastMessages).toBe(messages);
  });

  it('throws AiError(aborted) when the signal is already aborted', async () => {
    const provider = new FakeProvider({ chunks: ['a', 'b'] });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(drain(provider, { ...opts, signal: ctrl.signal })).rejects.toMatchObject(
      { kind: 'aborted' },
    );
  });

  it('throws mid-stream after errorAfter chunks, keeping the prior chunks', async () => {
    const provider = new FakeProvider({
      chunks: ['a', 'b', 'c'],
      errorAfter: 2,
      error: new AiError('network', 'dropped'),
    });
    const out: string[] = [];
    await expect(
      (async () => {
        for await (const chunk of provider.generate(messages, opts)) {
          out.push(chunk);
        }
      })(),
    ).rejects.toMatchObject({ kind: 'network' });
    expect(out).toEqual(['a', 'b']);
  });

  it('testConnection reflects the configured error state', async () => {
    expect(await new FakeProvider().testConnection()).toBe(true);
    expect(
      await new FakeProvider({ error: new AiError('auth', 'bad') }).testConnection(),
    ).toBe(false);
  });
});
