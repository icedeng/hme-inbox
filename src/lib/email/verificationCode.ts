/**
 * 从邮件里提取验证码。
 *
 * 设计前提：**误报比漏报危险得多**。
 * 漏报时用户还能看到正文自己找码；误报会让用户拿着一个错的码反复重试，
 * 而且完全意识不到是系统给错了。所以宁可返回 null，也不返回可疑值。
 *
 * 排除规则因此比匹配规则更重要，且都来自真实样本：
 *   - `© 2026 X.AI LLC`     年份（实测出现在 SpaceXAI 邮件正文）
 *   - `font-weight: 400`    内联 CSS（实测每封信几 KB）
 *   - `#outlook`、`0pt`     CSS 选择器与尺寸
 *   - URL 里的数字、电话号码、金额、日期时间
 *
 * 支持的码形态（同样来自真实样本）：
 *   - 纯数字      935298        （ChatGPT，中文标签「临时验证码以继续：」）
 *   - 分组码      MJP-0LS       （SpaceXAI，3-3 连字符分组）
 *   - 字母数字块  A1B2C3
 */
import { htmlToText } from './htmlToText.ts';

export interface CodeCandidate {
  /** 原样返回，绝不做 O↔0 / I↔1 之类的「纠正」—— 那会把对的码改错。 */
  code: string;
  confidence: number;
  /** 命中来源，便于排查误报。 */
  source: string;
}

export interface CodeExtraction {
  best: CodeCandidate | null;
  candidates: CodeCandidate[];
}

export interface CodeInput {
  subject?: string | null;
  text?: string | null;
  html?: string | null;
}

/** 低于此置信度不作为 `best` 返回，也不供 `format=code` 使用。 */
export const CODE_CONFIDENCE_THRESHOLD = 0.7;

// ── 码形态 ─────────────────────────────────────────────────────

/** 分组码：MJP-0LS、ABC-123、A1B2-C3D4-E5F6。 */
const RE_GROUPED = /\b[A-Z0-9]{3,4}(?:-[A-Z0-9]{3,4}){1,2}\b/g;

/** 纯数字 4–8 位。 */
const RE_DIGITS = /\b\d{4,8}\b/g;

/** 大写字母数字混合块，必须同时含字母与数字，否则 PLEASE、ACCOUNT 之类会误报。 */
const RE_ALNUM = /\b(?=[A-Z0-9]{4,8}\b)(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]{4,8}\b/g;

// ── 标签词 ─────────────────────────────────────────────────────

const LABEL_PATTERN = new RegExp(
  [
    // 英文：修饰语 + code/token/password/pin
    String.raw`(?:verification|verify|security|confirmation|confirm|one[-\s]?time|onetime|single[-\s]?use|access|login|log[-\s]?in|sign[-\s]?in|auth(?:entication)?|temporary|activation|activate|reset|recovery)\s*(?:code|token|password|pin|passcode|key)`,
    // 英文：独立缩写
    String.raw`\b(?:otp|2fa|mfa|passcode)\b`,
    // 英文：裸 code / pin（弱，但 SpaceXAI 正文正是 "use the code below"）
    String.raw`\bcode\b`,
    String.raw`\bpin\b`,
    // 中文
    String.raw`验证码|校验码|动态密码|安全码|确认码|一次性密码|临时密码|临时验证码|登录码|验证代码|激活码|授权码|动态口令`,
  ].join('|'),
  'gi',
);

/** 反向句式：`123456 is your code` / `123456 是您的验证码`。 */
const RE_REVERSE = new RegExp(
  String.raw`\b([A-Z0-9]{4,8}|[A-Z0-9]{3,4}(?:-[A-Z0-9]{3,4}){1,2})\b\s*(?:is\s+(?:your|the)|为您的|是您的|是你的|为你的)`,
  'gi',
);

/** 标签之后允许隔多少字符去找码。SpaceXAI 正文里隔了 38 个字符。 */
const LABEL_WINDOW = 48;

// ── 屏蔽区域 ───────────────────────────────────────────────────

/**
 * 这些区域里的数字绝不能当验证码。用等长空格替换以保持下标不变，
 * 这样后续的「标签在码之前多少字符」判断仍然准确。
 */
