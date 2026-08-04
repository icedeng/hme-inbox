import { getDb } from '../../../lib/db/connection.ts';
import * as unmatchedRepo from '../../../lib/repositories/unmatched.repo.ts';
import * as messagesRepo from '../../../lib/repositories/messages.repo.ts';

export const dynamic = 'force-dynamic';

const REASON_LABEL: Record<string, string> = {
  no_icloud_address: '头里没有任何 icloud 地址',
  address_not_in_alias_table: '地址不在已导入的别名里',
  alias_disabled: '别名已停用',
  parse_error: '解析失败',
};

/** 归属层里我们认识并信任的头名。不在这里面的都是新面孔。 */
const KNOWN_HEADERS = new Set([
  'X-ICLOUD-HME', 'To', 'Cc', 'Bcc', 'From', 'Subject', 'Date', 'Message-ID',
  'Received', 'Return-path', 'Original-recipient', 'Reply-To', 'Sender',
  'Content-Type', 'Mime-Version', 'DKIM-Signature', 'Authentication-Results',
  'Content-Transfer-Encoding', 'References', 'In-Reply-To',
]);

function formatTime(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

export default async function UnmatchedPage() {
  const db = getDb();
  const pending = unmatchedRepo.listPending(db, 100);
  const topHeaders = unmatchedRepo.topHeaderNames(db, 25);
  const topCandidates = unmatchedRepo.topCandidateAddresses(db, 15);
  const layers = messagesRepo.matchLayerDistribution(db);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">未归属邮件</h1>
        <p className="mt-1 text-sm leading-relaxed text-muted">
          收到了但没能对应到任何收件地址的信。原文会保留 60 天 ——
          比正常邮件长，这样「先收到信、后导入地址」时还能回填回来。
        </p>
      </div>

      {pending.length === 0 ? (
        <div className="rounded border border-dashed border-rule px-6 py-12 text-center">
          <p className="mb-1 font-medium">全部邮件都已归属</p>
          <p className="text-sm text-muted">
            归属方式：
            {layers.map((l) => `${l.layer} ${l.count} 封`).join('，') || '暂无数据'}。
          </p>
        </div>
      ) : (
        <>
          <section className="grid gap-4 lg:grid-cols-2">
            <div className="rounded border border-rule bg-floor-raised p-4">
              <h2 className="text-sm font-semibold tracking-wide text-ink-soft uppercase">
                出现最多的邮件头
              </h2>
              <p className="mt-1 mb-3 text-xs leading-relaxed text-muted">
                带记号的是归属规则不认识的头。如果某个陌生头名频繁出现，
                很可能就是苹果换用的新头 —— 把它加进{' '}
                <code className="font-mono">HME_MATCH_EXTRA_HEADERS</code> 即可恢复归属，不必改代码。
              </p>
              <ul className="space-y-1 text-xs">
                {topHeaders.map((h) => {
                  const unknown = !KNOWN_HEADERS.has(h.name);
                  return (
                    <li key={h.name} className="flex items-center justify-between gap-3">
                      <span className={`font-mono ${unknown ? 'text-live' : 'text-ink-soft'}`}>
                        {unknown && '◆ '}
                        {h.name}
                      </span>
                      <span className="tabular-nums text-muted">{h.count}</span>
                    </li>
                  );
                })}
              </ul>
            </div>

            <div className="rounded border border-rule bg-floor-raised p-4">
              <h2 className="text-sm font-semibold tracking-wide text-ink-soft uppercase">
                出现最多的 icloud 地址
              </h2>
              <p className="mt-1 mb-3 text-xs leading-relaxed text-muted">
                这些地址出现在邮件头里但不在已导入的别名中。
                高频出现的多半是漏导入的地址 —— 补一次导入就会自动回填。
              </p>
              {topCandidates.length === 0 ? (
                <p className="text-xs text-muted">没有候选地址，说明这些信压根不是发给 HME 别名的。</p>
              ) : (
                <ul className="space-y-1 text-xs">
                  {topCandidates.map((c) => (
                    <li key={c.address} className="flex items-center justify-between gap-3">
                      <span className="truncate font-mono text-ink-soft">{c.address}</span>
                      <span className="shrink-0 tabular-nums text-muted">{c.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold tracking-wide text-ink-soft uppercase">
              待处理（{pending.length}）
            </h2>
            <ul className="divide-y divide-rule-soft overflow-hidden rounded border border-rule bg-floor-raised">
              {pending.map((u) => (
                <li key={u.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <span className="font-medium">{u.subject || '（无主题）'}</span>
                    <span className="shrink-0 font-mono text-xs text-muted">
                      {formatTime(u.dateReceived)}
                    </span>
                  </div>
                  <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                    <span>{u.fromAddress ?? '（无发件人）'}</span>
                    <span className="font-mono">{u.mailbox}</span>
                    <span className="rounded bg-live-soft px-1.5 py-0.5 text-live">
                      {REASON_LABEL[u.reason] ?? u.reason}
                    </span>
                    {u.rematchAttempts > 0 && <span>已重试 {u.rematchAttempts} 次</span>}
                  </p>
                  {u.candidates.length > 0 && (
                    <p className="mt-1 font-mono text-xs text-ink-soft">
                      候选地址：{u.candidates.slice(0, 3).join('、')}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
