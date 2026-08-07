import Link from 'next/link';
import { getDb } from '../../../lib/db/connection.ts';
import { webEnv } from '../../../lib/config/env.ts';
import { decryptToken, buildPickupUrl } from '../../../lib/tokens/token.ts';
import { AddressSpecimen } from '../../../components/AddressSpecimen.tsx';
import { CopyButton } from '../../../components/CopyButton.tsx';
import { AliasPoolPushControls } from '../../../components/AliasPoolPushControls.tsx';
import { rotateAllTokensAction } from '../actions.ts';
import { pushAliasesToPoolAction } from './actions.ts';
import * as aliasesRepo from '../../../lib/repositories/aliases.repo.ts';
import * as messagesRepo from '../../../lib/repositories/messages.repo.ts';

export const dynamic = 'force-dynamic';

/** 60 秒内到达的信给一次琥珀色脉冲，这是全站唯一的动效。 */
const LIVE_WINDOW_MS = 60_000;
const POOL_PUSH_FORM_ID = 'alias-pool-push-form';

interface AliasSearchParams {
  q?: string;
  status?: string;
  poolPush?: string;
  inserted?: string;
  existing?: string;
  skippedInactive?: string;
  skippedMissing?: string;
  errorCode?: string;
}

function resultCount(value: string | undefined): number {
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : 0;
}

function poolPushError(code: string | undefined): string {
  if (code === 'unauthorized') return 'turb 邮箱池鉴权失败，请检查鉴权码。';
  if (code === 'network_error') return '无法连接 turb 邮箱池服务，请检查服务地址和网络。';
  if (code === 'invalid_response') return 'turb 邮箱池返回的数据格式不正确。';
  if (code === 'remote_error') return 'turb 邮箱池服务返回错误，请检查服务状态。';
  return '推送请求无效或执行失败，请重试。';
}

