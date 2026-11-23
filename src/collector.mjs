// 采集计划：每次采集根据争议区段和来源重传清单决定补领何处。
// 纪律：
//  - 细拆来源仅供应目录中明确给出的区间地址，不构造目录之外的拉取；
//  - 不能为查一段样本全量拉取其它网点资料（按世代内缺口与目录批次的交集决定）；
//  - availableUntil 已过的批次不再请求细拆渠道，直接转书面核对；
//  - 425 归档中：记录后下次再试；410 超留存：按 reference 发起书面核对；
//  - 核对窗口内到达的新明细先与已确认号段比对（由模型层判争议）。

import { classifyFailure } from './client.mjs';

const isDetail = batch => batch.kind === 'detail';
const isSubtotal = batch => batch.kind === 'subtotal';

export async function runCollectionCycle({ client, store, stage, now }) {
  await client.selectStage(stage);
  const catalog = await client.getCatalog();
  await store.saveCatalog(stage, catalog);
  const transfer = await client.getTransfer();
  await store.saveTransfer(stage, transfer);
  if (!(await store.getWindows())) {
    const windows = await client.getWindows();
    await store.saveWindows(windows);
  }

  const plan = {
    stage,
    now,
    catalogAsOf: catalog.asOf,
    fetched: [],
    retained: [],
    blocked: [],
    reviewRequests: [],
    reviewPolls: [],
  };

  const held = await store.listBatches();
  const heldById = new Map(held.map(record => [record.catalogEntry.id, record]));

  for (const batch of catalog.batches) {
    const known = heldById.get(batch.id);

    if (isSubtotal(batch)) {
      // 封存小计：未持有则取，已持有则原样留住用于对照，不重复拉取。
      if (!known) {
        try {
          const document = await client.getBatch(batch);
          await store.saveBatch(batch, document);
          plan.fetched.push({ id: batch.id, kind: batch.kind, interval: batch.interval });
        } catch (error) {
          plan.blocked.push({ id: batch.id, ...classifyFailure(error) });
        }
      } else {
        plan.retained.push({ id: batch.id, reason: '封存小计已持有，原样留存对照' });
      }
      continue;
    }

    if (!isDetail(batch)) continue;

    // 目录新汇总明确声明 replaces；仅当 replaces 区段变化（切过已有小计边界）时才重取。
    const replacesChanged =
      known && JSON.stringify(known.catalogEntry.replaces ?? null) !== JSON.stringify(batch.replaces ?? null);

    if (known && !replacesChanged) {
      plan.retained.push({ id: batch.id, reason: '该批次报文已取得且 replaces 未变化' });
      continue;
    }

    // 留存期信息只是目录提示：仍先向细拆渠道实际请求一次，
    // 由 410 响应（含书面核对 reference）驱动转件，避免凭目录猜测渠道状态。
    try {
      const document = await client.getBatch(batch);
      await store.saveBatch(batch, document);
      plan.fetched.push({
        id: batch.id,
        kind: batch.kind,
        interval: batch.interval,
        replaces: batch.replaces ?? null,
        retransmitted: Boolean(known),
        pastAvailableUntil: Number.isInteger(batch.availableUntil) && batch.availableUntil < now,
      });
    } catch (error) {
      plan.blocked.push({ id: batch.id, interval: batch.interval, generation: batch.generation, ...classifyFailure(error) });
    }
  }

  // 目录中已消失但库里仍持有的批次（如 DET-7 被 DET-7b 替换）：保留留痕，不再请求。
  const currentIds = new Set(catalog.batches.map(batch => batch.id));
  for (const record of held) {
    if (!currentIds.has(record.catalogEntry.id)) {
      plan.retained.push({ id: record.catalogEntry.id, reason: '目录已撤下，保留原报文留痕，不再拉取' });
    }
  }

  await planWrittenReviews({ client, store, plan, now });
  await store.flushRequests();
  return plan;
}

/** 只把当前缺细拆的世代和号段发给交接办；一个核对件可先确认其中某一段或结案。 */
async function planWrittenReviews({ client, store, plan }) {
  const expired = plan.blocked.filter(b => b.kind === 'expired');
  const existing = await store.listReviewCases();

  for (const block of expired) {
    const caseRef = block.reference;
    const already = existing.find(record => record.body.case === caseRef);
    if (!already) {
      try {
        const acknowledged = await client.openReviewCase({
          generation: block.generation,
          interval: block.interval,
          reason: block.reason,
          sourceId: block.id,
        });
        plan.reviewRequests.push({
          caseId: acknowledged.case ?? caseRef,
          generation: block.generation,
          interval: block.interval,
          sourceId: block.id,
        });
      } catch (error) {
        plan.blocked.push({ id: block.id, review: true, ...classifyFailure(error) });
        continue;
      }
    }
    if (caseRef) {
      try {
        const caseRecord = await client.getReviewCase(caseRef);
        await store.saveReviewCase(caseRef, caseRecord);
        plan.reviewPolls.push({ caseId: caseRef, parts: caseRecord.parts?.length ?? 0 });
      } catch (error) {
        const classified = classifyFailure(error);
        plan.blocked.push({ id: caseRef, review: true, ...classified });
      }
    }
  }

  // 已发起的核对件也要持续轮询，直至全部子段有 confirmed/unresolved 结论。
  for (const record of existing) {
    const caseId = record.body.case;
    const settled = (record.body.parts ?? []).every(part => part.state === 'confirmed' || part.state === 'unresolved');
    if (settled) continue;
    try {
      const caseRecord = await client.getReviewCase(caseId);
      await store.saveReviewCase(caseId, caseRecord);
      plan.reviewPolls.push({ caseId, parts: caseRecord.parts?.length ?? 0 });
    } catch (error) {
      plan.blocked.push({ id: caseId, review: true, ...classifyFailure(error) });
    }
  }
}

/** 把库内证据整理成模型层输入。 */
export async function loadEvidenceInputs(store) {
  const [batches, transfer, reviewRecords] = await Promise.all([
    store.listBatches(),
    store.latestTransfer(),
    store.listReviewCases(),
  ]);
  const detailDocs = [];
  const subtotalDocs = [];
  for (const record of batches) {
    const entry = record.catalogEntry;
    const common = {
      id: entry.id,
      generation: entry.generation,
      observedAt: Date.parse(record.fetchedAt) ?? 0,
      sha256: record.sha256,
      interval: entry.interval,
    };
    if (entry.kind === 'detail') {
      detailDocs.push({
        ...common,
        replaces: entry.replaces ?? record.document.coverage ?? entry.interval,
        coverage: record.document.coverage ?? entry.interval,
        document: record.document,
      });
    } else if (entry.kind === 'subtotal') {
      subtotalDocs.push({
        ...common,
        sealed: entry.sealed ?? false,
        amountFen: record.document.amountFen,
      });
    }
  }
  const reviewCases = reviewRecords.map(record => ({
    caseId: record.body.case,
    generation: record.body.generation,
    observedAt: Date.parse(record.fetchedAt) ?? 0,
    interval: record.body.interval,
    parts: record.body.parts ?? [],
  }));
  return {
    detailDocs: detailDocs.sort((a, b) => a.observedAt - b.observedAt),
    subtotalDocs,
    reviewCases,
    transferList: transfer ?? [],
  };
}
