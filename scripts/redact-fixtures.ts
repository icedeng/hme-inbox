/**
 * 把 probe-*.eml 里的真实身份脱敏，产出可提交的 *.redacted.eml 回归固件。
 *
 * 脱敏用「保形替换」：分隔符（. _ -）留在原位，字母换字母、数字换数字。
 * 这样固件仍然覆盖含点 / 含下划线 / 数字开头 等地址边界情况 ——
 * 而这些正是别名归属最容易出错的地方（比如误做 dot-stripping）。
 *
 * 用法：
 *   npm run redact              # 处理 tests/fixtures/probe-*.eml
 *   npm run redact -- --check   # 只报告会替换什么，不写文件
 *
 * 产出同时包含 fixtures.json，记录合成别名清单供测试加载。
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = resolve(PROJECT_ROOT, 'tests/fixtures');
const DEFAULT_ALIAS_FILE = resolve(
  PROJECT_ROOT,
  '../icloud-hme-cli-v0.2.0/batch0804.jsonl',
);

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/**
 * 保形替换：字母 → 字母、数字 → 数字、其余字符原样保留。
 * 用地址本身做种子，保证同一个地址每次都映射到同一个结果（可重复的固件）。
 */
function shapePreservingPseudonym(localPart: string, seed: number): string {
  let out = '';
  for (let i = 0; i < localPart.length; i++) {
    const ch = localPart[i]!;
    if (ch >= 'a' && ch <= 'z') {
      const idx = (ch.charCodeAt(0) - 97 + seed + i * 7) % 26;
      out += LETTERS[idx];
    } else if (ch >= 'A' && ch <= 'Z') {
      const idx = (ch.charCodeAt(0) - 65 + seed + i * 7) % 26;
      out += LETTERS[idx]!.toUpperCase();
    } else if (ch >= '0' && ch <= '9') {
      out += String((Number(ch) + seed + i) % 10);
    } else {
      out += ch; // . _ - 等分隔符原位保留，这是保形的关键
    }
  }
  return out;
}

function seedOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 997;
  return h;
}

function loadAliases(path: string): string[] {
  const out: string[] = [];
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    console.error(`读不到别名清单：${path}`);
    process.exit(1);
  }
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t) as { email?: unknown };
      if (typeof rec.email === 'string' && rec.email.includes('@')) {
        out.push(rec.email.toLowerCase());
      }
    } catch {
      /* 跳过畸形行 */
    }
  }
  return out;
}

interface Replacement {
  from: string;
  to: string;
  kind: 'owner' | 'alias';
}

function buildReplacements(aliases: string[], owner: string): Replacement[] {
  const out: Replacement[] = [
    { from: owner, to: 'owner@icloud.com', kind: 'owner' },
  ];
  for (const alias of aliases) {
    const at = alias.lastIndexOf('@');
    const local = alias.slice(0, at);
    const domain = alias.slice(at + 1);
    out.push({
      from: alias,
      to: `${shapePreservingPseudonym(local, seedOf(alias))}@${domain}`,
      kind: 'alias',
    });
  }
  return out;
}

/**
 * 替换要同时覆盖两种写法：
 *  - 正常地址   linen_cornel5g@icloud.com
 *  - VERP 编码  linen_cornel5g=icloud.com   （出现在 Return-path 的退信地址里）
 * 漏掉后者会让真实别名从 Return-path 泄漏到提交的固件里。
 */
function applyReplacements(text: string, reps: Replacement[]): [string, number] {
  let out = text;
  let count = 0;
  for (const rep of reps) {
    const atForm = rep.from;
    const verpForm = rep.from.replace('@', '=');
    const atTo = rep.to;
    const verpTo = rep.to.replace('@', '=');
    for (const [needle, replacement] of [
      [atForm, atTo],
      [verpForm, verpTo],
    ] as const) {
      // 大小写不敏感的全局替换，转义正则元字符（地址里的点）
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(escaped, 'gi');
      const before = out;
      out = out.replace(re, replacement);
      if (before !== out) count += (before.match(re) ?? []).length;
    }
  }
  return [out, count];
}

function main(): void {
  const checkOnly = process.argv.includes('--check');
  const owner = process.env.HME_IMAP_USER?.toLowerCase();
  if (!owner) {
    console.error('缺少 HME_IMAP_USER —— 需要它才知道要把哪个主邮箱脱敏掉。');
    console.error('用 `npm run redact` 启动（会带 --env-file=.env）。');
    process.exit(1);
  }

  const aliases = loadAliases(DEFAULT_ALIAS_FILE);
  const reps = buildReplacements(aliases, owner);
  console.log(`脱敏映射：1 个主邮箱 + ${aliases.length} 个别名`);

  const files = readdirSync(FIXTURE_DIR).filter(
    (f) => f.startsWith('probe-') && f.endsWith('.eml') && !f.includes('.redacted.'),
  );
  if (files.length === 0) {
    console.error(`${FIXTURE_DIR} 下没有 probe-*.eml。先跑 npm run probe。`);
    process.exit(1);
  }

  const usedAliases = new Set<string>();
  for (const file of files) {
    const srcPath = resolve(FIXTURE_DIR, file);
    const raw = readFileSync(srcPath, 'utf8');
    const [redacted, count] = applyReplacements(raw, reps);

    for (const rep of reps) {
      if (rep.kind === 'alias' && raw.toLowerCase().includes(rep.from)) {
        usedAliases.add(rep.to);
      }
    }

    const outName = basename(file, '.eml') + '.redacted.eml';
    const outPath = resolve(FIXTURE_DIR, outName);
    if (checkOnly) {
      console.log(`  ${file} → ${outName}（将替换 ${count} 处）`);
    } else {
      writeFileSync(outPath, redacted, 'utf8');
      console.log(`  ${file} → ${outName}（替换 ${count} 处）`);
    }

    // 兜底自检：脱敏后绝不能再出现真实主邮箱或真实别名
    const lower = redacted.toLowerCase();
    const leaked = [owner, ...aliases].filter(
      (s) => lower.includes(s) || lower.includes(s.replace('@', '=')),
    );
    if (leaked.length > 0) {
      console.error(`  ✗ ${outName} 仍残留真实地址：${leaked.join(', ')}`);
      process.exitCode = 1;
    }
  }

  if (!checkOnly) {
    const manifest = {
      note: '合成别名清单，供归属层回归测试加载。真实地址不出现在本文件中。',
      aliases: [...usedAliases].sort(),
    };
    writeFileSync(
      resolve(FIXTURE_DIR, 'fixtures.json'),
      JSON.stringify(manifest, null, 2) + '\n',
      'utf8',
    );
    console.log(`\n合成别名清单已写入 tests/fixtures/fixtures.json（${usedAliases.size} 个）`);
    console.log('*.redacted.eml 与 fixtures.json 可以安全提交。');
  }
}

main();
