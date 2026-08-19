/**
 * 三次多项式工具。OpenDRIVE 中 elevation / superelevation / laneOffset / width
 * 均形如 f(ds) = a + b·ds + c·ds² + d·ds³，其中 ds 为相对各记录起点的偏移。
 */

export interface Poly3 {
  a: number;
  b: number;
  c: number;
  d: number;
}

export const ZERO_POLY3: Poly3 = { a: 0, b: 0, c: 0, d: 0 };

export function constPoly3(value: number): Poly3 {
  return { a: value, b: 0, c: 0, d: 0 };
}

export function evalPoly3(p: Poly3, ds: number): number {
  return p.a + ds * (p.b + ds * (p.c + ds * p.d));
}

/** 一阶导 f'(ds) */
export function evalPoly3Derivative(p: Poly3, ds: number): number {
  return p.b + ds * (2 * p.c + 3 * ds * p.d);
}

/** 二阶导 f''(ds) */
export function evalPoly3SecondDerivative(p: Poly3, ds: number): number {
  return 2 * p.c + 6 * ds * p.d;
}

/**
 * 构造在 [0,len] 上满足端点值与端点斜率的三次多项式（Hermite 插值）。
 * 用于生成平滑的车道宽度过渡（如渐变加宽/收窄）与高程衔接。
 */
export function hermitePoly3(v0: number, v1: number, slope0: number, slope1: number, len: number): Poly3 {
  if (len <= 1e-9) return constPoly3(v0);
  const l2 = len * len;
  const l3 = l2 * len;
  return {
    a: v0,
    b: slope0,
    c: (3 * (v1 - v0)) / l2 - (2 * slope0 + slope1) / len,
    d: (2 * (v0 - v1)) / l3 + (slope0 + slope1) / l2,
  };
}

/**
 * 一组按 s 排序的分段多项式记录（每段自带起始 s，取值时用 ds = s - sOffset）。
 */
export interface PolyRecord extends Poly3 {
  /** 该段在参考线上的起始 s（米） */
  s: number;
}

/** 二分查找 s 所落入的记录索引；返回 -1 表示 s 落在首条记录之前 */
export function findRecordIndex(records: readonly PolyRecord[], s: number): number {
  let lo = 0;
  let hi = records.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (records[mid]!.s <= s) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** 在分段多项式序列上求值；序列为空或 s 在首段之前时返回 fallback */
export function evalRecords(records: readonly PolyRecord[], s: number, fallback = 0): number {
  if (records.length === 0) return fallback;
  const i = findRecordIndex(records, s);
  if (i < 0) {
    // s 早于首条记录：按 OpenDRIVE 惯例沿用首条记录的值
    const first = records[0]!;
    return evalPoly3(first, 0);
  }
  const rec = records[i]!;
  return evalPoly3(rec, s - rec.s);
}

/** 在分段多项式序列上求一阶导 */
export function evalRecordsDerivative(records: readonly PolyRecord[], s: number): number {
  if (records.length === 0) return 0;
  const i = findRecordIndex(records, s);
  if (i < 0) return 0;
  const rec = records[i]!;
  return evalPoly3Derivative(rec, s - rec.s);
}
