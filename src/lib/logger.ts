/**
 * 结构化日志。
 *
 * 刻意保持极简：worker 与 web 都只需要「带时间戳的 JSON 行」，
 * 引入 pino 之类的框架换不来什么，反倒多一层配置。
 *
 * 唯一不能省的是脱敏：IMAP 密码与取件 token 一旦进了日志，
 * 日志文件的泄露面就等同于凭证的泄露面。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const REDACT_KEYS = new Set([
  'pass',
  'password',
  'token',
  'tokenCiphertext',
  'secret',
  'authorization',
  'cookie',
  'HME_IMAP_PASS',
  'TOKEN_ENC_KEY',
  'SESSION_SECRET',
  'ADMIN_PASSWORD_HASH',
]);

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[层级过深]';
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `[${value.length} 字节]`;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = REDACT_KEYS.has(k) ? '[已脱敏]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function levelFromEnv(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return raw in LEVEL_ORDER ? (raw as LogLevel) : 'info';
}

export function createLogger(bindings: Record<string, unknown> = {}): Logger {
  const minLevel = LEVEL_ORDER[levelFromEnv()];
  // 开发时人读，生产时机器读
  const pretty = process.env.NODE_ENV !== 'production';

  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[level] < minLevel) return;
    const payload = {
      time: new Date().toISOString(),
      level,
      msg,
      ...(redact(bindings) as Record<string, unknown>),
      ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
    };
    const line = pretty
      ? `${payload.time} ${level.toUpperCase().padEnd(5)} ${msg}${
          fields || Object.keys(bindings).length
            ? ' ' + JSON.stringify({ ...redact(bindings) as object, ...(fields ? redact(fields) as object : {}) })
            : ''
        }`
      : JSON.stringify(payload);

    if (level === 'error' || level === 'warn') console.error(line);
    else console.log(line);
  };

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (extra) => createLogger({ ...bindings, ...extra }),
  };
}

export const logger = createLogger();
