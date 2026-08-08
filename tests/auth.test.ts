import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword,
  verifyPassword,
  isValidPasswordHash,
} from '../src/lib/auth/password.ts';
import {
  generateToken,
  hashToken,
  encryptToken,
  decryptToken,
  buildPickupUrl,
  safeEqual,
} from '../src/lib/tokens/token.ts';

const KEY = Buffer.alloc(32, 5).toString('base64');

describe('管理员密码', () => {
  test('哈希后能验回来', () => {
    const stored = hashPassword('test-password-not-real');
    assert.ok(verifyPassword('test-password-not-real', stored));
    assert.ok(!verifyPassword('wrong', stored));
  });

  test('同一密码两次哈希不同（加盐）', () => {
    assert.notEqual(hashPassword('same'), hashPassword('same'));
  });

  test('哈希串里绝不能含 $ —— 会被 .env 的变量展开吃掉', () => {
    const stored = hashPassword('anything');
    assert.ok(
      !stored.includes('$'),
      'Next 用 dotenv-expand、Compose 自己也插值 $VAR。哈希里带 $ 会被静默啃掉一截，' +
        '表现成「密码怎么都不对」，是最难排查的一类故障。',
    );
  });

  test('模拟 dotenv-expand 的破坏，形状校验必须拦下', () => {
    // dotenv-expand 会把 $65536 / $8 这类当成未定义变量替换成空串
    const brokenLegacy = 'scrypt==+gAkaEw3vVH0V09DwgrleBPGjrBAJpldQ8J2fsBfHtva072MTydi';
    assert.ok(!isValidPasswordHash(brokenLegacy));
    assert.ok(!verifyPassword('test-password-not-real', brokenLegacy));
  });

  test('形状校验认得出合法哈希与各种畸形值', () => {
    assert.ok(isValidPasswordHash(hashPassword('x')));
    for (const bad of [
      '',
      'plaintext',
      'scrypt:65536:8:1:short',
      'scrypt:notanumber:8:1:AAAAAAAAAAAAAAAAAAAAAA==:AAAA',
      'bcrypt:65536:8:1:AAAAAAAAAAAAAAAAAAAAAA==:AAAA',
    ]) {
      assert.ok(!isValidPasswordHash(bad), `应判定为非法：${bad}`);
    }
  });

  test('畸形哈希不抛异常，只返回 false', () => {
    for (const bad of ['', 'x', 'scrypt:1:1:1:!!!:!!!', 'a:b:c:d:e:f']) {
      assert.equal(verifyPassword('any', bad), false);
    }
  });

});

describe('取件 token', () => {
  test('生成的 token 是 URL 安全的，且不含 $', () => {
    for (let i = 0; i < 50; i++) {
      const token = generateToken();
      assert.match(token, /^[A-Za-z0-9_-]+$/, 'base64url 不该含 + / = 或 $');
      assert.equal(token.length, 32);
      // 放进 URL path 段后不应被改写
      assert.equal(encodeURIComponent(token), token);
    }
  });

  test('token 不重复', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateToken()));
    assert.equal(seen.size, 500);
  });

  test('哈希稳定且单向', () => {
    const token = generateToken();
    assert.equal(hashToken(token), hashToken(token));
    assert.equal(hashToken(token).length, 64);
    assert.notEqual(hashToken(token), hashToken(generateToken()));
  });

  test('加密后能解回原文', () => {
    const token = generateToken();
    const blob = encryptToken(token, KEY);
    assert.equal(decryptToken(blob, KEY), token);
  });

  test('同一 token 两次加密密文不同（随机 IV）', () => {
    const token = generateToken();
    assert.notDeepEqual(encryptToken(token, KEY), encryptToken(token, KEY));
  });

  test('换密钥解不开，密文被篡改也解不开（GCM 认证）', () => {
    const blob = encryptToken(generateToken(), KEY);
    const otherKey = Buffer.alloc(32, 9).toString('base64');
    assert.throws(() => decryptToken(blob, otherKey));

    const tampered = Buffer.from(blob);
    const last = tampered.length - 1;
    tampered[last] = (tampered[last] ?? 0) ^ 0xff;
    assert.throws(() => decryptToken(tampered, KEY));
  });

  test('密钥长度不对时立即报错，而不是产出不可解的密文', () => {
    assert.throws(() => encryptToken('x', Buffer.alloc(16).toString('base64')), /32 字节/);
  });

  test('拼出的取件 URL 形如 base/token/email', () => {
    const url = buildPickupUrl('https://api.example.com/', 'TOK', 'mint.cave.4m@icloud.com');
    assert.equal(url, 'https://api.example.com/TOK/mint.cave.4m@icloud.com');
  });

  test('常量时间比较', () => {
    assert.ok(safeEqual('abc', 'abc'));
    assert.ok(!safeEqual('abc', 'abd'));
    assert.ok(!safeEqual('abc', 'abcd'));
  });
});
