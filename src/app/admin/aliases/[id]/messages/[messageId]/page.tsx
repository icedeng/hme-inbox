import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAdminPage } from '../../../../../../lib/auth/adminPage.ts';
import { getDb } from '../../../../../../lib/db/connection.ts';
import { webEnv } from '../../../../../../lib/config/env.ts';
import { withWriteTx } from '../../../../../../lib/db/driver.ts';
import { sanitizeEmailHtml, EMAIL_IFRAME_SANDBOX } from '../../../../../../lib/email/sanitizeHtml.ts';
import { parseHeaders } from '../../../../../../lib/email/headers.ts';
import { decryptToken, buildPickupUrl } from '../../../../../../lib/tokens/token.ts';
import { AddressSpecimen } from '../../../../../../components/AddressSpecimen.tsx';
import { CopyButton } from '../../../../../../components/CopyButton.tsx';
import * as aliasesRepo from '../../../../../../lib/repositories/aliases.repo.ts';
import * as messagesRepo from '../../../../../../lib/repositories/messages.repo.ts';
import * as attachmentsRepo from '../../../../../../lib/repositories/attachments.repo.ts';

export const dynamic = 'force-dynamic';

const SHOWN_HEADERS = ['from', 'to', 'cc', 'subject', 'date', 'message-id', 'x-icloud-hme'];

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

export default async function MessagePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; messageId: string }>;
  searchParams: Promise<{ images?: string }>;
}) {
  await requireAdminPage();
  const { id, messageId } = await params;
  const query = await searchParams;
  const aliasId = Number(id);
  const msgId = Number(messageId);
  if (!Number.isInteger(aliasId) || !Number.isInteger(msgId)) notFound();

  const db = getDb();
  const env = webEnv();
  const alias = aliasesRepo.findById(db, aliasId);
  if (!alias) notFound();

  // 带别名归属校验：即使在后台，也不该靠改 URL 里的数字读到别的地址的信
  const message = messagesRepo.getForAlias(db, aliasId, msgId);
  if (!message) notFound();

  if (message.readAt === null) {
    withWriteTx(db, (tx) => messagesRepo.markRead(tx, [msgId]));
  }

  const attachments = attachmentsRepo.listByMessage(db, msgId);
  const allowImages = query.images === '1';
  const html = sanitizeEmailHtml(message.htmlBody, { allowRemoteImages: allowImages });

  const headers = parseHeaders(message.rawHeaders).filter((h) => SHOWN_HEADERS.includes(h.lower));
  const token = decryptToken(alias.tokenCiphertext, env.TOKEN_ENC_KEY);
  const detailUrl = `${buildPickupUrl(env.PUBLIC_BASE_URL, token, alias.email)}/${msgId}`;

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/admin/aliases/${aliasId}`}
          className="text-xs text-muted transition-colors hover:text-transit"
        >
          ← <AddressSpecimen email={alias.email} size="sm" showDomain={false} />
        </Link>
        <h1 className="mt-3 text-xl font-semibold tracking-tight">
          {message.subject || '（无主题）'}
        </h1>
        <p className="mt-1.5 text-sm text-muted">
          {message.fromName ? `${message.fromName} <${message.fromAddress}>` : message.fromAddress}
          {' · '}
          {formatTime(message.dateReceived)}
          {' · '}
          <span className="font-mono">{message.mailbox}</span>
        </p>
      </div>

      {message.verificationCode && (
        <div className="rounded border border-transit/30 bg-transit-soft px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs tracking-wide text-transit uppercase">验证码</p>
              <p className="mt-0.5 font-mono text-2xl font-semibold tracking-wider text-transit">
                {message.verificationCode}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted">
                置信度 {((message.codeConfidence ?? 0) * 100).toFixed(0)}%
              </span>
              <CopyButton value={message.verificationCode} />
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded border border-rule px-2 py-1 font-mono text-muted">
          归属 {message.matchLayer} @ {message.matchConfidence}
        </span>
        {message.truncated && (
          <span className="rounded border border-live/40 bg-live-soft px-2 py-1 text-live">
            体积超限，只保存了头部
          </span>
        )}
        <CopyButton value={detailUrl} label="复制 API 地址" />
      </div>

      {html ? (
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold tracking-wide text-ink-soft uppercase">正文</h2>
            {!allowImages && (
              <Link
                href={`?images=1`}
                className="text-xs text-transit underline"
                title="远程图片会把你的 IP 和查看时刻回传给发件人"
              >
                载入远程图片
              </Link>
            )}
          </div>
          {/*
            必须放进 sandbox iframe，且 sandbox 属性里绝不能有 allow-same-origin ——
            邮件 HTML 是攻击者完全可控的输入，一旦同源，后台会话 cookie 立刻暴露。
            sanitizeEmailHtml 是第一层，这个 iframe 是第二层，两层缺一不可。
          */}
          <iframe
            title="邮件正文"
            sandbox={EMAIL_IFRAME_SANDBOX}
            srcDoc={`<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:16px;font:14px/1.6 -apple-system,system-ui,sans-serif;color:#17212b}img{max-width:100%;height:auto}a{color:#1f4fd8}</style>${html}`}
            className="h-[60vh] w-full rounded border border-rule bg-white"
          />
        </section>
      ) : message.textBody ? (
        <section>
          <h2 className="mb-2 text-sm font-semibold tracking-wide text-ink-soft uppercase">正文</h2>
          <pre className="overflow-x-auto rounded border border-rule bg-floor-raised p-4 text-sm whitespace-pre-wrap">
            {message.textBody}
          </pre>
        </section>
      ) : (
        <p className="rounded border border-dashed border-rule px-4 py-6 text-center text-sm text-muted">
          这封邮件没有可显示的正文。
        </p>
      )}

      {attachments.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold tracking-wide text-ink-soft uppercase">附件</h2>
          <ul className="divide-y divide-rule-soft overflow-hidden rounded border border-rule bg-floor-raised text-sm">
            {attachments.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <span className="truncate">{a.filename || '（无文件名）'}</span>
                <span className="shrink-0 text-xs text-muted">
                  {(a.sizeBytes / 1024).toFixed(1)} KB
                  {a.storage === 'dropped' && ' · 体积超限未保存'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold tracking-wide text-ink-soft uppercase">邮件头</h2>
        <dl className="overflow-hidden rounded border border-rule bg-floor-raised text-xs">
          {headers.map((h, i) => (
            <div key={i} className="flex gap-3 border-b border-rule-soft px-4 py-2 last:border-0">
              <dt className="w-28 shrink-0 font-mono text-muted">{h.name}</dt>
              <dd className="min-w-0 break-all">{h.value}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
