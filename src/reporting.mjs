// 出报：月报截点覆盖凭据、跨期补充单、交班逐段核对视图、争议清单。
// 规则：
//  - 已归属且不重叠的覆盖可签发；争议网点/区间随报告标明待核，禁止比例分摊；
//  - 已签发期内只对实质差额开补充单，并与原报送关联；
//  - 同一笔不能在报送端同时算作“书面补认”和“新到明细补认”；
//  - 渠道意见不一致时保留两个来源，正式金额只纳入有确定归属和分值的覆盖。

import { describe, lo, hi, merge, contains, splitBy } from './intervals.mjs';
import { sha256 } from './store.mjs';

const EVIDENCE_LABEL = {
  detail: '可核实原凭据（逐号明细，含同世代撤销/冲补净额）',
  'written-subtotal': '交接办书面确认的独立小计（未拆到具体凭据）',
  subtotal: '封存小计证明（整段未分解）',
  none: '缺细拆，不能计入正式金额',
  conflict: '两源冲突（书面与明细分值不一致）',
};

const STATUS_LABEL = {
  formal: '可计入正式金额',
  'pending-attribution': '归属待核（交接号未确认，不得先分配）',
  'pending-detail': '缺细拆待核',
  unresolved: '书面核对结案，无法再确认',
  disputed: '渠道争议，保留两源',
};

const segmentEntry = segment => ({
  generation: segment.generation,
  station: segment.station,
  interval: segment.interval,
  intervalText: describe(segment.interval),
  amountFen: segment.amountFen,
  bookedFen: segment.bookedFen,
  unbookedDeltaFen: segment.unbookedDeltaFen,
  status: segment.status,
  statusText: STATUS_LABEL[segment.status],
  evidenceKind: segment.evidenceKind,
  evidenceText: EVIDENCE_LABEL[segment.evidenceKind],
  stationReason: segment.stationReason,
  evidenceRefs: segment.evidenceRefs,
  ...(segment.perNumberFen ? { perNumberFen: segment.perNumberFen } : {}),
  note: segment.note,
});

export function buildCutoffReport({ coverage, windows, cutoffKind, issuedAt, reportSequence, priorReport }) {
  const formalEntries = [];
  const pendingEntries = [];
  const disputes = [];
  const crossChecks = [];

  for (const generation of coverage.generations) {
    for (const segment of generation.segments) {
      const entry = segmentEntry(segment);
      if (segment.status === 'formal') {
        formalEntries.push({ ...entry, amountFen: segment.amountFen });
      } else if (segment.status === 'disputed' && segment.bookedFen !== null) {
        // 争议段：只有此前已入账的确定分值维持在正式金额内，未入账差额挂争议清单。
        formalEntries.push({
          ...entry,
          amountFen: segment.bookedFen,
          disputed: true,
        });
      } else {
        pendingEntries.push(entry);
      }
      if (segment.status === 'disputed') {
        disputes.push({
          generation: segment.generation,
          station: segment.station,
          interval: segment.interval,
          written: segment.conflict.written,
          detail: segment.conflict.detail,
          bookedFen: segment.bookedFen,
          unbookedDeltaFen: segment.unbookedDeltaFen,
          rule: segment.conflict.rule,
          handling: '两个来源同时留痕，待监管人员裁定；裁定前差额不得入账，也不得按比例分摊',
        });
      }
    }
    crossChecks.push(
      ...generation.crossChecks.map(check => ({
        generation: generation.generation,
        ...check,
        intervalText: describe(check.interval),
      })),
    );
  }

  const stationTotals = {};
  for (const entry of formalEntries) {
    const key = entry.station ?? 'UNASSIGNED';
    stationTotals[key] = (stationTotals[key] ?? 0) + entry.amountFen;
  }
  const totalFen = Object.values(stationTotals).reduce((a, b) => a + b, 0);

  const report = {
    reportType: 'cutoff',
    reportSequence,
    period: windows.period,
    cutoffKind, // firstCutoff | correctionCutoff
    cutoff: windows[cutoffKind],
    issuedAt,
    generatedFromCoverageAt: coverage.generatedAt,
    stations: windows.stations,
    summary: {
      totalFormalFen: totalFen,
      formalFenByStation: stationTotals,
      pendingSegmentCount: pendingEntries.length,
      disputeCount: disputes.length,
    },
    formalEntries: formalEntries.sort(
      (a, b) => a.generation.localeCompare(b.generation) || lo(a.interval) - lo(b.interval),
    ),
    pendingEntries: pendingEntries.sort(
      (a, b) => a.generation.localeCompare(b.generation) || lo(a.interval) - lo(b.interval),
    ),
    disputes,
    subtotalCrossChecks: crossChecks,
    evidenceIntegrity: collectHashes(coverage),
  };
  report.sha256 = sha256(JSON.stringify(report));
  report.priorReportSha256 = priorReport?.sha256 ?? null;
  return report;
}

