/**
 * worker 主进程：IMAP IDLE 收信 + 入库 + 定期清理。
 *
 * 独立于 Next.js 运行。理由（都吃过亏或可预见）：
 *  - Next 进程重启（部署、OOM、渲染崩溃）会带走 IMAP 长连接
 *  - dev 模式 HMR 会反复执行 instrumentation，堆积 IMAP 连接
 *  - 多副本时会开出多份 IDLE，触发 iCloud 的并发连接限制
 *  - worker 挂了而 web 还活着时，web 的 healthcheck 完全看不出来
 */
import { hostname } from 'node:os';
import { loadWorkerEnv } from '../lib/config/env.ts';
import { openDb, withWriteTx } from '../lib/db/driver.ts';
import { assertSchemaCurrent } from '../lib/db/migrate.ts';
import { createLogger } from '../lib/logger.ts';
import { buildAliasIndex, type AliasIndex } from '../lib/matching/aliasIndex.ts';
import { rulesFromEnv } from '../lib/matching/rules.ts';
import { createAttachmentStore } from '../lib/ingest/attachmentStore.ts';
import { ingestMessage, rematchUnmatched, type IngestDeps } from '../lib/ingest/ingestMessage.ts';
import { createMailboxWatcher, type MailboxWatcher } from '../lib/imap/mailboxWatcher.ts';
import { runCleanup } from '../lib/retention/cleanup.ts';
import * as aliasesRepo from '../lib/repositories/aliases.repo.ts';
import * as syncRepo from '../lib/repositories/sync.repo.ts';

const HEARTBEAT_MS = 15_000;
const INDEX_REFRESH_MS = 30_000;
const CLEANUP_MS = 6 * 60 * 60 * 1000;

const log = createLogger({ component: 'worker' });

