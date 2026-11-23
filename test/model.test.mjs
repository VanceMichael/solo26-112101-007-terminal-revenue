import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCoverage } from '../src/model.mjs';

const sha = (() => {
  let counter = 0;
  return () => `sha-${(counter += 1)}`;
})();

const detailDoc = ({ id, generation, coverage, replaces, rows, observedAt }) => ({
  id,
  generation,
  observedAt,
  sha256: sha(),
  interval: coverage,
  coverage,
  replaces,
  document: { id, generation, coverage, rows },
});

const subtotalDoc = ({ id, generation, interval, amountFen, observedAt = 1 }) => ({
  id,
  generation,
  observedAt,
  sha256: sha(),
  interval,
  sealed: true,
  amountFen,
});

const transferProposed = [
  { generation: 'G-41', from: 'R1', to: 'R2', cut: 117, state: 'proposed', stableThrough: 113 },
  { generation: 'G-42', from: 'R3', state: 'single' },
];
const transferConfirmed = [
  { generation: 'G-41', from: 'R1', to: 'R2', cut: 117, state: 'confirmed' },
  { generation: 'G-42', from: 'R3', state: 'single' },
];

test('proposed 阶段：跨交接边界的封存小计整段不可计入正式金额', () => {
  const coverage = buildCoverage({
    detailDocs: [],
    subtotalDocs: [subtotalDoc({ id: 'SUM-4', generation: 'G-41', interval: [100, 129], amountFen: 182500 })],
    reviewCases: [],
    transferList: transferProposed,
    now: 130,
  });
  const g41 = coverage.generations.find(g => g.generation === 'G-41');
  const statuses = g41.segments.map(s => s.status);
  assert.ok(statuses.includes('pending-attribution'));
  assert.equal(g41.formalAmountFen, 0);
  // 单网点世代的整段小计可以由小计证明并计入
  const g42 = buildCoverage({
    detailDocs: [],
    subtotalDocs: [subtotalDoc({ id: 'SUM-5', generation: 'G-42', interval: [100, 110], amountFen: 49500 })],
    reviewCases: [],
    transferList: transferProposed,
    now: 130,
  }).generations.find(g => g.generation === 'G-42');
  assert.equal(g42.formalAmountFen, 49500);
  assert.equal(g42.segments[0].evidenceKind, 'subtotal');
});

test('confirmed 后明细按交接号归属，撤销与冲补折算净额', () => {
  const detail = detailDoc({
    id: 'DET-7b',
    generation: 'G-41',
    coverage: [114, 123],
    replaces: [114, 123],
    observedAt: 138,
    rows: [
      ...[114, 115, 116, 117, 118, 119, 120, 121, 122, 123].map(n => ({
        n,
        type: 'sale',
        amountFen: 1000 + (n - 114) * 10,
      })),
      { n: 900, type: 'void', statement: 'C90', target: 116 },
      { n: 901, type: 'adjustment', statement: 'C91', target: 117, amountFen: -300 },
    ],
  });
  const coverage = buildCoverage({
    detailDocs: [detail],
    subtotalDocs: [],
    reviewCases: [],
    transferList: transferConfirmed,
    now: 138,
  });
  const g41 = coverage.generations.find(g => g.generation === 'G-41');
  const r1 = g41.segments.find(s => s.station === 'R1');
  const r2 = g41.segments.find(s => s.station === 'R2');
  assert.deepEqual(r1.interval, [114, 116]);
  assert.deepEqual(r2.interval, [117, 123]);
  // 114=1000、115=1010，116 被撤销归零 → R1=2010
  assert.equal(r1.amountFen, 2010);
  // 117=1030-300=730；118..123 = 1040..1090
  const expectedR2 = 730 + [1040, 1050, 1060, 1070, 1080, 1090].reduce((a, b) => a + b, 0);
  assert.equal(r2.amountFen, expectedR2);
  assert.equal(g41.formalByStation.R1 + g41.formalByStation.R2, g41.formalAmountFen);
});

