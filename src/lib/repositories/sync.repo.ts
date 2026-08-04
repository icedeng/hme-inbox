/**
 * IMAP 账号、每邮箱同步状态、worker 单实例互斥。
 */
import { type Db, isoNow } from '../db/driver.ts';

export interface ImapAccount {
  id: number;
  host: string;
  port: number;
  username: string;
  syncSince: string;
}

/**
 * 取得或创建账号行。
 *
 * `syncSince` 只在首次创建时写入 —— 它是「只收新信」的起点，
 * 后续重启绝不能把它推到当前时间，否则每次重启都会漏掉停机期间的信。
 */
export function ensureAccount(
  db: Db,
  host: string,
  port: number,
  username: string,
  syncSince: string,
): ImapAccount {
  const existing = db.get<{
    id: number;
    host: string;
    port: number;
    username: string;
    sync_since: string;
  }>('SELECT id, host, port, username, sync_since FROM imap_accounts WHERE username = ?', username);

  if (existing) {
    // 主机/端口可能改了，同步过来；sync_since 保持不动
    if (existing.host !== host || existing.port !== port) {
      db.run('UPDATE imap_accounts SET host = ?, port = ? WHERE id = ?', host, port, existing.id);
    }
    return {
      id: existing.id,
      host,
      port,
      username: existing.username,
      syncSince: existing.sync_since,
    };
  }

  const r = db.run(
    'INSERT INTO imap_accounts (host, port, username, sync_since) VALUES (?,?,?,?)',
    host,
    port,
    username,
    syncSince,
  );
  return { id: r.lastInsertRowid, host, port, username, syncSince };
}

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'authenticated'
  | 'idling'
  | 'syncing'
  | 'error';

export interface MailboxSync {
  accountId: number;
  mailbox: string;
  uidvalidity: number | null;
  lastSeenUid: number;
  connectionState: ConnectionState;
  idleSince: string | null;
  lastEventAt: string | null;
  lastPollAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  consecutiveFailures: number;
  reconnectCount: number;
  messagesIngested: number;
  updatedAt: string;
}

interface MailboxSyncRow {
  account_id: number;
  mailbox: string;
  uidvalidity: number | null;
  last_seen_uid: number;
  connection_state: ConnectionState;
  idle_since: string | null;
  last_event_at: string | null;
  last_poll_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  consecutive_failures: number;
  reconnect_count: number;
  messages_ingested: number;
  updated_at: string;
}

function toMailboxSync(row: MailboxSyncRow): MailboxSync {
  return {
    accountId: row.account_id,
    mailbox: row.mailbox,
    uidvalidity: row.uidvalidity,
    lastSeenUid: row.last_seen_uid,
    connectionState: row.connection_state,
    idleSince: row.idle_since,
    lastEventAt: row.last_event_at,
    lastPollAt: row.last_poll_at,
    lastSuccessAt: row.last_success_at,
    lastError: row.last_error,
    lastErrorAt: row.last_error_at,
    consecutiveFailures: row.consecutive_failures,
    reconnectCount: row.reconnect_count,
    messagesIngested: row.messages_ingested,
    updatedAt: row.updated_at,
  };
}

export function ensureMailbox(db: Db, accountId: number, mailbox: string): MailboxSync {
  db.run(
    `INSERT INTO mailbox_sync (account_id, mailbox, updated_at) VALUES (?,?,?)
     ON CONFLICT DO NOTHING`,
    accountId,
    mailbox,
    isoNow(),
  );
  const row = db.get<MailboxSyncRow>(
    'SELECT * FROM mailbox_sync WHERE account_id = ? AND mailbox = ?',
    accountId,
    mailbox,
  );
  if (!row) throw new Error(`无法创建邮箱同步状态：${mailbox}`);
  return toMailboxSync(row);
}

export function listMailboxes(db: Db): MailboxSync[] {
  return db
    .all<MailboxSyncRow>('SELECT * FROM mailbox_sync ORDER BY mailbox')
    .map(toMailboxSync);
}

export function setState(
  db: Db,
  accountId: number,
  mailbox: string,
  state: ConnectionState,
  detail?: string,
): void {
  const now = isoNow();
  if (state === 'error') {
    db.run(
      `UPDATE mailbox_sync
          SET connection_state = ?, last_error = ?, last_error_at = ?,
              consecutive_failures = consecutive_failures + 1, idle_since = NULL, updated_at = ?
        WHERE account_id = ? AND mailbox = ?`,
      state,
      detail ?? null,
      now,
      now,
      accountId,
      mailbox,
    );
    return;
  }
  db.run(
    `UPDATE mailbox_sync
        SET connection_state = ?,
            idle_since = CASE WHEN ? = 'idling' THEN ? ELSE NULL END,
            consecutive_failures = CASE WHEN ? IN ('idling','syncing','authenticated') THEN 0 ELSE consecutive_failures END,
            updated_at = ?
      WHERE account_id = ? AND mailbox = ?`,
    state,
    state,
    now,
    state,
    now,
    accountId,
    mailbox,
  );
}

