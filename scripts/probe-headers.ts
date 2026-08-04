/**
 * Phase 0 探测脚本：查明 iCloud 转发 Hide My Email 邮件时，
 * 究竟哪个邮件头里还保留着原始的别名地址。
 *
 * 苹果对此没有任何公开文档，别名归属规则必须建立在实测之上。
 * 本脚本连接真实 IMAP 账号，把原始 MIME 存到 tests/fixtures/，
 * 并统计「已知别名出现在哪些头里」。
 *
 * 用法：
 *   npm run probe                    # 扫描最近 30 封
 *   npm run probe -- --limit 100     # 扫描最近 100 封
 *   npm run probe -- --no-save       # 只分析不落盘
 *
 * 输出的头名命中统计，直接决定 src/lib/matching/rules.ts 的层级顺序。
 */
import { ImapFlow } from 'imapflow';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = resolve(PROJECT_ROOT, 'tests/fixtures');
const DEFAULT_ALIAS_FILE = resolve(
  PROJECT_ROOT,
  '../icloud-hme-cli-v0.2.0/batch0804.jsonl',
);

/** L6 原始头扫描必须排除的头：别名之间互发时，发件人恰好是库里另一个别名。 */
const SENDER_HEADERS = new Set([
  'from',
  'sender',
  'reply-to',
  'return-path',
  'message-id',
  'references',
  'in-reply-to',
  'disposition-notification-to',
]);

interface Args {
  limit: number;
  save: boolean;
  aliasFile: string;
  mailbox: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    limit: 30,
    save: true,
    aliasFile: DEFAULT_ALIAS_FILE,
    mailbox: 'INBOX',
  };
  const next = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined) throw new Error(`${flag} 缺少参数值`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') args.limit = Number(next(++i, '--limit'));
    else if (a === '--no-save') args.save = false;
    else if (a === '--alias-file') args.aliasFile = resolve(next(++i, '--alias-file'));
    else if (a === '--mailbox') args.mailbox = next(++i, '--mailbox');
  }
  if (!Number.isInteger(args.limit) || args.limit < 1) {
    throw new Error(`--limit 必须是正整数，收到：${args.limit}`);
  }
  return args;
}

/** 从 icloud-hme-cli 产出的 jsonl 里读出别名集合（小写）。 */
function loadAliases(path: string): Set<string> {
  const aliases = new Set<string>();
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    console.error(`读不到别名清单：${path}`);
    console.error('用 --alias-file <路径> 指定，或确认 icloud-hme-cli 仓库在同级目录。');
    process.exit(1);
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as { email?: unknown };
      if (typeof rec.email === 'string' && rec.email.includes('@')) {
        aliases.add(rec.email.toLowerCase());
      }
    } catch {
      // 跳过畸形行，探测脚本不该因为一行坏数据就罢工
    }
  }
  return aliases;
}

/** 切出头块（不含分隔空行），返回 [头块, 正文]。兼容 CRLF 与 LF。 */
function splitHeaderBlock(raw: string): [string, string] {
  const idx = (() => {
    const crlf = raw.indexOf('\r\n\r\n');
    const lf = raw.indexOf('\n\n');
    if (crlf === -1) return lf === -1 ? -1 : lf;
    if (lf === -1) return crlf;
    return Math.min(crlf, lf);
  })();
  if (idx === -1) return [raw, ''];
  const sepLen = raw.startsWith('\r\n', idx) ? 4 : 2;
  return [raw.slice(0, idx), raw.slice(idx + sepLen)];
}

interface HeaderPair {
  name: string; // 原样大小写
  lower: string;
  value: string; // 已 unfold，续行的前导空白折成单空格
}

/** RFC 5322 unfold：续行以空白开头，折回上一行。 */
function parseHeaders(headerBlock: string): HeaderPair[] {
  const out: HeaderPair[] = [];
  const lines = headerBlock.split(/\r?\n/);
  let current: string | null = null;

  const flush = () => {
    if (current === null) return;
    const colon = current.indexOf(':');
    if (colon > 0) {
      const name = current.slice(0, colon).trim();
      out.push({
        name,
        lower: name.toLowerCase(),
        value: current.slice(colon + 1).trim(),
      });
    }
    current = null;
  };

  for (const line of lines) {
    if (line === '') continue;
    if (/^[ \t]/.test(line)) {
      // 续行：折叠成单空格，避免长地址被换行切断导致扫描漏匹配
      if (current !== null) current += ' ' + line.trim();
    } else {
      flush();
      current = line;
    }
  }
  flush();
  return out;
}

