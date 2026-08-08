import Link from 'next/link';
import { requireAdminPage } from '../../lib/auth/adminPage.ts';
import { getDb } from '../../lib/db/connection.ts';
import { AddressSpecimen } from '../../components/AddressSpecimen.tsx';
import { requestReconnectAction } from './actions.ts';
import * as aliasesRepo from '../../lib/repositories/aliases.repo.ts';
import * as messagesRepo from '../../lib/repositories/messages.repo.ts';
import * as unmatchedRepo from '../../lib/repositories/unmatched.repo.ts';
import * as syncRepo from '../../lib/repositories/sync.repo.ts';

export const dynamic = 'force-dynamic';

const STATE_LABEL: Record<string, string> = {
  idling: '监听中',
  syncing: '收取中',
  authenticated: '已登录',
  connecting: '连接中',
  disconnected: '未连接',
  error: '出错',
};

function relative(iso: string | null): string {
  if (!iso) return '从未';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

export default async function DashboardPage() {
  await requireAdminPage();
  const db = getDb();

  const totalAliases = aliasesRepo.countAliases(db);
  const activeAliases = aliasesRepo.countAliases(db, 'active');
  const pendingUnmatched = unmatchedRepo.countPending(db);
  const mailboxes = syncRepo.listMailboxes(db);
  const worker = syncRepo.workerStatus(db);
  const workerAlive = syncRepo.isWorkerAlive(db);
  const layers = messagesRepo.matchLayerDistribution(db);

  const totalMessages = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages')?.n ?? 0;
  const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const ratio = unmatchedRepo.recentUnmatchedRatio(db, oneHourAgo);
  const recentTotal = ratio.matched + ratio.unmatched;
  const unmatchedPct = recentTotal > 0 ? (ratio.unmatched / recentTotal) * 100 : 0;

  // 归属规则失效的最早信号：专用头占比骤降，或未匹配率飙高
  const primaryLayer = layers.find((l) => l.layer === 'header:icloud-hme');
  const layerTotal = layers.reduce((sum, l) => sum + l.count, 0);
  const primaryPct = layerTotal > 0 ? ((primaryLayer?.count ?? 0) / layerTotal) * 100 : 100;
  const ruleDegraded = layerTotal >= 10 && primaryPct < 50;
  const unmatchedSpike = recentTotal >= 5 && unmatchedPct > 20;

  const recent = db.all<{ alias_id: number; email: string; date_received: string }>(
    `SELECT r.alias_id, a.email, r.date_received
       FROM message_recipients r JOIN aliases a ON a.id = r.alias_id
      ORDER BY r.date_received DESC LIMIT 8`,
  );

  return (
    <div className="space-y-8">
      {(ruleDegraded || unmatchedSpike) && (
        <div className="rounded border border-alert/30 bg-alert-soft px-4 py-3">
          <p className="text-sm font-medium text-alert">归属规则可能已失效</p>
          <p className="mt-1 text-sm text-ink-soft">
            {ruleDegraded &&
              `最近 ${layerTotal} 封里只有 ${primaryPct.toFixed(0)}% 走 X-ICLOUD-HME 专用头。`}
            {unmatchedSpike && ` 近一小时有 ${unmatchedPct.toFixed(0)}% 的邮件无法归属。`}{' '}
            到<Link href="/admin/unmatched" className="text-transit underline">未归属</Link>
            页看看是不是苹果换了邮件头 —— 那里会列出高频出现的头名。
          </p>
        </div>
      )}

      <section>
        <h1 className="mb-1 text-2xl font-semibold tracking-tight">概览</h1>
        <p className="text-sm text-muted">
          {activeAliases} 个地址在收信，共归档 {totalMessages} 封。
        </p>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="收件地址" value={String(totalAliases)} note={`${activeAliases} 个启用中`} />
        <Stat label="已归档邮件" value={String(totalMessages)} />
        <Stat
          label="未归属"
          value={String(pendingUnmatched)}
          note={pendingUnmatched > 0 ? '需要查看' : '全部已归属'}
          tone={pendingUnmatched > 0 ? 'warn' : 'normal'}
        />
        <Stat
          label="收信进程"
          value={workerAlive ? '运行中' : '未运行'}
          note={`心跳 ${relative(worker.heartbeatAt)}`}
          tone={workerAlive ? 'normal' : 'alert'}
        />
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold tracking-wide text-ink-soft uppercase">邮箱连接</h2>
          <form action={requestReconnectAction}>
            <button
              type="submit"
              className="rounded border border-rule px-2.5 py-1 text-xs text-ink-soft transition-colors hover:border-transit hover:text-transit"
            >
              立即检查
            </button>
          </form>
        </div>
        <div className="overflow-hidden rounded border border-rule bg-floor-raised">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-rule-soft text-left text-xs text-muted">
                <th className="px-4 py-2 font-medium">邮箱</th>
                <th className="px-4 py-2 font-medium">状态</th>
                <th className="px-4 py-2 font-medium">已收</th>
                <th className="px-4 py-2 font-medium">最近一次</th>
              </tr>
            </thead>
            <tbody>
              {mailboxes.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-muted">
                    收信进程还没启动过。运行 <code className="font-mono">npm run worker</code> 后这里会出现邮箱。
                  </td>
                </tr>
              )}
              {mailboxes.map((mb) => {
                const healthy = mb.connectionState === 'idling' || mb.connectionState === 'syncing';
                return (
                  <tr key={mb.mailbox} className="border-b border-rule-soft last:border-0">
                    <td className="px-4 py-2.5 font-mono text-[13px]">{mb.mailbox}</td>
                    <td className="px-4 py-2.5">
                      <span
                        className={`inline-flex items-center gap-1.5 ${healthy ? 'text-ink' : 'text-alert'}`}
                      >
                        <span
                          className={`size-1.5 rounded-full ${healthy ? 'bg-transit' : 'bg-alert'}`}
                          aria-hidden
                        />
                        {STATE_LABEL[mb.connectionState] ?? mb.connectionState}
                      </span>
                      {mb.lastError && !healthy && (
                        <span className="ml-2 text-xs text-muted">{mb.lastError}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums">{mb.messagesIngested}</td>
                    <td className="px-4 py-2.5 text-muted">{relative(mb.lastSuccessAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {layers.length > 0 && (
        <section>
          <h2 className="mb-1 text-sm font-semibold tracking-wide text-ink-soft uppercase">
            归属方式
          </h2>
          <p className="mb-3 text-xs text-muted">
            正常情况下几乎全部走 X-ICLOUD-HME —— 这是苹果转发时带的专用头。
            占比明显下滑说明苹果改了实现，需要调整归属规则。
          </p>
          <div className="flex flex-wrap gap-2">
            {layers.map((l) => (
              <span
                key={l.layer}
                className={`rounded border px-2.5 py-1 font-mono text-xs ${
                  l.layer === 'header:icloud-hme'
                    ? 'border-transit/30 bg-transit-soft text-transit'
                    : 'border-rule bg-floor-raised text-ink-soft'
                }`}
              >
                {l.layer} · {l.count}
              </span>
            ))}
          </div>
        </section>
      )}

      {recent.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold tracking-wide text-ink-soft uppercase">
            最近到达
          </h2>
          <ul className="divide-y divide-rule-soft overflow-hidden rounded border border-rule bg-floor-raised">
            {recent.map((r, i) => (
              <li key={i}>
                <Link
                  href={`/admin/aliases/${r.alias_id}`}
                  className="flex items-center justify-between gap-4 px-4 py-2.5 transition-colors hover:bg-transit-soft"
                >
                  <AddressSpecimen email={r.email} size="sm" />
                  <span className="shrink-0 text-xs text-muted">{relative(r.date_received)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {totalAliases === 0 && (
        <section className="rounded border border-dashed border-rule px-6 py-10 text-center">
          <p className="mb-1 font-medium">还没有收件地址</p>
          <p className="mb-4 text-sm text-muted">
            导入 icloud-hme-cli 生成的 jsonl，每个地址会拿到一条随机取件 URL。
          </p>
          <Link
            href="/admin/import"
            className="inline-block rounded bg-transit px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
          >
            导入 jsonl
          </Link>
        </section>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  note,
  tone = 'normal',
}: {
  label: string;
  value: string;
  note?: string;
  tone?: 'normal' | 'warn' | 'alert';
}) {
  const toneClass =
    tone === 'alert' ? 'text-alert' : tone === 'warn' ? 'text-live' : 'text-ink';
  return (
    <div className="rounded border border-rule bg-floor-raised px-4 py-3.5">
      <p className="text-xs tracking-wide text-muted uppercase">{label}</p>
      <p className={`mt-1 font-display text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</p>
      {note && <p className="mt-0.5 text-xs text-muted">{note}</p>}
    </div>
  );
}
