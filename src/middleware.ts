/**
 * 中间件**只做 cookie 存在性粗筛**。
 *
 * 它跑在 Edge runtime，读不到 SQLite，所以无法真正校验会话。
 * 真实校验必须在 Node runtime 的 layout / route handler 里做
 * （src/lib/auth/session.ts 的 requireSession）。
 *
 * 把这层误当成鉴权，是这类项目里最常见的安全漏洞：
 * 伪造一个任意值的 cookie 就能通过 middleware。
 */
import { NextResponse } from 'next/server';

export function middleware(request: Request): Response {
  const url = new URL(request.url);
  const hasCookie = request.headers.get('cookie')?.includes('hme_session=');

  if (!hasCookie) {
    const login = new URL('/login', url);
    login.searchParams.set('next', url.pathname);
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*'],
};
