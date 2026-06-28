import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Autosave } from './autosave';

describe('Autosave', () => {
  afterEach(() => vi.useRealTimers());

  it('starts in the saved state', () => {
    expect(new Autosave().state()).toBe('saved');
  });

  it('coalesces a burst into a single flushed write (latest wins)', async () => {
    const svc = new Autosave();
    let count = 0;
    let last = '';

    svc.schedule(async () => {
      count++;
      last = 'a';
    });
    svc.schedule(async () => {
      count++;
      last = 'b';
    });
    svc.schedule(async () => {
      count++;
      last = 'c';
    });
    expect(svc.state()).toBe('saving');

    await svc.flush();

    expect(count).toBe(1);
    expect(last).toBe('c');
    expect(svc.state()).toBe('saved');
  });

  it('debounces a burst to one timer-driven write', async () => {
    vi.useFakeTimers();
    const svc = new Autosave();
    svc.configure(800);
    let count = 0;

    svc.schedule(async () => {
      count++;
    });
    svc.schedule(async () => {
      count++;
    });
    expect(count).toBe(0); // still waiting out the quiet period

    await vi.advanceTimersByTimeAsync(800);

    expect(count).toBe(1);
    expect(svc.state()).toBe('saved');
  });

  it('reports failed when the write throws', async () => {
    const svc = new Autosave();
    svc.schedule(async () => {
      throw new Error('quota');
    });

    await svc.flush();

    expect(svc.state()).toBe('failed');
  });

  it('flush with nothing pending is a no-op', async () => {
    const svc = new Autosave();
    await svc.flush();
    expect(svc.state()).toBe('saved');
  });
});
