/** turb-gpt-free-register 通用 API 邮箱池 HTTP 客户端。 */

export interface TurbEmailPoolConfig {
  baseUrl: string;
  authCode: string;
}

export interface TurbEmailEntry {
  email: string;
  pickupUrl: string;
}

export interface TurbImportResult {
  parsed: number;
  inserted: number;
  skipped: number;
}

export type TurbEmailPoolErrorCode =
  | 'unauthorized'
  | 'remote_error'
  | 'invalid_response'
  | 'network_error';

export class TurbEmailPoolError extends Error {
  readonly code: TurbEmailPoolErrorCode;

  constructor(code: TurbEmailPoolErrorCode, message: string) {
    super(message);
    this.name = 'TurbEmailPoolError';
    this.code = code;
  }
}

function isCount(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

export async function importGenericApiEmails(
  config: TurbEmailPoolConfig,
  entries: TurbEmailEntry[],
  fetchImpl: typeof fetch = fetch,
): Promise<TurbImportResult> {
  if (entries.length === 0) return { parsed: 0, inserted: 0, skipped: 0 };

  let response: Response;
  try {
    response = await fetchImpl(`${config.baseUrl}/api/outlook/import`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.authCode}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        source: 'generic_api',
        as_registered: false,
        text: entries.map((entry) => `${entry.email}----${entry.pickupUrl}`).join('\n'),
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new TurbEmailPoolError('network_error', '无法连接 turb 邮箱池服务。');
  }

  if (response.status === 401 || response.status === 403) {
    throw new TurbEmailPoolError('unauthorized', 'turb 邮箱池鉴权失败，请检查配置。');
  }
  if (!response.ok) {
    throw new TurbEmailPoolError(
      'remote_error',
      `turb 邮箱池服务返回 HTTP ${response.status}。`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new TurbEmailPoolError('invalid_response', 'turb 邮箱池返回了无法解析的响应。');
  }

  if (
    typeof payload !== 'object' ||
    payload === null ||
    !isCount((payload as Record<string, unknown>).parsed) ||
    !isCount((payload as Record<string, unknown>).inserted) ||
    !isCount((payload as Record<string, unknown>).skipped)
  ) {
    throw new TurbEmailPoolError('invalid_response', 'turb 邮箱池返回的数据格式不正确。');
  }

  const result = payload as Record<string, number>;
  return {
    parsed: result.parsed!,
    inserted: result.inserted!,
    skipped: result.skipped!,
  };
}
