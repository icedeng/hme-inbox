import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  importGenericApiEmails,
  TurbEmailPoolError,
} from '../src/lib/turb/emailPoolClient.ts';

const CONFIG = { baseUrl: 'http://turb.test', authCode: 'secret-auth' };

describe('turb 通用 API 邮箱池客户端', () => {
  test('批量导入使用 generic_api 正文和 Bearer 鉴权', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return Response.json({ ok: true, parsed: 2, inserted: 1, skipped: 1 });
    }) as typeof fetch;

    const result = await importGenericApiEmails(
      CONFIG,
      [
        { email: 'a@icloud.com', pickupUrl: 'https://hme.test/token-a/a@icloud.com' },
        { email: 'b@icloud.com', pickupUrl: 'https://hme.test/token-b/b@icloud.com' },
      ],
      fetchImpl,
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'http://turb.test/api/outlook/import');
    assert.equal(calls[0]?.init.method, 'POST');
    assert.equal(new Headers(calls[0]?.init.headers).get('authorization'), 'Bearer secret-auth');
    assert.equal(new Headers(calls[0]?.init.headers).get('content-type'), 'application/json');
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
      source: 'generic_api',
      as_registered: false,
      text:
        'a@icloud.com----https://hme.test/token-a/a@icloud.com\n' +
        'b@icloud.com----https://hme.test/token-b/b@icloud.com',
    });
    assert.ok(calls[0]?.init.signal, '必须设置请求超时 signal');
    assert.deepEqual(result, { parsed: 2, inserted: 1, skipped: 1 });
  });

  test('空列表不发起网络请求', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      throw new Error('不应调用');
    }) as typeof fetch;

    const result = await importGenericApiEmails(CONFIG, [], fetchImpl);

    assert.equal(called, false);
    assert.deepEqual(result, { parsed: 0, inserted: 0, skipped: 0 });
  });

  test('401 返回明确鉴权错误且不泄露鉴权码', async () => {
    const fetchImpl = (async () =>
      Response.json(
        { ok: false, error: `invalid ${CONFIG.authCode}` },
        { status: 401 },
      )) as typeof fetch;

    await assert.rejects(
      () => importGenericApiEmails(CONFIG, [{ email: 'a@icloud.com', pickupUrl: 'u' }], fetchImpl),
      (error: unknown) => {
        assert.ok(error instanceof TurbEmailPoolError);
        assert.equal(error.code, 'unauthorized');
        assert.doesNotMatch(error.message, new RegExp(CONFIG.authCode));
        return true;
      },
    );
  });

  test('非 JSON 和畸形成功响应被拒绝', async () => {
    for (const response of [
      new Response('not json', { status: 200 }),
      Response.json({ ok: true, parsed: 1, inserted: -1, skipped: 2 }),
      Response.json({ ok: true, parsed: 1, inserted: '1', skipped: 0 }),
    ]) {
      const fetchImpl = (async () => response.clone()) as typeof fetch;
      await assert.rejects(
        () =>
          importGenericApiEmails(
            CONFIG,
            [{ email: 'a@icloud.com', pickupUrl: 'u' }],
            fetchImpl,
          ),
        (error: unknown) => {
          assert.ok(error instanceof TurbEmailPoolError);
          assert.equal(error.code, 'invalid_response');
          return true;
        },
      );
    }
  });

  test('网络异常被脱敏包装', async () => {
    const fetchImpl = (async () => {
      throw new Error(`connect failed with ${CONFIG.authCode}`);
    }) as typeof fetch;

    await assert.rejects(
      () => importGenericApiEmails(CONFIG, [{ email: 'a@icloud.com', pickupUrl: 'u' }], fetchImpl),
      (error: unknown) => {
        assert.ok(error instanceof TurbEmailPoolError);
        assert.equal(error.code, 'network_error');
        assert.doesNotMatch(error.message, new RegExp(CONFIG.authCode));
        return true;
      },
    );
  });
});
