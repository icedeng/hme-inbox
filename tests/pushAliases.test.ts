import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, type Db } from '../src/lib/db/driver.ts';
import { migrate } from '../src/lib/db/migrate.ts';
import { hashPassword } from '../src/lib/auth/password.ts';
import { loadWebEnv } from '../src/lib/config/env.ts';
import { normalizeAddress } from '../src/lib/email/address.ts';
import { createPushAliasesHandler } from '../src/lib/api/pushAliases.ts';
import { createToken } from '../src/lib/tokens/token.ts';
import * as aliasesRepo from '../src/lib/repositories/aliases.repo.ts';

const TOKEN_KEY = Buffer.alloc(32, 7).toString('base64');
const PUSH_TOKEN = 'push-token-for-tests-32-characters';
const opened: Db[] = [];
const BASE_ENV = {
  NODE_ENV: 'test' as const,
  ADMIN_PASSWORD_HASH: hashPassword('test-only'),
  SESSION_SECRET: Buffer.alloc(32, 8).toString('base64'),
  PUBLIC_BASE_URL: 'https://inbox.example',
  TOKEN_ENC_KEY: TOKEN_KEY,
};

function harness(pushToken: string | null = PUSH_TOKEN) {
  const db = openDb(':memory:');
  migrate(db);
  opened.push(db);
  return {
    db,
    post: createPushAliasesHandler({
      db,
      pushToken: pushToken ?? undefined,
      tokenEncKey: TOKEN_KEY,
    }),
  };
}

function request(emails: unknown, token = PUSH_TOKEN): Request {
  return new Request('https://inbox.example/api/aliases', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ emails }),
  });
}

function insertExisting(db: Db, email: string) {
  const address = normalizeAddress(email)!;
  const token = createToken(TOKEN_KEY);
  aliasesRepo.upsertAlias(db, {
    email: address.raw,
    emailNormalized: address.normalized,
    localPart: address.localPart,
    domain: address.domain,
    label: '保留标签',
    note: '保留备注',
    batchIndex: 7,
    portal: 'macos-system-settings',
    verified: false,
    sourceCreatedAt: '2026-08-01T00:00:00.000Z',
    importBatchId: null,
    tokenHash: token.hash,
    tokenPrefix: token.prefix,
    tokenCiphertext: token.ciphertext,
  });
  return aliasesRepo.findByNormalized(db, address.normalized)!;
}

afterEach(() => {
  while (opened.length) opened.pop()!.close();
});

