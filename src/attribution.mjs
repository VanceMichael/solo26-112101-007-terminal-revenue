// 网点归属：交接登记以凭据号切界，世代与网点编号严格分开处理。
// proposed（未确认）：原网点只能确认 stableThrough 及以前；cut 及以后归新网点；
//   中间号段归属未定，允许继续收材料但跨界金额不得先分配。
// confirmed：cut 是新网点开始使用的第一个凭据号。
// single：终端始终在同一网点，不存在交接。

export const classifyNumber = (entry, n) => {
  if (!entry) return { station: null, reason: '缺少交接登记' };
  if (entry.state === 'single') {
    return { station: entry.from, reason: 'single：终端未更换网点' };
  }
  if (entry.state === 'confirmed') {
    return n < entry.cut
      ? { station: entry.from, reason: `confirmed：号 ${n} 早于交接号 ${entry.cut}` }
      : { station: entry.to, reason: `confirmed：号 ${n} 不早于交接号 ${entry.cut}` };
  }
  if (entry.state === 'proposed') {
    if (n <= entry.stableThrough) {
      return { station: entry.from, reason: `proposed：号 ${n} 在 stableThrough=${entry.stableThrough} 内` };
    }
    if (n >= entry.cut) {
      return { station: entry.to, reason: `proposed：号 ${n} 不早于拟议交接号 ${entry.cut}` };
    }
    return {
      station: null,
      reason: `proposed：号 ${n} 落在未定界区间 (${entry.stableThrough}, ${entry.cut})，交接号未确认`,
    };
  }
  return { station: null, reason: `未知交接状态 ${entry.state}` };
};

/**
 * 把一个已定值的覆盖段按归属切成连续小段，每段要么有确定网点，要么 station=null 待核。
 * 禁止按比例分摊：切不出金额的小段保留金额证据引用，由报告层判定能否计入。
 */
export const splitByAttribution = (segment, entry) => {
  const [start, end] = segment.interval;
  const pieces = [];
  let runStart = start;
  let runKey = null;
  const flush = (runEnd) => {
    if (runEnd < runStart) return;
    const sample = classifyNumber(entry, runStart);
    pieces.push({
      ...segment,
      interval: [runStart, runEnd],
      station: sample.station,
      stationReason: sample.reason,
    });
  };
  for (let n = start; n <= end; n += 1) {
    const verdict = classifyNumber(entry, n);
    const key = verdict.station ?? 'PENDING';
    if (runKey === null) runKey = key;
    if (key !== runKey) {
      flush(n - 1);
      runStart = n;
      runKey = key;
    }
  }
  flush(end);
  return pieces;
};
