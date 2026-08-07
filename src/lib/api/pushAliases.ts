/**
 * Chrome 扩展推送隐藏邮箱的 HTTP 处理器。
 *
 * 依赖通过参数注入，Route Handler 只负责接真实数据库与环境变量；测试则使用
 * 内存 SQLite。鉴权先于请求体解析，避免未授权调用者利用解析差异探测接口。
 */
import { normalizeAddress, type NormalizedAddress } from '../email/address.ts';
import { withWriteTx, type Db } from '../db/driver.ts';
import { createToken, hashToken, safeEqual } from '../tokens/token.ts';
import * as aliasesRepo from '../repositories/aliases.repo.ts';

export interface PushAliasesDeps {
  db: Db;
  pushToken: string | undefined;
  tokenEncKey: string;
}

const MAX_EMAILS = 100;
const ICLOUD_EMAIL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@icloud\.com$/i;
const NO_STORE = { 'Cache-Control': 'no-store' };

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

function authorized(request: Request, configured: string): boolean {
  const header = request.headers.get('authorization') ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  // 固定为同长度 SHA-256 后再比较，避免直接比较时泄露 Token 长度。
  return safeEqual(hashToken(provided), hashToken(configured));
}

function parseEmails(value: unknown): { received: number; addresses: NormalizedAddress[] } | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_EMAILS) return null;

  const addresses: NormalizedAddress[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const raw = item.trim();
    if (!ICLOUD_EMAIL.test(raw)) return null;
    const address = normalizeAddress(raw);
    if (!address || address.domain !== 'icloud.com') return null;
    if (!seen.has(address.normalized)) {
      seen.add(address.normalized);
      addresses.push(address);
    }
  }
  return { received: value.length, addresses };
}

export function createPushAliasesHandler(deps: PushAliasesDeps) {
  return async function POST(request: Request): Promise<Response> {
    if (!deps.pushToken) {
      return json({ error: { code: 'push_disabled' } }, 503);
    }
    if (!authorized(request, deps.pushToken)) {
      return json({ error: { code: 'unauthorized' } }, 401);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: { code: 'invalid_json' } }, 400);
    }
    const parsed = parseEmails(
      body && typeof body === 'object' ? (body as { emails?: unknown }).emails : undefined,
    );
    if (!parsed) {
      return json({ error: { code: 'invalid_emails' } }, 400);
    }

    try {
      const created = withWriteTx(deps.db, (tx) => {
        let count = 0;
        for (const address of parsed.addresses) {
          // BEGIN IMMEDIATE 已持有写锁；检查与插入之间不会被另一写事务抢入。
          if (aliasesRepo.findByNormalized(tx, address.normalized)) continue;
          const token = createToken(deps.tokenEncKey);
          aliasesRepo.upsertAlias(tx, {
            email: address.raw,
            emailNormalized: address.normalized,
            localPart: address.localPart,
            domain: address.domain,
            label: 'Chrome 扩展',
            note: '',
            batchIndex: null,
            portal: 'chrome-extension',
            verified: true,
            sourceCreatedAt: null,
            importBatchId: null,
            tokenHash: token.hash,
            tokenPrefix: token.prefix,
            tokenCiphertext: token.ciphertext,
          });
          count++;
        }
        return count;
      });

      return json(
        {
          received: parsed.received,
          created,
          existing: parsed.addresses.length - created,
        },
        200,
      );
    } catch {
      return json({ error: { code: 'internal_error' } }, 500);
    }
  };
}
