/**
 * 导出收件地址与取件 URL。
 *
 * 默认 txt，每行 `email----url`，方便直接喂给脚本或别的系统。
 * 尊重列表页当前的搜索与状态筛选 —— 导出的就是你眼前看到的那批。
 */
import { getDb } from '../../../../lib/db/connection.ts';
import { webEnv } from '../../../../lib/config/env.ts';
import { requireSession } from '../../../../lib/auth/session.ts';
import { decryptToken, buildPickupUrl } from '../../../../lib/tokens/token.ts';
import * as aliasesRepo from '../../../../lib/repositories/aliases.repo.ts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 分隔符用四个连字符：邮箱和 URL 里都不会出现它，切分不会歧义。 */
const SEPARATOR = '----';

export async function GET(request: Request): Promise<Response> {
  if (!(await requireSession())) {
    return Response.json({ error: { code: 'unauthorized', message: '请先登录' } }, { status: 401 });
  }

  const search = new URL(request.url).searchParams;
  const format = (search.get('format') ?? 'txt').toLowerCase();
  const q = search.get('q');
  const status = search.get('status');

  const db = getDb();
  const env = webEnv();

  const aliases = aliasesRepo.listAliases(db, {
    ...(q ? { search: q } : {}),
    ...(status === 'active' || status === 'disabled' ? { status } : {}),
    limit: 10_000,
  });

  const rows = aliases.map((alias) => ({
    email: alias.email,
    url: buildPickupUrl(env.PUBLIC_BASE_URL, decryptToken(alias.tokenCiphertext, env.TOKEN_ENC_KEY), alias.email),
    label: alias.label,
    status: alias.status,
  }));

  const stamp = new Date().toISOString().slice(0, 10);

  if (format === 'json') {
    return new Response(JSON.stringify(rows, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="hme-pickup-${stamp}.json"`,
        'Cache-Control': 'no-store',
      },
    });
  }

  if (format === 'csv') {
    const escape = (v: string): string => `"${v.replace(/"/g, '""')}"`;
    const csv = [
      'email,url,label,status',
      ...rows.map((r) => [r.email, r.url, r.label, r.status].map(escape).join(',')),
    ].join('\n');
    return new Response('﻿' + csv, {
      status: 200,
      headers: {
        // BOM 是给 Excel 的，没有它中文标签会乱码
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="hme-pickup-${stamp}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  }

  const txt = rows.map((r) => `${r.email}${SEPARATOR}${r.url}`).join('\n');
  return new Response(txt + (txt ? '\n' : ''), {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="hme-pickup-${stamp}.txt"`,
      // 导出文件里全是取件凭证，绝不能被缓存或索引
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}
