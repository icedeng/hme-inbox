import { redirect } from 'next/navigation';
import { requireSession } from '../lib/auth/session.ts';

export const dynamic = 'force-dynamic';

export default async function RootPage() {
  redirect((await requireSession()) ? '/admin' : '/login');
}