const MASK_PATTERNS: Array<[RegExp, string]> = [
  [/https?:\/\/[^\s<>"']+/gi, 'url'],
  [/\bwww\.[^\s<>"']+/gi, 'url'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'email'],
  // 版权年份 —— 实测 SpaceXAI 正文的 `© 2026 X.AI LLC`
  [/(?:©|\(c\)|copyright|版权所有)\s*\d{4}(?:\s*[-–]\s*\d{4})?/gi, 'copyright'],
  // 日期
  [/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/g, 'date'],
  [/\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/g, 'date'],
  [/\b\d{4}\s*年\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?/g, 'date'],
  [/\b\d{1,2}\s*月\s*\d{1,2}\s*日/g, 'date'],
  // 时间
  [/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?/gi, 'time'],
  // 电话。国家码必须是可选组：555-123-4567 只有 10 位，
  // 把 \d{1,3} 写成必选会导致整条规则失配，号码就被分组码正则吃掉了。
  [/\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, 'phone'],
  // 金额与百分比
  [/[$¥€£₽]\s*[\d,]+(?:\.\d+)?/g, 'money'],
  [/\b[\d,]+(?:\.\d+)?\s*(?:USD|CNY|EUR|GBP|JPY|元|美元|人民币)\b/gi, 'money'],
  [/\b\d+(?:\.\d+)?\s*%/g, 'percent'],
  // CSS 尺寸与颜色（内联样式残留）
  [/\b\d+(?:\.\d+)?\s*(?:px|pt|em|rem|vh|vw|ex|ch|cm|mm|in|pc|deg|ms|s)\b/gi, 'css-unit'],
  [/#[0-9a-fA-F]{3,8}\b/g, 'hex-color'],
  // 版本号与 IP
  [/\bv?\d+\.\d+(?:\.\d+)+\b/g, 'version'],
  // 订单号 / 发票号之类的显式标注，避免被当成码
  [/(?:order|invoice|ticket|reference|ref|tracking|account|订单|发票|工单|参考|单号|账号)\s*(?:number|no\.?|#|号|编号)?\s*[:：#]?\s*[A-Za-z0-9-]{4,20}/gi, 'reference'],
];

function maskDangerousRegions(input: string): string {
  let out = input;
  for (const [pattern] of MASK_PATTERNS) {
    out = out.replace(pattern, (m) => ' '.repeat(m.length));
  }
  return out;
}

// ── 排除判定 ───────────────────────────────────────────────────

/** 4 位且落在 1900–2099，极可能是年份。 */
function isYearLike(code: string): boolean {
  if (!/^\d{4}$/.test(code)) return false;
  const n = Number(code);
  return n >= 1900 && n <= 2099;
}

/** 全同数字（0000、111111）几乎不会是真验证码，多半是占位或样式残留。 */
function isRepeatedDigits(code: string): boolean {
  return /^(\d)\1+$/.test(code);
}

/** 简单连续序列（1234、123456）风险同上。 */
function isSequential(code: string): boolean {
  if (!/^\d+$/.test(code)) return false;
  let asc = true;
  let desc = true;
  for (let i = 1; i < code.length; i++) {
    const d = code.charCodeAt(i) - code.charCodeAt(i - 1);
    if (d !== 1) asc = false;
    if (d !== -1) desc = false;
  }
  return asc || desc;
}

// ── 候选收集 ───────────────────────────────────────────────────

interface RawHit {
  code: string;
  index: number;
  shape: 'grouped' | 'digits' | 'alnum';
}

function collectHits(masked: string): RawHit[] {
  const hits: RawHit[] = [];
  const taken: Array<[number, number]> = [];

  const overlaps = (start: number, end: number) =>
    taken.some(([s, e]) => start < e && end > s);

  // 分组码优先：它比组成它的片段更长也更可信，先占位防止被拆开
  for (const re of [RE_GROUPED, RE_ALNUM, RE_DIGITS] as const) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked)) !== null) {
      const code = m[0];
      const start = m.index;
      const end = start + code.length;
      if (overlaps(start, end)) continue;
      taken.push([start, end]);
      hits.push({
        code,
        index: start,
        shape: re === RE_GROUPED ? 'grouped' : re === RE_DIGITS ? 'digits' : 'alnum',
      });
    }
  }
  return hits;
}

/** 找出所有标签的位置。 */
function labelPositions(masked: string): number[] {
  LABEL_PATTERN.lastIndex = 0;
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = LABEL_PATTERN.exec(masked)) !== null) {
    out.push(m.index + m[0].length);
  }
  return out;
}

/** 码之前 window 字符内是否有标签结束位置。 */
function distanceToLabel(labels: number[], codeIndex: number): number | null {
  let best: number | null = null;
    for (const end of labels) {
    if (end > codeIndex) continue;
    const d = codeIndex - end;
    if (d <= LABEL_WINDOW && (best === null || d < best)) best = d;
  }
  return best;
}

interface ScoredHit extends RawHit {
  confidence: number;
  source: string;
}

function scoreCorpus(
  raw: string,
  where: 'subject' | 'body',
  hasCodeWordAnywhere: boolean,
): ScoredHit[] {
  if (!raw) return [];
  const masked = maskDangerousRegions(raw);
  const labels = labelPositions(masked);
  const hits = collectHits(masked);
  const out: ScoredHit[] = [];

  // 反向句式单独扫一遍：`935298 is your code`
  const reverseCodes = new Set<string>();
  RE_REVERSE.lastIndex = 0;
  let rm: RegExpExecArray | null;
  while ((rm = RE_REVERSE.exec(masked)) !== null) {
    if (rm[1]) reverseCodes.add(rm[1]);
  }

  const lines = masked.split('\n');
  const standaloneCodes = new Set<string>();
  for (const line of lines) {
    const t = line.trim();
    if (t.length >= 4 && t.length <= 12 && /^[A-Z0-9-]+$/.test(t)) {
      standaloneCodes.add(t);
    }
  }

  for (const hit of hits) {
    // ── 硬排除 ──
    if (isRepeatedDigits(hit.code)) continue;
    if (isSequential(hit.code) && hit.code.length <= 6) continue;

    const dist = distanceToLabel(labels, hit.index);
    const labeled = dist !== null;

    // 年份：没有紧邻标签一律丢弃。这是本模块最要紧的一条规则。
    if (isYearLike(hit.code)) {
      if (!labeled || dist! > 16) continue;
    }

    let confidence: number;
    let source: string;

    if (labeled && where === 'subject') {
      confidence = 0.95;
      source = 'subject:labeled';
    } else if (labeled) {
      confidence = 0.93;
      source = 'body:labeled';
    } else if (reverseCodes.has(hit.code)) {
      confidence = 0.9;
      source = `${where}:reverse`;
    } else if (hit.shape === 'grouped' && hasCodeWordAnywhere) {
      // 分组码是极罕见的 token 形态，正常英文散文里不会出现，
      // 所以只要全文提到过 code 类词，它本身就是强信号。
      confidence = 0.85;
      source = `${where}:grouped`;
    } else if (standaloneCodes.has(hit.code) && hasCodeWordAnywhere) {
      confidence = 0.75;
      source = `${where}:standalone`;
    } else if (where === 'subject' && hasCodeWordAnywhere) {
      confidence = 0.6;
      source = 'subject:bare';
    } else {
      confidence = 0.35;
      source = `${where}:weak`;
    }

    // 形态微调：6 位数字最常见；4 位与 8 位次之
    if (hit.shape === 'digits') {
      if (hit.code.length === 6) confidence += 0.02;
      else if (hit.code.length === 5 || hit.code.length === 7) confidence -= 0.05;
    }
    if (isYearLike(hit.code)) confidence -= 0.15;

    out.push({ ...hit, confidence: Math.min(confidence, 0.99), source });
  }
  return out;
}

/**
 * 提取验证码。
 *
 * 优先级：subject 带标签 > body 带标签 > 反向句式 > 分组码 > 独占一行 > 弱候选。
 * 同一个码同时出现在主题与正文时加分 —— 这是很强的交叉验证。
 */
export function extractVerificationCode(input: CodeInput): CodeExtraction {
  const subject = (input.subject ?? '').trim();
  const bodyText = input.text?.trim()
    ? input.text
    : input.html
      ? htmlToText(input.html)
      : '';

  // 标签词是否在全文任意处出现过。SpaceXAI 正文的 "use the code below"
  // 与码之间隔了近 40 字符，靠这个开关放行分组码。
  const combined = `${subject}\n${bodyText}`;
  LABEL_PATTERN.lastIndex = 0;
  const hasCodeWordAnywhere = LABEL_PATTERN.test(maskDangerousRegions(combined));

  const subjectHits = scoreCorpus(subject, 'subject', hasCodeWordAnywhere);
  const bodyHits = scoreCorpus(bodyText, 'body', hasCodeWordAnywhere);

  const subjectCodes = new Set(subjectHits.map((h) => h.code));
  const merged = new Map<string, CodeCandidate>();

  for (const hit of [...subjectHits, ...bodyHits]) {
    let confidence = hit.confidence;
    // 主题与正文都出现同一个码 —— 交叉验证，很难是巧合
    if (subjectCodes.has(hit.code) && bodyHits.some((b) => b.code === hit.code)) {
      confidence += 0.05;
    }
    confidence = Math.min(confidence, 0.99);

    const prev = merged.get(hit.code);
    if (!prev || confidence > prev.confidence) {
      merged.set(hit.code, { code: hit.code, confidence, source: hit.source });
    }
  }

  const candidates = [...merged.values()].sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    // 置信度相同时，6 位优先，其次更长的
    const score = (c: string) => (c.length === 6 ? 100 : c.length);
    return score(b.code) - score(a.code);
  });

  const top = candidates[0];
  return {
    best: top && top.confidence >= CODE_CONFIDENCE_THRESHOLD ? top : null,
    candidates: candidates.slice(0, 5),
  };
}
