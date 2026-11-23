// 来源访问客户端：所有出站请求都留痕，状态码按业务语义归类。
// - 200 正常取得报文
// - 425 细拆暂不可得（归档中），后续采集周期可再试
// - 410 超过留存期，只能按 reference 走书面核对
// - 404 来源尚未发布该资源（核对件未发起等），不等于永久不可得

export class SourceError extends Error {
  constructor(status, path, body) {
    super(`来源 ${path} 返回 ${status}`);
    this.name = 'SourceError';
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

export class SourceClient {
  constructor(baseUrl, store) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.store = store;
  }

  async request(method, path, body) {
    const started = Date.now();
    const options =
      body === undefined
        ? { method }
        : { method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } };
    let response;
    try {
      response = await fetch(this.baseUrl + path, options);
    } catch (error) {
      this.store.logRequest({ method, path, stage: this.stage, error: error.message });
      throw error;
    }
    const text = await response.text();
    let parsed = null;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json') && text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    const entry = {
      method,
      path,
      stage: this.stage,
      status: response.status,
      ms: Date.now() - started,
      ...(body === undefined ? {} : { requestBody: body }),
      ...(parsed === null ? { rawText: text.slice(0, 500) } : { responseBody: parsed }),
    };
    this.store.logRequest(entry);
    if (!response.ok) throw new SourceError(response.status, path, parsed ?? text);
    return parsed ?? text;
  }

  get(path) {
    return this.request('GET', path);
  }

  post(path, body) {
    return this.request('POST', path, body);
  }

  async selectStage(stage) {
    this.stage = stage;
    await this.request('POST', `/scenario/${stage}`);
  }

  async getCatalog() {
    return this.get('/books/catalog');
  }

  async getTransfer() {
    return this.get('/station/transfer');
  }

  async getWindows() {
    return this.get('/desk/windows');
  }

  async getBatch(batch) {
    return this.get(batch.url);
  }

  async openReviewCase({ generation, interval, reason, sourceId }) {
    const body = { generation, interval, reason, source: sourceId };
    return this.post('/review/cases', body);
  }

  async getReviewCase(caseId) {
    return this.get(`/review/cases/${caseId}`);
  }
}

// 把来源异常映射成采集计划可处理的结论，不抛断整个采集周期。
export const classifyFailure = error => {
  if (!(error instanceof SourceError)) return { kind: 'network', retryable: true, error };
  switch (error.status) {
    case 410:
      return {
        kind: 'expired',
        retryable: false,
        reference: error.body?.reference ?? null,
        reason: error.body?.reason ?? '原明细超过留存期',
      };
    case 425:
      return { kind: 'pending', retryable: true, reason: error.body?.reason ?? '细拆归档中' };
    case 404:
      return { kind: 'not-published', retryable: true, reason: error.body?.message ?? '来源未发布' };
    case 422:
      return { kind: 'rejected', retryable: false, reason: error.body?.message ?? '申请表不可受理' };
    default:
      return { kind: 'http-error', retryable: true, status: error.status, reason: error.message };
  }
};
