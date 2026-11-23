import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isValid,
  intersects,
  intersection,
  contains,
  subtract,
  splitBy,
  merge,
  gapsWithin,
} from '../src/intervals.mjs';

test('闭区间有效性与相交判定', () => {
  assert.equal(isValid([1, 1]), true);
  assert.equal(isValid([2, 1]), false);
  assert.equal(intersects([1, 3], [3, 5]), true); // 端点相接也算相交
  assert.equal(intersects([1, 2], [3, 5]), false);
  assert.deepEqual(intersection([1, 5], [4, 8]), [4, 5]);
  assert.equal(intersection([1, 2], [3, 5]), null);
  assert.equal(contains([1, 10], [4, 7]), true);
  assert.equal(contains([1, 5], [5, 6]), false);
});

test('subtract 处理左留、右留和穿透三种切法', () => {
  assert.deepEqual(subtract([100, 129], [114, 123]), [
    [100, 113],
    [124, 129],
  ]);
  assert.deepEqual(subtract([100, 129], [100, 113]), [[114, 129]]);
  assert.deepEqual(subtract([100, 129], [100, 129]), []);
  assert.deepEqual(subtract([100, 105], [120, 130]), [[100, 105]]);
});

test('splitBy 按切刀边界把区间切成连续不重叠小段', () => {
  const pieces = splitBy([100, 129], [
    [114, 123],
    [124, 126],
  ]);
  assert.deepEqual(pieces, [
    [100, 113],
    [114, 123],
    [124, 126],
    [127, 129],
  ]);
  assert.deepEqual(splitBy([1, 3], [[1, 1], [3, 3]]), [
    [1, 1],
    [2, 2],
    [3, 3],
  ]);
});

test('merge 合并相邻区间，gapsWithin 报告未覆盖部分', () => {
  assert.deepEqual(
    merge([
      [100, 113],
      [114, 123],
      [130, 140],
    ]),
    [
      [100, 123],
      [130, 140],
    ],
  );
  assert.deepEqual(gapsWithin([100, 129], [[114, 123]]), [
    [100, 113],
    [124, 129],
  ]);
  assert.deepEqual(gapsWithin([1, 10], [[1, 10]]), []);
});
