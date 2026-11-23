// 编排：采集 → 建模 → 截点判定 → 签发/补充，串起完整证据链。

import { buildCoverage } from './model.mjs';
import { buildCutoffReport, buildSupplement, buildHandoffView, buildDisputeSchedule } from './reporting.mjs';
import { loadEvidenceInputs } from './collector.mjs';

export async function buildCurrentCoverage(store, now) {
  const inputs = await loadEvidenceInputs(store);
  const issued = await store.listIssued();
  const issuedReports = issued
    .filter(({ payload }) => payload.reportType === 'cutoff')
    .map(({ payload }) => payload)
    .sort((a, b) => a.reportSequence - b.reportSequence);
  const coverage = buildCoverage({ ...inputs, issued: issuedReports, now });
  return { coverage, inputs, issuedReports };
}

/**
 * 截点签发：
 *  - 首个截点出正式月报；
 *  - 更正截点只对实质差额开补充单，并与原报送关联；
 *  - 争议段随报告标明待核，不把同一笔同时算作书面补认和新到明细补认。
 */
export async function issueAtCutoff({ store, now, cutoffKind }) {
  const windows = await store.getWindows();
  if (!windows) throw new Error('尚未取得 /desk/windows，无法判定截点');
  const cutoff = windows[cutoffKind];
  if (now < cutoff) {
    throw new Error(`当前 ${now} 未到截点 ${cutoffKind}=${cutoff}`);
  }
  const { coverage, issuedReports } = await buildCurrentCoverage(store, now);
  const prior = issuedReports.at(-1) ?? null;

  if (prior === null) {
    const report = buildCutoffReport({
      coverage,
      windows,
      cutoffKind,
      issuedAt: now,
      reportSequence: issuedReports.length + 1,
      priorReport: null,
    });
    const path = await store.issue(`report-${String(report.reportSequence).padStart(2, '0')}-${cutoffKind}.json`, report);
    const disputes = buildDisputeSchedule(report);
    await store.issue(`disputes-${String(report.reportSequence).padStart(2, '0')}.json`, disputes);
    return { kind: 'cutoff', report, disputes, path };
  }

  const supplement = buildSupplement({
    coverage,
    priorReport: prior,
    windows,
    issuedAt: now,
    supplementSequence: issuedReports.length + 1,
  });
  const path = await store.issue(
    `supplement-${String(supplement.supplementSequence).padStart(2, '0')}-linked-${String(prior.reportSequence).padStart(2, '0')}.json`,
    supplement,
  );
  // 更正截点仍出一份完整对照报告，争议清单同步更新。
  const report = buildCutoffReport({
    coverage,
    windows,
    cutoffKind,
    issuedAt: now,
    reportSequence: prior.reportSequence,
    priorReport: prior,
  });
  const disputes = buildDisputeSchedule(report);
  await store.issue(`disputes-${String(report.reportSequence).padStart(2, '0')}-${cutoffKind}.json`, disputes);
  return { kind: 'supplement', supplement, report, disputes, path };
}

export async function handoffForStation(store, { station = null, generation = null, now }) {
  const { coverage } = await buildCurrentCoverage(store, now);
  return buildHandoffView({ coverage, station, generationFilter: generation });
}
