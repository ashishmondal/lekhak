import { Service } from '@angular/core';

/**
 * A unit of background work. Receives a signal that aborts when a foreground
 * generation preempts the queue, so a cooperating task (e.g. one streaming from
 * the provider via `collect`) can bail out promptly and free the BYOK key.
 */
export type QueueTask<T> = (signal: AbortSignal) => Promise<T>;

interface Job<T> {
  task: QueueTask<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

/**
 * One shared, single-flight queue for all background AI work (drift check,
 * extraction, full canon check). Tasks run strictly one at a time so the app
 * never fires two background calls at once on the user's single BYOK key.
 *
 * The foreground "Write Next" generation always wins: {@link beginForeground}
 * aborts any in-flight background task and pauses the queue until released, so
 * advisory work never races the action the author is waiting on (which would
 * otherwise invite 429s on one key).
 */
@Service()
export class BackgroundQueue {
  private readonly jobs: Job<unknown>[] = [];
  private active = false;
  private foreground = 0;
  private controller: AbortController | null = null;

  /** Number of jobs waiting to start (excludes the one currently running). */
  get size(): number {
    return this.jobs.length;
  }

  /** Whether a foreground generation currently holds the queue paused. */
  get isForeground(): boolean {
    return this.foreground > 0;
  }

  /**
   * Enqueue background work. Resolves with the task's result, or rejects if it
   * throws — including with an abort error when a foreground generation
   * preempts it. Callers treat a preempt as "try again on the next trigger".
   */
  enqueue<T>(task: QueueTask<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.jobs.push({ task, resolve, reject } as Job<unknown>);
      void this.pump();
    });
  }

  /**
   * Mark a foreground generation in flight. Immediately preempts (aborts) any
   * running background task and pauses dequeuing. Returns an idempotent release
   * function — call it (e.g. in a `finally`) when the foreground work settles to
   * let background work resume.
   */
  beginForeground(): () => void {
    this.foreground++;
    this.controller?.abort();
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.foreground = Math.max(0, this.foreground - 1);
      void this.pump();
    };
  }

  /** Run a foreground action with automatic preempt-then-release bookkeeping. */
  async runForeground<T>(action: () => Promise<T>): Promise<T> {
    const release = this.beginForeground();
    try {
      return await action();
    } finally {
      release();
    }
  }

  private async pump(): Promise<void> {
    if (this.active || this.foreground > 0) {
      return;
    }
    const job = this.jobs.shift();
    if (!job) {
      return;
    }
    this.active = true;
    this.controller = new AbortController();
    try {
      job.resolve(await job.task(this.controller.signal));
    } catch (err) {
      job.reject(err);
    } finally {
      this.controller = null;
      this.active = false;
      if (this.foreground === 0 && this.jobs.length > 0) {
        void this.pump();
      }
    }
  }
}
