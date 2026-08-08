import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAliasPoolPushMode,
  setAliasPoolPushMode,
} from '../src/lib/browser/aliasPoolPushMode.ts';

describe('邮箱池推送模式', () => {
  test('只接受显式的 all 或 selected，缺失值不能静默变成空选中推送', () => {
    assert.equal(parseAliasPoolPushMode('all'), 'all');
    assert.equal(parseAliasPoolPushMode('selected'), 'selected');
    assert.equal(parseAliasPoolPushMode(null), null);
    assert.equal(parseAliasPoolPushMode(''), null);
    assert.equal(parseAliasPoolPushMode('unexpected'), null);
  });

  test('按钮点击可以把显式模式写入隐藏表单字段', () => {
    const field = { value: 'selected' };
    setAliasPoolPushMode(field, 'all');
    assert.equal(field.value, 'all');
  });
});
