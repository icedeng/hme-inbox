import { requireAdminPage } from '../../../lib/auth/adminPage.ts';
import { getDb } from '../../../lib/db/connection.ts';
import { ImportForm } from './ImportForm.tsx';
import * as miscRepo from '../../../lib/repositories/misc.repo.ts';

export const dynamic = 'force-dynamic';

function formatTime(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

export default async function ImportPage() {
  await requireAdminPage();
  const batches = miscRepo.listImportBatches(getDb(), 10);

  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">导入收件地址</h1>
        <p className="mt-1 text-sm text-muted">
          按邮箱地址匹配，重复导入同一份文件是安全的：已有地址只更新标签和备注，
          取件 URL 保持不变。
        </p>
      </div>

      <ImportForm />

      <section className="rounded border border-rule bg-floor-raised p-4">
        <h2 className="mb-2 text-sm font-semibold tracking-wide text-ink-soft uppercase">
          导入之后会发生什么
        </h2>
        <ul className="space-y-1.5 text-sm text-ink-soft">
          <li>· 每个新地址拿到一条随机取件 URL，可以单独复制、单独轮换、单独停用。</li>
          <li>· 已经存在的地址保留原有 URL —— 重复导入不会让已经发出去的链接失效。</li>
          <li>
            · 此前因为「地址还没导入」而无法归属的邮件会被自动回填，不需要手动处理。
          </li>
        </ul>
      </section>

      {batches.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold tracking-wide text-ink-soft uppercase">
            导入记录
          </h2>
          <ul className="divide-y divide-rule-soft overflow-hidden rounded border border-rule bg-floor-raised text-sm">
            {batches.map((b) => (
              <li key={b.id} className="px-4 py-2.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-mono text-[13px]">{b.filename}</span>
                  <span className="text-xs text-muted">{formatTime(b.createdAt)}</span>
                </div>
                <p className="mt-0.5 text-xs text-muted">
                  共 {b.totalLines} 行 · 新增 {b.inserted} · 更新 {b.updated}
                  {b.failed > 0 && <span className="text-alert"> · {b.failed} 行有问题</span>}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