/** 在一段文本里找出所有出现的已知别名。 */
function findAliases(text: string, aliases: Set<string>): string[] {
  const lower = text.toLowerCase();
  const hits: string[] = [];
  for (const alias of aliases) {
    if (lower.includes(alias)) hits.push(alias);
  }
  return hits;
}

/** 抽出文本里所有 @icloud.com 地址，用来发现「漏导入的别名」。 */
function extractIcloudAddresses(text: string): string[] {
  const re = /[A-Za-z0-9._%+-]+@icloud\.com/gi;
  return [...new Set((text.match(re) ?? []).map((s) => s.toLowerCase()))];
}

interface MessageReport {
  uid: number;
  mailbox: string;
  internalDate: string;
  from: string;
  subject: string;
  sizeBytes: number;
  /** 头名 → 该头里命中的别名 */
  aliasHitsByHeader: Map<string, string[]>;
  /** 正文里命中的别名 */
  bodyHits: string[];
  /** 全部头名（原样大小写） */
  headerNames: string[];
  /** 头块里出现的所有 @icloud.com 地址（含不在别名表里的） */
  icloudAddresses: string[];
  fixturePath?: string;
}

function analyzeMessage(
  uid: number,
  internalDate: Date,
  raw: string,
  aliases: Set<string>,
): MessageReport {
  const [headerBlock, body] = splitHeaderBlock(raw);
  const headers = parseHeaders(headerBlock);

  const aliasHitsByHeader = new Map<string, string[]>();
  for (const h of headers) {
    const hits = findAliases(h.value, aliases);
    if (hits.length === 0) continue;
    // 发件人类头单独标注，它们的命中是噪声不是信号
    const key = SENDER_HEADERS.has(h.lower) ? `${h.name} (发件人类·排除)` : h.name;
    const existing = aliasHitsByHeader.get(key) ?? [];
    aliasHitsByHeader.set(key, [...new Set([...existing, ...hits])]);
  }

  const findHeader = (name: string) =>
    headers.find((h) => h.lower === name)?.value ?? '';

  return {
    uid,
    mailbox: '',
    internalDate: internalDate.toISOString(),
    from: findHeader('from').slice(0, 60),
    subject: findHeader('subject').slice(0, 60),
    sizeBytes: Buffer.byteLength(raw),
    aliasHitsByHeader,
    bodyHits: findAliases(body.slice(0, 200_000), aliases),
    headerNames: headers.map((h) => h.name),
    icloudAddresses: extractIcloudAddresses(headerBlock),
  };
}

