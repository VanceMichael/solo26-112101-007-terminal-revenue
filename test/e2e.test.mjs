import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startSources } from '../sources/server.mjs';
import { EvidenceStore } from '../src/store.mjs';
import { runSimulation } from '../src/simulate.mjs';

const freshStore = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'terminal-revenue-'));
  const store = await EvidenceStore.open(dir);
  return { dir, store };
};

test('端到端：四阶段采集、截点签发、书面核对与渠道争议全链路', async () => {
  const { dir, store } = await freshStore();
  const source = await startSources(0);
  assert.notEqual(dir, null);
  try {
    const result = await runSimulation({ store, externalSource: source });
    const { summary } = result;

    // 采集纪律：只请求目录内地址；425/410/404 都有对应处理，不触发目录外路由
    const paths = new Set(source.calls.map(call => call.method + ' ' + call.path.split('?')[0]));
    for (const call of source.calls) {
      assert.ok(
        call.path.startsWith('/books/') ||
          call.path.startsWith('/station/') ||
          call.path.startsWith('/desk/') ||
          call.path.startsWith('/review/') ||
          call.path.startsWith('/scenario/'),
        `越权请求：${call.path}`,
      );
    }
    assert.ok(paths.has('GET /books/DET-8')); // 425 后下阶段再试成功
    assert.ok(paths.has('GET /books/DET-9')); // 404 后 410，转书面核对
    assert.ok(paths.has('POST /review/cases'));
    assert.ok(paths.has('GET /review/cases/WH-6'));

    // ---- 首个截点（135）----
    const first = summary.firstReport;
    assert.equal(first.totalFormalFen, 96350 + 49500);
    assert.deepEqual(first.formalFenByStation, { R1: 24600, R2: 71750, R3: 49500 });
    // 待核：G-41 的 [100,113]（封存小计拆不出）与 [124,129]（无材料）
    assert.equal(first.pendingSegmentCount, 2);
    assert.equal(first.disputeCount, 0);

    // ---- 更正截点（149）补充单 ----
    const correction = summary.correction;
    assert.ok(/^[0-9a-f]{64}$/.test(correction.linkedReport));
    const kinds = correction.entryKinds;
    // 首次取得：R1 [100,113]=66010
    const firstObtained = kinds.filter(k => k.kind === 'first-obtained');
    assert.deepEqual(
      firstObtained.map(k => [k.station, k.interval, k.deltaFen]),
      [['R1', [100, 113], 66010]],
    );
    // 金额更正：DET-7b 替换 DET-7 —— 116 撤销 -8610（R1）、117 冲补 -300（R2）
    const corrected = kinds
      .filter(k => k.kind === 'amount-correction')
      .sort((a, b) => a.interval[0] - b.interval[0]);
    assert.deepEqual(
      corrected.map(k => [k.station, k.interval, k.deltaFen]),
      [
        ['R1', [114, 116], -8610],
        ['R2', [117, 123], -300],
      ],
    );
    // 争议段 [124,126] 从未入账且渠道冲突：既不开补充单，也不把 36420/36900 计入正式金额
    assert.equal(kinds.some(k => k.interval[0] === 124), false);
    assert.equal(kinds.some(k => k.deltaFen === 480), false);
    assert.equal(correction.netDeltaFen, 66010 - 8610 - 300);

    // ---- 最终正式金额：争议段未入账过，整体排除 ----
    const finalByStation = summary.finalFormalFenByStation;
    assert.deepEqual(finalByStation['G-41'], { R1: 82000, R2: 71450 });
    assert.deepEqual(finalByStation['G-42'], { R3: 49500 });
    assert.deepEqual(summary.finalDisputes, [
      { generation: 'G-41', interval: [124, 126], bookedFen: null, unbookedDeltaFen: 480 },
    ]);

    // ---- 交班视图逐段可核对：证据分级齐全 ----
    const r2 = result.handoffR2;
    const kindsSeen = new Set(r2.sections.flatMap(section => section.segments.map(s => s.evidenceKind)));
    for (const kind of ['detail', 'none', 'conflict']) {
      assert.ok(kindsSeen.has(kind), `R2 交班视图缺少证据类型 ${kind}`);
    }
    // 书面确认在争议段内仍作为两源之一留痕
    const disputed = r2.sections
      .flatMap(section => section.segments)
      .find(s => s.intervalText === '[124, 126]');
    assert.equal(disputed.status, 'disputed');
    assert.equal(disputed.includedInFormalFen, null);
    // 冲突两源（明细 + 书面确认），封存小计另作对照留痕
    assert.deepEqual(
      disputed.evidenceRefs.filter(ref => ref.kind !== 'subtotal').map(ref => ref.kind).sort(),
      ['detail', 'review'],
    );
    assert.ok(disputed.evidenceRefs.some(ref => ref.kind === 'subtotal' && ref.id === 'SUM-4'));
    const unresolved = r2.sections
      .flatMap(section => section.segments)
      .find(s => s.intervalText === '[127, 129]');
    assert.equal(unresolved.status, 'unresolved');
    assert.equal(unresolved.includedInFormalFen, null);
    // 书面小计的独立证据能力在它被新明细覆盖前可单独验证（adjustment 时点）
    const reviewPoll = summary.timeline.find(t => t.stage === 'adjustment');
    assert.deepEqual(reviewPoll.reviewPolls, ['WH-6']);

    // R1 交班视图：两段都由可核实原凭据证明，金额与正式金额一致
    const r1Kinds = new Set(result.handoffR1.sections.flatMap(section => section.segments.map(s => s.evidenceKind)));
    assert.deepEqual([...r1Kinds], ['detail']);
    assert.ok(
      result.handoffR1.sections.flatMap(section => section.segments).every(s => s.includedInFormalFen === s.amountFen),
    );

    // 全网点交班视图必须同时呈现三种证据能力：逐号凭据、封存小计、缺细拆不可计入
    const { handoffForStation } = await import('../src/pipeline.mjs');
    const all = await handoffForStation(store, { station: null, now: 149 });
    const allKinds = new Set(all.sections.flatMap(section => section.segments.map(s => s.evidenceKind)));
    for (const kind of ['detail', 'subtotal', 'none', 'conflict']) {
      assert.ok(allKinds.has(kind), `全网点交班视图缺少证据类型 ${kind}`);
    }

    // ---- 封存小计对照留痕 ----
    const issued = await store.listIssued();
    const report1 = issued.find(f => f.name.startsWith('report-01'));
    const check = report1.payload.subtotalCrossChecks.find(c => c.id === 'SUM-4');
    assert.equal(check.sealed, true);
    assert.equal(check.fullyExplained, false);
    const sum5 = report1.payload.subtotalCrossChecks.find(c => c.id === 'SUM-5');
    assert.equal(sum5.fullyExplained, true);
    assert.equal(sum5.differenceFen, 0);

    // 证据完整性：所有金额段都带原始报文哈希
    assert.ok(report1.payload.evidenceIntegrity.length >= 3);
    for (const item of report1.payload.evidenceIntegrity) {
      assert.ok(/^[0-9a-f]{64}$/.test(item.sha256));
    }

    // 请求日志已落盘；来源服务自身的 calls 不登记 /scenario 切换（见 server.mjs 提前 return）
    const logged = JSON.parse(await readFile(join(dir, 'requests.log.json'), 'utf8'));
    const businessCalls = logged.filter(call => !call.path.startsWith('/scenario/'));
    assert.equal(businessCalls.length, source.calls.length);
    assert.equal(logged.filter(call => call.path.startsWith('/scenario/')).length, 4);
  } finally {
    await source.close();
    await rm(dir, { recursive: true, force: true });
  }
});
