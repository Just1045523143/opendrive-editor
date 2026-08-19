/**
 * 参考线几何图元求值：给定图元与其上偏移 ds，返回位姿 (x, y, hdg, curvature)。
 *
 * 各图元的处理方式：
 *   line       解析解
 *   arc        解析解
 *   spiral     Fresnel 积分闭式解（见下方推导）
 *   poly3      局部三次多项式 + 弧长反演
 *   paramPoly3 参数三次多项式 + 弧长反演（两种 pRange 都要反演）
 */

import { fresnel } from '../math/fresnel.ts';
import {
  buildArcLengthTable,
  invertArcLength,
  type ArcLengthTable,
} from '../math/quadrature.ts';
import { CURVATURE_EPS, type Geometry, type Pose } from './types.ts';

const HALF_PI = Math.PI / 2;

/** 局部位移（未含起点平移，但已含起点航向旋转） */
interface Offset {
  dx: number;
  dy: number;
}

/**
 * 回旋线位移的闭式解。
 *
 * 曲率线性变化 c(t) = c₀ + c'·t，故航向
 *   θ(t) = hdg + c₀t + (c'/2)t²
 * 位移
 *   Δx = ∫₀^ds cos θ(t) dt,  Δy = ∫₀^ds sin θ(t) dt
 *
 * 记 a = c'/2。当 a > 0，令 u = √(2a/π)·(t + c₀/(2a))，则
 *   θ(t) = φ₀ + πu²/2,  φ₀ = hdg − c₀²/(4a),  dt = √(π/(2a))·du
 * 于是
 *   Δx = √(π/(2a))·[cos φ₀·(C(u₁)−C(u₀)) − sin φ₀·(S(u₁)−S(u₀))]
 *   Δy = √(π/(2a))·[sin φ₀·(C(u₁)−C(u₀)) + cos φ₀·(S(u₁)−S(u₀))]
 * 其中 u₀ = u(0)，u₁ = u(ds)。
 *
 * 当 a < 0：θ 关于 x 轴镜像。以 (−c₀, −c', −hdg) 求解后把 Δy 取反即可。
 * 当 a ≈ 0：退化为定曲率圆弧（或直线）。
 */
function spiralOffset(hdg: number, curvStart: number, cDot: number, ds: number): Offset {
  if (Math.abs(cDot) < 1e-12) {
    return arcOffset(hdg, curvStart, ds);
  }

  if (cDot < 0) {
    const mirrored = spiralOffset(-hdg, -curvStart, -cDot, ds);
    return { dx: mirrored.dx, dy: -mirrored.dy };
  }

  const a = cDot / 2;
  const k = Math.sqrt(HALF_PI / a); // √(π/(2a))
  const invK = 1 / k; // √(2a/π)
  const shift = curvStart / (2 * a);

  const u0 = invK * shift;
  const u1 = invK * (ds + shift);
  const phi0 = hdg - (curvStart * curvStart) / (4 * a);

  const f0 = fresnel(u0);
  const f1 = fresnel(u1);
  const dC = f1.c - f0.c;
  const dS = f1.s - f0.s;

  const cosP = Math.cos(phi0);
  const sinP = Math.sin(phi0);

  return {
    dx: k * (cosP * dC - sinP * dS),
    dy: k * (sinP * dC + cosP * dS),
  };
}

/** 定曲率圆弧位移；曲率趋零时退化为直线 */
function arcOffset(hdg: number, curvature: number, ds: number): Offset {
  if (Math.abs(curvature) < CURVATURE_EPS) {
    return { dx: Math.cos(hdg) * ds, dy: Math.sin(hdg) * ds };
  }
  const r = 1 / curvature;
  const dTheta = curvature * ds;
  // 圆心在起点法向 r 处；位移由弦长与转角给出
  return {
    dx: r * (Math.sin(hdg + dTheta) - Math.sin(hdg)),
    dy: r * (Math.cos(hdg) - Math.cos(hdg + dTheta)),
  };
}

/** poly3 / 归一化 paramPoly3 的弧长表缓存（图元对象为键，几何被替换时自动失效） */
const arcTableCache = new WeakMap<Geometry, ArcLengthTable>();

/** paramPoly3 的参数速度 |dC/dp| */
function paramPoly3Speed(g: Extract<Geometry, { type: 'paramPoly3' }>, p: number): number {
  const du = g.bU + p * (2 * g.cU + 3 * p * g.dU);
  const dv = g.bV + p * (2 * g.cV + 3 * p * g.dV);
  return Math.hypot(du, dv);
}

/** poly3 的参数速度 |d(u, v(u))/du| = √(1 + v'²) */
function poly3Speed(g: Extract<Geometry, { type: 'poly3' }>, u: number): number {
  const dv = g.b + u * (2 * g.c + 3 * u * g.d);
  return Math.hypot(1, dv);
}

