/**
 * 迁移入口。由独立的 migrate 容器运行一次，
 * web 与 worker 靠 compose 的 service_completed_successfully 等它完成。
 *
 * 用法：npm run migrate
 */
import { hostname } from 'node:os';
import { loadMigrateEnv } from '../src/lib/config/env.ts';
import { openDb, checkLockingSupport } from '../src/lib/db/driver.ts';
import { migrate, currentVersion } from '../src/lib/db/migrate.ts';

function main(): void {
  const env = loadMigrateEnv();
  console.log(`数据库：${env.DATABASE_PATH}`);

  const db = openDb(env.DATABASE_PATH);
  try {
    // 文件锁自检。NFS / CIFS / Docker Desktop for Mac 的 bind mount 上
    // fcntl 锁不可靠，会导致静默数据损坏 —— 宁可现在就拒绝启动。
    const lock = checkLockingSupport(env.DATABASE_PATH);
    if (!lock.ok) {
      console.error(`✗ 文件锁自检未通过：${lock.detail}`);
      console.error('  请把数据库放在 named volume 或本地块设备上，不要用网络文件系统。');
      process.exitCode = 1;
      return;
    }
    console.log(`✓ ${lock.detail}`);

    const before = currentVersion(db);
    const result = migrate(db);

    if (result.applied.length === 0) {
      console.log(`schema 已是最新（版本 ${result.to}），无需迁移。`);
    } else {
      console.log(`schema ${before} → ${result.to}，应用了 ${result.applied.length} 个迁移：`);
      for (const m of result.applied) {
        console.log(`  ${String(m.version).padStart(3, '0')}  ${m.name}`);
      }
    }
    console.log(`完成（${hostname()}）`);
  } finally {
    db.close();
  }
}

main();
