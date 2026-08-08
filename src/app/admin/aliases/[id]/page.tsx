import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAdminPage } from '../../../../lib/auth/adminPage.ts';
import { getDb } from '../../../../lib/db/connection.ts';
import { webEnv } from '../../../../lib/config/env.ts';
import { decryptToken, buildPickupUrl } from '../../../../lib/tokens/token.ts';
import { AddressSpecimen } from '../../../../components/AddressSpecimen.tsx';
import { CopyButton } from '../../../../components/CopyButton.tsx';
import { rotateTokenAction, setAliasStatusAction } from '../../actions.ts';
import * as aliasesRepo from '../../../../lib/repositories/aliases.repo.ts';
import * as messagesRepo from '../../../../lib/repositories/messages.repo.ts';
import * as miscRepo from '../../../../lib/repositories/misc.repo.ts';

export const dynamic = 'force-dynamic';

function formatTime(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

export default async function AliasDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdminPage();
  const { id } = await params;
  const aliasId = Number(id);
  if (!Number.isInteger(aliasId)) notFound();

  const db = getDb();
  const env = webEnv();
  const alias = aliasesRepo.findById(db, aliasId);
  if (!alias) notFound();

  const token = decryptToken(alias.tokenCiphertext, env.TOKEN_ENC_KEY);
  const url = buildPickupUrl(env.PUBLIC_BASE_URL, token, alias.email);
  const messages = messagesRepo.listByAlias(db, { aliasId, limit: 100 });
  const accessLog = miscRepo.listAccessLog(db, 5, aliasId);

  return (
    <div className="space-y-8">
      <div>
        <Link href="/admin/aliases" className="text-xs text-muted transition-colors hover:text-transit">
          ← 收件地址
        </Link>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <AddressSpecimen email={alias.email} size="lg" />
          <CopyButton value={alias.email} label="复制地址" />
        </div>
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
          <span className="font-mono">{alias.label || '（无标签）'}</span>
          <span>{messages.length} 封</span>
          <span>被取件 {alias.accessCount} 次</span>
          {alias.status === 'disabled' && (
            <span className="rounded bg-alert-soft px-1.5 py-0.5 text-xs text-alert">已停用</span>
          )}
        </p>
        {alias.note && <p className="mt-2 text-sm text-ink-soft">{alias.note}</p>}
      </div>

      <section className="rounded border border-rule bg-floor-raised p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold tracking-wide text-ink-soft uppercase">取件 URL</h2>
          <div className="flex items-center gap-2">
            <CopyButton value={url} label="复制 URL" />
            <CopyButton value={`${alias.email}----${url}`} label="复制 地址----URL" />
            <form action={rotateTokenAction}>
              <input type="hidden" name="aliasId" value={alias.id} />
              <button
                type="submit"
                className="rounded border border-rule px-2.5 py-1 text-xs text-ink-soft transition-colors hover:border-alert hover:text-alert"
                title="生成新 URL，旧 URL 立即失效"
              >
                轮换
              </button>
            </form>
            <form action={setAliasStatusAction}>
              <input type="hidden" name="aliasId" value={alias.id} />
              <input
                type="hidden"
                name="status"
                value={alias.status === 'active' ? 'disabled' : 'active'}
              />
              <button
                type="submit"
                className="rounded border border-rule px-2.5 py-1 text-xs text-ink-soft transition-colors hover:border-transit hover:text-transit"
              >
                {alias.status === 'active' ? '停用' : '启用'}
              </button>
            </form>
          </div>
        </div>
        <code className="block break-all font-mono text-xs text-ink-soft">{url}</code>
        <p className="mt-2 text-xs text-muted">
          GET 这个地址即可读到最新邮件。加 <code className="font-mono">?n=5</code> 取多封，
          <code className="font-mono">?wait=30</code> 等待新信最多 30 秒，
          <code className="font-mono">?format=code</code> 只返回验证码本身。
          {alias.tokenRotatedAt && ` 上次轮换于 ${formatTime(alias.tokenRotatedAt)}。`}
        </p>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold tracking-wide text-ink-soft uppercase">邮件</h2>
        {messages.length === 0 ? (
          <div className="rounded border border-dashed border-rule px-6 py-12 text-center">
            <p className="mb-1 font-medium">还没收到邮件</p>
            <p className="text-sm text-muted">
              发一封信到上面这个地址，收信进程会在几秒内把它归档到这里。
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-rule-soft overflow-hidden rounded border border-rule bg-floor-raised">
            {messages.map((m) => (
              <li key={m.id}>
                <Link
                  href={`/admin/aliases/${aliasId}/messages/${m.id}`}
                  className="block px-4 py-3 transition-colors hover:bg-transit-soft"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <span className="font-medium">
                      {m.readAt === null && (
                        <span className="mr-2 inline-block size-1.5 rounded-full bg-live align-middle" aria-label="未读" />
                      )}
                      {m.subject || '（无主题）'}
                    </span>
                    <span className="shrink-0 font-mono text-xs text-muted">
                      {formatTime(m.dateReceived)}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                    <span>{m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress}</span>
                    <span className="font-mono">{m.mailbox}</span>
                    {m.verificationCode && (
                      <span className="rounded bg-transit-soft px-1.5 py-0.5 font-mono text-transit">
                        {m.verificationCode}
                      </span>
                    )}
                    {m.hasAttachments && <span>有附件</span>}
                    {m.truncated && <span className="text-live">仅头部</span>}
                  </div>
                  {m.snippet && <p className="mt-1 truncate text-sm text-ink-soft">{m.snippet}</p>}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {accessLog.length > 0 && (
        <section>
          <h2 className="mb-1 text-sm font-semibold tracking-wide text-ink-soft uppercase">
            最近取件
          </h2>
          <p className="mb-3 text-xs text-muted">
            用来区分「对方根本没来取」和「来取了但当时库里没信」。
          </p>
          <ul className="divide-y divide-rule-soft overflow-hidden rounded border border-rule bg-floor-raised text-xs">
            {accessLog.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between gap-3 px-4 py-2">
                <span className="font-mono">
                  {entry.statusCode} · {entry.outcome} · 返回 {entry.returned} 封
                </span>
                <span className="text-muted">{formatTime(entry.createdAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
