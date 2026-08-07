/** Chrome 扩展推送新隐藏邮箱。 */
import { getDb } from '../../../lib/db/connection.ts';
import { webEnv } from '../../../lib/config/env.ts';
import { createPushAliasesHandler } from '../../../lib/api/pushAliases.ts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const env = webEnv();
  return createPushAliasesHandler({
    db: getDb(),
    pushToken: env.HME_PUSH_TOKEN,
    tokenEncKey: env.TOKEN_ENC_KEY,
  })(request);
}
