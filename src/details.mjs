// 明细评估：把一份 detail 报文逐号折算成净分值。
// sale：按原号记正额；void：撤销同世代具体原号（不能抵另一网点的同号凭据，
// 因为评估始终在单一 generation 内进行）；adjustment：对原号追加冲补额。
// 同一报文内重复行按 (n,type,target,statement,amountFen) 去重；重新发起同一记录不改变事实。

import { isValid, lo, hi, contains } from './intervals.mjs';

const rowKey = row =>
  [row.n, row.type, row.target ?? '', row.statement ?? '', row.amountFen ?? ''].join('|');

export const evaluateDetail = (document, { generation, observedAt, sourceId }) => {
  const coverage = isValid(document.coverage)
    ? document.coverage
    : isValid(document.interval)
      ? document.interval
      : null;
  const anomalies = [];
  if (!coverage) {
    anomalies.push({ code: 'DETAIL_NO_COVERAGE', sourceId, message: '明细缺少可用覆盖区间' });
    return { perNumber: new Map(), coverage: null, anomalies, observedAt };
  }
  if (document.generation && document.generation !== generation) {
    anomalies.push({
      code: 'GENERATION_MISMATCH',
      sourceId,
      message: `报文世代 ${document.generation} 与目录世代 ${generation} 不一致`,
    });
  }

  const perNumber = new Map();
  const seen = new Set();
  for (const row of document.rows ?? []) {
    const key = rowKey(row);
    if (seen.has(key)) continue; // 重新发起同一记录不改变事实
    seen.add(key);

    if (!Number.isInteger(row.n)) {
      anomalies.push({ code: 'BAD_ROW_NUMBER', sourceId, row });
      continue;
    }

    if (row.type === 'sale') {
      if (!contains(coverage, [row.n, row.n])) {
        anomalies.push({
          code: 'ROW_OUTSIDE_COVERAGE',
          sourceId,
          n: row.n,
          coverage,
          message: `销售流水号 ${row.n} 超出明细覆盖 ${JSON.stringify(coverage)}`,
        });
        continue;
      }
      const current = perNumber.get(row.n) ?? { sales: 0, voids: [], adjustments: [] };
      current.sales += row.amountFen;
      perNumber.set(row.n, current);
      continue;
    }

    if (row.type === 'void' || row.type === 'adjustment') {
      if (!Number.isInteger(row.target)) {
        anomalies.push({ code: 'MISSING_TARGET', sourceId, row, message: '撤销/冲补必须引用具体原号' });
        continue;
      }
      if (!contains(coverage, [row.target, row.target])) {
        // 撤销只能引用同一世代的具体原号；越界（含跨世代）一律不生效。
        anomalies.push({
          code: 'TARGET_OUTSIDE_GENERATION',
          sourceId,
          target: row.target,
          coverage,
          message: `撤销/冲补目标 ${row.target} 不在同世代覆盖 ${JSON.stringify(coverage)} 内`,
        });
        continue;
      }
      const current = perNumber.get(row.target) ?? { sales: 0, voids: [], adjustments: [] };
      if (row.type === 'void') {
        current.voids.push({ statement: row.statement ?? null, sourceId, n: row.n });
      } else {
        current.adjustments.push({ amountFen: row.amountFen, statement: row.statement ?? null, sourceId, n: row.n });
      }
      perNumber.set(row.target, current);
    }
  }

  const totals = new Map();
  for (const [n, entry] of perNumber) {
    let net = entry.sales;
    if (entry.voids.length) net = 0; // 撤销成立后原凭据金额归零，冲补另行追加
    for (const adjustment of entry.adjustments) net += adjustment.amountFen;
    totals.set(n, {
      n,
      saleFen: entry.sales,
      netFen: net,
      voided: entry.voids.length > 0,
      voids: entry.voids,
      adjustments: entry.adjustments,
    });
  }

  // 覆盖区间内缺号也要显式暴露：缺细拆的号不能被当成零额。
  const missing = [];
  for (let n = lo(coverage); n <= hi(coverage); n += 1) {
    if (!totals.has(n)) missing.push(n);
  }
  if (missing.length) {
    anomalies.push({
      code: 'DETAIL_HAS_GAPS',
      sourceId,
      coverage,
      missing,
      message: `明细覆盖 ${JSON.stringify(coverage)} 内缺号 ${missing.join(',')}，缺号不能按零额处理`,
    });
  }

  return { perNumber: totals, coverage, anomalies, observedAt, sourceId };
};

export const sumPerNumber = (perNumber, interval) => {
  let amount = 0;
  for (let n = lo(interval); n <= hi(interval); n += 1) {
    const entry = perNumber.get(n);
    if (!entry) return null;
    amount += entry.netFen;
  }
  return amount;
};
