/**
 * 单封邮件详情：HTML 正文（已清洗）+ 附件清单 + 精选头。
 */
import { getDb } from '../../../../../lib/db/connection.ts';
import { webEnv } from '../../../../../lib/config/env.ts';
import { resolveAlias, parseParams, recordAccess, tokenPrefix } from '../../../../../lib/api/pickup.ts';
import { sanitizeEmailHtml } from '../../../../../lib/email/sanitizeHtml.ts';
import { parseHeaders } from '../../../../../lib/email/headers.ts';
import * as messagesRepo from '../../../../../lib/repositories/messages.repo.ts';
import * as attachmentsRepo from '../../../../../lib/repositories/attachments.repo.ts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = {
  'Cache-Control': 'no-store, max-age=0',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer',
};

/** 只回显这几个头，避免把内部投递链路暴露给调用方。 */
const EXPOSED_HEADERS = [
  'from', 'to', 'cc', 'subject', 'date', 'message-id',
  'reply-to', 'list-unsubscribe', 'x-icloud-hme',
];

export async function GET(
  request: Request,
  context: { params: Promise<{ token: string; email: string; messageId: string }> },
): Promise<Response> {
  const { token, email, messageId } = await context.params;
  const db = getDb();
  const env = webEnv();

  const id = Number(messageId);
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json(
      { error: { code: 'invalid_parameter', message: 'messageId 必须是正整数', field: 'messageId' } },
      { status: 400, headers: NO_STORE },
    );
  }

  const resolved = resolveAlias(db, token, email);
  if (!resolved.ok) {
    recordAccess(db, {
      aliasId: resolved.outcome === 'alias_disabled' ? resolved.alias.id : null,
      tokenPrefix: tokenPrefix(token),
      emailParam: email,
      statusCode: resolved.status,
      outcome: resolved.outcome,
      returned: 0,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: request.headers.get('user-agent'),
    });
    return resolved.status === 403
      ? Response.json({ error: { code: 'alias_disabled', message: '该收件地址已被停用' } }, { status: 403, headers: NO_STORE })
      : Response.json({ error: { code: 'not_found', message: '取件地址无效' } }, { status: 404, headers: NO_STORE });
  }

  const parsed = parseParams(new URL(request.url).searchParams);
  const allowImages = 'params' in parsed ? parsed.params.allowImages : false;

  // 必须带别名归属校验：不校验的话，任一 token 都能靠遍历 messageId 读到全库邮件
  const message = messagesRepo.getForAlias(db, resolved.alias.id, id);
  if (!message) {
    return Response.json(
      { error: { code: 'not_found', message: '邮件不存在' } },
      { status: 404, headers: NO_STORE },
    );
  }

  const attachments = attachmentsRepo.listByMessage(db, id);
  const headerMap: Record<string, string> = {};
  for (const h of parseHeaders(message.rawHeaders)) {
    if (EXPOSED_HEADERS.includes(h.lower) && !(h.lower in headerMap)) {
      headerMap[h.lower] = h.value;
    }
  }

  const base = `${env.PUBLIC_BASE_URL}/${token}/${resolved.alias.email}`;

  return Response.json(
    {
      id: message.id,
      email: resolved.alias.email,
      from: { name: message.fromName, address: message.fromAddress },
      subject: message.subject,
      date: message.dateSent,
      received_at: message.dateReceived,
      mailbox: message.mailbox,
      text: message.textBody,
      // 远程图片默认阻断：追踪像素会把服务器 IP 和取件时刻回传给发件人
      html: sanitizeEmailHtml(message.htmlBody, { allowRemoteImages: allowImages }),
      images_blocked: !allowImages,
      verification_code: message.verificationCode,
      code_confidence: message.codeConfidence,
      unread: message.readAt === null,
      truncated: message.truncated,
      size_bytes: message.sizeBytes,
      headers: headerMap,
      match: { layer: message.matchLayer, confidence: message.matchConfidence },
      attachments: attachments.map((a) => ({
        id: a.id,
        filename: a.filename,
        content_type: a.contentType,
        size_bytes: a.sizeBytes,
        available: a.storage !== 'dropped',
        download_url: `${base}/${message.id}/attachments/${a.id}`,
      })),
    },
    { status: 200, headers: NO_STORE },
  );
}
