/**
 * web 侧的数据库连接。
 *
 * Next.js 的 dev 模式会热重载模块，每次重载都新建连接会很快耗尽文件句柄，
 * 所以把连接挂在 globalThis 上复用。生产环境是单进程 standalone，同样适用。
 */
import { openDb, type Db } from './driver.ts';
import { assertSchemaCurrent } from './migrate.ts';
import { webEnv } from '../config/env.ts';

declare global {
  // eslint-disable-next-line no-var
  var __hmeDb: Db | undefined;
}

export function getDb(): Db {
  if (globalThis.__hmeDb) return globalThis.__hmeDb;

  const env = webEnv();
  const db = openDb(env.DATABASE_PATH);

  // 版本不符直接抛错。web 不自己迁移 —— 那是 migrate 容器的职责，
  // 两个容器同时建表是共享 SQLite 时最常见的启动故障。
  assertSchemaCurrent(db);

  globalThis.__hmeDb = db;
  return db;
}
