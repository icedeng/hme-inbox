import { redirect } from 'next/navigation';
import { requireSession } from './session.ts';
import { createAdminPageGuard } from './admin.ts';

export const requireAdminPage = createAdminPageGuard({ requireSession, redirect });
