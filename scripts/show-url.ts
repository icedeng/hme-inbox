/**
 * 打印取件 URL。运维排查时用，也方便本地测试。
 *
 * 用法：
 *   npm run url                        # 全部别名
 *   npm run url -- cobalt-alibi-1g      # 模糊匹配
 *   npm run url -- --base http://127.0.0.1:3111/m   # 覆盖基址
 */
import { loadWebEnv } from '../src/lib/config/env.ts';
import { openDb } from '../src/lib/db/driver.ts';
import { decryptToken, buildPickupUrl } from '../src/lib/tokens/token.ts';
import * as aliasesRepo from '../src/lib/repositories/aliases.repo.ts';

function main(): void {
  const argv = process.argv.slice(2);
  const baseIdx = argv.indexOf('--base');
  const env = loadWebEnv();
  const base = baseIdx >= 0 ? (argv[baseIdx + 1] ?? env.PUBLIC_BASE_URL) : env.PUBLIC_BASE_URL;
  const filter = argv.find((a, i) => !a.startsWith('--') && i !== baseIdx + 1);

  const db = openDb(env.DATABASE_PATH, { readOnly: true });
  try {
    const aliases = aliasesRepo.listAliases(db, filter ? { search: filter } : {});
    if (aliases.length === 0) {
      console.error(filter ? `没有匹配「${filter}」的别名` : '库里还没有别名，先运行 npm run import');
      process.exitCode = 1;
      return;
    }
    for (const alias of aliases) {
      const token = decryptToken(alias.tokenCiphertext, env.TOKEN_ENC_KEY);
      const flag = alias.status === 'active' ? ' ' : '停用';
      console.log(`${flag} ${buildPickupUrl(base, token, alias.email)}`);
    }
  } finally {
    db.close();
  }
}

main();
