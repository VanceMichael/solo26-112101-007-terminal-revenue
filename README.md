# 零售终端换点后的汇总区间补采与监管月报

以下源只提供货币汇总和匿名凭据号。目录 `/books/catalog` 列批次 ID、范围、格式、替换区段及是否仍可补取。`interval`、`coverage` 和 `replaces` 均为含端点的凭据号闭区间。金额单位分。 `detail` 的 `rows` 记录按原号的金额或指向原凭据的撤销，重新发起同一记录不改变事实。撤销记录有自己的流水号及独立 `target`，表中 `n` 指原凭据号。细拆来源仅供应目录中明确给出的区间地址。
 
归属登记 `/station/transfer` 的 `cut` 是新网点开始使用的第一个凭据号。若仅 `proposed` 表示原网点可以确认所有在 `stableThrough` 及以前的凭据，后续待核。 `/desk/windows` 是监管报送的期间及时间限制，时间以演练整数表示，网点编号和终端世代不能互换。

## 本地来源

资料均为合成记录。Node.js 22 环境下执行 `npm ci`，再用 `npm run sources` 启动，默认监听 `127.0.0.1:4180`。可用环境变量 `PORT` 修改端口。在容器中运行时，服务和访问端处于同一网络命名空间。

`data/sources.json` 保存原始报文及站点页面。连续响应由来源按同一进程内的观察次数提供。阶段从 `initial` 启动，本地演练人员可用 `POST /scenario/阶段名` 切换，未覆盖的路由延用初始响应。切换不清空来源的请求记录。重开服务会复位。

执行 `npm test` 核对来源契约。依赖锁仅包含 Node.js 标准库运行所需的项目清单。容器方式可先执行 `docker build -t terminal-revenue-sources .`，再执行 `docker run --rm terminal-revenue-sources`。镜像准备完成后的验证不需要外网。
