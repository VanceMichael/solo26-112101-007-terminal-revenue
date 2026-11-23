// 完整演练：在进程内启动合成来源，按 initial → cutover → adjustment → disputed
// 四阶段采集，并在月报两个截点签发正式月报与关联补充单。
// 时间线对齐 /desk/windows：firstCutoff=135，correctionCutoff=149。

import { startSources } from '../sources/server.mjs';
import { EvidenceStore } from './store.mjs';
import { SourceClient } from './client.mjs';
import { runCollectionCycle } from './collector.mjs';
import { issueAtCutoff, buildCurrentCoverage, handoffForStation } from './pipeline.mjs';

export async function runSimulation({ store, keepServer = false, externalSource = null } = {}) {
  const source = externalSource ?? (await startSources(0));
  const client = new SourceClient(source.url, store);
  const timeline = [];

  try {
    // 阶段一（asOf=130）：只有两个封存小计；交接 proposed，G-41 跨界不得分配。
    timeline.push({ stage: 'initial', plan: await runCollectionCycle({ client, store, stage: 'initial', now: 130 }) });

    // 阶段二（asOf=134）：交接确认；DET-7 细拆到手，DET-8 归档中（425）。
    timeline.push({ stage: 'cutover', plan: await runCollectionCycle({ client, store, stage: 'cutover', now: 134 }) });

    // 首个截点：已归属且不重叠的覆盖签发，待核段随报告标明。
    const firstIssue = await issueAtCutoff({ store, now: 135, cutoffKind: 'firstCutoff' });
    timeline.push({ stage: 'cutoff-135', issue: firstIssue.path });

    // 阶段三（asOf=138）：DET-7b 重传（含撤销/冲补），DET-8 可领，DET-9 超留存转 WH-6。
    timeline.push({ stage: 'adjustment', plan: await runCollectionCycle({ client, store, stage: 'adjustment', now: 138 }) });

    // 阶段四（asOf=142）：核对窗口内 DET-10 到达，与 WH-6a 已确认号段重合且分值不一致。
    timeline.push({ stage: 'disputed', plan: await runCollectionCycle({ client, store, stage: 'disputed', now: 142 }) });

    // 更正截点：只对实质差额开补充单，争议差额不入账。
    const correctionIssue = await issueAtCutoff({ store, now: 149, cutoffKind: 'correctionCutoff' });
    timeline.push({ stage: 'cutoff-149', issue: correctionIssue.path });

    const { coverage } = await buildCurrentCoverage(store, 149);
    const handoffR2 = await handoffForStation(store, { station: 'R2', now: 149 });
    const handoffR1 = await handoffForStation(store, { station: 'R1', now: 149 });

    const summary = {
      requestCount: source.calls.length,
      callsByStage: source.calls.reduce((acc, call) => {
        acc[call.stage] = (acc[call.stage] ?? 0) + 1;
        return acc;
      }, {}),
      timeline: timeline.map(item => ({
        stage: item.stage,
        issue: item.issue ?? null,
        fetched: item.plan?.fetched.map(f => f.id) ?? [],
        blocked: item.plan?.blocked.map(b => ({ id: b.id, kind: b.kind, status: b.status ?? null })) ?? [],
        reviewRequests: item.plan?.reviewRequests.map(r => r.caseId) ?? [],
        reviewPolls: item.plan?.reviewPolls.map(r => r.caseId) ?? [],
      })),
      firstReport: summarizeReport(firstIssue.report),
      correction: correctionIssue.supplement
        ? {
            supplement: correctionIssue.supplement.sha256,
            linkedReport: correctionIssue.supplement.linkedReportSha256,
            entryKinds: correctionIssue.supplement.entries.map(e => ({
              kind: e.kind,
              generation: e.generation,
              station: e.station ?? null,
              interval: e.interval,
              deltaFen: e.deltaFen,
            })),
            netDeltaFen: correctionIssue.supplement.netDeltaFen,
          }
        : null,
      finalFormalFenByStation: Object.fromEntries(
        coverage.generations.map(g => [g.generation, g.formalByStation]),
      ),
      finalDisputes: coverage.generations.flatMap(g =>
        g.segments.filter(s => s.status === 'disputed').map(s => ({
          generation: s.generation,
          interval: s.interval,
          bookedFen: s.bookedFen,
          unbookedDeltaFen: s.unbookedDeltaFen,
        })),
      ),
      handoffR2SegmentCount: handoffR2.sections.reduce((n, section) => n + section.segments.length, 0),
      handoffR1SegmentCount: handoffR1.sections.reduce((n, section) => n + section.segments.length, 0),
    };

    await store.issue('simulation-summary.json', summary);
    return { summary, timeline, coverage, handoffR2, handoffR1, sourceUrl: source.url };
  } finally {
    if (!keepServer && !externalSource) await source.close();
  }
}

const summarizeReport = report => ({
  sequence: report.reportSequence,
  totalFormalFen: report.summary.totalFormalFen,
  formalFenByStation: report.summary.formalFenByStation,
  pendingSegmentCount: report.summary.pendingSegmentCount,
  disputeCount: report.summary.disputeCount,
  sha256: report.sha256,
});