function relative(iso: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

export default async function AliasesPage({
  searchParams,
}: {
  searchParams: Promise<AliasSearchParams>;
}) {
  const params = await searchParams;
  const db = getDb();
  const env = webEnv();

  const aliases = aliasesRepo.listAliases(db, {
    ...(params.q ? { search: params.q } : {}),
    ...(params.status === 'active' || params.status === 'disabled'
      ? { status: params.status }
      : {}),
    limit: 500,
  });
  const stats = messagesRepo.statsByAlias(db);
  const activeCount = aliasesRepo.countAliases(db, 'active');
  const poolPushConfigured = Boolean(env.TURB_GPT_BASE_URL && env.TURB_GPT_AUTH_CODE);

  // token 解密一次就够，列表与批量复制共用
  const rows = aliases.map((alias) => ({
    alias,
    url: buildPickupUrl(
      env.PUBLIC_BASE_URL,
      decryptToken(alias.tokenCiphertext, env.TOKEN_ENC_KEY),
      alias.email,
    ),
    stat: stats.get(alias.id),
  }));

  // 导出与批量复制都跟随当前筛选，所见即所得
  const exportParams = new URLSearchParams();
  if (params.q) exportParams.set('q', params.q);
  if (params.status) exportParams.set('status', params.status);
  const exportQuery = exportParams.size > 0 ? `&${exportParams.toString()}` : '';
  const allPairs = rows.map((r) => `${r.alias.email}----${r.url}`).join('\n');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">收件地址</h1>
          <p className="mt-1 text-sm text-muted">
            每个地址一条独立的取件 URL，泄露一条不会波及其他地址。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* 导出的就是当前筛选出的这批，所以把筛选参数原样带上 */}
          <a
            href={`/api/admin/export?format=txt${exportQuery}`}
            className="rounded border border-rule bg-floor-raised px-3 py-1.5 text-xs text-ink-soft transition-colors hover:border-transit hover:text-transit"
            title="每行一条 email----url"
          >
            导出 txt
          </a>
          <a
            href={`/api/admin/export?format=csv${exportQuery}`}
            className="rounded border border-rule bg-floor-raised px-3 py-1.5 text-xs text-ink-soft transition-colors hover:border-transit hover:text-transit"
          >
            csv
          </a>
          <a
            href={`/api/admin/export?format=json${exportQuery}`}
            className="rounded border border-rule bg-floor-raised px-3 py-1.5 text-xs text-ink-soft transition-colors hover:border-transit hover:text-transit"
          >
            json
          </a>
          <CopyButton
            value={allPairs}
            label={`复制全部 ${aliases.length} 条`}
            className="!px-3 !py-1.5"
          />
          <AliasPoolPushControls
            formId={POOL_PUSH_FORM_ID}
            configured={poolPushConfigured}
            activeCount={activeCount}
          />
          <form action={rotateAllTokensAction}>
            <button
              type="submit"
              className="rounded border border-alert/40 px-3 py-1.5 text-xs text-alert transition-colors hover:bg-alert-soft"
              title="怀疑数据库泄露时使用。全部旧 URL 立即失效，需要重新分发。"
            >
              全部轮换
            </button>
          </form>
        </div>
      </div>

      <form className="flex flex-wrap gap-2">
        <input
          name="q"
          defaultValue={params.q ?? ''}
          placeholder="按地址、标签或备注搜索"
          className="min-w-56 flex-1 rounded border border-rule bg-floor-raised px-3 py-1.5 text-sm outline-none focus:border-transit"
        />
        <select
          name="status"
          defaultValue={params.status ?? ''}
          className="rounded border border-rule bg-floor-raised px-3 py-1.5 text-sm outline-none focus:border-transit"
        >
          <option value="">全部状态</option>
          <option value="active">启用中</option>
          <option value="disabled">已停用</option>
        </select>
        <button
          type="submit"
          className="rounded border border-rule px-3 py-1.5 text-sm text-ink-soft transition-colors hover:border-transit hover:text-transit"
        >
          筛选
        </button>
      </form>

      {params.poolPush === 'success' && (
        <div className="rounded border border-transit/30 bg-transit-soft px-4 py-3 text-sm text-transit">
          推送完成：新增 {resultCount(params.inserted)} 个，已存在 {resultCount(params.existing)} 个
          {resultCount(params.skippedInactive) > 0 &&
            `，跳过停用 ${resultCount(params.skippedInactive)} 个`}
          {resultCount(params.skippedMissing) > 0 &&
            `，跳过已删除或无效 ${resultCount(params.skippedMissing)} 个`}
          。
        </div>
      )}
      {params.poolPush === 'unconfigured' && (
        <div className="rounded border border-alert/30 bg-alert-soft px-4 py-3 text-sm text-alert">
          未配置 turb 邮箱池服务，请设置 TURB_GPT_BASE_URL 和 TURB_GPT_AUTH_CODE。
        </div>
      )}
      {params.poolPush === 'error' && (
        <div className="rounded border border-alert/30 bg-alert-soft px-4 py-3 text-sm text-alert">
          {poolPushError(params.errorCode)}
        </div>
      )}

      <form id={POOL_PUSH_FORM_ID} action={pushAliasesToPoolAction}>
        <input type="hidden" name="q" value={params.q ?? ''} />
        <input type="hidden" name="status" value={params.status ?? ''} />
        {aliases.length === 0 ? (
          <div className="rounded border border-dashed border-rule px-6 py-12 text-center">
            <p className="mb-1 font-medium">没有匹配的地址</p>
            <p className="text-sm text-muted">
              {params.q ? '换个关键词试试。' : '先到导入页上传 jsonl。'}
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {rows.map(({ alias, url, stat }) => {
              const isLive =
                stat?.lastReceivedAt != null &&
                Date.now() - new Date(stat.lastReceivedAt).getTime() < LIVE_WINDOW_MS;

              return (
                <li
                  key={alias.id}
                  className={`rounded border bg-floor-raised px-4 py-3.5 transition-colors ${
                    isLive ? 'live-pulse border-live/40' : 'border-rule'
                  } ${alias.status === 'disabled' ? 'opacity-55' : ''}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                      <input
                        type="checkbox"
                        name="aliasId"
                        value={alias.id}
                        disabled={alias.status !== 'active'}
                        aria-label={`选择 ${alias.email}`}
                        className="mt-1 size-4 shrink-0 accent-[var(--color-transit)] disabled:cursor-not-allowed"
                      />
                      <div className="min-w-0">
                        <Link href={`/admin/aliases/${alias.id}`} className="block">
                          <AddressSpecimen email={alias.email} size="md" />
                        </Link>
                        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                          <span className="font-mono">{alias.label || '（无标签）'}</span>
                          <span>
                            {stat?.total ?? 0} 封
                            {stat && stat.unread > 0 && (
                              <span className="text-live"> · {stat.unread} 未读</span>
                            )}
                          </span>
                          <span>最近 {relative(stat?.lastReceivedAt ?? null)}</span>
                          {alias.status === 'disabled' && (
                            <span className="rounded bg-alert-soft px-1.5 py-0.5 text-alert">
                              已停用
                            </span>
                          )}
                        </p>
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      <CopyButton value={alias.email} label="复制地址" />
                      <CopyButton value={url} label="复制 URL" />
                      <Link
                        href={`/admin/aliases/${alias.id}`}
                        className="rounded border border-rule px-2.5 py-1 text-xs text-ink-soft transition-colors hover:border-transit hover:text-transit"
                      >
                        查看邮件
                      </Link>
                    </div>
                  </div>

                  <p className="mt-2 truncate font-mono text-[11px] text-muted" title={url}>
                    {url}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </form>
    </div>
  );
}
