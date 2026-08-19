/**
 * Fresnel 积分 C(x)=∫₀ˣcos(πt²/2)dt, S(x)=∫₀ˣsin(πt²/2)dt
 *
 * clothoid（回旋线 / OpenDRIVE `<spiral>`）的闭式解依赖这两个积分。
 * 实现采用双路径：
 *   - |x| ≤ 1.8：幂级数，逐项衰减，无抵消误差，精度 ~1e-16
 *   - |x| >  1.8：按相位分段的 16 点 Gauss–Legendre 求积，精度 ~1e-15
 *
 * 之所以不用大参数渐近展开：该级数在 x≈3 附近仅能收敛到 ~1e-10，
 * 而分段 GL 求积在任意区间都能保持机器精度，且代码路径更少。
 * 实际路网中归一化参数 x = s·√(|c'|/π) = √(2Δθ/π)，单条 spiral 转角
 * Δθ 极少超过 2π，故 x < 2.1，分段数很小。
 */

// 求积节点复用 quadrature.ts，避免两处维护同一组常数
import { GL16_NODES as GL_NODES, GL16_WEIGHTS as GL_WEIGHTS } from './quadrature.ts';

const HALF_PI = Math.PI / 2;

/** 幂级数适用上界。取 1.8 时末项量级 < 1e-17，且中间项不超过 ~30，无抵消风险。 */
const SERIES_LIMIT = 1.8;

/** 每个求积子区间允许的最大相位变化（弧度）。1.0 rad 下 16 点 GL 已达机器精度。 */
const MAX_PHASE_PER_SEGMENT = 1.0;

export interface FresnelPair {
  /** C(x) = ∫₀ˣ cos(πt²/2) dt */
  c: number;
  /** S(x) = ∫₀ˣ sin(πt²/2) dt */
  s: number;
}

/**
 * 幂级数展开：
 *   C(x) = Σ (-1)ⁿ (π/2)²ⁿ x⁴ⁿ⁺¹ / ((2n)!(4n+1))
 *   S(x) = Σ (-1)ⁿ (π/2)²ⁿ⁺¹ x⁴ⁿ⁺³ / ((2n+1)!(4n+3))
 */
function fresnelSeries(x: number): FresnelPair {
  const x2 = x * x;
  const x4 = x2 * x2;
  const q = HALF_PI * HALF_PI * x4; // 每次迭代的公共增长因子

  let c = 0;
  let s = 0;

  // termC/termS 为不含符号与除数的累积部分，逐项递推避免阶乘溢出
  let termC = x; // n=0: x
  let termS = HALF_PI * x * x2; // n=0: (π/2)x³
  let sign = 1;

  for (let n = 0; n < 40; n++) {
    const dc = (sign * termC) / (4 * n + 1);
    const ds = (sign * termS) / (4 * n + 3);
    c += dc;
    s += ds;

    if (Math.abs(dc) < 1e-18 && Math.abs(ds) < 1e-18) break;

    // n → n+1：termC *= (π/2)²x⁴/((2n+1)(2n+2))，termS 同理错开一位
    termC = (termC * q) / ((2 * n + 1) * (2 * n + 2));
    termS = (termS * q) / ((2 * n + 2) * (2 * n + 3));
    sign = -sign;
  }

  return { c, s };
}

/**
 * 在 [a,b] 上用 16 点 Gauss–Legendre 同时求 cos/sin 分量积分。
 */
function glSegment(a: number, b: number): FresnelPair {
  const half = (b - a) * 0.5;
  const mid = (a + b) * 0.5;
  let c = 0;
  let s = 0;

  for (let i = 0; i < GL_NODES.length; i++) {
    const node = GL_NODES[i]!;
    const w = GL_WEIGHTS[i]!;
    const offset = half * node;

    // 对称取两侧节点
    const tPlus = mid + offset;
    const tMinus = mid - offset;
    const phasePlus = HALF_PI * tPlus * tPlus;
    const phaseMinus = HALF_PI * tMinus * tMinus;

    c += w * (Math.cos(phasePlus) + Math.cos(phaseMinus));
    s += w * (Math.sin(phasePlus) + Math.sin(phaseMinus));
  }

  return { c: c * half, s: s * half };
}

/**
 * 分段求积：相位 φ(t)=πt²/2，dφ/dt=πt，故靠后区间振荡更快、需更细分段。
 */
function fresnelQuadrature(x: number): FresnelPair {
  // 总相位变化 πx²/2，按 MAX_PHASE_PER_SEGMENT 估算分段数
  const totalPhase = HALF_PI * x * x;
  const segments = Math.max(2, Math.ceil(totalPhase / MAX_PHASE_PER_SEGMENT));

  let c = 0;
  let s = 0;
  let prev = 0;

  for (let i = 1; i <= segments; i++) {
    // 按 √ 分布切分，使各段相位增量大致均等
    const t = (x * Math.sqrt(i)) / Math.sqrt(segments);
    const part = glSegment(prev, t);
    c += part.c;
    s += part.s;
    prev = t;
  }

  return { c, s };
}

/**
 * 计算 Fresnel 积分对 (C(x), S(x))。两者均为奇函数。
 */
export function fresnel(x: number): FresnelPair {
  if (!Number.isFinite(x)) return { c: NaN, s: NaN };

  const ax = Math.abs(x);
  if (ax < 1e-12) return { c: x, s: 0 }; // S ~ (π/2)x³/3，量级 <1e-36，直接取 0

  const r = ax <= SERIES_LIMIT ? fresnelSeries(ax) : fresnelQuadrature(ax);
  return x < 0 ? { c: -r.c, s: -r.s } : r;
}
