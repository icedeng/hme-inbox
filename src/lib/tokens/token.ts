/**
 * 取件 token。
 *
 * 一别名一 token，本质是能力 URL（capability URL）：
 * 持有它就等于持有该别名的读取权。所以设计围绕三点：
 *
 * 1. 熵要足够 —— 系统不做速率限制，只能靠熵本身抗爆破
 * 2. 查询走哈希索引，明文另行加密存储 —— 后台要能随时复制 URL，
 *    但数据库文件泄露（备份、volume 快照、docker cp）不该等于凭证泄露
 * 3. 必须能轮换 —— 能力 URL 一旦泄露，除轮换外没有任何补救手段
 */
import { randomBytes, createHash, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';

/** 24 字节 = 192 位熵，base64url 编码后 32 字符。 */
const TOKEN_BYTES = 24;
const PREFIX_LENGTH = 8;

const IV_LENGTH = 12; // GCM 推荐 96 位
const TAG_LENGTH = 16;

/**
 * 生成取件 token。
 *
 * 用 base64url 而非 hex：同样熵下 hex 要 48 字符，URL 太长。
 * base64url 不含 `+` `/` `=`，放进 URL path 无需转义。
 * 也不用 UUID —— 只有 122 位有效熵，还带连字符和固定的版本位。
 */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** 查询键。token 本身已是高熵随机串，无需加盐或慢哈希。 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 前缀用于日志和 UI 识别，绝不记录完整 token。 */
export function tokenPrefix(token: string): string {
  return token.slice(0, PREFIX_LENGTH);
}

function keyFromBase64(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32) {
    throw new Error('TOKEN_ENC_KEY 必须是 base64 编码的 32 字节密钥');
  }
  return key;
}

/** 密文布局：iv(12) || tag(16) || ciphertext。 */
export function encryptToken(token: string, base64Key: string): Buffer {
  const key = keyFromBase64(base64Key);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptToken(blob: Uint8Array, base64Key: string): string {
  const key = keyFromBase64(base64Key);
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buf.length <= IV_LENGTH + TAG_LENGTH) {
    throw new Error('token 密文长度异常，数据可能已损坏');
  }
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export interface NewToken {
  token: string;
  hash: string;
  prefix: string;
  ciphertext: Buffer;
}

export function createToken(base64Key: string): NewToken {
  const token = generateToken();
  return {
    token,
    hash: hashToken(token),
    prefix: tokenPrefix(token),
    ciphertext: encryptToken(token, base64Key),
  };
}

/**
 * 拼取件 URL。
 *
 * email 段不做 encodeURIComponent：`@` 与 `.` 在 URL path 段里都是合法字符，
 * 编码后反而让复制出来的地址难读。服务端解析时会做一次 decode 以兼容
 * 那些坚持编码的调用方。
 */
export function buildPickupUrl(baseUrl: string, token: string, email: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${token}/${email}`;
}

/** 常量时间比较，用于会话令牌等需要防时序侧信道的场景。 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
