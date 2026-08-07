'use server';

import { redirect } from 'next/navigation';
import { requireSession } from '../../../lib/auth/session.ts';
import { webEnv } from '../../../lib/config/env.ts';
import { getDb } from '../../../lib/db/connection.ts';
import {
  TurbEmailPoolError,
  type TurbEmailPoolErrorCode,
} from '../../../lib/turb/emailPoolClient.ts';
import { pushAliasesToPool } from '../../../lib/turb/pushAliasesToPool.ts';

function returnParams(formData: FormData): URLSearchParams {
  const params = new URLSearchParams();
  const q = formData.get('q');
  const status = formData.get('status');
  if (typeof q === 'string' && q.trim()) params.set('q', q.trim().slice(0, 200));
  if (status === 'active' || status === 'disabled') params.set('status', status);
  return params;
}

function target(params: URLSearchParams): string {
  const query = params.toString();
  return query ? `/admin/aliases?${query}` : '/admin/aliases';
}

export async function pushAliasesToPoolAction(formData: FormData): Promise<void> {
  if (!(await requireSession())) redirect('/login');

  const params = returnParams(formData);
  const env = webEnv();
  if (!env.TURB_GPT_BASE_URL || !env.TURB_GPT_AUTH_CODE) {
    params.set('poolPush', 'unconfigured');
    redirect(target(params));
  }

  const mode = formData.get('pushMode') === 'all' ? 'all' : 'selected';
  const ids = formData
    .getAll('aliasId')
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);

  try {
    const result = await pushAliasesToPool(
      {
        db: getDb(),
        publicBaseUrl: env.PUBLIC_BASE_URL,
        tokenEncKey: env.TOKEN_ENC_KEY,
        turb: {
          baseUrl: env.TURB_GPT_BASE_URL,
          authCode: env.TURB_GPT_AUTH_CODE,
        },
      },
      { mode, ids },
    );
    params.set('poolPush', 'success');
    params.set('inserted', String(result.inserted));
    params.set('existing', String(result.existing));
    params.set('skippedInactive', String(result.skippedInactive));
    params.set('skippedMissing', String(result.skippedMissing));
  } catch (error) {
    params.set('poolPush', 'error');
    const code: TurbEmailPoolErrorCode | 'invalid_request' =
      error instanceof TurbEmailPoolError ? error.code : 'invalid_request';
    params.set('errorCode', code);
  }

  redirect(target(params));
}
