/**
 * 别名查找索引。
 *
 * 规模只有几十到几千条，全量驻留内存即可 —— 不必上 Aho-Corasick，
 * 一个 Map 加一次线性扫描就够，而且逻辑简单得多、不会出错。
 */
import type { AliasIndexRow } from '../repositories/aliases.repo.ts';
import { normalizeAddress } from '../email/address.ts';

export interface AliasEntry {
  id: number;
  normalized: string;
  status: 'active' | 'disabled';
}

export interface AliasIndex {
  /** 精确查找。 */
  lookup(normalized: string): AliasEntry | undefined;
  /** 在任意文本里找出所有出现的别名。用于原始头扫描与正文扫描。 */
  scan(text: string): AliasEntry[];
  readonly size: number;
  readonly entries: readonly AliasEntry[];
}

export function buildAliasIndex(rows: AliasIndexRow[]): AliasIndex {
  const byNormalized = new Map<string, AliasEntry>();
  const entries: AliasEntry[] = [];

  for (const row of rows) {
    const entry: AliasEntry = {
      id: row.id,
      normalized: row.emailNormalized,
      status: row.status,
    };
    byNormalized.set(entry.normalized, entry);
    entries.push(entry);
  }

  return {
    size: entries.length,
    entries,

    lookup(normalized) {
      return byNormalized.get(normalized);
    },

    /**
     * 用**已知别名集合**去文本里找，而不是用通用 email 正则去猜。
     *
     * 通用正则会把发件人地址、正文里的客服邮箱、退订链接里的地址
     * 统统当成候选，误报率极高。已知集合匹配是零误报的。
     *
     * 匹配完整地址而非仅 local-part：实测 Return-path 里以 VERP 形式
     * 带了别名（`cobalt-alibi-1g=icloud.com`，`=` 而非 `@`），
     * 只匹配 local-part 会把它当成命中。
     */
    scan(text) {
      if (!text) return [];
      const haystack = text.toLowerCase();
      const found: AliasEntry[] = [];
      for (const entry of entries) {
        if (haystack.includes(entry.normalized)) found.push(entry);
      }
      return found;
    },
  };
}

/** 从任意地址串查索引，先试完整（含 plus 标签）再试截断。 */
export function lookupAddress(index: AliasIndex, raw: string): AliasEntry | undefined {
  const addr = normalizeAddress(raw);
  if (!addr) return undefined;
  return index.lookup(addr.fullNormalized) ?? index.lookup(addr.normalized);
}
