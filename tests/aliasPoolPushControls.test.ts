import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { aliasPoolPushButtonState } from '../src/lib/browser/aliasPoolPushControls.ts';

describe('邮箱池推送按钮状态', () => {
  test('未配置时两个按钮都禁用', () => {
    assert.deepEqual(
      aliasPoolPushButtonState({
        configured: false,
        activeCount: 10,
        selectedCount: 2,
        submitting: false,
      }),
      { selectedDisabled: true, allDisabled: true },
    );
  });

  test('已配置时选中按钮依赖选择数，全部按钮依赖启用总数', () => {
    assert.deepEqual(
      aliasPoolPushButtonState({
        configured: true,
        activeCount: 10,
        selectedCount: 0,
        submitting: false,
      }),
      { selectedDisabled: true, allDisabled: false },
    );
    assert.deepEqual(
      aliasPoolPushButtonState({
        configured: true,
        activeCount: 0,
        selectedCount: 2,
        submitting: false,
      }),
      { selectedDisabled: false, allDisabled: true },
    );
  });

  test('提交期间两个按钮都禁用', () => {
    assert.deepEqual(
      aliasPoolPushButtonState({
        configured: true,
        activeCount: 10,
        selectedCount: 2,
        submitting: true,
      }),
      { selectedDisabled: true, allDisabled: true },
    );
  });
});
