import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { AiError } from '../ai/ai-error';
import { AI_PROVIDER } from '../ai/ai-provider.token';
import { FakeProvider } from '../ai/fake-provider';
import { ContextBuilder, type ContextInput } from '../context/context-builder';
import { GenerationService } from './generation.service';

function input(): ContextInput {
  return {
    story: {
      id: 's1',
      worldId: 'w1',
      eraId: '',
      title: 'T',
      updatedAt: 0,
    },
    chapters: [
      { id: 'c1', storyId: 's1', order: 0, title: 'T', body: 'Hello.', updatedAt: 0 },
    ],
    cards: [],
    nextBeat: 'next thing',
  };
}

function configure(provider: FakeProvider): GenerationService {
  TestBed.configureTestingModule({
    providers: [
      { provide: AI_PROVIDER, useValue: provider },
      ContextBuilder,
      GenerationService,
    ],
  });
  return TestBed.inject(GenerationService);
}

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of gen) {
    out.push(chunk);
  }
  return out;
}

describe('GenerationService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('streams the provider chunks in order', async () => {
    const svc = configure(new FakeProvider({ chunks: ['a', 'b', 'c'] }));
    const chunks = await collect(svc.generate(input()));
    expect(chunks).toEqual(['a', 'b', 'c']);
    expect(svc.streaming()).toBe(false);
    expect(svc.error()).toBeNull();
  });

  it('records a terminal provider error and leaves partial chunks', async () => {
    const provider = new FakeProvider({
      chunks: ['a', 'b'],
      error: new AiError('rate_limit', 'slow down'),
      errorAfter: 1,
    });
    const svc = configure(provider);

    const chunks = await collect(svc.generate(input()));

    expect(chunks).toEqual(['a']);
    expect(svc.error()?.kind).toBe('rate_limit');
    expect(svc.streaming()).toBe(false);
  });

  it('stop() aborts in flight and does not record an error', async () => {
    const provider = new FakeProvider({ chunks: ['a', 'b', 'c'], delayMs: 10 });
    const svc = configure(provider);

    const out: string[] = [];
    const run = (async () => {
      for await (const chunk of svc.generate(input())) {
        out.push(chunk);
        svc.stop();
      }
    })();
    await run;

    expect(svc.error()).toBeNull();
    expect(svc.streaming()).toBe(false);
    expect(out.length).toBeGreaterThanOrEqual(1);
  });

  it('propagates the context trim notice', async () => {
    const svc = configure(new FakeProvider({ chunks: ['x'] }));
    const big = 'y'.repeat(40000); // ~10k tokens, over the default budget
    const cfg = input();
    cfg.chapters = [
      { id: 'a', storyId: 's1', order: 0, title: '', body: big, updatedAt: 0 },
      { id: 'b', storyId: 's1', order: 1, title: '', body: 'tail', updatedAt: 0 },
      { id: 'c', storyId: 's1', order: 2, title: '', body: 'current', updatedAt: 0 },
    ];
    await collect(svc.generate(cfg));
    expect(svc.trimmedNote()).toMatch(/trimmed to fit/);
  });

  it('clears a prior error when a new run starts', async () => {
    const svc = configure(new FakeProvider({ chunks: ['ok'] }));
    svc.error.set(new AiError('network', 'boom'));
    await collect(svc.generate(input()));
    expect(svc.error()).toBeNull();
  });
});
