/**
 * 异步小工具。
 */

/**
 * 互斥锁。
 *
 * IDLE 与兜底轮询都会触发 fetch，同时跑会对同一批 UID 重复拉取、
 * 也会让 last_seen_uid 的推进出现竞态。ingestMessage 的幂等键能兜住
 * 重复入库，但白白浪费带宽和 iCloud 的配额，所以这里再加一层互斥。
 */
export class AsyncMutex {
  #queue: Array<() => void> = [];
  #locked = false;

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await fn();
    } finally {
      this.#release();
    }
  }

  get locked(): boolean {
    return this.#locked;
  }

  #acquire(): Promise<void> {
    if (!this.#locked) {
      this.#locked = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.#queue.push(resolve));
  }

  #release(): void {
    const next = this.#queue.shift();
    if (next) next();
    else this.#locked = false;
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('已取消'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('已取消'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  /** 抖动比例，0.2 表示 ±20%。两个容器同步重试会互相打架，抖动能错开。 */
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 1000, maxMs: 60_000, jitter: 0.2 };

export function backoffDelay(
  attempt: number,
  options: BackoffOptions = DEFAULT_BACKOFF,
): number {
  const raw = Math.min(options.baseMs * 2 ** attempt, options.maxMs);
  const jitter = 1 + (Math.random() * 2 - 1) * options.jitter;
  return Math.round(raw * jitter);
}
