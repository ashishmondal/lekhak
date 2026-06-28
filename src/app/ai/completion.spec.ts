import { describe, expect, it } from 'vitest';

import { AiError } from './ai-error';
import { collect, parseJsonLoose } from './completion';
import { FakeProvider } from './fake-provider';

const opts = { model: 'fake' };

describe('collect', () => {
  it('accumulates all streamed chunks into one string', async () => {
    const provider = new FakeProvider({ chunks: ['Hello, ', 'world', '!'] });
    expect(await collect(provider, [], opts)).toBe('Hello, world!');
  });

  it('returns empty string when the provider yields nothing', async () => {
    const provider = new FakeProvider({ chunks: [] });
    expect(await collect(provider, [], opts)).toBe('');
  });

  it('throws an aborted AiError when the signal is already aborted', async () => {
    const provider = new FakeProvider({ chunks: ['a', 'b'] });
    const controller = new AbortController();
    controller.abort();
    await expect(
      collect(provider, [], { ...opts, signal: controller.signal }),
    ).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('maps a provider failure through AiError, preserving kind', async () => {
    const provider = new FakeProvider({
      chunks: ['a', 'b'],
      errorAfter: 1,
      error: new AiError('rate_limit', 'slow down'),
    });
    await expect(collect(provider, [], opts)).rejects.toMatchObject({
      kind: 'rate_limit',
    });
  });
});

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

interface Flag {
  cardId: string;
  reason: string;
}
const isFlag = (v: unknown): v is Flag =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as Flag).cardId === 'string' &&
  typeof (v as Flag).reason === 'string';

describe('parseJsonLoose', () => {
  it('parses a clean JSON object', () => {
    expect(parseJsonLoose('{"cardId":"c1","reason":"x"}', isFlag)).toEqual({
      cardId: 'c1',
      reason: 'x',
    });
  });

  it('parses JSON inside a ```json fence', () => {
    const text = 'Here you go:\n```json\n["Mira", "Tomas"]\n```\nDone.';
    expect(parseJsonLoose(text, isStringArray)).toEqual(['Mira', 'Tomas']);
  });

  it('parses JSON embedded in surrounding prose', () => {
    const text = 'The answer is ["a","b"] and nothing else.';
    expect(parseJsonLoose(text, isStringArray)).toEqual(['a', 'b']);
  });

  it('ignores braces inside string literals', () => {
    const text = '{"reason":"contradicts } the bible","cardId":"c2"}';
    expect(parseJsonLoose(text, isFlag)).toEqual({
      cardId: 'c2',
      reason: 'contradicts } the bible',
    });
  });

  it('returns null on malformed JSON', () => {
    expect(parseJsonLoose('{"cardId": "c1", oops}', isFlag)).toBeNull();
  });

  it('returns null when no JSON is present', () => {
    expect(parseJsonLoose('I could not analyze this draft.', isFlag)).toBeNull();
  });

  it('returns null when the guard rejects the shape', () => {
    expect(parseJsonLoose('{"unexpected":true}', isFlag)).toBeNull();
  });
});
