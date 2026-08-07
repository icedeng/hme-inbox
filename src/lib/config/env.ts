/**
 * 环境变量校验。
 *
 * 原则是 fail fast：配置错了就在启动时炸掉，绝不带着错配置跑 ——
 * 一个拼错的 IMAP 主机名如果拖到运行时才暴露，表现出来就是「莫名其妙收不到信」。
 *
 * 三个入口（web / worker / migrate）需要的变量不同，所以按用途分别校验，
 * 免得 web 容器因为缺 IMAP 密码起不来。
 */
import { z } from 'zod';
import { isValidPasswordHash } from '../auth/password.ts';

const NonEmpty = z.string().trim().min(1);

const OptionalNonEmpty = z.preprocess(
  (value) => (typeof value === 'string' && !value.trim() ? undefined : value),
  z.string().trim().min(1).optional(),
);

const OptionalHttpUrl = OptionalNonEmpty.refine(
  (value) => {
    if (!value) return true;
    try {
      const protocol = new URL(value).protocol;
      return protocol === 'http:' || protocol === 'https:';
    } catch {
      return false;
    }
  },
  { message: '必须是 http 或 https URL' },
);

/** 32 字节的 base64/base64url 密钥。 */
const Key32 = NonEmpty.refine(
  (v) => {
    try {
      return Buffer.from(v, 'base64').length === 32;
    } catch {
      return false;
    }
  },
  { message: '必须是 base64 编码的 32 字节密钥，用 `openssl rand -base64 32` 生成' },
);

const IntFromEnv = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number(v)))
    .pipe(z.number().int().min(min).max(max));

// ── 分组 schema ────────────────────────────────────────────────

const StorageSchema = z.object({
  DATABASE_PATH: NonEmpty.default('./data/hme.db'),
  ATTACHMENT_DIR: NonEmpty.default('./data/attachments'),
});

const RetentionSchema = z.object({
  RETENTION_DAYS: IntFromEnv(30, 1, 3650),
  UNMATCHED_RETENTION_DAYS: IntFromEnv(60, 1, 3650),
  ACCESS_LOG_RETENTION_DAYS: IntFromEnv(7, 1, 365),
});