describe('隐藏邮箱推送 API', () => {
  test('正确凭证新增缺失地址并对请求内重复项去重', async () => {
    const { db, post } = harness();
    const response = await post(
      request(['New.Alias@icloud.com', ' new.alias@icloud.com ']),
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { received: 2, created: 1, existing: 0 });
    assert.equal(aliasesRepo.countAliases(db), 1);
    const alias = aliasesRepo.findByNormalized(db, 'new.alias@icloud.com')!;
    assert.equal(alias.portal, 'chrome-extension');
    assert.equal(alias.label, 'Chrome 扩展');
    assert.equal(alias.verified, true);
    assert.equal(alias.tokenHash.length, 64);
  });

  test('重复推送保持已有元数据、状态和取件 Token 不变', async () => {
    const { db, post } = harness();
    const before = insertExisting(db, 'stable@icloud.com');
    aliasesRepo.setStatus(db, before.id, 'disabled');

    const response = await post(request(['STABLE@icloud.com']));
    const after = aliasesRepo.findByNormalized(db, 'stable@icloud.com')!;

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { received: 1, created: 0, existing: 1 });
    assert.equal(aliasesRepo.countAliases(db), 1);
    assert.equal(after.status, 'disabled');
    assert.equal(after.tokenHash, before.tokenHash);
    assert.equal(after.tokenPrefix, before.tokenPrefix);
    assert.deepEqual(after.tokenCiphertext, before.tokenCiphertext);
    assert.equal(after.label, '保留标签');
    assert.equal(after.note, '保留备注');
    assert.equal(after.batchIndex, 7);
    assert.equal(after.portal, 'macos-system-settings');
    assert.equal(after.verified, false);
  });

  test('未配置服务端 Token 时接口禁用', async () => {
    const { post } = harness(null);
    const response = await post(request(['x@icloud.com']));

    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { error: { code: 'push_disabled' } });
  });

  test('缺少或错误凭证时拒绝请求且不泄露 Token', async () => {
    const { post } = harness();
    const missing = await post(
      new Request('https://inbox.example/api/aliases', { method: 'POST' }),
    );
    const wrong = await post(request(['x@icloud.com'], 'wrong'));

    assert.equal(missing.status, 401);
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(await wrong.text(), new RegExp(PUSH_TOKEN));
  });

  test('非法 JSON、邮箱、空数组和超过上限的数组被拒绝', async () => {
    const { post } = harness();
    const invalidJson = new Request('https://inbox.example/api/aliases', {
      method: 'POST',
      headers: { authorization: `Bearer ${PUSH_TOKEN}` },
      body: '{',
    });
    assert.equal((await post(invalidJson)).status, 400);

    for (const emails of [
      [],
      ['not-an-email'],
      ['x@example.com'],
      ['<script>@icloud.com'],
      [123],
      Array(101).fill('x@icloud.com'),
    ]) {
      assert.equal((await post(request(emails))).status, 400);
    }
  });

  test('数据库异常返回不泄露内部细节的 500', async () => {
    const { db, post } = harness();
    opened.pop();
    db.close();

    const response = await post(request(['x@icloud.com']));

    assert.equal(response.status, 500);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { error: { code: 'internal_error' } });
  });
});

describe('隐藏邮箱推送配置', () => {
  test('推送 Token 可选，空字符串兼容 Compose 默认值', () => {
    assert.equal(loadWebEnv(BASE_ENV).HME_PUSH_TOKEN, undefined);
    assert.equal(loadWebEnv({ ...BASE_ENV, HME_PUSH_TOKEN: '' }).HME_PUSH_TOKEN, undefined);
  });

  test('推送 Token 去除首尾空白且拒绝过短值', () => {
    assert.equal(
      loadWebEnv({ ...BASE_ENV, HME_PUSH_TOKEN: '  configured-push-token  ' }).HME_PUSH_TOKEN,
      'configured-push-token',
    );
    assert.throws(
      () => loadWebEnv({ ...BASE_ENV, HME_PUSH_TOKEN: 'short' }),
      /HME_PUSH_TOKEN/,
    );
  });

  test('turb 邮箱池配置可选，空字符串表示禁用', () => {
    const env = loadWebEnv({
      ...BASE_ENV,
      TURB_GPT_BASE_URL: '',
      TURB_GPT_AUTH_CODE: '',
    });

    assert.equal(env.TURB_GPT_BASE_URL, undefined);
    assert.equal(env.TURB_GPT_AUTH_CODE, undefined);
  });

  test('turb 地址去除末尾斜杠且鉴权码去除空白', () => {
    const env = loadWebEnv({
      ...BASE_ENV,
      TURB_GPT_BASE_URL: ' http://192.168.0.250:5050/// ',
      TURB_GPT_AUTH_CODE: '  test-auth-code  ',
    });

    assert.equal(env.TURB_GPT_BASE_URL, 'http://192.168.0.250:5050');
    assert.equal(env.TURB_GPT_AUTH_CODE, 'test-auth-code');
  });

  test('turb 地址拒绝非 HTTP 协议和畸形 URL', () => {
    for (const value of ['ftp://example.com', 'not-a-url']) {
      assert.throws(
        () => loadWebEnv({ ...BASE_ENV, TURB_GPT_BASE_URL: value }),
        /TURB_GPT_BASE_URL/,
      );
    }
  });
});
