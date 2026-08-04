import { redirect } from 'next/navigation';
import { cookies, headers } from 'next/headers';
import { webEnv } from '../../lib/config/env.ts';
import { verifyPassword, isRateLimited, recordFailure, clearFailures } from '../../lib/auth/password.ts';
import { startSession, cookieOptions, SESSION_COOKIE, requireSession } from '../../lib/auth/session.ts';

export const dynamic = 'force-dynamic';

async function login(formData: FormData): Promise<void> {
  'use server';

  const password = String(formData.get('password') ?? '');
  const next = String(formData.get('next') ?? '/admin');
  const headerList = await headers();
  const ip = headerList.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';

  if (isRateLimited(ip)) {
    redirect('/login?error=rate_limited');
  }

  const env = webEnv();
  if (!verifyPassword(password, env.ADMIN_PASSWORD_HASH)) {
    recordFailure(ip);
    redirect('/login?error=bad_password');
  }

  clearFailures(ip);
  const session = startSession({ userAgent: headerList.get('user-agent'), ip });
  const store = await cookies();
  store.set(SESSION_COOKIE, session.id, cookieOptions(session.expiresAt));

  // 只允许跳回站内路径，防开放重定向
  redirect(next.startsWith('/admin') ? next : '/admin');
}

const ERRORS: Record<string, string> = {
  bad_password: '密码不正确。',
  rate_limited: '尝试次数过多，请 5 分钟后再试。',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  // 已登录就直接进后台，不让用户对着登录页发呆
  if (await requireSession()) redirect('/admin');

  const params = await searchParams;
  const error = params.error ? ERRORS[params.error] : null;

  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-10">
          <p className="mb-2 font-mono text-[11px] tracking-[0.18em] text-muted uppercase">
            iCloud Hide My Email
          </p>
          <h1 className="text-4xl font-semibold tracking-tight">分拣间</h1>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            所有别名的来信汇进一个收件箱，这里按地址把它们分回各自的格口。
          </p>
        </div>

        <form action={login} className="space-y-4">
          <input type="hidden" name="next" value={params.next ?? '/admin'} />
          <div>
            <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-ink-soft">
              管理员密码
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              autoFocus
              required
              className="w-full rounded border border-rule bg-floor-raised px-3 py-2.5 font-mono text-sm outline-none transition-colors focus:border-transit"
            />
          </div>

          {error && (
            <p className="rounded border border-alert/30 bg-alert-soft px-3 py-2 text-sm text-alert">
              {error}
            </p>
          )}

          <button
            type="submit"
            className="w-full rounded bg-transit px-4 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90"
          >
            进入
          </button>
        </form>
      </div>
    </main>
  );
}
