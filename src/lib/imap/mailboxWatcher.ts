/**
 * 单个邮箱的监视器：一条 IMAP 连接 + IDLE + 兜底轮询。
 *
 * 为什么每个邮箱一条连接：imapflow 的一条连接同时只能锁一个邮箱，
 * IDLE 也只对当前选中的邮箱生效。而验证码邮件被判进 Junk 是常态，
 * 只盯 INBOX 会静默漏信 —— 这是 Phase 0 实测后加上的。
 */
import { ImapFlow, type FetchMessageObject } from 'imapflow';
import { AsyncMutex, sleep, backoffDelay } from '../util/async.ts';
import type { Logger } from '../logger.ts';

export interface WatcherConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  mailbox: string;
  /** 只收此时间点之后的信。 */
  syncSince: Date;
  pollIntervalMs: number;
  /** IDLE 主动刷新周期。RFC 2177 建议不超过 29 分钟。 */
  idleRefreshMs: number;
  fetchBatchSize: number;
}

export interface FetchedMessage {
  uid: number;
  uidvalidity: number;
  internalDate: Date;
  raw: Buffer;
}

export interface WatcherCallbacks {
  /** 返回已成功入库的条数，用于统计。 */
  onMessages(messages: FetchedMessage[]): Promise<number>;
  onStateChange(state: 'connecting' | 'authenticated' | 'idling' | 'syncing' | 'error' | 'disconnected', detail?: string): void;
  /** UIDVALIDITY 变化：旧 UID 全部作废，需要重置游标。 */
  onUidValidityChange(previous: number | null, current: number): void;
  /** 读取当前游标。返回 0 表示尚未同步过，走 syncSince 全量搜索。 */
  getLastSeenUid(): number;
  advanceUid(uid: number): void;
  /**
   * 认证失败。**必须停止重试** —— 反复用错误凭证登录会触发苹果的
   * 账号保护，把整个 Apple ID 锁掉，那比收不到信严重得多。
   */
  onFatalAuthFailure(error: Error): void;
  onReconnect(): void;
}

export interface MailboxWatcher {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** 手动触发一次同步（后台的「立即检查」按钮）。 */
  syncNow(): Promise<void>;
  readonly mailbox: string;
}

function isAuthFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const text = `${err.message} ${(err as { responseText?: string }).responseText ?? ''}`;
  return /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed|authentication failed/i.test(text);
}

