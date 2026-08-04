/**
 * 管理会话。
 *
 * 会话 ID 存数据库而非签名 JWT，理由是要能**立即注销** ——
 * 单管理员系统里，"我怀疑密码泄露了"时能一键踢掉所有会话比无状态更重要。
 */
import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { getDb } from '../db/connection.ts';
import { withWriteTx } from '../db/driver.ts';
import { webEnv } from '../config/env.ts';
import * as miscRepo from '../repositories/misc.repo.ts';

export const SESSION_COOKIE = 'hme_session';

export function createSessionId(): string {
  return randomBytes(32).toString('hex');
}

export interface SessionContext {
  userAgent: string | null;
  ip: string | null;
}

export function startSession(context: SessionContext): { id: string; expiresAt: Date } {
  const env = webEnv();
  const id = createSessionId();
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_HOURS * 3_600_000);
  withWriteTx(getDb(), (tx) =>
    miscRepo.createSession(tx, id, expiresAt.toISOString(), context.userAgent, context.ip),
  );
  return { id, expiresAt };
}

/**
 * 校验当前请求的会话。
 *
 * **必须在 Node runtime 里调用。** middleware 跑在 Edge runtime，
 * 读不到 SQLite —— 那里只能做 cookie 存在性粗筛，真正的校验在这里。
 * 漏掉这一层的话，伪造任意 cookie 值就能进后台。
 */
export async function requireSession(): Promise<string | null> {
  const store = await cookies();
  const id = store.get(SESSION_COOKIE)?.value;
  if (!id) return null;

  const db = getDb();
  const session = miscRepo.findValidSession(db, id);
  if (!session) return null;

  try {
    withWriteTx(db, (tx) => miscRepo.touchSession(tx, id));
  } catch {
    // 更新 last_seen 失败不该导致鉴权失败
  }
  return id;
}

export async function endSession(): Promise<void> {
  const store = await cookies();
  const id = store.get(SESSION_COOKIE)?.value;
  if (id) {
    withWriteTx(getDb(), (tx) => miscRepo.deleteSession(tx, id));
  }
  store.delete(SESSION_COOKIE);
}

export function cookieOptions(expiresAt: Date): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  expires: Date;
} {
  return {
    httpOnly: true,
    // 生产环境走 HTTPS；本地 http 开发时不能强制 secure，否则 cookie 根本不会被设置
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  };
}
