/**
 * SQLite 驱动层 —— **全项目唯一 import `node:sqlite` 的文件**。
 *
 * 这层存在的三个理由：
 *
 * 1. `node:sqlite` 目前仍是实验性 API，把它锁在一个文件里，
 *    将来换回 better-sqlite3 只改这一处。
 * 2. WAL 下有一个致命细节：**读事务升级为写事务时 `busy_timeout` 不生效**，
 *    会立刻返回 SQLITE_BUSY。所以所有写操作必须用 `BEGIN IMMEDIATE`
 *    一开始就拿写锁。这条规则靠 `withWriteTx()` 强制，不留给调用方自觉。
 * 3. web 与 worker 是两个容器共享同一个 DB 文件，退避重试是必需品。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type SqlValue = string | number | bigint | null | Uint8Array;
export type Row = Record<string, SqlValue>;

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface Db {
  run(sql: string, ...params: SqlValue[]): RunResult;
  get<T = Row>(sql: string, ...params: SqlValue[]): T | undefined;
  all<T = Row>(sql: string, ...params: SqlValue[]): T[];
  exec(sql: string): void;
  close(): void;
  /** 仅供 withWriteTx 使用，业务代码不要直接调。 */
  readonly raw: DatabaseSync;
  readonly path: string;
}

// ── 错误判定 ───────────────────────────────────────────────────

/** SQLITE_BUSY=5, SQLITE_LOCKED=6。node:sqlite 把它们放在 errcode 上。 */
function isBusyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { errcode?: unknown }).errcode;
  if (code === 5 || code === 6) return true;
  return /database is locked|database table is locked|SQLITE_BUSY/i.test(err.message);
}

/**
 * 同步睡眠。node:sqlite 是同步 API，重试退避没法用 await，
 * 只能靠 Atomics.wait 阻塞当前线程。
 */
function sleepSync(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

// ── 打开与配置 ─────────────────────────────────────────────────

export interface OpenOptions {
  /** 只读连接（web 的大部分场景），会跳过建库。 */
  readOnly?: boolean;
  busyTimeoutMs?: number;
}

export function openDb(path: string, options: OpenOptions = {}): Db {
  if (path !== ':memory:' && !options.readOnly) {
    mkdirSync(dirname(path), { recursive: true });
  }

  const raw = new DatabaseSync(path, {
    readOnly: options.readOnly ?? false,
    // 允许不带 : 前缀的具名参数会引入歧义，这里全用位置参数 ?，保持关闭
    enableForeignKeyConstraints: true,
  });

  const busyTimeout = options.busyTimeoutMs ?? 5000;

  // WAL 持久化在文件头，设一次即可，但每次设无害；其余 pragma 是连接级的，必须每次设。
  if (!options.readOnly) {
    raw.exec('PRAGMA journal_mode = WAL');
    raw.exec('PRAGMA auto_vacuum = INCREMENTAL');
  }
  raw.exec(`PRAGMA busy_timeout = ${busyTimeout}`);
  raw.exec('PRAGMA foreign_keys = ON');
  // WAL 下 NORMAL 是安全的；FULL 每次提交都 fsync，对本场景太慢
  raw.exec('PRAGMA synchronous = NORMAL');
  raw.exec('PRAGMA wal_autocheckpoint = 1000');

  const db: Db = {
    raw,
    path,
    run(sql, ...params) {
      const stmt = raw.prepare(sql);
      const r = stmt.run(...params);
      return {
        changes: Number(r.changes),
        lastInsertRowid: Number(r.lastInsertRowid),
      };
    },
    get<T>(sql: string, ...params: SqlValue[]): T | undefined {
      return raw.prepare(sql).get(...params) as T | undefined;
    },
    all<T>(sql: string, ...params: SqlValue[]): T[] {
      return raw.prepare(sql).all(...params) as T[];
    },
    exec(sql) {
      raw.exec(sql);
    },
    close() {
      raw.close();
    },
  };

  return db;
}

// ── 事务 ───────────────────────────────────────────────────────

const MAX_WRITE_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 10;

/**
 * 写事务。**所有写操作都必须走这里。**
 *
 * 用 `BEGIN IMMEDIATE` 而非默认的 `BEGIN DEFERRED`：后者先拿读锁、
 * 到第一条写语句时才尝试升级，而升级失败会立刻返回 SQLITE_BUSY 且
 * 不受 busy_timeout 保护。IMMEDIATE 一开始就取写锁，busy_timeout 才起作用。
 *
 * 嵌套调用会复用外层事务（SQLite 不支持真正的嵌套事务）。
 */
let txDepth = 0;

export function withWriteTx<T>(db: Db, fn: (db: Db) => T): T {
  if (txDepth > 0) {
    // 已在事务中，直接执行，由最外层负责提交/回滚
    return fn(db);
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (err) {
      if (!isBusyError(err) || attempt === MAX_WRITE_ATTEMPTS - 1) throw err;
      lastError = err;
      // 指数退避 + 抖动，避免两个容器同步重试互相打架
      const jitter = 0.8 + ((attempt * 37) % 40) / 100;
      sleepSync(Math.round(BASE_BACKOFF_MS * 2 ** attempt * jitter));
      continue;
    }

    txDepth++;
    try {
      const result = fn(db);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // 回滚失败通常意味着事务已因错误自动回滚，忽略以免掩盖原始错误
      }
      throw err;
    } finally {
      txDepth--;
    }
  }
  throw lastError ?? new Error('写事务重试次数耗尽');
}