export function recordUidValidity(
  db: Db,
  accountId: number,
  mailbox: string,
  uidvalidity: number,
): { changed: boolean; previous: number | null } {
  const row = db.get<{ uidvalidity: number | null }>(
    'SELECT uidvalidity FROM mailbox_sync WHERE account_id = ? AND mailbox = ?',
    accountId,
    mailbox,
  );
  const previous = row?.uidvalidity ?? null;
  if (previous === uidvalidity) return { changed: false, previous };

  // UIDVALIDITY 变了说明服务端重建了 UID 空间，旧的 last_seen_uid 全部作废。
  // 重置为 0 后按 sync_since 重搜；content_hash 唯一键保证不会重复入库。
  db.run(
    `UPDATE mailbox_sync SET uidvalidity = ?, last_seen_uid = 0, updated_at = ?
      WHERE account_id = ? AND mailbox = ?`,
    uidvalidity,
    isoNow(),
    accountId,
    mailbox,
  );
  return { changed: previous !== null, previous };
}

export function advanceUid(db: Db, accountId: number, mailbox: string, uid: number): void {
  db.run(
    `UPDATE mailbox_sync SET last_seen_uid = MAX(last_seen_uid, ?), updated_at = ?
      WHERE account_id = ? AND mailbox = ?`,
    uid,
    isoNow(),
    accountId,
    mailbox,
  );
}

export function recordSuccess(db: Db, accountId: number, mailbox: string, ingested: number): void {
  const now = isoNow();
  db.run(
    `UPDATE mailbox_sync
        SET last_success_at = ?, last_event_at = ?,
            messages_ingested = messages_ingested + ?,
            consecutive_failures = 0, updated_at = ?
      WHERE account_id = ? AND mailbox = ?`,
    now,
    now,
    ingested,
    now,
    accountId,
    mailbox,
  );
}

export function recordPoll(db: Db, accountId: number, mailbox: string): void {
  const now = isoNow();
  db.run(
    'UPDATE mailbox_sync SET last_poll_at = ?, updated_at = ? WHERE account_id = ? AND mailbox = ?',
    now,
    now,
    accountId,
    mailbox,
  );
}

export function recordReconnect(db: Db, accountId: number, mailbox: string): void {
  db.run(
    `UPDATE mailbox_sync SET reconnect_count = reconnect_count + 1, updated_at = ?
      WHERE account_id = ? AND mailbox = ?`,
    isoNow(),
    accountId,
    mailbox,
  );
}

// ── worker 单实例互斥 ──────────────────────────────────────────

const STALE_HEARTBEAT_SECONDS = 90;

/**
 * 抢占 worker 锁。返回 false 表示另一个 worker 还活着，本进程应立即退出。
 *
 * 防的是 `docker compose up --scale worker=2`：两份 IDLE 会触发 iCloud
 * 的并发连接限制，严重时导致账号被临时锁定。
 */
export function acquireWorkerLock(db: Db, pid: number, hostname: string): boolean {
  const now = isoNow();
  const r = db.run(
    `UPDATE worker_lock
        SET worker_pid = ?, hostname = ?, heartbeat_at = ?, started_at = ?
      WHERE id = 1
        AND (heartbeat_at IS NULL
             OR heartbeat_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-${STALE_HEARTBEAT_SECONDS} seconds'))`,
    pid,
    hostname,
    now,
    now,
  );
  return r.changes > 0;
}

export function heartbeat(db: Db, pid: number): void {
  db.run('UPDATE worker_lock SET heartbeat_at = ? WHERE id = 1 AND worker_pid = ?', isoNow(), pid);
}

export function releaseWorkerLock(db: Db, pid: number): void {
  db.run(
    'UPDATE worker_lock SET worker_pid = NULL, heartbeat_at = NULL WHERE id = 1 AND worker_pid = ?',
    pid,
  );
}

export interface WorkerStatus {
  workerPid: number | null;
  hostname: string | null;
  heartbeatAt: string | null;
  startedAt: string | null;
  command: string | null;
}

export function workerStatus(db: Db): WorkerStatus {
  const row = db.get<{
    worker_pid: number | null;
    hostname: string | null;
    heartbeat_at: string | null;
    started_at: string | null;
    command: string | null;
  }>('SELECT worker_pid, hostname, heartbeat_at, started_at, command FROM worker_lock WHERE id = 1');
  return {
    workerPid: row?.worker_pid ?? null,
    hostname: row?.hostname ?? null,
    heartbeatAt: row?.heartbeat_at ?? null,
    startedAt: row?.started_at ?? null,
    command: row?.command ?? null,
  };
}

/** worker 心跳是否新鲜。healthcheck 与后台状态页都用它。 */
export function isWorkerAlive(db: Db, now: Date = new Date()): boolean {
  const status = workerStatus(db);
  if (!status.heartbeatAt) return false;
  const age = now.getTime() - new Date(status.heartbeatAt).getTime();
  return age < STALE_HEARTBEAT_SECONDS * 1000;
}

/** 后台下发命令给 worker（目前只有 reconnect）。worker 每 15 秒读一次。 */
export function setCommand(db: Db, command: string | null): void {
  db.run('UPDATE worker_lock SET command = ? WHERE id = 1', command);
}

export function takeCommand(db: Db): string | null {
  const status = workerStatus(db);
  if (status.command) db.run('UPDATE worker_lock SET command = NULL WHERE id = 1');
  return status.command;
}
