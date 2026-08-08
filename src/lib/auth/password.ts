/**
 * 管理员密码。
 *
 * 只有一个管理员，但密码仍然用 scrypt 哈希存储、明文绝不进环境变量 ——
 * 环境变量会出现在 `docker inspect`、进程列表和崩溃日志里。
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SALT_BYTES = 16;
const KEY_BYTES = 64;
/** scrypt 参数。N=2^16 在现代硬件上约 100ms，对单管理员登录完全可接受。 */
const SCRYPT_PARAMS = { N: 65536, r: 8, p: 1, maxmem: 128 * 65536 * 8 * 2 };

/**
 * 格式：`scrypt:N:r:p:salt_base64:hash_base64`。
 *
 * **分隔符刻意用 `:` 而不是惯例的 `$`。** 这个哈希要放进环境变量，
 * 而处理 .env 的工具普遍会做变量展开：Next.js 用 dotenv-expand、
 * Docker Compose 自己也插值 `$VAR`。用 `$` 的话 `scrypt$65536$8$1$...`
 * 里的 `$65536`、`$8` 会被当成变量引用替换成空串，哈希被静默啃掉一截，
 * 表现出来是「密码怎么都不对」，极难联想到是 env 解析的问题。
 */
export function hashPassword(password: string): string {
  if (!password) throw new Error('密码不能为空');
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(password, salt, KEY_BYTES, SCRYPT_PARAMS);
  const { N, r, p } = SCRYPT_PARAMS;
  return `scrypt:${N}:${r}:${p}:${salt.toString('base64')}:${derived.toString('base64')}`;
}

/** 校验哈希串的形状。用于启动时 fail fast，把「被 env 展开吃掉」变成明确的报错。 */
export function isValidPasswordHash(stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  if (![parts[1], parts[2], parts[3]].every((v) => /^\d+$/.test(v ?? ''))) return false;
  return Buffer.from(parts[4] ?? '', 'base64').length === SALT_BYTES;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (salt.length === 0 || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = scryptSync(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: 128 * N * r * 2,
    });
  } catch {
    return false;
  }
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
