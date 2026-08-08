export type AliasPoolPushMode = 'all' | 'selected';

export function parseAliasPoolPushMode(value: unknown): AliasPoolPushMode | null {
  return value === 'all' || value === 'selected' ? value : null;
}

/** 提交按钮位于列表表单外时，显式更新表单里的模式字段。 */
export function setAliasPoolPushMode(
  field: { value: string },
  mode: AliasPoolPushMode,
): void {
  field.value = mode;
}