/** 只读事务，保证一组查询看到一致快照。 */
export function withReadTx<T>(db: Db, fn: (db: Db) => T): T {
  if (txDepth > 0) return fn(db);
  db.exec('BEGIN');
  txDepth++;
  try {
    const result = fn(db);
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 同上 */
    }
    throw err;
  } finally {
    txDepth--;
  }
}

// ── 类型辅助 ───────────────────────────────────────────────────

/**
 * node:sqlite 的 BLOB 返回 Uint8Array，better-sqlite3 返回 Buffer。
 * 统一转成 Buffer，避免两种驱动的差异渗进业务代码。
 */
export function toBuffer(value: SqlValue | undefined): Buffer | null {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return null;
}

/** SQLite 无布尔类型，统一用 0/1。 */
export function toBool(value: SqlValue | undefined): boolean {
  return value === 1 || value === 1n || value === '1';
}

export function fromBool(value: boolean): number {
  return value ? 1 : 0;
}

/** 供 SQL 直接比较的 ISO8601 UTC 串（字典序 = 时间序）。 */
export function isoNow(clock: () => Date = () => new Date()): string {
  return clock().toISOString();
}

export function isoOffsetDays(days: number, clock: () => Date = () => new Date()): string {
  const d = new Date(clock().getTime() + days * 86_400_000);
  return d.toISOString();
}

/** 数据库文件所在文件系统是否支持 fcntl 锁 —— NFS / 某些 bind mount 上会静默损坏数据。 */
export function checkLockingSupport(path: string): { ok: boolean; detail: string } {
  if (path === ':memory:') return { ok: true, detail: '内存库，无需文件锁' };
  let a: Db | undefined;
  let b: Db | undefined;
  try {
    a = openDb(path);
    b = openDb(path);
    a.exec('BEGIN IMMEDIATE');
    try {
      // 第二个连接此时应拿不到写锁。拿到了说明锁没生效。
      b.exec('PRAGMA busy_timeout = 100');
      b.exec('BEGIN IMMEDIATE');
      b.exec('ROLLBACK');
      return {
        ok: false,
        detail: '两个连接同时取得写锁 —— 该文件系统的 fcntl 锁不可靠，有静默损坏风险',
      };
    } catch (err) {
      if (isBusyError(err)) return { ok: true, detail: '文件锁正常' };
      throw err;
    } finally {
      a.exec('ROLLBACK');
    }
  } catch (err) {
    return { ok: false, detail: `自检失败：${err instanceof Error ? err.message : String(err)}` };
  } finally {
    a?.close();
    b?.close();
  }
}
