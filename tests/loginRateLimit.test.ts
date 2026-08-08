import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

interface LoginRateLimit {
  isLimited(headers: Headers, trustProxy: boolean, now?: number): boolean;
  recordFailure(headers: Headers, trustProxy: boolean, now?: number): void;
  clear(headers: Headers, trustProxy: boolean): void;
  clientKeyCount(now?: number): number;
  clientIp(headers: Headers, trustProxy: boolean): string | null;
}

type LoginRateLimitFactory = (options?: {
  windowMs?: number;
  accountMaxAttempts?: number;
  clientMaxAttempts?: number;
  maxClientKeys?: number;
}) => LoginRateLimit;

async function loadFactory(): Promise<LoginRateLimitFactory | null> {
  const modulePath = '../src/lib/auth/loginRateLimit.ts';
  const module = (await import(modulePath).catch(() => null)) as {
    createLoginRateLimit?: LoginRateLimitFactory;
  } | null;
  return module?.createLoginRateLimit ?? null;
}

function forwarded(ip: string): Headers {
  return new Headers({ 'x-forwarded-for': ip });
}

describe('管理员登录限速', () => {
  test('未显式信任代理时忽略客户端提供的转发 IP', async () => {
    const createRateLimit = await loadFactory();
    assert.ok(createRateLimit, '缺少可信代理感知的登录限速器');
    const limiter = createRateLimit();
    const headers = forwarded('203.0.113.9');

    assert.equal(limiter.clientIp(headers, false), null);
    assert.equal(limiter.clientIp(headers, true), '203.0.113.9');
  });

  test('更换伪造转发 IP 仍会触发不可绕过的账户级限制', async () => {
    const createRateLimit = await loadFactory();
    assert.ok(createRateLimit, '缺少可信代理感知的登录限速器');
    const limiter = createRateLimit({
      windowMs: 300_000,
      accountMaxAttempts: 3,
      clientMaxAttempts: 2,
      maxClientKeys: 8,
    });
    const now = 1_000_000;

    for (const ip of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) {
      limiter.recordFailure(forwarded(ip), true, now);
    }

    assert.equal(
      limiter.isLimited(forwarded('203.0.113.99'), true, now),
      true,
      '账户级计数不能因更换 X-Forwarded-For 而绕过',
    );
  });

  test('客户端失败记录有容量上限且过期后清理', async () => {
    const createRateLimit = await loadFactory();
    assert.ok(createRateLimit, '缺少可信代理感知的登录限速器');
    const limiter = createRateLimit({
      windowMs: 1_000,
      accountMaxAttempts: 100,
      clientMaxAttempts: 5,
      maxClientKeys: 2,
    });

    limiter.recordFailure(forwarded('203.0.113.1'), true, 10_000);
    limiter.recordFailure(forwarded('203.0.113.2'), true, 10_000);
    limiter.recordFailure(forwarded('203.0.113.3'), true, 10_000);
    assert.equal(limiter.clientKeyCount(10_000), 2, '记录数不得超过配置上限');
    assert.equal(limiter.clientKeyCount(11_001), 0, '窗口过期后应主动清理全部旧记录');
  });
});
