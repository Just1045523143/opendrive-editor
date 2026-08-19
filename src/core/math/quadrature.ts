/**
 * 数值求积与弧长反演。
 *
 * 用途有二：
 *   1. Fresnel 积分在大参数区间的分段求积（见 fresnel.ts）
 *   2. poly3 / paramPoly3 图元的弧长参数化反演——这两类图元的原生参数 p
 *      并非弧长，而 OpenDRIVE 的 s 是弧长，必须数值求解 s(p)=target。
 */

/** 16 点 Gauss–Legendre 半边节点（另一半按对称取负） */
export const GL16_NODES = [
  0.095012509837637440185, 0.281603550779258913230, 0.458016777657227386342,
  0.617876244402643748447, 0.755404408355003033895, 0.865631202387831743880,
  0.944575023073232576078, 0.989400934991649932596,
] as const;

/** 对应权重 */
export const GL16_WEIGHTS = [
  0.189450610455068496285, 0.182603415044923588867, 0.169156519395002538189,
  0.149595988816576732081, 0.124628971255533872052, 0.095158511682492784810,
  0.062253523938647892863, 0.027152459411754094852,
] as const;

/** 在 [a,b] 上做 16 点 Gauss–Legendre 求积 */
export function gaussLegendre(f: (t: number) => number, a: number, b: number): number {
  const half = (b - a) * 0.5;
  const mid = (a + b) * 0.5;
  let sum = 0;
  for (let i = 0; i < GL16_NODES.length; i++) {
    const off = half * GL16_NODES[i]!;
    sum += GL16_WEIGHTS[i]! * (f(mid + off) + f(mid - off));
  }
  return sum * half;
}

/** 分段 Gauss–Legendre：把 [a,b] 均分 n 段后逐段求积，用于被积函数变化剧烈时 */
export function gaussLegendreSegmented(
  f: (t: number) => number,
  a: number,
  b: number,
  segments: number,
): number {
  if (segments <= 1) return gaussLegendre(f, a, b);
  const step = (b - a) / segments;
  let sum = 0;
  for (let i = 0; i < segments; i++) {
    sum += gaussLegendre(f, a + i * step, a + (i + 1) * step);
  }
  return sum;
}

/** 弧长累积表：把参数区间离散化，缓存各采样点的累积弧长 */
export interface ArcLengthTable {
  pStart: number;
  pEnd: number;
  /** 采样点参数值，长度 = segments+1 */
  params: Float64Array;
  /** 对应的累积弧长，params[0] 处为 0 */
  lengths: Float64Array;
  /** 总弧长 */
  total: number;
}

/**
 * 构建弧长累积表。speed(p) = |dC/dp| 为参数速度函数。
 */
export function buildArcLengthTable(
  speed: (p: number) => number,
  pStart: number,
  pEnd: number,
  segments = 32,
): ArcLengthTable {
  const n = Math.max(1, segments);
  const params = new Float64Array(n + 1);
  const lengths = new Float64Array(n + 1);
  const step = (pEnd - pStart) / n;

  params[0] = pStart;
  lengths[0] = 0;
  let acc = 0;
  for (let i = 1; i <= n; i++) {
    const p0 = pStart + (i - 1) * step;
    const p1 = pStart + i * step;
    acc += gaussLegendre(speed, p0, p1);
    params[i] = p1;
    lengths[i] = acc;
  }

  return { pStart, pEnd, params, lengths, total: acc };
}

/**
 * 弧长反演：求参数 p 使得从 pStart 起的弧长等于 target。
 *
 * 先在累积表上二分定位区间，再用 Newton 迭代精化
 * （f(p)=arclen(p)-target，f'(p)=speed(p)，速度函数恒正故收敛稳定）。
 */
export function invertArcLength(
  table: ArcLengthTable,
  speed: (p: number) => number,
  target: number,
): number {
  const { params, lengths, total } = table;
  if (target <= 0) return table.pStart;
  if (target >= total) return table.pEnd;

  // 二分定位：找到最大的 i 使 lengths[i] <= target
  let lo = 0;
  let hi = lengths.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (lengths[mid]! <= target) lo = mid;
    else hi = mid;
  }

  const pLo = params[lo]!;
  const sLo = lengths[lo]!;
  const pHi = params[hi]!;
  const sHi = lengths[hi]!;

  // 线性插值作初值
  const span = sHi - sLo;
  let p = span < 1e-15 ? pLo : pLo + ((target - sLo) / span) * (pHi - pLo);

  // Newton 精化，被积区间很短故单段 GL 已足够精确
  for (let iter = 0; iter < 8; iter++) {
    const sHere = sLo + gaussLegendre(speed, pLo, p);
    const residual = sHere - target;
    const v = speed(p);
    if (v < 1e-12) break;
    const dp = residual / v;
    p -= dp;
    if (p < pLo) p = pLo;
    else if (p > pHi) p = pHi;
    if (Math.abs(dp) < 1e-13) break;
  }

  return p;
}