const collectHashes = coverage =>
  coverage.generations.flatMap(generation => [
    ...generation.evidence.activeDetails.map(e => ({ kind: 'detail', id: e.id, sha256: e.sha256 })),
    ...generation.evidence.retiredDetails.map(e => ({ kind: 'detail-retired', id: e.id, sha256: e.sha256 })),
    ...generation.evidence.subtotals.map(e => ({ kind: 'subtotal', id: e.id, sha256: e.sha256 })),
  ]);

/** 取一个覆盖段在指定（原子）区间内的分值；明细按逐号净额，小计级只在整段匹配时有值。 */
const valueWithin = (holder, interval) => {
  if (!holder) return null;
  if (holder.perNumberFen) {
    let sum = 0;
    for (let n = lo(interval); n <= hi(interval); n += 1) {
      const value = holder.perNumberFen[n];
      if (value === undefined) return null;
      sum += value;
    }
    return sum;
  }
  const whole = lo(holder.interval) === lo(interval) && hi(holder.interval) === hi(interval);
  const total = holder.bookedFen ?? holder.amountFen;
  return whole ? total : null;
};

/** 逐号判定前后两份正式覆盖的变化类型。 */
const classifyChange = (before, after) => {
  if (!before && after) {
    return { kind: 'first-obtained', fromStation: null, toStation: after.station, note: '首次取得可定值覆盖' };
  }
  if (before && !after) {
    return { kind: 'amount-correction', fromStation: before.station, toStation: null, note: '原覆盖退出正式金额' };
  }
  if (before.station !== after.station) {
    return {
      kind: 'attribution-change',
      fromStation: before.station,
      toStation: after.station,
      note: after.stationReason ?? '交接切界更正导致归属网点变更',
    };
  }
  if (before.amountFen !== (after.bookedFen ?? after.amountFen)) {
    return { kind: 'amount-correction', fromStation: before.station, toStation: after.station, note: '替换报文重算后的实质差额' };
  }
  return { kind: 'unchanged', fromStation: before.station, toStation: after.station, note: '' };
};

/**
 * 限定于受影响网点和期间的补充单，供统计人员区分：
 * first-obtained（首次取得）、amount-correction（金额更正）、attribution-change（归属变更）。
 * 把前后两份正式覆盖按双方段边界重切成原子段后逐段比对，再合并同类连续段，
 * 因此切界重切、跨段移动也能正确归类，且不会重发无变化区间。
 */
