/**
 * 别名归属规则表。**纯数据，不含逻辑。**
 *
 * 做成数据而非代码，是因为苹果随时可能改转发实现。真到那天，
 * 运维应该能靠改一个环境变量恢复归属，而不是等一次发版。
 *
 * 层级顺序来自 Phase 0 实测（5 封真实转发信）：
 *   X-ICLOUD-HME 的 p= 字段 100% 命中，且 BCC 场景下仍在 → L1
 *   To 头 100% 命中，但 BCC 投递时会失效        → L2
 * 实测同时否掉了两条原本以为可用的信号，见 SCAN_EXCLUDED_HEADERS 的注释。
 */

export type MatchLayer =
  | 'header:icloud-hme'
  | 'header:to'
  | 'header:cc'
  | 'header:configured'
  | 'header:bcc'
  | 'raw_header_scan'
  | 'body_scan';

export interface MatchRules {
  /** 结构化头：解析后取指定字段。 */
  structuredHeader: {
    name: string;
    field: 'pseudonym';
    layer: MatchLayer;
    confidence: number;
  };
  /** 按地址列表解析的头，按顺序尝试。 */
  addressHeaders: Array<{
    name: string;
    layer: MatchLayer;
    confidence: number;
  }>;
  /** 额外要试的头名。实测发现新头名时加进这里即可，不必改代码。 */
  configuredHeaders: string[];
  configuredConfidence: number;
  /** 原始头块全文扫描。 */
  rawScanConfidence: number;
  /** 正文扫描。 */
  bodyScanConfidence: number;
  /** 是否启用正文扫描（误报风险最高的一层）。 */
  bodyScanEnabled: boolean;
}

export const DEFAULT_RULES: MatchRules = {
  structuredHeader: {
    name: 'X-ICLOUD-HME',
    field: 'pseudonym',
    layer: 'header:icloud-hme',
    confidence: 1.0,
  },
  addressHeaders: [
    { name: 'To', layer: 'header:to', confidence: 0.95 },
    { name: 'Cc', layer: 'header:cc', confidence: 0.9 },
    { name: 'Bcc', layer: 'header:bcc', confidence: 0.6 },
    { name: 'Resent-To', layer: 'header:bcc', confidence: 0.6 },
    { name: 'Resent-Cc', layer: 'header:bcc', confidence: 0.6 },
  ],
  // 这几个是其他 MTA 的常见约定。苹果实测都没有，留着是为了兜住
  // 「将来换转发实现」或「用户把 HME 转发到了第三方邮箱再转进来」。
  configuredHeaders: ['Delivered-To', 'X-Original-To', 'X-Forwarded-To', 'Envelope-To', 'X-Delivered-To'],
  configuredConfidence: 0.85,
  rawScanConfidence: 0.5,
  bodyScanConfidence: 0.3,
  bodyScanEnabled: true,
};

/**
 * 用环境变量覆盖规则。
 *
 * HME_MATCH_EXTRA_HEADERS  逗号分隔，追加到 configuredHeaders
 * HME_MATCH_BODY_SCAN      设为 "0" 关闭正文扫描
 */
export function rulesFromEnv(source: NodeJS.ProcessEnv = process.env): MatchRules {
  const extra = (source.HME_MATCH_EXTRA_HEADERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    ...DEFAULT_RULES,
    configuredHeaders: [...new Set([...DEFAULT_RULES.configuredHeaders, ...extra])],
    bodyScanEnabled: source.HME_MATCH_BODY_SCAN !== '0',
  };
}
