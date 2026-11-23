import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCoverage } from '../src/model.mjs';
import { buildSupplement, buildCutoffReport } from '../src/reporting.mjs';

const shaCounter = (() => {
  let n = 0;
  return () => `hash-${(n += 1)}`;
})();

const detail = ({ id, coverage, rows, observedAt }) => ({
  id,
  generation: 'G-41',
  observedAt,
  sha256: shaCounter(),
  interval: coverage,
  coverage,
  replaces: coverage,
  document: { id, generation: 'G-41', coverage, rows },
});

const saleRows = (start, end, base) =>
  Array.from({ length: end - start + 1 }, (_, i) => ({
    n: start + i,
    type: 'sale',
    amountFen: base + i,
  }));

const windows = {
  period: '2026-10',
  firstCutoff: 135,
  correctionCutoff: 149,
  stations: ['R1', 'R2', 'R3'],
};

test('交接确认后归属落定：proposed 待核段转为正式段并出首次取得补充单', () => {
  const docs = [detail({ id: 'DET-M', coverage: [114, 120], rows: saleRows(114, 120, 5000), observedAt: 130 })];

  // 首次：交接 proposed，[114,116] 归属未定
  const proposed = buildCoverage({
    detailDocs: docs,
    subtotalDocs: [],
    reviewCases: [],
    transferList: [
      { generation: 'G-41', from: 'R1', to: 'R2', cut: 117, state: 'proposed', stableThrough: 113 },
    ],
    now: 130,
  });
  const firstReport = buildCutoffReport({
    coverage: proposed,
    windows,
    cutoffKind: 'firstCutoff',
    issuedAt: 135,
    reportSequence: 1,
    priorReport: null,
  });
  const pending = firstReport.pendingEntries.find(e => e.interval[0] === 114 && e.station === null);
  assert.equal(pending.status, 'pending-attribution');

  // 之后：交接 confirmed，同号段归属落定，金额不变
  const confirmed = buildCoverage({
    detailDocs: docs,
    subtotalDocs: [],
    reviewCases: [],
    transferList: [{ generation: 'G-41', from: 'R1', to: 'R2', cut: 117, state: 'confirmed' }],
    issued: [{ payload: firstReport }],
    now: 140,
  });
  const supplement = buildSupplement({
    coverage: confirmed,
    priorReport: firstReport,
    windows,
    issuedAt: 149,
    supplementSequence: 2,
  });
  assert.equal(supplement.linkedReportSha256, firstReport.sha256);
  const entries = supplement.entries;
  // [114,116] 此前归属待核未入账，确认后首次取得；[117,120] 首报已入账不重复出条
  assert.ok(entries.every(e => e.deltaFen !== 0));
  assert.deepEqual(entries.map(e => [e.kind, e.station, e.interval]), [
    ['first-obtained', 'R1', [114, 116]],
  ]);
  const finalReport = buildCutoffReport({
    coverage: confirmed,
    windows,
    cutoffKind: 'correctionCutoff',
    issuedAt: 149,
    reportSequence: 1,
    priorReport: firstReport,
  });
  assert.equal(finalReport.pendingEntries.length, 0);
  assert.deepEqual(finalReport.summary.formalFenByStation, { R1: 15003, R2: 20018 });
});

test('交接切界更正产生归属变更补充单：同号段网点移动、金额不变', () => {
  const docs = [detail({ id: 'D-MOVE', coverage: [114, 116], rows: saleRows(114, 116, 5000), observedAt: 130 })];
  // 首次按 cut=115 确认：114 在 R1，115-116 在 R2
  const before = buildCoverage({
    detailDocs: docs,
    subtotalDocs: [],
    reviewCases: [],
    transferList: [{ generation: 'G-41', from: 'R1', to: 'R2', cut: 115, state: 'confirmed' }],
    now: 130,
  });
  const firstReport = buildCutoffReport({
    coverage: before,
    windows,
    cutoffKind: 'firstCutoff',
    issuedAt: 135,
    reportSequence: 1,
    priorReport: null,
  });
  assert.deepEqual(firstReport.summary.formalFenByStation, { R1: 5000, R2: 10003 });

  // 管理站更正切界为 cut=117：115-116 从 R2 移到 R1
  const after = buildCoverage({
    detailDocs: docs,
    subtotalDocs: [],
    reviewCases: [],
    transferList: [{ generation: 'G-41', from: 'R1', to: 'R2', cut: 117, state: 'confirmed' }],
    issued: [{ payload: firstReport }],
    now: 140,
  });
  const supplement = buildSupplement({
    coverage: after,
    priorReport: firstReport,
    windows,
    issuedAt: 149,
    supplementSequence: 2,
  });
  const move = supplement.entries.find(e => e.kind === 'attribution-change');
  assert.deepEqual(move.interval, [115, 116]);
  assert.equal(move.fromStation, 'R2');
  assert.equal(move.toStation, 'R1');
  assert.equal(move.deltaFen, 0); // 归属变更不改变金额总额，只调整网点归属
});

test('金额更正只对实质差额开补充单，无差额段不产生条目', () => {
  const oldDoc = detail({ id: 'D-OLD', coverage: [100, 101], rows: saleRows(100, 101, 1000), observedAt: 130 });
  const before = buildCoverage({
    detailDocs: [oldDoc],
    subtotalDocs: [],
    reviewCases: [],
    transferList: [{ generation: 'G-41', from: 'R1', to: 'R2', cut: 200, state: 'confirmed' }],
    now: 130,
  });
  const firstReport = buildCutoffReport({
    coverage: before,
    windows,
    cutoffKind: 'firstCutoff',
    issuedAt: 135,
    reportSequence: 1,
    priorReport: null,
  });
  // 重传：100 金额变化、101 不变
  const newDoc = detail({
    id: 'D-NEW',
    coverage: [100, 101],
    rows: [
      { n: 100, type: 'sale', amountFen: 1400 },
      { n: 101, type: 'sale', amountFen: 1001 },
    ],
    observedAt: 140,
  });
  const after = buildCoverage({
    detailDocs: [oldDoc, newDoc],
    subtotalDocs: [],
    reviewCases: [],
    transferList: [{ generation: 'G-41', from: 'R1', to: 'R2', cut: 200, state: 'confirmed' }],
    issued: [{ payload: firstReport }],
    now: 140,
  });
  const supplement = buildSupplement({
    coverage: after,
    priorReport: firstReport,
    windows,
    issuedAt: 149,
    supplementSequence: 2,
  });
  assert.equal(supplement.entries.length, 1);
  assert.equal(supplement.entries[0].kind, 'amount-correction');
  assert.deepEqual(supplement.entries[0].interval, [100, 101]);
  assert.equal(supplement.entries[0].deltaFen, 400);
});
