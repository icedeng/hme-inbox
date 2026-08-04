/**
 * 取件列表接口。
 *
 * 内部路径是 /m/{token}/{email}，反向代理把 api.example.com/(.*) 重写到 /m/$1，
 * 对外就是 https://api.example.com/{token}/{email}。
 * 不用根路径 catch-all，是因为它会跟 /_next/*、/admin/*、favicon 全面冲突，
 * 还会吞掉所有 404。
 */
import { getDb } from '../../../../lib/db/connection.ts';
import { webEnv } from '../../../../lib/config/env.ts';
import {
  parseParams,
  resolveAlias,
  fetchMessages,
  markMessagesRead,
  recordAccess,
  touchAlias,
  toPayload,
  tokenPrefix,
  type ListPayload,
} from '../../../../lib/api/pickup.ts';
import { CODE_CONFIDENCE_THRESHOLD } from '../../../../lib/email/verificationCode.ts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = {
  'Cache-Control': 'no-store, max-age=0',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer',
};

function errorResponse(status: number, code: string, message: string, field?: string): Response {
  return Response.json(
    { error: { code, message, ...(field ? { field } : {}) } },
    { status, headers: NO_STORE },
  );
}

function clientIp(request: Request): string | null {
  const forwarded = request.headers.get('x-forwarded-for');
  return forwarded ? (forwarded.split(',')[0]?.trim() ?? null) : null;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ token: string; email: string }> },
): Promise<Response> {
  const { token, email } = await context.params;
  const db = getDb();
  const env = webEnv();
  const ip = clientIp(request);
  const userAgent = request.headers.get('user-agent');
  const prefix = tokenPrefix(token);

  const parsed = parseParams(new URL(request.url).searchParams);
  if ('error' in parsed) {
    recordAccess(db, {
      aliasId: null,
      tokenPrefix: prefix,
      emailParam: email,
      statusCode: 400,
      outcome: 'invalid_parameter',
      returned: 0,
      ip,
      userAgent,
    });
    return errorResponse(400, 'invalid_parameter', parsed.error.message, parsed.error.field);
  }
  const params = parsed.params;

  const resolved = resolveAlias(db, token, email);
  if (!resolved.ok) {
    recordAccess(db, {
      aliasId: resolved.outcome === 'alias_disabled' ? resolved.alias.id : null,
      tokenPrefix: prefix,
      emailParam: email,
      statusCode: resolved.status,
      outcome: resolved.outcome,
      returned: 0,
      ip,
      userAgent,
    });
    if (resolved.status === 403) {
      return errorResponse(403, 'alias_disabled', '该收件地址已被停用');
    }
    // token 不存在与 email 不匹配返回完全相同的响应，防枚举
    return errorResponse(404, 'not_found', '取件地址无效');
  }

  const alias = resolved.alias;
  const messages = await fetchMessages(db, alias.id, params, request.signal);

  if (params.markRead && messages.length > 0) {
    markMessagesRead(db, messages);
  }
  touchAlias(db, alias.id);
  recordAccess(db, {
    aliasId: alias.id,
    tokenPrefix: prefix,
    emailParam: email,
    statusCode: 200,
    outcome: messages.length > 0 ? 'ok' : 'empty',
    returned: messages.length,
    ip,
    userAgent,
  });

  // format=code：返回裸验证码纯文本，专为 shell 服务。
  //   CODE=$(curl -sf "$URL?format=code&wait=30") || echo "没收到"
  // 置信度不达标时返回 404 空体，而不是给一个可疑的值 ——
  // 用户拿着错码反复重试，比拿不到码难排查得多。
  if (params.format === 'code') {
    const best = messages.find(
      (m) => m.verificationCode && (m.codeConfidence ?? 0) >= CODE_CONFIDENCE_THRESHOLD,
    );
    if (!best?.verificationCode) {
      return new Response('', { status: 404, headers: NO_STORE });
    }
    return new Response(best.verificationCode, {
      status: 200,
      headers: { ...NO_STORE, 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  if (params.format === 'text') {
    const body = messages
      .map((m) =>
        [
          `From: ${m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress}`,
          `Subject: ${m.subject ?? ''}`,
          `Received: ${m.dateReceived}`,
          m.verificationCode ? `Code: ${m.verificationCode}` : null,
          '',
          m.textBody ?? m.snippet ?? '',
        ]
          .filter((line) => line !== null)
          .join('\n'),
      )
      .join('\n\n' + '─'.repeat(60) + '\n\n');
    return new Response(body, {
      status: 200,
      headers: { ...NO_STORE, 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  // 无符合条件的邮件返回 200 + 空数组，而不是 404。
  // 轮询场景下这远比 404 好处理；404 的语义留给「资源不存在」。
  const payload: ListPayload = {
    email: alias.email,
    alias_label: alias.label,
    count: messages.length,
    server_time: new Date().toISOString(),
    messages: messages.map((m) => toPayload(m, env.PUBLIC_BASE_URL, token, alias.email)),
  };
  return Response.json(payload, { status: 200, headers: NO_STORE });
}
