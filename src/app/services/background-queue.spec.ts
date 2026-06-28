import { describe, expect, it } from 'vitest';

import { BackgroundQueue } from './background-queue';

/** A promise plus its resolver, for gating a task at a precise point. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('BackgroundQueue', () => {
  it('runs enqueued tasks serially in FIFO order', async () => {
    const queue = new BackgroundQueue();
    const order: number[] = [];

    const a = queue.enqueue(async () => {
      order.push(1);
    });
    const b = queue.enqueue(async () => {
      order.push(2);
    });
    const c = queue.enqueue(async () => {
      order.push(3);
    });

    await Promise.all([a, b, c]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('resolves with the task result and rejects when a task throws', async () => {
    const queue = new BackgroundQueue();

    await expect(queue.enqueue(async () => 42)).resolves.toBe(42);
    await expect(
      queue.enqueue(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('never overlaps two tasks (single-flight)', async () => {
    const queue = new BackgroundQueue();
    let running = 0;
    let maxConcurrent = 0;
    const gateA = deferred();
    const gateB = deferred();

    const first = queue.enqueue(async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await gateA.promise;
      running--;
    });
    const second = queue.enqueue(async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await gateB.promise;
      running--;
    });

    await tick();
    expect(running).toBe(1); // second has not started while first is gated

    gateA.resolve();
    await tick();
    expect(running).toBe(1); // now it's the second one

    gateB.resolve();
    await Promise.all([first, second]);
    expect(maxConcurrent).toBe(1);
  });

  it('pauses dequeuing while a foreground generation holds the queue', async () => {
    const queue = new BackgroundQueue();
    let ran = false;

    const release = queue.beginForeground();
    const job = queue.enqueue(async () => {
      ran = true;
    });

    await tick();
    expect(ran).toBe(false); // queued behind the foreground hold
    expect(queue.isForeground).toBe(true);

    release();
    await job;
    expect(ran).toBe(true);
  });

  it('preempts an in-flight background task when foreground begins', async () => {
    const queue = new BackgroundQueue();
    const started = deferred();
    let aborted = false;

    const job = queue.enqueue(async (signal) => {
      started.resolve();
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      });
    });

    await started.promise; // task is running
    queue.beginForeground(); // preempt

    await expect(job).rejects.toThrow('aborted');
    expect(aborted).toBe(true);
  });

  it('runForeground preempts a running background task, then resumes', async () => {
    const queue = new BackgroundQueue();
    const order: string[] = [];
    const started = deferred();
    let bgAborted = false;

    const bg = queue
      .enqueue(async (signal) => {
        started.resolve();
        await new Promise<void>((_, reject) => {
          signal.addEventListener('abort', () => {
            bgAborted = true;
            reject(new Error('aborted'));
          });
        });
        order.push('bg');
      })
      .catch(() => order.push('bg-aborted'));

    await started.promise; // background task is running
    await queue.runForeground(async () => {
      order.push('fg');
    });
    await bg;

    expect(bgAborted).toBe(true);
    expect(order).toEqual(['fg', 'bg-aborted']);
    expect(queue.isForeground).toBe(false);
  });

  it('treats the foreground release as idempotent', async () => {
    const queue = new BackgroundQueue();
    const release = queue.beginForeground();
    release();
    release(); // second call is a no-op, does not go negative
    expect(queue.isForeground).toBe(false);

    await expect(queue.enqueue(async () => 'ok')).resolves.toBe('ok');
  });
});