export function buildSupplement({ coverage, priorReport, windows, issuedAt, supplementSequence }) {
  const entries = [];
  for (const generation of coverage.generations) {
    const prior = priorReport.formalEntries.filter(entry => entry.generation === generation.generation);
    const current = generation.segments.filter(
      segment => segment.status === 'formal' || (segment.status === 'disputed' && segment.bookedFen !== null),
    );

    const universe = merge([
      ...prior.map(entry => entry.interval),
      ...current.map(segment => segment.interval),
    ]);

    for (const envelope of universe) {
      // 用前后两份覆盖的全部边界重切，原子段内前后归属与证据均恒定。
      const atomic = splitBy(envelope, [
        ...prior.map(entry => entry.interval),
        ...current.map(segment => segment.interval),
      ]);

      for (const interval of atomic) {
        const before = prior.find(entry => contains(entry.interval, interval));
        const after = current.find(segment => contains(segment.interval, interval));
        const verdict = classifyChange(before, after);
        if (verdict.kind === 'unchanged') continue;
        const beforeFen = valueWithin(before, interval);
        const afterFen = valueWithin(after, interval);
        entries.push({
          kind: verdict.kind,
          generation: generation.generation,
          station: after?.station ?? before?.station ?? null,
          interval,
          intervalText: describe(interval),
          beforeFen,
          afterFen,
          deltaFen: (afterFen ?? 0) - (beforeFen ?? 0),
          evidenceKind: after?.evidenceKind ?? before?.evidenceKind ?? null,
          evidenceRefs: after?.evidenceRefs ?? before?.evidenceRefs ?? [],
          note: verdict.note,
          ...(verdict.kind === 'attribution-change'
            ? { fromStation: verdict.fromStation, toStation: verdict.toStation }
            : {}),
        });
      }
    }
  }

  const supplement = {
    reportType: 'supplement',
    supplementSequence,
    period: windows.period,
    issuedAt,
    linkedReportSequence: priorReport.reportSequence,
    linkedReportSha256: priorReport.sha256,
    scopeRule: '仅覆盖受影响网点和期间，不重发无关区间',
    entryKinds: ['first-obtained', 'amount-correction', 'attribution-change'],
    entries,
    netDeltaFen: entries.reduce((sum, entry) => sum + entry.deltaFen, 0),
  };
  supplement.sha256 = sha256(JSON.stringify(supplement));
  return supplement;
}

/** 交班视图：逐段标明证据来源、能否计入正式金额及原因。 */
export function buildHandoffView({ coverage, station, generationFilter = null }) {
  const sections = [];
  for (const generation of coverage.generations) {
    if (generationFilter && generation.generation !== generationFilter) continue;
    const transfer = generation.transfer;
    const segments = generation.segments
      .filter(segment => station === null || segment.station === station || segment.station === null)
      .map(segment => ({
        intervalText: describe(segment.interval),
        station: segment.station ?? '待核',
        status: segment.status,
        statusText: STATUS_LABEL[segment.status],
        evidenceKind: segment.evidenceKind,
        evidenceText: EVIDENCE_LABEL[segment.evidenceKind],
        amountFen: segment.amountFen,
        includedInFormalFen:
          segment.status === 'formal'
            ? segment.amountFen
            : segment.status === 'disputed'
              ? segment.bookedFen
              : null,
        evidenceRefs: segment.evidenceRefs,
        note: segment.note,
      }));
    sections.push({
      generation: generation.generation,
      transfer,
      formalFen: station === null ? generation.formalAmountFen : generation.formalByStation[station] ?? 0,
      formalFenScope: station === null ? '全部网点' : `仅本视图网点 ${station}`,
      formalByStation: generation.formalByStation,
      segments,
    });
  }
  return {
    viewType: 'handoff',
    station,
    generatedAt: coverage.generatedAt,
    sections,
    legend: EVIDENCE_LABEL,
  };
}

/** 争议清单：把冲突双源、已入账金额与未入账差额单列给监管人员。 */
export function buildDisputeSchedule(report) {
  return {
    viewType: 'dispute-schedule',
    period: report.period,
    issuedAt: report.issuedAt,
    rule: '确认渠道意见不一致时保留两个来源；正式金额只纳入有确定归属和分值的覆盖；无权比例分摊',
    disputes: report.disputes,
  };
}
