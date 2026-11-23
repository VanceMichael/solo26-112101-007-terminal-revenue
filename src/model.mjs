// 覆盖模型：按终端世代重建可出报的凭据覆盖。
//
// 证据分级（同一段金额的证明力）：
//   detail           可逐号核实的原凭据（含同世代撤销/冲补后的净额）
//   written-subtotal 交接办书面确认的子段小计（没有拆到具体凭据，按独立小计理解）
//   subtotal         封存的未分解区间小计（只能证明整个闭区间，不能拆出未重叠部分）
//   none             无金额证据（书面结案 unresolved、缺细拆等）
//
// 段状态：
//   formal               归属确定、分值确定、无未决冲突，可计入正式金额
//   pending-attribution  交接号未确认，金额不得先分配
//   pending-detail       归属已知但缺细拆，只有不能拆分的小计
//   unresolved           书面核对结案为无法再确认
//   disputed             两个确认渠道意见不一致，保留两源，正式金额只含已入账部分

import { isValid, lo, hi, merge, splitBy, contains, intersects, describe } from './intervals.mjs';
import { splitByAttribution } from './attribution.mjs';
import { evaluateDetail, sumPerNumber } from './details.mjs';

const byObserved = (a, b) => a.observedAt - b.observedAt;

/** 同一覆盖号段内只保留最新报文；旧报文保留留痕但不再用于定值。 */
const selectActiveDetails = detailDocs => {
  const groups = new Map();
  for (const doc of detailDocs) {
    const key = `${doc.generation}|${lo(doc.coverage)}-${hi(doc.coverage)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(doc);
  }
  const active = [];
  const retired = [];
  for (const docs of groups.values()) {
    const sorted = [...docs].sort(byObserved);
    sorted.forEach((doc, index) => {
      if (index === sorted.length - 1) active.push(doc);
      else retired.push({ ...doc, supersededBy: sorted.at(-1).id });
    });
  }
  return { active: active.sort(byObserved), retired };
};

const envelopeOf = intervals => merge(intervals.filter(isValid));

const buildBookedIndex = issued => {
  const entries = [];
  for (const record of issued ?? []) {
    const formal = record?.payload?.formalEntries ?? record?.payload?.entries ?? record?.formalEntries ?? record?.entries;
    if (!formal) continue;
    for (const entry of formal) {
      if (!entry?.interval || !entry.generation) continue;
      entries.push(entry);
    }
  }
  return entries;
};

/** 已签发覆盖可能按更粗号段入账；当前段完全落在某条已入账记录内时取回其分值。 */
const findBooking = (bookedEntries, generation, interval) =>
  bookedEntries.find(entry => entry.generation === generation && contains(entry.interval, interval)) ?? null;

export function buildCoverage({ detailDocs, subtotalDocs, reviewCases, transferList, issued = [], now = 0 }) {
  const booked = buildBookedIndex(issued);
  const generations = new Map();
  const anomalies = [];

  const transferByGeneration = new Map((transferList ?? []).map(entry => [entry.generation, entry]));

  const allGenerations = new Set([
    ...detailDocs.map(d => d.generation),
    ...subtotalDocs.map(s => s.generation),
    ...reviewCases.flatMap(c => [c.generation]),
    ...transferByGeneration.keys(),
  ]);

  for (const generation of allGenerations) {
    const transfer = transferByGeneration.get(generation) ?? null;
    const ownDetails = detailDocs.filter(d => d.generation === generation);
    const ownSubtotals = subtotalDocs.filter(s => s.generation === generation);
    const ownReviews = reviewCases.filter(c => c.generation === generation);

    const { active, retired } = selectActiveDetails(ownDetails);
    const evaluated = active.map(doc => ({
      doc,
      ...evaluateDetail(doc.document, { generation, observedAt: doc.observedAt, sourceId: doc.id }),
    }));
    anomalies.push(...evaluated.flatMap(e => e.anomalies.map(a => ({ ...a, generation }))));

    const reviewParts = ownReviews.flatMap(caseRecord =>
      (caseRecord.parts ?? []).map(part => ({
        caseId: caseRecord.caseId,
        generation,
        interval: part.interval,
        state: part.state,
        amountFen: part.amountFen ?? null,
        receipt: part.receipt ?? null,
        observedAt: caseRecord.observedAt,
      })),
    );

    const valueIntervals = [
      ...evaluated.map(e => e.coverage),
      ...reviewParts.map(p => p.interval),
      ...ownSubtotals.map(s => s.interval),
    ];
    const envelopes = envelopeOf(valueIntervals);
    const segments = [];
    for (const envelope of envelopes) {
      const atomic = splitBy(envelope, [
        ...evaluated.map(e => e.coverage),
        ...reviewParts.map(p => p.interval),
        ...ownSubtotals.map(s => s.interval),
      ]);
      for (const bare of atomic) {
        for (const attributed of splitByAttribution({ interval: bare }, transfer)) {
          segments.push(
            assembleSegment({
              segment: attributed,
              generation,
              evaluated,
              reviewParts,
              subtotals: ownSubtotals,
              booked,
              now,
            }),
          );
        }
      }
    }

    const crossChecks = ownSubtotals.map(subtotal => {
      // 按段累加：明细段逐号可查，小计/书面小计段只有整段额，不能按号放大。
      const holders = segments.filter(segment => intersects(segment.interval, subtotal.interval));
      const coversWhole =
        merge(holders.map(h => h.interval)).length === 1 &&
        holders.every(h => contains(subtotal.interval, h.interval)) &&
        lo(holders[0].interval) === lo(subtotal.interval) &&
        hi(holders.at(-1).interval) === hi(subtotal.interval);
      let complete = coversWhole;
      let coveredFen = 0;
      if (complete) {
        for (const holder of holders) {
          const value = holder.bookedFen ?? holder.amountFen;
          if (value === null || holder.status === 'unresolved') {
            complete = false;
            break;
          }
          coveredFen += value;
        }
      }
      return {
        id: subtotal.id,
        interval: subtotal.interval,
        subtotalFen: subtotal.amountFen,
        sealed: subtotal.sealed,
        fullyExplained: complete,
        explainedFen: complete ? coveredFen : null,
        differenceFen: complete ? subtotal.amountFen - coveredFen : null,
        note: complete
          ? '封存小计与当前覆盖逐段可核对'
          : '区间内存在缺细拆或未决段，封存小计原样留存对照，不拆算差额',
      };
    });

    const bookedSegments = segments.filter(
      s => s.status === 'formal' || (s.status === 'disputed' && s.bookedFen !== null),
    );
    const formalAmountFen = bookedSegments.reduce((sum, s) => sum + (s.bookedFen ?? s.amountFen ?? 0), 0);
    const formalByStation = {};
    for (const segment of bookedSegments) {
      const value = segment.bookedFen ?? segment.amountFen ?? 0;
      formalByStation[segment.station] = (formalByStation[segment.station] ?? 0) + value;
    }

    generations.set(generation, {
      generation,
      transfer: transfer
        ? {
            state: transfer.state,
            from: transfer.from,
            to: transfer.to ?? null,
            cut: transfer.cut ?? null,
            stableThrough: transfer.stableThrough ?? null,
          }
        : null,
      envelopes,
      evidence: {
        activeDetails: evaluated.map(({ doc, coverage }) => ({
          id: doc.id,
          coverage,
          replaces: doc.replaces,
          observedAt: doc.observedAt,
          sha256: doc.sha256,
        })),
        retiredDetails: retired.map(doc => ({
          id: doc.id,
          coverage: doc.coverage,
          replaces: doc.replaces,
          observedAt: doc.observedAt,
          supersededBy: doc.supersededBy,
          sha256: doc.sha256,
        })),
        subtotals: ownSubtotals.map(s => ({
          id: s.id,
          interval: s.interval,
          amountFen: s.amountFen,
          sealed: s.sealed,
          sha256: s.sha256,
        })),
        reviewParts,
      },
      segments: segments.sort((a, b) => lo(a.interval) - lo(b.interval)),
      crossChecks,
      formalAmountFen,
      formalByStation,
    });
  }

  return { generatedAt: now, generations: [...generations.values()], anomalies };
}

const detailCovering = (evaluated, interval) =>
  evaluated.find(e => contains(e.coverage, interval));

const writtenPartCovering = (reviewParts, interval) =>
  reviewParts.find(part => part.state === 'confirmed' && contains(part.interval, interval));

const subtotalCovering = (subtotals, interval) =>
  subtotals.find(sub => contains(sub.interval, interval));

function assembleSegment({ segment, generation, evaluated, reviewParts, subtotals, booked, now }) {
  const interval = segment.interval;
  const base = {
    generation,
    interval,
    station: segment.station,
    stationReason: segment.stationReason,
    evidenceKind: 'none',
    amountFen: null,
    bookedFen: null,
    unbookedDeltaFen: null,
    status: 'pending-detail',
    evidenceRefs: [],
    conflict: null,
    note: '',
  };

  const detail = detailCovering(evaluated, interval);
  const written = writtenPartCovering(reviewParts, interval);
  const unresolvedPart = reviewParts.find(part => part.state === 'unresolved' && contains(part.interval, interval));
  const subtotal = subtotalCovering(subtotals, interval);

  if (subtotal) {
    base.evidenceRefs.push({ kind: 'subtotal', id: subtotal.id, interval: subtotal.interval, sha256: subtotal.sha256 });
  }

  // 书面结案：无法再确认，不能计入正式金额。
  if (unresolvedPart) {
    base.status = 'unresolved';
    base.evidenceKind = 'none';
    base.evidenceRefs.push({
      kind: 'review',
      caseId: unresolvedPart.caseId,
      receipt: unresolvedPart.receipt,
      interval: unresolvedPart.interval,
      state: 'unresolved',
    });
    base.note = `交接办结案意见：${describe(unresolvedPart.interval)} 无法进一步确认`;
    return applyAttributionGate(base);
  }

  // 明细与书面确认同时覆盖：核对窗口内到达的新明细必须先检查与已确认号段是否重合。
  if (detail && written) {
    const detailFen = sumPerNumber(detail.perNumber, interval);
    const sameShape =
      lo(written.interval) === lo(interval) && hi(written.interval) === hi(interval);
    base.evidenceRefs.push(
      { kind: 'detail', id: detail.doc.id, coverage: detail.coverage, sha256: detail.doc.sha256, amountFen: detailFen },
      { kind: 'review', caseId: written.caseId, receipt: written.receipt, interval: written.interval, amountFen: written.amountFen, state: 'confirmed' },
    );
    const booking = findBooking(booked, generation, interval);
    const alreadyBooked = booking ? booking.amountFen : null;

    if (detailFen === written.amountFen) {
      base.evidenceKind = 'detail';
      base.amountFen = detailFen;
      base.bookedFen = alreadyBooked;
      base.status = 'formal';
      base.note = '新到明细与书面确认金额一致，两源相互印证';
      return applyAttributionGate(base);
    }

    // 渠道意见不一致：保留两个来源，正式金额只纳入有确定归属和已入账分值的覆盖。
    base.evidenceKind = 'conflict';
    base.conflict = {
      written: { caseId: written.caseId, receipt: written.receipt, amountFen: written.amountFen },
      detail: { id: detail.doc.id, amountFen: detailFen },
      rule: '同一笔不得在报送端同时算作书面补认和新到明细补认',
      observedAt: now,
    };
    if (alreadyBooked === null) {
      // 从未入账：分值已无确定性，整段排除出正式金额，随争议清单交监管人员裁定。
      base.amountFen = null;
      base.bookedFen = null;
      base.unbookedDeltaFen = detailFen - written.amountFen;
      base.status = 'disputed';
      base.note = '书面与明细分值不一致且未入账，争议金额暂不计入正式金额，待监管人员裁定';
    } else {
      // 已签发期内：维持已入账分值，只把实质差额挂账，裁定前不得开补充单。
      base.amountFen = alreadyBooked;
      base.bookedFen = alreadyBooked;
      base.unbookedDeltaFen = detailFen - written.amountFen;
      base.status = 'disputed';
      base.note = `书面与明细分值不一致，维持已入账 ${alreadyBooked} 分，差额 ${base.unbookedDeltaFen} 分开补充单前不得入账`;
    }
    return applyAttributionGate(base);
  }

  if (detail) {
    const detailFen = sumPerNumber(detail.perNumber, interval);
    base.evidenceKind = 'detail';
    base.amountFen = detailFen;
    // 逐号净额随段携带，供补充单在切界重切后按号折算，不做比例分摊。
    base.perNumberFen = Object.fromEntries(
      [...detail.perNumber.entries()]
        .filter(([n]) => contains(interval, [n, n]))
        .map(([n, entry]) => [n, entry.netFen]),
    );
    base.evidenceRefs.push({ kind: 'detail', id: detail.doc.id, coverage: detail.coverage, sha256: detail.doc.sha256 });
    if (detailFen === null) {
      base.status = 'pending-detail';
      base.note = '明细覆盖内存在缺号，缺细拆部分不能按零额计入';
    } else {
      base.status = 'formal';
    }
    return applyAttributionGate(base);
  }

  if (written) {
    const wholePart = lo(written.interval) === lo(interval) && hi(written.interval) === hi(interval);
    base.evidenceRefs.push({
      kind: 'review',
      caseId: written.caseId,
      receipt: written.receipt,
      interval: written.interval,
      amountFen: written.amountFen,
      state: 'confirmed',
    });
    if (!wholePart) {
      // 书面确认没有拆到具体凭据，切过其边界的小段无法独立定值。
      base.evidenceKind = 'subtotal';
      base.status = 'pending-detail';
      base.note = `书面确认 ${describe(written.interval)} 为独立小计，切出的 ${describe(interval)} 无法单独定值`;
      return applyAttributionGate(base);
    }
    base.evidenceKind = 'written-subtotal';
    base.amountFen = written.amountFen;
    base.status = 'formal';
    base.note = '交接办书面确认的独立小计，未拆到具体凭据';
    return applyAttributionGate(base);
  }

  // 只剩封存小计：未分解小计只能证明整个闭区间，切过边界的部分无法证明金额。
  if (subtotal) {
    const wholeSubtotal = lo(subtotal.interval) === lo(interval) && hi(subtotal.interval) === hi(interval);
    if (wholeSubtotal && segment.station !== null) {
      base.evidenceKind = 'subtotal';
      base.amountFen = subtotal.amountFen;
      base.status = 'formal';
      base.note = '整段由封存小计证明，无细拆';
    } else {
      base.evidenceKind = 'subtotal';
      base.status = 'pending-detail';
      base.note = wholeSubtotal
        ? '小计整段归属未定，跨界金额不得先分配'
        : `封存小计 ${describe(subtotal.interval)} 未分解，${describe(interval)} 的金额无法从中间拆出`;
    }
    return applyAttributionGate(base);
  }

  base.note = '无任何金额证据';
  return applyAttributionGate(base);
}

/** 归属闸门：归属未定的段，哪怕分值已知也只能待核，禁止比例分摊。 */
function applyAttributionGate(segment) {
  if (segment.station === null) {
    if (segment.status === 'formal' || segment.status === 'disputed') {
      segment.status = 'pending-attribution';
    } else if (segment.status === 'pending-detail') {
      segment.status = 'pending-attribution';
    }
  }
  return segment;
}
