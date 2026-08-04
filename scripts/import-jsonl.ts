/**
 * 从命令行导入 batch*.jsonl。
 * 与后台上传走同一套逻辑（src/lib/importer + aliases.repo），
 * 所以两条路径的行为保证一致。
 *
 * 用法：
 *   npm run import -- ../icloud-hme-cli-v0.2.0/batch0804.jsonl
 *   npm run import -- batch.jsonl --print-urls
 */
import { readFileSync, existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { loadWebEnv } from '../src/lib/config/env.ts';
import { openDb, withWriteTx } from '../src/lib/db/driver.ts';
import { assertSchemaCurrent } from '../src/lib/db/migrate.ts';
import { parseBatchJsonl } from '../src/lib/importer/importJsonl.ts';
import { createToken, decryptToken, buildPickupUrl } from '../src/lib/tokens/token.ts';
import * as aliasesRepo from '../src/lib/repositories/aliases.repo.ts';
import * as miscRepo from '../src/lib/repositories/misc.repo.ts';

function main(): void {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const printUrls = args.includes('--print-urls');

  if (!file) {
    console.error('用法：npm run import -- <path/to/batch.jsonl> [--print-urls]');
    process.exitCode = 1;
    return;
  }
  const path = resolve(file);
  if (!existsSync(path)) {
    console.error(`文件不存在：${path}`);
    process.exitCode = 1;
    return;
  }

  const env = loadWebEnv();
  const db = openDb(env.DATABASE_PATH);
  try {
    assertSchemaCurrent(db);

    const buffer = readFileSync(path);
    const parsed = parseBatchJsonl(buffer);

    const previous = miscRepo.findBatchByHash(db, parsed.fileSha256);
    if (previous) {
      console.log(`提示：内容相同的文件在 ${previous.createdAt} 导入过，本次仍会执行（幂等）。`);
    }
    if (parsed.duplicatesInFile.length > 0) {
      console.log(`提示：文件内有 ${parsed.duplicatesInFile.length} 个重复地址，保留了后出现的那条。`);
    }

    const counts = { inserted: 0, updated: 0, failed: parsed.errors.length };

    withWriteTx(db, (tx) => {
      const batchId = miscRepo.createImportBatch(
        tx,
        basename(path),
        parsed.fileSha256,
        parsed.totalLines,
      );

      for (const record of parsed.records) {
        // token 只在首次插入时生成；已存在的别名，upsertAlias 不会覆盖 token 列，
        // 所以已发出去的取件 URL 不会失效。
        const token = createToken(env.TOKEN_ENC_KEY);
        const outcome = aliasesRepo.upsertAlias(tx, {
          email: record.email,
          emailNormalized: record.address.normalized,
          localPart: record.address.localPart,
          domain: record.address.domain,
          label: record.label,
          note: record.note,
          batchIndex: record.batchIndex,
          portal: record.portal,
          verified: record.verified,
          sourceCreatedAt: record.sourceCreatedAt,
          importBatchId: batchId,
          tokenHash: token.hash,
          tokenPrefix: token.prefix,
          tokenCiphertext: token.ciphertext,
        });
        if (outcome === 'inserted') counts.inserted++;
        else counts.updated++;
      }

      miscRepo.finishImportBatch(tx, batchId, counts, parsed.errors);
    });

    console.log(
      `导入完成：新增 ${counts.inserted}，更新 ${counts.updated}，失败 ${counts.failed}，共 ${parsed.totalLines} 行`,
    );
    for (const err of parsed.errors.slice(0, 10)) {
      console.error(`  第 ${err.line} 行：${err.reason}`);
    }

    if (printUrls) {
      console.log('\n取件地址：');
      for (const alias of aliasesRepo.listAliases(db, { status: 'active' })) {
        const token = decryptToken(alias.tokenCiphertext, env.TOKEN_ENC_KEY);
        console.log(`  ${buildPickupUrl(env.PUBLIC_BASE_URL, token, alias.email)}`);
      }
    }
  } finally {
    db.close();
  }
}

main();
