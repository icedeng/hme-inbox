import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireSession } from '../../lib/auth/session.ts';
import { logoutAction } from './actions.ts';

export const dynamic = 'force-dynamic';

const NAV = [
  { href: '/admin', label: '概览' },
  { href: '/admin/aliases', label: '收件地址' },
  { href: '/admin/unmatched', label: '未归属' },
  { href: '/admin/import', label: '导入' },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // 真正的会话校验在这里（Node runtime，能读数据库）。
  // middleware 那层只判断 cookie 存不存在，挡不住伪造。
  if (!(await requireSession())) redirect('/login');

  return (
    <div className="min-h-dvh">
      <header className="border-b border-rule bg-floor-raised">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-5 py-3.5">
          <Link href="/admin" className="flex items-baseline gap-2.5">
            <span className="font-display text-lg font-semibold tracking-tight">分拣间</span>
            <span className="font-mono text-[10px] tracking-[0.16em] text-muted uppercase">HME</span>
          </Link>

          <nav className="flex items-center gap-1">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded px-2.5 py-1.5 text-sm text-ink-soft transition-colors hover:bg-transit-soft hover:text-transit"
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <form action={logoutAction} className="ml-auto">
            <button
              type="submit"
              className="rounded px-2.5 py-1.5 text-sm text-muted transition-colors hover:text-ink"
            >
              退出
            </button>
          </form>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-5 py-8">{children}</main>
    </div>
  );
}
