// 命令行入口：针对已运行的来源服务执行采集、签发、交班视图。
// 用法：
//   node src/cli.mjs collect  --stage cutover --now 134
//   node src/cli.mjs issue    --cutoff firstCutoff --now 135
//   node src/cli.mjs handoff  --station R2 [--generation G-41]
//   node src/cli.mjs simulate（内置启动来源，跑完整四阶段演练）

import { resolve } from 'node:path';
import { EvidenceStore } from './store.mjs';
import { SourceClient } from './client.mjs';
import { runCollectionCycle } from './collector.mjs';
import { issueAtCutoff, handoffForStation } from './pipeline.mjs';
import { runSimulation } from './simulate.mjs';

const parseArgs = argv => {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    }
  }
  return args;
};

const main = async () => {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const root = resolve(args.store ?? 'run/evidence');
  const store = await EvidenceStore.open(root);

  if (command === 'simulate') {
    const result = await runSimulation({ store, keepServer: Boolean(args.keepServer) });
    console.log(JSON.stringify(result.summary, null, 2));
    return;
  }

  const baseUrl = args.source ?? 'http://127.0.0.1:4180';
  const client = new SourceClient(baseUrl, store);

  if (command === 'collect') {
    const plan = await runCollectionCycle({
      client,
      store,
      stage: args.stage,
      now: Number(args.now),
    });
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  if (command === 'issue') {
    const result = await issueAtCutoff({
      store,
      now: Number(args.now),
      cutoffKind: args.cutoff,
    });
    console.log(JSON.stringify({ kind: result.kind, path: result.path }, null, 2));
    return;
  }

  if (command === 'handoff') {
    const view = await handoffForStation(store, {
      station: args.station ?? null,
      generation: args.generation ?? null,
      now: Number(args.now ?? 0),
    });
    console.log(JSON.stringify(view, null, 2));
    return;
  }

  if (!command || ['-h', '--help', 'help'].includes(command)) {
    console.log(
      [
        '用法：node src/cli.mjs <命令> [选项]',
        '  simulate                                      进程内启动来源并跑完整四阶段演练',
        '  collect --stage <阶段> --now <整数>           执行一次采集周期',
        '  issue   --cutoff firstCutoff|correctionCutoff --now <整数>',
        '  handoff [--station R2] [--generation G-41]   交班逐段核对视图',
        '通用选项：--source http://127.0.0.1:4180 --store run/evidence',
      ].join('\n'),
    );
    return;
  }

  console.error(`未知命令：${command}`);
  process.exitCode = 1;
};

main().catch(error => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
