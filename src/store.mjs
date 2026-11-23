// 本地证据库：持久化采集到的原始报文、目录快照、核对件、请求记录和已签发文件。
// 只依赖 Node 标准库；写入采用临时文件+rename，避免半写文件污染证据链。

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';

export const sha256 = value => createHash('sha256').update(value).digest('hex');

const jsonText = value => `${JSON.stringify(value, null, 2)}\n`;

export class EvidenceStore {
  constructor(rootDir) {
    this.root = rootDir;
    this.dir = {
      catalog: join(rootDir, 'catalog'),
      batches: join(rootDir, 'batches'),
      transfer: join(rootDir, 'transfer'),
      windows: join(rootDir, 'windows'),
      review: join(rootDir, 'review'),
      requests: join(rootDir, 'requests'),
      issued: join(rootDir, 'issued'),
    };
    this.requestLog = [];
  }

  async init() {
    for (const dir of Object.values(this.dir)) await mkdir(dir, { recursive: true });
    try {
      const raw = await readFile(join(this.root, 'requests.log.json'), 'utf8');
      this.requestLog = JSON.parse(raw);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return this;
  }

  static async open(rootDir) {
    return new EvidenceStore(rootDir).init();
  }

  async #write(dir, name, payload) {
    const text = jsonText(payload);
    const target = join(dir, name);
    const temporary = join(dir, `.${name}.tmp-${process.pid}-${this.requestLog.length}`);
    await writeFile(temporary, text);
    await rename(temporary, target);
    return target;
  }

  async #read(dir, name) {
    return JSON.parse(await readFile(join(dir, name), 'utf8'));
  }

  async #list(dir) {
    try {
      return await readdir(dir);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  logRequest(entry) {
    this.requestLog.push({ seq: this.requestLog.length, at: new Date().toISOString(), ...entry });
  }

  async flushRequests() {
    await writeFile(join(this.root, 'requests.log.json'), jsonText(this.requestLog));
  }

  async saveCatalog(stage, catalog) {
    await this.#write(this.dir.catalog, `asof-${catalog.asOf}-${stage}.json`, {
      stage,
      fetchedAt: new Date().toISOString(),
      body: catalog,
      sha256: sha256(jsonText(catalog)),
    });
  }

  async listCatalogs() {
    const names = await this.#list(this.dir.catalog);
    return Promise.all(names.filter(n => n.endsWith('.json')).map(n => this.#read(this.dir.catalog, n)));
  }

  async saveBatch(batch, document) {
    await this.#write(this.dir.batches, `${batch.id}.json`, {
      catalogEntry: batch,
      fetchedAt: new Date().toISOString(),
      document,
      sha256: sha256(jsonText(document)),
    });
  }

  async getBatch(id) {
    try {
      return await this.#read(this.dir.batches, `${id}.json`);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async listBatches() {
    const names = await this.#list(this.dir.batches);
    return Promise.all(names.filter(n => n.endsWith('.json')).map(n => this.#read(this.dir.batches, n)));
  }

  async saveTransfer(stage, transfer) {
    await this.#write(this.dir.transfer, `transfer-${stage}.json`, {
      stage,
      fetchedAt: new Date().toISOString(),
      body: transfer,
    });
  }

  async latestTransfer() {
    const names = await this.#list(this.dir.transfer);
    if (!names.length) return null;
    const payloads = await Promise.all(
      names.filter(n => n.endsWith('.json')).map(n => this.#read(this.dir.transfer, n)),
    );
    // 同一交接登记以采集推进的最新阶段为准，而不是文件名字典序。
    const order = { initial: 0, cutover: 1, adjustment: 2, disputed: 3 };
    const latest = payloads.sort(
      (a, b) => (order[a.stage] ?? -1) - (order[b.stage] ?? -1),
    ).at(-1);
    return latest.body;
  }

  async saveWindows(windows) {
    await this.#write(this.dir.windows, 'windows.json', {
      fetchedAt: new Date().toISOString(),
      body: windows,
    });
  }

  async getWindows() {
    try {
      return (await this.#read(this.dir.windows, 'windows.json')).body;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async saveReviewCase(caseId, payload) {
    await this.#write(this.dir.review, `${caseId}.json`, {
      fetchedAt: new Date().toISOString(),
      body: payload,
    });
  }

  async getReviewCase(caseId) {
    try {
      return await this.#read(this.dir.review, `${caseId}.json`);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async listReviewCases() {
    const names = await this.#list(this.dir.review);
    return Promise.all(names.filter(n => n.endsWith('.json')).map(n => this.#read(this.dir.review, n)));
  }

  async issue(name, payload) {
    await this.#write(this.dir.issued, name, payload);
    return join(this.dir.issued, name);
  }

  async listIssued() {
    const names = await this.#list(this.dir.issued);
    return Promise.all(names.filter(n => n.endsWith('.json')).map(async n => ({ name: n, payload: await this.#read(this.dir.issued, n) })));
  }
}