export function createMailboxWatcher(
  config: WatcherConfig,
  callbacks: WatcherCallbacks,
  logger: Logger,
): MailboxWatcher {
  const log = logger.child({ mailbox: config.mailbox });
  const mutex = new AsyncMutex();

  let client: ImapFlow | null = null;
  let stopped = false;
  let pollTimer: NodeJS.Timeout | null = null;
  let currentUidValidity: number | null = null;
  let running: Promise<void> | null = null;

  function makeClient(): ImapFlow {
    return new ImapFlow({
      host: config.host,
      port: config.port,
      secure: true,
      auth: { user: config.user, pass: config.pass },
      logger: false,
      // imapflow 会在超过这个时长后自动重启 IDLE。
      // 设成 25 分钟（< RFC 2177 建议的 29 分钟），防 NAT/防火墙静默掐连接。
      maxIdleTime: config.idleRefreshMs,
      socketTimeout: Math.max(config.idleRefreshMs + 60_000, 300_000),
      greetingTimeout: 20_000,
      connectionTimeout: 20_000,
      // 连接复用会话时不要求 CONDSTORE/QRESYNC，我们自己管游标
      qresync: false,
    });
  }

  /**
   * 抓取新邮件。
   *
   * 走 mutex：IDLE 的 exists 事件与兜底轮询都会调它，
   * 并发跑会对同一批 UID 重复拉取，也会让游标推进出现竞态。
   */
  async function sync(): Promise<void> {
    if (stopped || !client || !client.usable) return;

    await mutex.run(async () => {
      if (stopped || !client || !client.usable) return;
      callbacks.onStateChange('syncing');

      const lastSeen = callbacks.getLastSeenUid();
      const found = lastSeen > 0
        ? // 有游标：直接按 UID 区间取增量
          await client.search({ uid: `${lastSeen + 1}:*` }, { uid: true })
        : // 首次同步：按日期搜索。IMAP 的 SEARCH SINCE 只有**日期**粒度
          // 且按服务器时区判断，所以往前多退一天，再在应用层按精确时间过滤。
          await client.search({ since: new Date(config.syncSince.getTime() - 86_400_000) }, { uid: true });

      // imapflow 在邮箱未打开或搜索失败时返回 false。绝不能把它当成
      // 「没有新邮件」—— 那会让故障表现为静默漏信，是最难排查的一类问题。
      if (found === false) {
        throw new Error('IMAP SEARCH 失败（邮箱可能未正确打开）');
      }
      const uids: number[] = found;

      if (uids.length === 0) {
        callbacks.onStateChange('idling');
        return;
      }

      // 单轮上限，防一次拉几千封把内存打爆；剩下的下一轮继续
      const batch = uids.sort((a, b) => a - b).slice(0, config.fetchBatchSize);
      log.info('发现新邮件', { count: batch.length, total: uids.length });

      const collected: FetchedMessage[] = [];
      for await (const msg of client.fetch(
        batch.join(','),
        { source: true, uid: true, internalDate: true },
        { uid: true },
      )) {
        const m = msg as FetchMessageObject;
        if (!m.source) continue;

        const internalDate = normalizeInternalDate(m.internalDate);
        // 应用层精确过滤：补上 SEARCH SINCE 的日期粒度缺口
        if (internalDate.getTime() < config.syncSince.getTime()) {
          callbacks.advanceUid(m.uid);
          continue;
        }
        collected.push({
          uid: m.uid,
          uidvalidity: currentUidValidity ?? 0,
          internalDate,
          raw: Buffer.isBuffer(m.source) ? m.source : Buffer.from(m.source),
        });
      }

      if (collected.length > 0) {
        await callbacks.onMessages(collected);
        for (const m of collected) callbacks.advanceUid(m.uid);
      }
      // 空跳过的也要推进游标，否则每轮都会重新扫到它们
      const maxUid = Math.max(...batch);
      if (Number.isFinite(maxUid)) callbacks.advanceUid(maxUid);

      callbacks.onStateChange('idling');
    });
  }

  async function connectOnce(): Promise<void> {
    const c = makeClient();
    client = c;

    c.on('error', (err: Error) => {
      log.warn('IMAP 连接报错', { error: err.message });
    });
    c.on('close', () => {
      log.debug('IMAP 连接已关闭');
    });

    callbacks.onStateChange('connecting');
    await c.connect();
    callbacks.onStateChange('authenticated');

    const lock = await c.getMailboxLock(config.mailbox);
    try {
      const mailbox = c.mailbox;
      if (typeof mailbox === 'boolean') throw new Error(`打开邮箱失败：${config.mailbox}`);

      const uidValidity = Number(mailbox.uidValidity);
      if (currentUidValidity !== null && currentUidValidity !== uidValidity) {
        log.warn('UIDVALIDITY 变化，游标作废', {
          previous: currentUidValidity,
          current: uidValidity,
        });
      }
      callbacks.onUidValidityChange(currentUidValidity, uidValidity);
      currentUidValidity = uidValidity;

      // 新邮件到达。fetch 会自动打断 IDLE，imapflow 处理完再自行恢复。
      c.on('exists', () => {
        void sync().catch((err: unknown) => {
          log.warn('IDLE 触发的同步失败', { error: err instanceof Error ? err.message : err });
        });
      });

      // 连上先补一次：IDLE 只通知「之后」到的信，断线期间的要靠这次补齐
      await sync();

      // 兜底轮询。IDLE 可能因 NAT 静默掐连接而失效却不报错，
      // 这个定时器是最后一道保险。
      pollTimer = setInterval(() => {
        void sync().catch((err: unknown) => {
          log.warn('轮询同步失败', { error: err instanceof Error ? err.message : err });
        });
      }, config.pollIntervalMs);

      callbacks.onStateChange('idling');
      // idle() 在连接关闭或 maxIdleTime 到期时返回，外层循环负责重进
      while (!stopped && c.usable) {
        await c.idle();
      }
    } finally {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      lock.release();
    }
  }

  async function loop(): Promise<void> {
    let attempt = 0;
    while (!stopped) {
      try {
        await connectOnce();
        attempt = 0; // 成功连过就重置退避
      } catch (err) {
        if (isAuthFailure(err)) {
          // 停止重试。继续拿错误凭证登录会触发苹果的账号保护。
          const error = err instanceof Error ? err : new Error(String(err));
          log.error('IMAP 认证失败，停止重试', { error: error.message });
          callbacks.onStateChange('error', `认证失败：${error.message}`);
          callbacks.onFatalAuthFailure(error);
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        log.warn('连接中断', { error: message, attempt });
        callbacks.onStateChange('error', message);
      } finally {
        try {
          await client?.logout();
        } catch {
          // 连接已经断了，logout 失败无所谓
        }
        client = null;
      }

      if (stopped) break;
      const delay = backoffDelay(attempt++);
      callbacks.onReconnect();
      log.info('准备重连', { delayMs: delay });
      try {
        await sleep(delay);
      } catch {
        break;
      }
    }
    callbacks.onStateChange('disconnected');
  }

  return {
    mailbox: config.mailbox,

    async start() {
      stopped = false;
      running = loop();
      // 不 await：loop 会一直跑到 stop() 为止
      running.catch((err: unknown) => {
        log.error('监视器异常退出', { error: err instanceof Error ? err.message : err });
      });
      // 给首次连接一点时间，让启动日志顺序更可读
      await sleep(0);
    },

    async stop() {
      stopped = true;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      try {
        await client?.logout();
      } catch {
        /* 关停路径上的失败无需处理 */
      }
      client = null;
      await running?.catch(() => undefined);
    },

    async syncNow() {
      await sync();
    },
  };
}

/**
 * INTERNALDATE 是排序与保留期的基准，缺失时不能静默当成 now ——
 * 那会把一封老信当成刚到的，排到列表最前面。落成 epoch 0 让异常显眼。
 */
function normalizeInternalDate(value: Date | string | undefined): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(0);
}
