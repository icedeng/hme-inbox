/**
 * 把 worker、healthcheck、migrate 各打包成单文件。
 *
 * 为什么必须打包：Next 的 `output: 'standalone'` 只把它静态分析到的模块
 * 塞进产物，worker 的代码不在 Next 的依赖图里，imapflow / mailparser
 * 根本不会被复制进镜像。打包成单文件后运行阶段完全不需要 node_modules。
 */
import { build } from 'esbuild';
import { mkdirSync, cpSync } from 'node:fs';

const ENTRIES = [
  { in: 'src/worker/main.ts', out: 'dist/worker/main.js' },
  { in: 'src/worker/healthcheck.ts', out: 'dist/worker/healthcheck.js' },
  { in: 'scripts/migrate.ts', out: 'dist/scripts/migrate.js' },
  { in: 'scripts/import-jsonl.ts', out: 'dist/scripts/import-jsonl.js' },
];

for (const entry of ENTRIES) {
  await build({
    entryPoints: [entry.in],
    outfile: entry.out,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // node: 前缀的内置模块交给运行时；sqlite 是实验性 API，绝不能被打包器改写
    external: ['node:*'],
    banner: {
      // esm 产物里没有 require，但 mailparser 的依赖链上有 CJS 互操作代码需要它
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
    logLevel: 'warning',
    minify: false, // 保留可读堆栈，排查生产问题时值这个体积
    sourcemap: false,
  });
  console.log(`✓ ${entry.in} → ${entry.out}`);
}

// .sql 不会被打包器处理，单独拷一份；容器里用 MIGRATIONS_DIR 指向它
mkdirSync('dist/migrations', { recursive: true });
cpSync('src/lib/db/migrations', 'dist/migrations', { recursive: true });
console.log('✓ 迁移 SQL → dist/migrations');
