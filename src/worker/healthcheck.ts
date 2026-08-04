/**
 * worker 容器的健康检查。读心跳时间戳，超时即判定不健康。
 *
 * 单独一个进程而不是 HTTP 端点：worker 不该为了健康检查去开一个端口。
 * 退出码 0 = 健康，1 = 不健康（Docker 的约定）。
 */
import { loadMigrateEnv } from '../lib/config/env.ts';
import { openDb } from '../lib/db/driver.ts';
import * as syncRepo from '../lib/repositories/sync.repo.ts';

function main(): void {
  let db;
  try {
    const env = loadMigrateEnv();
    db = openDb(env.DATABASE_PATH, { readOnly: true });
    const alive = syncRepo.isWorkerAlive(db);
    if (!alive) {
      const status = syncRepo.workerStatus(db);
      console.error(`worker 心跳过期，最后一次：${status.heartbeatAt ?? '(从未)'}`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = 0;
  } catch (err) {
    console.error(`健康检查失败：${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    db?.close();
  }
}

main();
