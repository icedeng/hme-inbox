/**
 * 保留期清理。
 *
 * 两条纪律：
 *
 * 1. **分批**。web 与 worker 共享同一个 SQLite 文件，一个长事务会把
 *    另一个容器整个卡住。每批 500 行、批间让出 50ms。
 * 2. **绝不 VACUUM**。它会独占整个数据库。用 incremental_vacuum 代替。
 *
 * 删除顺序也是刻意的：先查出待删的附件路径 → 删数据库行 → 最后删文件。
 * 反过来的话，删文件成功但删行失败会留下指向不存在文件的记录（下载报 500）；
 * 按这个顺序最差只会留下孤儿文件，再由孤儿扫描兜底。
 */
import { type Db, withWriteTx, isoNow } from '../db/driver.ts';
import * as attachmentsRepo from '../repositories/attachments.repo.ts';
import * as miscRepo from '../repositories/misc.repo.ts';
import type { AttachmentStore } from '../ingest/attachmentStore.ts';
import { sleep } from '../util/async.ts';
import type { Logger } from '../logger.ts';

const BATCH_SIZE = 500;
const BATCH_PAUSE_MS = 50;

export interface CleanupOptions {
  attachmentStore: AttachmentStore;
  accessLogRetentionDays: number;
  clock?: () => Date;
  logger?: Logger;
}

export interface CleanupResult {
  messagesDeleted: number;
  unmatchedDeleted: number;
  attachmentFilesDeleted: number;
  orphanFilesDeleted: number;
  accessLogDeleted: number;
  sessionsDeleted: number;
  durationMs: number;
}

export async function runCleanup(db: Db, options: CleanupOptions): Promise<CleanupResult> {
  const clock = options.clock ?? (() => new Date());
  const startedAt = Date.now();
  const now = clock().toISOString();

  const result: CleanupResult = {
    messagesDeleted: 0,
    unmatchedDeleted: 0,
    attachmentFilesDeleted: 0,
    orphanFilesDeleted: 0,
    accessLogDeleted: 0,
    sessionsDeleted: 0,
    durationMs: 0,
  };

  // ── 过期邮件 ────────────────────────────────────────────────
  for (;;) {
    // 先取路径（此时行还在），删行时 CASCADE 会带走 attachments 记录
    const paths = withWriteTx(db, (tx) => {
      const filePaths = attachmentsRepo.filePathsForExpiredMessages(tx, now, BATCH_SIZE);
      // SQLite 的 DELETE ... LIMIT 需要编译选项支持，内置版通常没开，用子查询
      const deleted = tx.run(
        `DELETE FROM messages WHERE id IN (
           SELECT id FROM messages WHERE expires_at < ? LIMIT ?
         )`,
        now,
        BATCH_SIZE,
      ).changes;
      result.messagesDeleted += deleted;
      return deleted > 0 ? filePaths : [];
    });

    for (const path of paths) {
      if (options.attachmentStore.remove(path)) result.attachmentFilesDeleted++;
    }
    if (paths.length === 0 && result.messagesDeleted % BATCH_SIZE !== 0) break;

    const more = db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM (SELECT 1 FROM messages WHERE expires_at < ? LIMIT 1)',
      now,
    );
    if ((more?.n ?? 0) === 0) break;
    await sleep(BATCH_PAUSE_MS);
  }

  // ── 过期的未匹配留档 ────────────────────────────────────────
  for (;;) {
    const deleted = withWriteTx(
      db,
      (tx) =>
        tx.run(
          `DELETE FROM unmatched_messages WHERE id IN (
             SELECT id FROM unmatched_messages WHERE expires_at < ? LIMIT ?
           )`,
          now,
          BATCH_SIZE,
        ).changes,
    );
    result.unmatchedDeleted += deleted;
    if (deleted < BATCH_SIZE) break;
    await sleep(BATCH_PAUSE_MS);
  }

  // ── 访问日志与会话 ──────────────────────────────────────────
  const logCutoff = new Date(
    clock().getTime() - options.accessLogRetentionDays * 86_400_000,
  ).toISOString();
  result.accessLogDeleted = withWriteTx(
    db,
    (tx) => tx.run('DELETE FROM access_log WHERE created_at < ?', logCutoff).changes,
  );
  result.sessionsDeleted = withWriteTx(db, (tx) => miscRepo.deleteExpiredSessions(tx));

  // ── 孤儿附件文件 ────────────────────────────────────────────
  // 上面的删除顺序保证孤儿只可能多不可能少，所以这一步是安全的兜底。
  const referenced = attachmentsRepo.allReferencedFilePaths(db);
  for (const orphan of options.attachmentStore.findOrphans(referenced)) {
    if (options.attachmentStore.remove(orphan)) result.orphanFilesDeleted++;
  }

  // 增量回收页面。VACUUM 会独占整库，绝对不能用。
  try {
    db.exec('PRAGMA incremental_vacuum(1000)');
  } catch {
    // 没开 auto_vacuum 时会报错，无所谓
  }

  result.durationMs = Date.now() - startedAt;
  options.logger?.info('清理完成', { ...result });
  return result;
}

/**
 * 磁盘吃紧时的应急收缩：把保留期临时压到 7 天。
 * 由调用方在检测到磁盘使用率过高时触发。
 */
export function emergencyExpire(db: Db, days = 7, clock: () => Date = () => new Date()): number {
  const cutoff = new Date(clock().getTime() + days * 86_400_000).toISOString();
  return withWriteTx(
    db,
    (tx) => tx.run('UPDATE messages SET expires_at = ? WHERE expires_at > ?', cutoff, cutoff).changes,
  );
}

export { isoNow };