function getPoly3Table(g: Extract<Geometry, { type: 'poly3' }>): ArcLengthTable {
  let t = arcTableCache.get(g);
  if (!t) {
    // u 的上界不会超过弧长（因 √(1+v'²) ≥ 1），以 length 为搜索上界是安全的
    t = buildArcLengthTable((u) => poly3Speed(g, u), 0, g.length, 32);
    arcTableCache.set(g, t);
  }
  return t;
}

/**
 * paramPoly3 的弧长表。
 *
 * 参数上界随 pRange 而变：'normalized' 时 p∈[0,1]，'arcLength' 时 p∈[0,length]。
 * 后者的名字容易误导——它只说明 p 的**取值范围**与弧长同量级，并不保证 p 就是
 * 弧长。只有 |dC/dp| ≡ 1 时两者才相等，一般的三次多项式不满足，故同样要反演。
 */
function getParamPoly3Table(g: Extract<Geometry, { type: 'paramPoly3' }>): ArcLengthTable {
  let t = arcTableCache.get(g);
  if (!t) {
    const pEnd = g.pRange === 'arcLength' ? g.length : 1;
    t = buildArcLengthTable((p) => paramPoly3Speed(g, p), 0, pEnd, 32);
    arcTableCache.set(g, t);
  }
  return t;
}

/**
 * 求图元在偏移 ds（相对图元起点，米）处的位姿。ds 会被夹紧到 [0, length]。
 */
export function evaluateGeometry(g: Geometry, ds: number): Pose {
  const t = ds < 0 ? 0 : ds > g.length ? g.length : ds;

  switch (g.type) {
    case 'line':
      return {
        x: g.x + Math.cos(g.hdg) * t,
        y: g.y + Math.sin(g.hdg) * t,
        hdg: g.hdg,
        curvature: 0,
      };

    case 'arc': {
      const o = arcOffset(g.hdg, g.curvature, t);
      return {
        x: g.x + o.dx,
        y: g.y + o.dy,
        hdg: g.hdg + g.curvature * t,
        curvature: g.curvature,
      };
    }

    case 'spiral': {
      const cDot = g.length > 1e-9 ? (g.curvEnd - g.curvStart) / g.length : 0;
      const o = spiralOffset(g.hdg, g.curvStart, cDot, t);
      return {
        x: g.x + o.dx,
        y: g.y + o.dy,
        hdg: g.hdg + g.curvStart * t + 0.5 * cDot * t * t,
        curvature: g.curvStart + cDot * t,
      };
    }

    case 'poly3': {
      const table = getPoly3Table(g);
      const u = invertArcLength(table, (uu) => poly3Speed(g, uu), t);
      const v = g.a + u * (g.b + u * (g.c + u * g.d));
      const dv = g.b + u * (2 * g.c + 3 * u * g.d);
      const ddv = 2 * g.c + 6 * u * g.d;
      const cos = Math.cos(g.hdg);
      const sin = Math.sin(g.hdg);
      // 曲率 κ = v'' / (1+v'²)^{3/2}
      const denom = Math.pow(1 + dv * dv, 1.5);
      return {
        x: g.x + u * cos - v * sin,
        y: g.y + u * sin + v * cos,
        hdg: g.hdg + Math.atan2(dv, 1),
        curvature: denom < 1e-12 ? 0 : ddv / denom,
      };
    }

    case 'paramPoly3': {
      // 两种 pRange 都要反演，区别只在参数上界（见 getParamPoly3Table）
      const table = getParamPoly3Table(g);
      const p = invertArcLength(table, (pp) => paramPoly3Speed(g, pp), t);
      const u = g.aU + p * (g.bU + p * (g.cU + p * g.dU));
      const v = g.aV + p * (g.bV + p * (g.cV + p * g.dV));
      const du = g.bU + p * (2 * g.cU + 3 * p * g.dU);
      const dv = g.bV + p * (2 * g.cV + 3 * p * g.dV);
      const ddu = 2 * g.cU + 6 * p * g.dU;
      const ddv = 2 * g.cV + 6 * p * g.dV;
      const cos = Math.cos(g.hdg);
      const sin = Math.sin(g.hdg);
      // 参数曲线曲率 κ = (u'v'' − v'u'') / (u'²+v'²)^{3/2}
      const sp = du * du + dv * dv;
      const denom = Math.pow(sp, 1.5);
      return {
        x: g.x + u * cos - v * sin,
        y: g.y + u * sin + v * cos,
        hdg: g.hdg + Math.atan2(dv, du),
        curvature: denom < 1e-12 ? 0 : (du * ddv - dv * ddu) / denom,
      };
    }
  }
}

/** 图元终点位姿 */
export function geometryEndPose(g: Geometry): Pose {
  return evaluateGeometry(g, g.length);
}

/** 图元起点位姿 */
export function geometryStartPose(g: Geometry): Pose {
  return evaluateGeometry(g, 0);
}
