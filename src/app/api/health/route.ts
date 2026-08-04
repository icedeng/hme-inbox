/**
 * 健康检查。供 Docker healthcheck 与反向代理使用。
 *
 * 刻意把 worker 心跳也纳入判断：worker 挂了但 web 还活着时，
 * 系统实际上已经收不到信了，这种「半死」状态必须能被外部看见。
 */
import { getDb } from '../../../lib/db/connection.ts';
import { checkLockingSupport } from '../../../lib/db/driver.ts';
import { webEnv } from '../../../lib/config/env.ts';
import * as syncRepo from '../../../lib/repositories/sync.repo.ts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<Response> {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};

  try {
    const db = getDb();
    db.get('SELECT 1');
    checks.database = { ok: true };

    const workerAlive = syncRepo.isWorkerAlive(db);
    const status = syncRepo.workerStatus(db);
    checks.worker = {
      ok: workerAlive,
      detail: workerAlive ? undefined : `心跳过期，最后一次：${status.heartbeatAt ?? '(从未)'}`,
    };

    const mailboxes = syncRepo.listMailboxes(db);
    for (const mb of mailboxes) {
      const healthy = mb.connectionState === 'idling' || mb.connectionState === 'syncing';
      checks[`mailbox:${mb.mailbox}`] = {
        ok: healthy,
        detail: healthy ? undefined : `状态 ${mb.connectionState}${mb.lastError ? `：${mb.lastError}` : ''}`,
      };
    }
  } catch (err) {
    checks.database = { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }

  // 文件锁自检：NFS / 某些 bind mount 上 fcntl 锁不可靠，会静默损坏数据
  try {
    const lock = checkLockingSupport(webEnv().DATABASE_PATH);
    checks.fileLocking = { ok: lock.ok, detail: lock.ok ? undefined : lock.detail };
  } catch {
    checks.fileLocking = { ok: false, detail: '无法自检' };
  }

  const ok = Object.values(checks).every((c) => c.ok);
  return Response.json(
    { ok, time: new Date().toISOString(), checks },
    { status: ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  );
}