test('同 replaces 重传：旧明细留痕但定值只采用最新报文', () => {
  const oldDoc = detailDoc({
    id: 'DET-7',
    generation: 'G-41',
    coverage: [114, 115],
    replaces: [114, 115],
    observedAt: 134,
    rows: [
      { n: 114, type: 'sale', amountFen: 7790 },
      { n: 115, type: 'sale', amountFen: 8200 },
    ],
  });
  const newDoc = detailDoc({
    id: 'DET-7b',
    generation: 'G-41',
    coverage: [114, 115],
    replaces: [114, 115],
    observedAt: 138,
    rows: [
      { n: 114, type: 'sale', amountFen: 7790 },
      { n: 115, type: 'sale', amountFen: 8200 },
      { n: 900, type: 'void', statement: 'C90', target: 115 },
    ],
  });
  const coverage = buildCoverage({
    detailDocs: [oldDoc, newDoc],
    subtotalDocs: [],
    reviewCases: [],
    transferList: transferConfirmed,
    now: 138,
  });
  const g41 = coverage.generations.find(g => g.generation === 'G-41');
  assert.deepEqual(g41.evidence.retiredDetails.map(d => d.id), ['DET-7']);
  assert.deepEqual(g41.evidence.activeDetails.map(d => d.id), ['DET-7b']);
  const segment = g41.segments.find(s => s.interval[0] === 114);
  assert.equal(segment.amountFen, 7790); // 115 被撤销，仅剩 114
});

test('书面确认与后到明细分值不一致：保留两源，争议差额不入正式金额', () => {
  const reviewCases = [
    {
      caseId: 'WH-6',
      generation: 'G-41',
      observedAt: 138,
      interval: [124, 129],
      parts: [
        { interval: [124, 126], amountFen: 36420, state: 'confirmed', receipt: 'WH-6a' },
        { interval: [127, 129], state: 'unresolved', receipt: 'WH-6b' },
      ],
    },
  ];
  const before = buildCoverage({
    detailDocs: [],
    subtotalDocs: [],
    reviewCases,
    transferList: transferConfirmed,
    now: 138,
  });
  const gBefore = before.generations.find(g => g.generation === 'G-41');
  const confirmedSeg = gBefore.segments.find(s => s.interval[0] === 124 && s.interval[1] === 126);
  assert.equal(confirmedSeg.status, 'formal');
  assert.equal(confirmedSeg.evidenceKind, 'written-subtotal');
  const unresolvedSeg = gBefore.segments.find(s => s.interval[0] === 127);
  assert.equal(unresolvedSeg.status, 'unresolved');
  assert.equal(unresolvedSeg.amountFen, null);

  // 模拟首次入账后，窗口内新明细到达且分值不同
  const issued = [
    {
      sha256: 'prior',
      formalEntries: [{ generation: 'G-41', interval: [124, 126], station: 'R2', amountFen: 36420 }],
    },
  ];
  const detail = detailDoc({
    id: 'DET-10',
    generation: 'G-41',
    coverage: [124, 126],
    replaces: [124, 126],
    observedAt: 142,
    rows: [
      { n: 124, type: 'sale', amountFen: 11890 },
      { n: 125, type: 'sale', amountFen: 12300 },
      { n: 126, type: 'sale', amountFen: 12710 },
    ],
  });
  const after = buildCoverage({
    detailDocs: [detail],
    subtotalDocs: [],
    reviewCases,
    transferList: transferConfirmed,
    issued,
    now: 142,
  });
  const disputed = after.generations
    .find(g => g.generation === 'G-41')
    .segments.find(s => s.status === 'disputed');
  assert.deepEqual(disputed.interval, [124, 126]);
  assert.equal(disputed.bookedFen, 36420);
  assert.equal(disputed.unbookedDeltaFen, 480);
  assert.equal(disputed.evidenceRefs.filter(r => r.kind === 'review').length, 1);
  assert.equal(disputed.evidenceRefs.filter(r => r.kind === 'detail').length, 1);
});

test('书面与新明细金额一致时相互印证，可按明细证据计入', () => {
  const reviewCases = [
    {
      caseId: 'WH-9',
      generation: 'G-41',
      observedAt: 138,
      interval: [130, 131],
      parts: [{ interval: [130, 131], amountFen: 2500, state: 'confirmed', receipt: 'R' }],
    },
  ];
  const detail = detailDoc({
    id: 'DET-X',
    generation: 'G-41',
    coverage: [130, 131],
    replaces: [130, 131],
    observedAt: 140,
    rows: [
      { n: 130, type: 'sale', amountFen: 1200 },
      { n: 131, type: 'sale', amountFen: 1300 },
    ],
  });
  const coverage = buildCoverage({
    detailDocs: [detail],
    subtotalDocs: [],
    reviewCases,
    transferList: transferConfirmed,
    now: 140,
  });
  const segment = coverage.generations.find(g => g.generation === 'G-41').segments[0];
  assert.equal(segment.status, 'formal');
  assert.equal(segment.evidenceKind, 'detail');
  assert.equal(segment.amountFen, 2500);
});

