import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyNumber, splitByAttribution } from '../src/attribution.mjs';
import { evaluateDetail, sumPerNumber } from '../src/details.mjs';

const confirmed = { generation: 'G', from: 'R1', to: 'R2', cut: 117, state: 'confirmed' };
const proposed = { generation: 'G', from: 'R1', to: 'R2', cut: 117, state: 'proposed', stableThrough: 113 };

test('confirmed 交接以 cut 为新网点首个凭据号', () => {
  assert.equal(classifyNumber(confirmed, 116).station, 'R1');
  assert.equal(classifyNumber(confirmed, 117).station, 'R2');
  assert.equal(classifyNumber({ state: 'single', from: 'R3' }, 999).station, 'R3');
});

test('proposed 交接中间号段归属未定，不得先分配', () => {
  assert.equal(classifyNumber(proposed, 113).station, 'R1');
  assert.equal(classifyNumber(proposed, 114).station, null);
  assert.equal(classifyNumber(proposed, 116).station, null);
  assert.equal(classifyNumber(proposed, 117).station, 'R2');
});

test('归属切分把区间切成可分配与待核连续小段', () => {
  const pieces = splitByAttribution({ interval: [110, 120] }, proposed);
  assert.deepEqual(
    pieces.map(p => [p.interval, p.station]),
    [
      [[110, 113], 'R1'],
      [[114, 116], null],
      [[117, 120], 'R2'],
    ],
  );
});

test('撤销只对同世代同覆盖内的原号生效，冲补在撤销后追加', () => {
  const document = {
    id: 'D1',
    generation: 'G',
    coverage: [114, 117],
    rows: [
      { n: 114, type: 'sale', amountFen: 7790 },
      { n: 115, type: 'sale', amountFen: 8200 },
      { n: 116, type: 'sale', amountFen: 8610 },
      { n: 117, type: 'sale', amountFen: 9020 },
      { n: 500, type: 'void', statement: 'BAD', target: 999 }, // 目标在覆盖外：不生效
      { n: 501, type: 'void', statement: 'C91', target: 116 },
      { n: 502, type: 'adjustment', statement: 'C92', target: 117, amountFen: -300 },
      { n: 501, type: 'void', statement: 'C91', target: 116 }, // 重复行不改变事实
    ],
  };
  const result = evaluateDetail(document, { generation: 'G', observedAt: 1, sourceId: 'D1' });
  assert.equal(result.perNumber.get(116).netFen, 0);
  assert.equal(result.perNumber.get(117).netFen, 8720);
  assert.equal(result.anomalies.some(a => a.code === 'TARGET_OUTSIDE_GENERATION'), true);
  // 覆盖内每个号都有 sale，无缺号
  assert.equal(result.anomalies.some(a => a.code === 'DETAIL_HAS_GAPS'), false);
  assert.equal(sumPerNumber(result.perNumber, [114, 117]), 7790 + 8200 + 0 + 8720);
});

test('覆盖内缺号显式报异常且不能按零额求和', () => {
  const document = {
    id: 'D2',
    generation: 'G',
    coverage: [124, 126],
    rows: [
      { n: 124, type: 'sale', amountFen: 100 },
      { n: 126, type: 'sale', amountFen: 300 },
    ],
  };
  const result = evaluateDetail(document, { generation: 'G', observedAt: 1, sourceId: 'D2' });
  const gap = result.anomalies.find(a => a.code === 'DETAIL_HAS_GAPS');
  assert.deepEqual(gap.missing, [125]);
  assert.equal(sumPerNumber(result.perNumber, [124, 126]), null);
});
