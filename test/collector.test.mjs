import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startSources } from '../sources/server.mjs';
import { EvidenceStore } from '../src/store.mjs';
import { SourceClient } from '../src/client.mjs';
import { runCollectionCycle } from '../src/collector.mjs';

const allowedPrefixes = ['/books/', '/station/', '/desk/', '/review/', '/scenario/'];

test('采集只请求目录发布的地址，425/404 不产生目录外拉取', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'collector-'));
  const store = await EvidenceStore.open(dir);
  const source = await startSources(0);
  const client = new SourceClient(source.url, store);
  try {
    const plan = await runCollectionCycle({ client, store, stage: 'cutover', now: 134 });

    for (const call of source.calls) {
      assert.ok(
        allowedPrefixes.some(prefix => call.path.startsWith(prefix)),
        `出现目录外请求：${call.path}`,
      );
    }
    // 细拆渠道状态归类：425 可再试，404 未发布
    assert.deepEqual(
      plan.blocked.map(b => [b.id, b.kind, b.retryable]).sort(),
      [
        ['DET-8', 'pending', true],
        ['DET-9', 'not-published', true],
      ],
    );
    // 封存小计按目录地址正常拉取（本周期首次持有）；不出现目录之外的批次地址
    const catalogPaths = new Set(
      (await client.getCatalog()).batches.map(batch => batch.url),
    );
    const batchCalls = source.calls
      .filter(c => c.path.startsWith('/books/') && c.path !== '/books/catalog')
      .map(c => c.path);
    for (const path of batchCalls) assert.ok(catalogPaths.has(path), `目录外批次地址：${path}`);
    assert.ok(batchCalls.includes('/books/DET-7'));
  } finally {
    await source.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('超留存明细只按缺细拆号段发起一个书面核对件并轮询结论', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'review-'));
  const store = await EvidenceStore.open(dir);
  const source = await startSources(0);
  const client = new SourceClient(source.url, store);
  try {
    await runCollectionCycle({ client, store, stage: 'cutover', now: 134 });
    const plan = await runCollectionCycle({ client, store, stage: 'adjustment', now: 138 });

    const expired = plan.blocked.find(b => b.id === 'DET-9');
    assert.equal(expired.kind, 'expired');
    assert.equal(expired.retryable, false);

    assert.equal(plan.reviewRequests.length, 1);
    const request = source.calls.find(c => c.method === 'POST' && c.path === '/review/cases');
    const body = JSON.parse(request.body);
    assert.equal(body.generation, 'G-41');
    assert.deepEqual(body.interval, [124, 129]); // 只发当前缺细拆的世代和号段
    assert.equal(body.source, 'DET-9');

    // 来源服务的 calls 不登记 /scenario 切换也不记录状态码；状态以本地请求日志为准
    assert.ok(source.calls.some(c => c.method === 'GET' && c.path === '/review/cases/WH-6'));
    const loggedPoll = store.requestLog.find(c => c.path === '/review/cases/WH-6');
    assert.equal(loggedPoll.status, 200);
    const record = await store.getReviewCase('WH-6');
    assert.deepEqual(
      record.body.parts.map(p => [p.state, p.interval]),
      [
        ['confirmed', [124, 126]],
        ['unresolved', [127, 129]],
      ],
    );
  } finally {
    await source.close();
    await rm(dir, { recursive: true, force: true });
  }
});
