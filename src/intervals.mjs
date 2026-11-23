// 闭区间工具：所有 interval/coverage/replaces 均为含端点凭据号闭区间 [lo, hi]。
// 凭据号在终端世代内不回卷，因此同一世代内可直接按整数号比较、切分。

export const isValid = interval =>
  Array.isArray(interval) &&
  interval.length === 2 &&
  Number.isInteger(interval[0]) &&
  Number.isInteger(interval[1]) &&
  interval[0] <= interval[1];

export const lo = interval => interval[0];
export const hi = interval => interval[1];

export const intersects = (a, b) => isValid(a) && isValid(b) && lo(a) <= hi(b) && lo(b) <= hi(a);

export const intersection = (a, b) => {
  if (!intersects(a, b)) return null;
  return [Math.max(lo(a), lo(b)), Math.min(hi(a), hi(b))];
};

export const contains = (outer, inner) =>
  isValid(outer) && isValid(inner) && lo(outer) <= lo(inner) && hi(inner) <= hi(outer);

/** 从被切区间中移除 cutter 覆盖部分，返回不重叠的剩余闭区间（可能 0/1/2 段）。 */
export const subtract = (interval, cutter) => {
  if (!intersects(interval, cutter)) return [interval];
  const pieces = [];
  if (lo(interval) < lo(cutter)) pieces.push([lo(interval), Math.min(hi(interval), lo(cutter) - 1)]);
  if (hi(interval) > hi(cutter)) pieces.push([Math.max(lo(interval), hi(cutter) + 1), hi(interval)]);
  return pieces.filter(isValid);
};

/** 用一组切刀把一个闭区间切成互不重叠、连续覆盖原区间的小段。 */
export const splitBy = (interval, cutters) => {
  const bounds = new Set([lo(interval), hi(interval) + 1]);
  for (const cutter of cutters) {
    if (lo(cutter) > lo(interval) && lo(cutter) <= hi(interval)) bounds.add(lo(cutter));
    if (hi(cutter) + 1 > lo(interval) && hi(cutter) + 1 <= hi(interval)) bounds.add(hi(cutter) + 1);
  }
  const points = [...bounds].sort((a, b) => a - b);
  const pieces = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    pieces.push([points[i], points[i + 1] - 1]);
  }
  return pieces;
};

/** 合并相邻或重叠的闭区间。 */
export const merge = intervals => {
  const sorted = intervals.filter(isValid).sort((a, b) => lo(a) - lo(b) || hi(a) - hi(b));
  const merged = [];
  for (const interval of sorted) {
    const last = merged.at(-1);
    if (last && lo(interval) <= hi(last) + 1) {
      last[1] = Math.max(hi(last), hi(interval));
    } else {
      merged.push([...interval]);
    }
  }
  return merged;
};

/** 把 intervals 中未被 covered 覆盖的部分作为新区间返回。 */
export const gapsWithin = (universe, covered) => {
  let remaining = [universe];
  for (const cutter of covered) {
    remaining = remaining.flatMap(piece => subtract(piece, cutter));
  }
  return remaining;
};

export const keyOf = interval => `${lo(interval)}-${hi(interval)}`;

export const describe = interval => `[${lo(interval)}, ${hi(interval)}]`;
