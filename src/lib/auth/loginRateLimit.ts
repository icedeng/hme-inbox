import { isIP } from 'node:net';

export interface HeaderReader {
  get(name: string): string | null;
}

export interface FailureRateLimiterOptions {
  windowMs: number;
  maxAttempts: number;
  maxKeys: number;
}

interface FailureRecord {
  count: number;
  firstAt: number;
  lastAt: number;
}

/** 有 TTL 和容量上限的失败计数器，避免攻击者用无限新键耗尽内存。 */
export class FailureRateLimiter {
  private readonly attempts = new Map<string, FailureRecord>();
  private readonly options: FailureRateLimiterOptions;

  constructor(options: FailureRateLimiterOptions) {
    this.options = options;
    if (
      !Number.isSafeInteger(options.windowMs) ||
      options.windowMs <= 0 ||
      !Number.isSafeInteger(options.maxAttempts) ||
      options.maxAttempts <= 0 ||
      !Number.isSafeInteger(options.maxKeys) ||
      options.maxKeys <= 0
    ) {
      throw new Error('登录限速配置必须是正整数');
    }
  }

  private prune(now: number): void {
    for (const [key, record] of this.attempts) {
      if (now - record.firstAt >= this.options.windowMs) this.attempts.delete(key);
    }
  }

  isLimited(key: string, now: number = Date.now()): boolean {
    this.prune(now);
    return (this.attempts.get(key)?.count ?? 0) >= this.options.maxAttempts;
  }

  recordFailure(key: string, now: number = Date.now()): void {
    this.prune(now);
    const current = this.attempts.get(key);
    if (!current) {
      while (this.attempts.size >= this.options.maxKeys) {
        const oldest = this.attempts.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.attempts.delete(oldest);
      }
      this.attempts.set(key, { count: 1, firstAt: now, lastAt: now });
      return;
    }

    current.count++;
    current.lastAt = now;
    // 将活跃键移到队尾，容量淘汰优先淘汰最久未更新的键。
    this.attempts.delete(key);
    this.attempts.set(key, current);
  }

  clear(key: string): void {
    this.attempts.delete(key);
  }

  size(now: number = Date.now()): number {
    this.prune(now);
    return this.attempts.size;
  }
}

function firstValidIp(value: string | null): string | null {
  const first = value?.split(',')[0]?.trim() ?? '';
  return first && first.length <= 64 && isIP(first) ? first : null;
}

/** 只有明确配置可信代理时才读取转发头，直连模式完全忽略客户端伪造值。 */
export function trustedClientIp(headers: HeaderReader, trustProxy: boolean): string | null {
  if (!trustProxy) return null;
  return (
    firstValidIp(headers.get('x-real-ip')) ??
    firstValidIp(headers.get('cf-connecting-ip')) ??
    firstValidIp(headers.get('x-forwarded-for'))
  );
}

export interface LoginRateLimitOptions {
  windowMs?: number;
  accountMaxAttempts?: number;
  clientMaxAttempts?: number;
  maxClientKeys?: number;
}

export interface LoginRateLimit {
  isLimited(headers: HeaderReader, trustProxy: boolean, now?: number): boolean;
  recordFailure(headers: HeaderReader, trustProxy: boolean, now?: number): void;
  clear(headers: HeaderReader, trustProxy: boolean): void;
  clientIp(headers: HeaderReader, trustProxy: boolean): string | null;
  clientKeyCount(now?: number): number;
}

const ACCOUNT_KEY = 'admin-account';

/** 账户级限制不可绕过；客户端级限制只作为额外纵深防御。 */
export function createLoginRateLimit(options: LoginRateLimitOptions = {}): LoginRateLimit {
  const windowMs = options.windowMs ?? 5 * 60_000;
  const account = new FailureRateLimiter({
    windowMs,
    maxAttempts: options.accountMaxAttempts ?? 20,
    maxKeys: 1,
  });
  const clients = new FailureRateLimiter({
    windowMs,
    maxAttempts: options.clientMaxAttempts ?? 5,
    maxKeys: options.maxClientKeys ?? 1024,
  });

  const keys = (headers: HeaderReader, trustProxy: boolean): { ip: string | null } => ({
    ip: trustedClientIp(headers, trustProxy),
  });

  return {
    isLimited(headers, trustProxy, now = Date.now()) {
      const { ip } = keys(headers, trustProxy);
      return account.isLimited(ACCOUNT_KEY, now) || (ip !== null && clients.isLimited(ip, now));
    },
    recordFailure(headers, trustProxy, now = Date.now()) {
      const { ip } = keys(headers, trustProxy);
      account.recordFailure(ACCOUNT_KEY, now);
      if (ip !== null) clients.recordFailure(ip, now);
    },
    clear(headers, trustProxy) {
      const { ip } = keys(headers, trustProxy);
      account.clear(ACCOUNT_KEY);
      if (ip !== null) clients.clear(ip);
    },
    clientIp(headers, trustProxy) {
      return trustedClientIp(headers, trustProxy);
    },
    clientKeyCount(now = Date.now()) {
      return clients.size(now);
    },
  };
}

export const loginRateLimit = createLoginRateLimit();