async function main(): Promise<void> {
  // 1. 配置校验。错配置绝不带着跑 —— 一个拼错的主机名拖到运行时
  //    才暴露，表现出来就是「莫名其妙收不到信」。
  const env = loadWorkerEnv();
  log.info('worker 启动', {
    host: env.HME_IMAP_HOST,
    user: env.HME_IMAP_USER,
    mailboxes: env.HME_IMAP_MAILBOXES,
    retentionDays: env.RETENTION_DAYS,
  });

  const db = openDb(env.DATABASE_PATH);

  // 2. schema 版本校验。worker 不自己迁移 —— 那是 migrate 容器的职责，
  //    两个容器同时建表是共享 SQLite 时最常见的启动故障。
  assertSchemaCurrent(db);

  // 3. 单实例互斥。防 `docker compose up --scale worker=2`：
  //    两份 IDLE 会触发 iCloud 连接限制，严重时锁账号。
  const pid = process.pid;
  if (!syncRepo.acquireWorkerLock(db, pid, hostname())) {
    const status = syncRepo.workerStatus(db);
    log.error('另一个 worker 仍在运行，本进程退出', {
      existingPid: status.workerPid,
      existingHost: status.hostname,
      heartbeatAt: status.heartbeatAt,
    });
    db.close();
    process.exitCode = 1;
    return;
  }

  const account = withWriteTx(db, (tx) =>
    syncRepo.ensureAccount(
      tx,
      env.HME_IMAP_HOST,
      env.HME_IMAP_PORT,
      env.HME_IMAP_USER,
      env.HME_SYNC_SINCE ?? new Date().toISOString(),
    ),
  );
  log.info('IMAP 账号就绪', { accountId: account.id, syncSince: account.syncSince });

  const attachmentStore = createAttachmentStore({
    baseDir: env.ATTACHMENT_DIR,
    maxInlineBytes: env.MAX_INLINE_ATTACHMENT_BYTES,
    maxFileBytes: env.MAX_FILE_ATTACHMENT_BYTES,
  });

  // 4. 别名索引。用 DB 轮询检测变化而不是跨容器 IPC ——
  //    成本可忽略，省掉一整套消息通道。
  let aliasIndex: AliasIndex = buildAliasIndex(aliasesRepo.listForIndex(db));
  let indexFingerprint = aliasesRepo.indexFingerprint(db);
  log.info('别名索引已建立', { size: aliasIndex.size });

  const deps = (): IngestDeps => ({
    db,
    aliasIndex,
    rules: rulesFromEnv(),
    attachmentStore,
    clock: () => new Date(),
    maxMessageBytes: env.MAX_MESSAGE_BYTES,
    retentionDays: env.RETENTION_DAYS,
    unmatchedRetentionDays: env.UNMATCHED_RETENTION_DAYS,
  });

  const watchers: MailboxWatcher[] = [];
  /** 每个邮箱最近一次落库的连接状态，用于跳过重复写入。 */
  const lastState = new Map<string, string>();
  let shuttingDown = false;

  for (const mailbox of env.HME_IMAP_MAILBOXES) {
    withWriteTx(db, (tx) => syncRepo.ensureMailbox(tx, account.id, mailbox));

    const watcher = createMailboxWatcher(
      {
        host: env.HME_IMAP_HOST,
        port: env.HME_IMAP_PORT,
        user: env.HME_IMAP_USER,
        pass: env.HME_IMAP_PASS,
        mailbox,
        syncSince: new Date(account.syncSince),
        pollIntervalMs: env.POLL_INTERVAL_MS,
        idleRefreshMs: env.IDLE_REFRESH_MS,
        fetchBatchSize: env.FETCH_BATCH_SIZE,
      },
      {
        async onMessages(messages) {
          let ingested = 0;
          for (const msg of messages) {
            const outcome = await ingestMessage(deps(), {
              accountId: account.id,
              mailbox,
              uidvalidity: msg.uidvalidity,
              uid: msg.uid,
              raw: msg.raw,
              internalDate: msg.internalDate,
            });
            switch (outcome.kind) {
              case 'inserted':
                ingested++;
                log.info('已入库', {
                  mailbox,
                  uid: msg.uid,
                  messageId: outcome.messageId,
                  aliasIds: outcome.aliasIds,
                  layer: outcome.layer,
                });
                break;
              case 'unmatched':
                log.warn('未能归属到别名', { mailbox, uid: msg.uid, reason: outcome.reason });
                break;
              case 'duplicate':
                log.debug('重复邮件已跳过', { mailbox, uid: msg.uid, reason: outcome.reason });
                break;
              case 'error':
                log.error('入库失败', { mailbox, uid: msg.uid, error: outcome.error.message });
                break;
            }
          }
          if (ingested > 0) {
            withWriteTx(db, (tx) => syncRepo.recordSuccess(tx, account.id, mailbox, ingested));
          }
          return ingested;
        },

        onStateChange(state, detail) {
          // 只在状态真的变了才落库。
          // 轮询每 3 秒会走一遍 syncing→idling，无脑写的话两个邮箱
          // 每天要产生 5 万多次无意义的 UPDATE，把 WAL 撑大、也让
          // web 容器的读被反复打断。出错状态例外：detail 每次都可能不同。
          if (state === lastState.get(mailbox) && state !== 'error') return;
          lastState.set(mailbox, state);
          withWriteTx(db, (tx) => syncRepo.setState(tx, account.id, mailbox, state, detail));
        },

        onUidValidityChange(_previous, current) {
          const r = withWriteTx(db, (tx) =>
            syncRepo.recordUidValidity(tx, account.id, mailbox, current),
          );
          if (r.changed) {
            log.warn('UIDVALIDITY 变化，游标已重置', {
              mailbox,
              previous: r.previous,
              current,
            });
          }
        },

        getLastSeenUid() {
          const row = db.get<{ last_seen_uid: number }>(
            'SELECT last_seen_uid FROM mailbox_sync WHERE account_id = ? AND mailbox = ?',
            account.id,
            mailbox,
          );
          return row?.last_seen_uid ?? 0;
        },

        advanceUid(uid) {
          withWriteTx(db, (tx) => syncRepo.advanceUid(tx, account.id, mailbox, uid));
        },

        onFatalAuthFailure(error) {
          // 认证失败不重试。反复用错凭证登录会触发苹果的账号保护，
          // 锁掉整个 Apple ID —— 那比暂时收不到信严重得多。
          log.error('IMAP 认证失败，该邮箱停止收信，请更新 App 专用密码', {
            mailbox,
            error: error.message,
          });
        },

        onReconnect() {
          withWriteTx(db, (tx) => syncRepo.recordReconnect(tx, account.id, mailbox));
        },
      },
      log,
    );

    watchers.push(watcher);
    await watcher.start();
  }

  // 5. 定时任务
  const heartbeatTimer = setInterval(() => {
    syncRepo.heartbeat(db, pid);
    // 顺带读后台下发的命令
    const command = withWriteTx(db, (tx) => syncRepo.takeCommand(tx));
    if (command === 'reconnect') {
      log.info('收到后台的重连指令');
      for (const w of watchers) {
        void w.syncNow().catch(() => undefined);
      }
    }
  }, HEARTBEAT_MS);

  const indexTimer = setInterval(() => {
    const fingerprint = aliasesRepo.indexFingerprint(db);
    if (fingerprint === indexFingerprint) return;
    indexFingerprint = fingerprint;
    aliasIndex = buildAliasIndex(aliasesRepo.listForIndex(db));
    log.info('别名索引已重建', { size: aliasIndex.size });

    // 导入了新别名 → 立刻回填未匹配的信。
    // 没有这一步，「先收到信、后导入 jsonl」的时序竞争会永久丢信。
    void rematchUnmatched(deps(), account.id)
      .then((r) => {
        if (r.resolved > 0) log.info('未匹配邮件回填完成', r);
      })
      .catch((err: unknown) => {
        log.error('回填未匹配邮件失败', { error: err instanceof Error ? err.message : err });
      });
  }, INDEX_REFRESH_MS);

  const runCleanupNow = (): void => {
    void runCleanup(db, {
      attachmentStore,
      accessLogRetentionDays: env.ACCESS_LOG_RETENTION_DAYS,
      logger: log,
    }).catch((err: unknown) => {
      log.error('清理失败', { error: err instanceof Error ? err.message : err });
    });
  };
  const cleanupTimer = setInterval(runCleanupNow, CLEANUP_MS);
  runCleanupNow();

  // 6. 优雅退出
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('收到退出信号，正在关停', { signal });

    clearInterval(heartbeatTimer);
    clearInterval(indexTimer);
    clearInterval(cleanupTimer);

    const timeout = setTimeout(() => {
      log.warn('关停超时，强制退出');
      process.exit(1);
    }, 15_000);

    await Promise.all(watchers.map((w) => w.stop().catch(() => undefined)));
    syncRepo.releaseWorkerLock(db, pid);
    db.close();
    clearTimeout(timeout);
    log.info('已退出');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  log.info('worker 就绪', { mailboxes: watchers.map((w) => w.mailbox) });
}

main().catch((err: unknown) => {
  log.error('worker 启动失败', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
