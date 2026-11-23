# 零售终端换点后的汇总区间补采与监管月报

以下源只提供货币汇总和匿名凭据号。目录 `/books/catalog` 列批次 ID、范围、格式、替换区段及是否仍可补取。`interval`、`coverage` 和 `replaces` 均为含端点的凭据号闭区间。金额单位分。 `detail` 的 `rows` 记录按原号的金额或指向原凭据的撤销，重新发起同一记录不改变事实。撤销记录有自己的流水号及独立 `target`，表中 `n` 指原凭据号。细拆来源仅供应目录中明确给出的区间地址。
 
归属登记 `/station/transfer` 的 `cut` 是新网点开始使用的第一个凭据号。若仅 `proposed` 表示原网点可以确认所有在 `stableThrough` 及以前的凭据，后续待核。 `/desk/windows` 是监管报送的期间及时间限制，时间以演练整数表示，网点编号和终端世代不能互换。

## 本地来源

资料均为合成记录。Node.js 22 环境下执行 `npm ci`，再用 `npm run sources` 启动，默认监听 `127.0.0.1:4180`。可用环境变量 `PORT` 修改端口。在容器中运行时，服务和访问端处于同一网络命名空间。

`data/sources.json` 保存原始报文及站点页面。连续响应由来源按同一进程内的观察次数提供。阶段从 `initial` 启动，本地演练人员可用 `POST /scenario/阶段名` 切换，未覆盖的路由延用初始响应。切换不清空来源的请求记录。重开服务会复位。

执行 `npm test` 核对来源契约。依赖锁仅包含 Node.js 标准库运行所需的项目清单。容器方式可先执行 `docker build -t terminal-revenue-sources .`，再执行 `docker run --rm terminal-revenue-sources`。镜像准备完成后的验证不需要外网。

## 采集与出报应用（`src/`）

应用只消费上述合成监管汇总，不接交易和出票系统，全部代码仅使用 Node.js 22 标准库。

- `src/intervals.mjs`：含端点闭区间运算（相交、切分、合并、缺口），凭据号在世代内不回卷。
- `src/attribution.mjs`：交接切界。`proposed` 时原网点只能确认 `stableThrough` 及以前，`cut` 及以后归新网点，中间号段归属未定、金额不得先分配；`confirmed` 后以 `cut` 为新网点首号；世代与网点编号不互换。
- `src/details.mjs`：明细逐号折算。`void` 只撤销同世代同覆盖内的具体原号（不能抵另一网点的同号凭据），`adjustment` 追加冲补额；覆盖内缺号显式报异常，不按零额处理；重复行去重。
- `src/model.mjs`：按世代重建覆盖。同覆盖号段只采用最新报文（旧报文留痕为 `retiredDetails`）；证据分级为 `detail` / `written-subtotal` / `subtotal` / `none`；未分解小计切过边界的部分不能定值；书面 `unresolved` 结案段不计入；书面与后到明细分值不一致时保留两源、挂 `disputed`，从未入账的争议金额整体排除，已入账的只维持原额、差额不开补充单。
- `src/collector.mjs`：按目录和争议缺口决定补领，不构造目录外地址、不全量拉取其它网点；425 下周期再试，410 凭 `reference` 转书面核对；每个出站请求落 `requests.log.json`。
- `src/reporting.mjs` / `src/pipeline.mjs`：截点月报、关联原报送的补充单（`first-obtained` / `amount-correction` / `attribution-change`，只含实质差额）、交班逐段视图、争议清单。
- `src/store.mjs`：本地证据库，原始报文、目录快照、核对件和签发文件分目录留存，报文带 SHA-256 哈希，写入采用临时文件加改名。

### 命令

```bash
npm run simulate                 # 进程内启动来源，跑完整四阶段演练并签发到 run/evidence
node src/cli.mjs collect --stage cutover --now 134 \
  --source http://127.0.0.1:4180 --store run/evidence
node src/cli.mjs issue --cutoff firstCutoff --now 135 --store run/evidence
node src/cli.mjs handoff --station R2 --now 149 --store run/evidence
```

`run/evidence/issued/` 下可核对：`report-01-firstCutoff.json`（首份月报）、`supplement-02-linked-01.json`（与原报送哈希关联的补充单）、`disputes-*.json`（争议双源与未入账差额）、`simulation-summary.json`（演练摘要）。

## 书面核对

书面核对办接收 `POST /review/cases` ，内容为世代、号段以及导致缺细拆的来源编号。一次按号段收件， `/review/cases/WH-6` 给出 `confirmed`（金额已证实）或 `unresolved`（无法进一步确认）以及实际覆盖。金额仍以分为单位。若确认子段没有拆到具体凭据，仍按独立小计的证据能力理解。调阅办签名和终端具体凭据可以独立回查。
