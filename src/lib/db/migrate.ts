/**
 * 迁移执行器。
 *
 * 由独立的 migrate 容器运行，web 与 worker 只校验版本、绝不自己建表 ——
 * 两个容器同时建表是共享 SQLite 时最常见的启动故障。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Db, withWriteTx, isoNow } from './driver.ts';

/**
 * 迁移目录。
 *
 * worker 与 migrate 在容器里是 esbuild 打包成的单文件，`import.meta.url`
 * 指向 dist/ 而不是源码树，所以 .sql 找不到。Dockerfile 会把 migrations
 * 拷到镜像里并设置 MIGRATIONS_DIR，本地开发时则走相对源码的默认路径。
 */
const MIGRATIONS_DIR =
  process.env.MIGRATIONS_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), 'migrations');

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** 文件名形如 `001_init.sql`，前缀数字即版本号。 */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql'));
  const migrations = files.map((file) => {
    const m = /^(\d+)[_-](.+)\.sql$/.exec(file);
    if (!m || !m[1] || !m[2]) {
      throw new Error(`迁移文件名不合规（应为 001_name.sql）：${file}`);
    }
    return {
      version: Number(m[1]),
      name: m[2],
      sql: readFileSync(resolve(dir, file), 'utf8'),
    };
  });
  migrations.sort((a, b) => a.version - b.version);

  const seen = new Set<number>();
  for (const m of migrations) {
    if (seen.has(m.version)) throw new Error(`迁移版本号重复：${m.version}`);
    seen.add(m.version);
  }
  return migrations;
}

function ensureVersionTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
}

export function currentVersion(db: Db): number {
  ensureVersionTable(db);
  const row = db.get<{ v: number | null }>('SELECT MAX(version) AS v FROM schema_migrations');
  return row?.v ?? 0;
}

export interface MigrateResult {
  from: number;
  to: number;
  applied: Array<{ version: number; name: string }>;
}

export function migrate(db: Db, dir?: string): MigrateResult {
  ensureVersionTable(db);
  const migrations = loadMigrations(dir);
  const from = currentVersion(db);
  const applied: Array<{ version: number; name: string }> = [];

  for (const m of migrations) {
    if (m.version <= from) continue;
    // 每个迁移一个事务：失败时只回滚这一个，已成功的保持已应用
    withWriteTx(db, (tx) => {
      tx.exec(m.sql);
      tx.run(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        m.version,
        m.name,
        isoNow(),
      );
    });
    applied.push({ version: m.version, name: m.name });
  }

  return { from, to: currentVersion(db), applied };
}

/**
 * web 与 worker 启动时调用：版本不符直接抛错退出，
 * 不要带着不匹配的 schema 继续跑。
 */
export function assertSchemaCurrent(db: Db, dir?: string): void {
  const expected = loadMigrations(dir).reduce((max, m) => Math.max(max, m.version), 0);
  const actual = currentVersion(db);
  if (actual !== expected) {
    throw new Error(
      `数据库 schema 版本不符：期望 ${expected}，实际 ${actual}。请先运行迁移（npm run migrate）。`,
    );
  }
}