const ImapSchema = z.object({
  HME_IMAP_HOST: NonEmpty.default('imap.mail.me.com'),
  HME_IMAP_PORT: IntFromEnv(993, 1, 65535),
  HME_IMAP_USER: NonEmpty,
  HME_IMAP_PASS: NonEmpty,
  /**
   * 要盯的邮箱。验证码邮件常被判为垃圾，只盯 INBOX 会静默漏信；
   * imapflow 一个连接只能锁一个邮箱，所以这里每多一个就多一条连接。
   */
  HME_IMAP_MAILBOXES: z
    .string()
    .optional()
    .transform((v) =>
      (v && v.trim() ? v : 'INBOX,Junk')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .pipe(z.array(NonEmpty).min(1).max(8)),
  /**
   * 首次创建账号时的收信起点。不设则用「当前时间」，即只收新信。
   * 只在账号首次创建时生效 —— 后续重启改这个值不会有任何作用，
   * 否则每次重启都会把起点推到当下，漏掉停机期间的信。
   */
  HME_SYNC_SINCE: z
    .string()
    .optional()
    .transform((v) => {
      if (!v || !v.trim()) return null;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    })
    .pipe(z.string().nullable()),
  /**
   * 兜底轮询间隔。
   *
   * IDLE 正常时它几乎用不上；但 IDLE 一旦静默失效（NAT 掐连接、
   * 服务端不推送），这个间隔就是实际的收信延迟上限。
   * 下限放到 1 秒：一次 SEARCH 很轻（没有新信时不产生 FETCH），
   * 用它换一个确定的延迟上限是划算的。
   */
  POLL_INTERVAL_MS: IntFromEnv(3_000, 1_000, 3_600_000),
  /** IDLE 主动刷新周期。RFC 2177 建议不超过 29 分钟，默认取 25 分钟。 */
  IDLE_REFRESH_MS: IntFromEnv(1_500_000, 60_000, 1_740_000),
  MAX_MESSAGE_BYTES: IntFromEnv(5_242_880, 65_536, 104_857_600),
  MAX_INLINE_ATTACHMENT_BYTES: IntFromEnv(262_144, 0, 10_485_760),
  MAX_FILE_ATTACHMENT_BYTES: IntFromEnv(10_485_760, 0, 104_857_600),
  FETCH_BATCH_SIZE: IntFromEnv(200, 1, 1000),
});

const WebSchema = z.object({
  /**
   * 校验哈希的形状，而不是只查非空。
   *
   * 处理 .env 的工具普遍会做变量展开（Next 用 dotenv-expand、
   * Compose 自己也插值），值里的 `$xxx` 会被静默替换成空串。
   * 不校验形状的话，被啃坏的哈希会一路走到登录页，
   * 表现成「密码怎么都不对」——那是最难排查的一类故障。
   */
  ADMIN_PASSWORD_HASH: NonEmpty.refine(isValidPasswordHash, {
    message:
      '格式不对，应为 scrypt:N:r:p:salt:hash。如果值里出现过 $，多半是被 .env 的变量展开吃掉了一截，请用 `npm run hash-password` 重新生成',
  }),
  SESSION_SECRET: Key32,
  PUBLIC_BASE_URL: NonEmpty.transform((v) => v.replace(/\/+$/, '')),
  SESSION_TTL_HOURS: IntFromEnv(72, 1, 8760),
  /** Chrome 扩展推送别名使用；空值表示禁用写入 API。 */
  HME_PUSH_TOKEN: z.preprocess(
    (value) => (typeof value === 'string' && !value.trim() ? undefined : value),
    z.string().trim().min(16).optional(),
  ),
  /** turb-gpt-free-register 通用 API 邮箱池；任一项为空时禁用管理页推送。 */
  TURB_GPT_BASE_URL: OptionalHttpUrl.transform((value) => value?.replace(/\/+$/, '')),
  TURB_GPT_AUTH_CODE: OptionalNonEmpty,
});

const TokenSchema = z.object({
  TOKEN_ENC_KEY: Key32,
});

// ── 对外类型与加载器 ───────────────────────────────────────────

export type StorageEnv = z.infer<typeof StorageSchema>;
export type RetentionEnv = z.infer<typeof RetentionSchema>;
export type ImapEnv = z.infer<typeof ImapSchema>;
export type WebEnv = z.infer<typeof WebSchema>;
export type TokenEnv = z.infer<typeof TokenSchema>;

export type WorkerEnv = StorageEnv & RetentionEnv & ImapEnv & TokenEnv;
export type WebAppEnv = StorageEnv & RetentionEnv & WebEnv & TokenEnv;
export type MigrateEnv = StorageEnv;

function parse<T extends z.ZodType>(schema: T, source: NodeJS.ProcessEnv, who: string): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => {
      const key = i.path.join('.') || '(根)';
      return `  ${key}: ${i.message}`;
    });
    throw new Error(`${who} 的环境变量校验失败：\n${lines.join('\n')}\n\n参考 .env.example。`);
  }
  return result.data;
}

export function loadWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  return parse(
    StorageSchema.and(RetentionSchema).and(ImapSchema).and(TokenSchema),
    source,
    'worker',
  );
}

export function loadWebEnv(source: NodeJS.ProcessEnv = process.env): WebAppEnv {
  return parse(StorageSchema.and(RetentionSchema).and(WebSchema).and(TokenSchema), source, 'web');
}

export function loadMigrateEnv(source: NodeJS.ProcessEnv = process.env): MigrateEnv {
  return parse(StorageSchema, source, 'migrate');
}

/**
 * web 侧的单例。Next.js 每个请求都读它，不必反复校验。
 * 校验失败会在首次访问时抛出，Next 会把它显示成启动错误。
 */
let cachedWebEnv: WebAppEnv | undefined;
export function webEnv(): WebAppEnv {
  cachedWebEnv ??= loadWebEnv();
  return cachedWebEnv;
}