function printReport(reports: MessageReport[], aliases: Set<string>): void {
  const line = '─'.repeat(72);
  console.log(`\n${line}\n探测结果\n${line}`);

  // ── 逐封摘要 ──────────────────────────────────────────────
  for (const r of reports) {
    const matchedHeaders = [...r.aliasHitsByHeader.keys()].filter(
      (k) => !k.includes('排除'),
    );
    const flag = matchedHeaders.length > 0 ? '✓' : r.bodyHits.length > 0 ? '~' : '✗';
    console.log(
      `\n${flag} [${r.mailbox}] UID ${r.uid}  ${r.internalDate}  ${(r.sizeBytes / 1024).toFixed(1)}KB`,
    );
    console.log(`   From:    ${r.from}`);
    console.log(`   Subject: ${r.subject}`);
    if (r.aliasHitsByHeader.size > 0) {
      for (const [header, hits] of r.aliasHitsByHeader) {
        console.log(`   → ${header}: ${hits.join(', ')}`);
      }
    }
    if (r.bodyHits.length > 0) {
      console.log(`   → 正文命中: ${r.bodyHits.join(', ')}`);
    }
    if (matchedHeaders.length === 0 && r.bodyHits.length === 0) {
      const unknown = r.icloudAddresses.filter((a) => !aliases.has(a));
      console.log(
        `   → 未命中任何已知别名${unknown.length ? `；头里的其他 icloud 地址: ${unknown.slice(0, 5).join(', ')}` : ''}`,
      );
    }
  }

  // ── 头名命中统计（本脚本的核心产出）──────────────────────
  console.log(`\n${line}\n头名命中统计 — 这决定 rules.ts 的层级顺序\n${line}`);
  const headerHitCount = new Map<string, number>();
  for (const r of reports) {
    for (const header of r.aliasHitsByHeader.keys()) {
      headerHitCount.set(header, (headerHitCount.get(header) ?? 0) + 1);
    }
  }
  if (headerHitCount.size === 0) {
    console.log('没有任何头命中已知别名。');
  } else {
    const sorted = [...headerHitCount.entries()].sort((a, b) => b[1] - a[1]);
    const width = Math.max(...sorted.map(([h]) => h.length));
    for (const [header, count] of sorted) {
      const pct = ((count / reports.length) * 100).toFixed(0);
      console.log(`  ${header.padEnd(width)}  ${String(count).padStart(3)} 封 (${pct}%)`);
    }
  }

  // ── 全部头名清单，用来发现 X-Apple-* 私有头 ───────────────
  console.log(`\n${line}\n出现过的全部头名（★ = 曾命中别名）\n${line}`);
  const allHeaders = new Map<string, number>();
  const everMatched = new Set<string>();
  for (const r of reports) {
    for (const n of r.headerNames) {
      allHeaders.set(n, (allHeaders.get(n) ?? 0) + 1);
    }
    for (const k of r.aliasHitsByHeader.keys()) {
      everMatched.add(k.replace(' (发件人类·排除)', ''));
    }
  }
  const sortedAll = [...allHeaders.entries()].sort((a, b) => b[1] - a[1]);
  for (const [name, count] of sortedAll) {
    const star = everMatched.has(name) ? '★' : ' ';
    console.log(`  ${star} ${name.padEnd(38)} ${String(count).padStart(3)}`);
  }

  // ── 结论 ─────────────────────────────────────────────────
  const matched = reports.filter(
    (r) => [...r.aliasHitsByHeader.keys()].some((k) => !k.includes('排除')),
  ).length;
  const bodyOnly = reports.filter(
    (r) =>
      ![...r.aliasHitsByHeader.keys()].some((k) => !k.includes('排除')) &&
      r.bodyHits.length > 0,
  ).length;
  console.log(`\n${line}\n结论\n${line}`);
  console.log(`  总计 ${reports.length} 封`);
  console.log(`  头部命中别名: ${matched}`);
  console.log(`  仅正文命中:   ${bodyOnly}`);
  console.log(`  完全未命中:   ${reports.length - matched - bodyOnly}`);
  if (matched === 0) {
    console.log(
      '\n  ⚠️  没有任何一封信的头部含已知别名。',
    );
    console.log('     可能原因：(a) 收件箱里还没有发往这些别名的信；');
    console.log('     (b) 苹果转发时改写了头部 —— 那样就必须依赖正文扫描或换方案。');
    console.log('     请往别名地址发一封测试信后重跑本脚本。');
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const required = ['HME_IMAP_HOST', 'HME_IMAP_PORT', 'HME_IMAP_USER', 'HME_IMAP_PASS'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`缺少环境变量：${missing.join(', ')}`);
    console.error('确认 .env 存在且用 `npm run probe` 启动（它会带 --env-file=.env）。');
    process.exit(1);
  }

  const aliases = loadAliases(args.aliasFile);
  console.log(`已加载 ${aliases.size} 个别名：${args.aliasFile}`);
  if (aliases.size === 0) {
    console.error('别名清单为空，无法分析归属。');
    process.exit(1);
  }

  const client = new ImapFlow({
    host: process.env.HME_IMAP_HOST!,
    port: Number(process.env.HME_IMAP_PORT),
    secure: true,
    auth: {
      user: process.env.HME_IMAP_USER!,
      pass: process.env.HME_IMAP_PASS!,
    },
    logger: false,
    // 探测脚本不该无限等待
    socketTimeout: 60_000,
    greetingTimeout: 15_000,
    connectionTimeout: 15_000,
  });

  client.on('error', (err: Error) => {
    console.error(`IMAP 连接出错：${err.message}`);
  });

  console.log(`连接 ${process.env.HME_IMAP_HOST} …`);
  await client.connect();
  console.log(`已登录 ${process.env.HME_IMAP_USER}`);

  // 邮箱清单。验证码邮件常被判为垃圾邮件，只盯 INBOX 会静默漏信，
  // 所以这里默认把每个邮箱都扫一遍，用实测数据决定 worker 该盯哪些。
  const boxes = await client.list();
  console.log('\n邮箱列表：');
  for (const box of boxes) {
    console.log(`  ${box.path}${box.specialUse ? `  ${box.specialUse}` : ''}`);
  }

  const targets =
    args.mailbox === 'ALL' ? boxes.map((b) => b.path) : [args.mailbox];

  const reports: MessageReport[] = [];
  /** 邮箱 → [该箱总信数, 其中命中别名的信数] */
  const perMailbox = new Map<string, [number, number]>();

  if (args.save) mkdirSync(FIXTURE_DIR, { recursive: true });

  try {
    for (const boxPath of targets) {
      let lock;
      try {
        lock = await client.getMailboxLock(boxPath);
      } catch (err) {
        console.log(`\n${boxPath}: 打不开（${err instanceof Error ? err.message : err}），跳过`);
        continue;
      }
      try {
        const mailbox = client.mailbox;
        if (typeof mailbox === 'boolean') continue;
        const total = mailbox.exists;
        console.log(
          `\n${boxPath}: 共 ${total} 封, UIDVALIDITY=${mailbox.uidValidity}`,
        );
        if (total === 0) {
          perMailbox.set(boxPath, [0, 0]);
          continue;
        }

        const start = Math.max(1, total - args.limit + 1);
        let boxHits = 0;
        let boxCount = 0;

        for await (const msg of client.fetch(
          `${start}:*`,
          { source: true, uid: true, internalDate: true },
        )) {
          if (!msg.source) continue;
          const raw = msg.source.toString('utf8');
          // INTERNALDATE 是排序与保留期的基准，缺失时不能静默当成 now，
          // 否则一封老信会被当成刚到的。落成 epoch 0 让异常在报告里显眼。
          const internalDate =
            msg.internalDate instanceof Date
              ? msg.internalDate
              : msg.internalDate
                ? new Date(msg.internalDate)
                : new Date(0);
          const report = analyzeMessage(msg.uid, internalDate, raw, aliases);
          report.mailbox = boxPath;

          const hitHeader = [...report.aliasHitsByHeader.keys()].some(
            (k) => !k.includes('排除'),
          );
          if (hitHeader || report.bodyHits.length > 0) boxHits++;
          boxCount++;

          if (args.save) {
            const safeBox = boxPath.replace(/[^A-Za-z0-9]+/g, '_');
            const path = resolve(
              FIXTURE_DIR,
              `probe-${safeBox}-${String(msg.uid).padStart(6, '0')}.eml`,
            );
            writeFileSync(path, msg.source, { mode: 0o600 });
            report.fixturePath = path;
          }
          reports.push(report);
          process.stdout.write(`\r  已处理 ${boxCount} 封`);
        }
        process.stdout.write('\n');
        perMailbox.set(boxPath, [boxCount, boxHits]);
      } finally {
        lock.release();
      }
    }
  } finally {
    await client.logout();
  }

  // ── 分邮箱命中统计：直接回答「worker 该盯哪几个邮箱」──────
  const line = '─'.repeat(72);
  console.log(`\n${line}\n分邮箱统计 — 这决定 worker 要 IDLE 哪些邮箱\n${line}`);
  const boxWidth = Math.max(...[...perMailbox.keys()].map((k) => k.length), 8);
  for (const [box, [count, hits]] of perMailbox) {
    const mark = hits > 0 ? '★' : ' ';
    console.log(
      `  ${mark} ${box.padEnd(boxWidth)}  扫描 ${String(count).padStart(3)} 封, 含别名 ${String(hits).padStart(3)} 封`,
    );
  }
  console.log('\n  ★ = 该邮箱出现过发往别名的信，worker 必须盯住它。');

  printReport(reports, aliases);

  if (args.save && reports.length > 0) {
    console.log(`\n原始 MIME 已存到 ${FIXTURE_DIR}/probe-*.eml（权限 0600，已被 gitignore）`);
    console.log('脱敏后重命名为 *.redacted.eml 才会进版本库，作为归属层的回归固件。');
  }
}

main().catch((err: unknown) => {
  console.error('\n探测失败：', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
