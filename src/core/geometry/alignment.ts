/**
 * 线形生成：把用户点击的折线转成 OpenDRIVE 几何图元链。
 *
 * 提供两种拟合模式：
 *
 *   'arc'    直线 + 切线圆弧（圆角）。转角处插入与两侧直线相切的圆弧，
 *            切线长 T = R·tan(Δ/2)。几何精确、导出即为 line/arc，无近似。
 *
 *   'spiral' 缓和曲线（clothoid-arc-clothoid）。符合道路设计规范的线形，
 *            曲率连续（无离心加速度突变），也是实车/仿真更真实的形态。
 *
 * 缓和曲线的切线长推导（顶点在原点、入射方向沿 +x、转角 Δ>0 左转）：
 *   设入口回旋线起点在 (−T, 0)，航向 0，长度 Ls，终点曲率 1/R。
 *   其终点相对起点位移 (xs, ys)、航向增量 Δs = Ls/(2R)。
 *   圆心 = 终点 + R·左法向 = (−T + xs − R·sin Δs,  ys + R·cos Δs)。
 *   纯圆角时圆心为 (−R·tan(Δ/2), R)，故角平分线约束为 Cx = −Cy·tan(Δ/2)，解得
 *       T = xs − R·sin Δs + (ys + R·cos Δs)·tan(Δ/2)
 *   Ls→0 时 xs=ys=Δs=0，退化为 T = R·tan(Δ/2)，与圆角一致。
 */

import { evaluateGeometry } from './evaluate.ts';
import { gaussLegendreSegmented } from '../math/quadrature.ts';
import {
  angleDelta,
  distance,
  fromAngle,
  normalizeAngle,
  type Vec2,
} from '../math/vec.ts';
import type { Geometry } from './types.ts';

export type FitMode = 'arc' | 'spiral' | 'polyline';

export interface FitOptions {
  mode: FitMode;
  /** 圆角/圆曲线半径（米） */
  radius: number;
  /** 缓和曲线长度（米），仅 mode='spiral' 时使用 */
  spiralLength: number;
}

export const DEFAULT_FIT: FitOptions = {
  mode: 'spiral',
  radius: 60,
  spiralLength: 25,
};

/** 转角小于此值视为共线，不插入曲线 */
const MIN_DEFLECTION = 1e-4;

/** 长度小于此值的图元不予输出，避免产生退化段 */
const MIN_SEGMENT = 1e-4;

/** 入口回旋线终点在局部系（起点在原点、航向 0）的位移与航向增量 */
function spiralEndOffset(radius: number, spiralLength: number): { xs: number; ys: number; ds: number } {
  const probe: Geometry = {
    type: 'spiral',
    s: 0,
    x: 0,
    y: 0,
    hdg: 0,
    length: spiralLength,
    curvStart: 0,
    curvEnd: 1 / radius,
  };
  const end = evaluateGeometry(probe, spiralLength);
  return { xs: end.x, ys: end.y, ds: end.hdg };
}

/** 单个顶点的转角处理结果 */
interface CornerFit {
  /** 顶点两侧所需切线长 */
  tangent: number;
  /** 从切点开始的图元序列（相对位姿由调用方补全） */
  build: (start: Vec2, hdg: number, sBase: number) => Geometry[];
}

/**
 * 计算某顶点的圆角/缓和曲线拟合。
 * deflection 为有向转角（左正右负），已保证 |deflection| > MIN_DEFLECTION。
 */
function fitCorner(deflection: number, opts: FitOptions): CornerFit | null {
  const turn = Math.sign(deflection);
  const delta = Math.abs(deflection);

  // 转角接近平角（掉头）无法用圆角衔接
  if (delta > Math.PI - 1e-3) return null;

  const R = opts.radius;
  const halfTan = Math.tan(delta / 2);

  if (opts.mode === 'arc' || opts.spiralLength <= MIN_SEGMENT) {
    const tangent = R * halfTan;
    return {
      tangent,
      build: (start, hdg, sBase) => {
        const arcLen = R * delta;
        if (arcLen < MIN_SEGMENT) return [];
        return [
          {
            type: 'arc',
            s: sBase,
            x: start.x,
            y: start.y,
            hdg,
            length: arcLen,
            curvature: turn / R,
          },
        ];
      },
    };
  }

  // 缓和曲线：先按给定 Ls 试算，若圆曲线转角不足则缩短 Ls
  let Ls = opts.spiralLength;
  // 两段回旋线各消耗 Ls/(2R) 转角，圆曲线转角 = Δ − Ls/R，要求 ≥ 0
  const maxLs = delta * R;
  if (Ls > maxLs) Ls = maxLs;
  if (Ls < MIN_SEGMENT) {
    return fitCorner(deflection, { ...opts, mode: 'arc' });
  }

  const { xs, ys, ds } = spiralEndOffset(R, Ls);
  const tangent = xs - R * Math.sin(ds) + (ys + R * Math.cos(ds)) * halfTan;
  const arcDelta = delta - 2 * ds;

  return {
    tangent,
    build: (start, hdg, sBase) => {
      const out: Geometry[] = [];
      let s = sBase;
      let cur = { ...start };
      let h = hdg;

      // 入口回旋线：曲率 0 → turn/R
      const entry: Geometry = {
        type: 'spiral',
        s,
        x: cur.x,
        y: cur.y,
        hdg: h,
        length: Ls,
        curvStart: 0,
        curvEnd: turn / R,
      };
      out.push(entry);
      const afterEntry = evaluateGeometry(entry, Ls);
      s += Ls;
      cur = { x: afterEntry.x, y: afterEntry.y };
      h = afterEntry.hdg;

      // 圆曲线
      const arcLen = R * arcDelta;
      if (arcLen > MIN_SEGMENT) {
        const arc: Geometry = {
          type: 'arc',
          s,
          x: cur.x,
          y: cur.y,
          hdg: h,
          length: arcLen,
          curvature: turn / R,
        };
        out.push(arc);
        const afterArc = evaluateGeometry(arc, arcLen);
        s += arcLen;
        cur = { x: afterArc.x, y: afterArc.y };
        h = afterArc.hdg;
      }

      // 出口回旋线：曲率 turn/R → 0
      out.push({
        type: 'spiral',
        s,
        x: cur.x,
        y: cur.y,
        hdg: h,
        length: Ls,
        curvStart: turn / R,
        curvEnd: 0,
      });

      return out;
    },
  };
}

/**
 * 在切线长预算内求可行的顶点拟合。
 *
 * 圆角模式下 T = R·tan(Δ/2) 与 R 严格成正比，故可直接解出恰好合规的半径；
 * 缓和曲线模式下 T 对 R 近似线性，迭代两轮即可收敛。若缓和曲线仍不可行，
 * 则退回圆角——后者有解析解，数学上保证可行，从而不会产出断裂的几何链。
 */
function fitCornerWithinBudget(
  deflection: number,
  opts: FitOptions,
  budget: number,
): { corner: CornerFit; shrunk: boolean } | null {
  const delta = Math.abs(deflection);
  if (delta > Math.PI - 1e-3 || budget < MIN_SEGMENT) return null;

  const first = fitCorner(deflection, opts);
  if (first && first.tangent <= budget) return { corner: first, shrunk: false };

  // 缩半径重试
  if (first && opts.mode === 'spiral') {
    let radius = opts.radius;
    for (let iter = 0; iter < 4; iter++) {
      const probe = fitCorner(deflection, {
        ...opts,
        radius,
        spiralLength: Math.min(opts.spiralLength, radius * delta),
      });
      if (!probe) break;
      if (probe.tangent <= budget) return { corner: probe, shrunk: true };
      // 留 2% 余量，避免线性外推后仍超预算而反复迭代
      radius *= (budget / probe.tangent) * 0.98;
      if (radius < 1) break;
    }
  }

  // 圆角解析解：R = budget / tan(Δ/2)
  const halfTan = Math.tan(delta / 2);
  if (halfTan < 1e-9) return null;
  const exactRadius = budget / halfTan;
  const fallback = fitCorner(deflection, { ...opts, mode: 'arc', radius: exactRadius });
  return fallback ? { corner: fallback, shrunk: true } : null;
}

export interface FitResult {
  geometries: Geometry[];
  /** 因约束（半径过大/点距过近）而被降级处理的顶点下标 */
  degradedCorners: number[];
  totalLength: number;
}

/**
 * 由折线点列生成几何图元链。
 *
 * 相邻顶点间距不足以容纳所需切线长时，该顶点自动缩减半径；仍不可行则退化为
 * 折线尖角（记入 degradedCorners，界面据此提示用户）。
 */
export function fitAlignment(points: readonly Vec2[], options: Partial<FitOptions> = {}): FitResult {
  const opts: FitOptions = { ...DEFAULT_FIT, ...options };
  const geometries: Geometry[] = [];
  const degraded: number[] = [];

  if (points.length < 2) {
    return { geometries, degradedCorners: degraded, totalLength: 0 };
  }

  // 预处理：剔除重复点
  const pts: Vec2[] = [points[0]!];
  for (let i = 1; i < points.length; i++) {
    if (distance(points[i]!, pts[pts.length - 1]!) > 1e-6) pts.push(points[i]!);
  }
  if (pts.length < 2) {
    return { geometries, degradedCorners: degraded, totalLength: 0 };
  }

  // 各段方向与长度
  const dirs: number[] = [];
  const lens: number[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    dirs.push(Math.atan2(b.y - a.y, b.x - a.x));
    lens.push(distance(a, b));
  }

  // 逐顶点计算切线长，受两侧段长约束（各段最多让出一半长度）
  const corners: Array<{ fit: CornerFit; deflection: number } | null> = [];
  const tangents: number[] = [];

  for (let i = 1; i < pts.length - 1; i++) {
    const deflection = angleDelta(dirs[i - 1]!, dirs[i]!);
    if (Math.abs(deflection) < MIN_DEFLECTION) {
      corners.push(null);
      tangents.push(0);
      continue;
    }

    const budget = Math.min(lens[i - 1]!, lens[i]!) * 0.5;
    const fit = fitCornerWithinBudget(deflection, opts, budget);

    if (!fit) {
      // 仅在掉头级转角（|Δ|→π）时发生，此处无法用圆角衔接
      degraded.push(i);
      corners.push(null);
      tangents.push(0);
    } else {
      if (fit.shrunk) degraded.push(i);
      corners.push({ fit: fit.corner, deflection });
      tangents.push(fit.corner.tangent);
    }
  }

  // 组装图元链
  let cursor: Vec2 = { ...pts[0]! };
  let s = 0;

  for (let seg = 0; seg < dirs.length; seg++) {
    const dir = dirs[seg]!;
    const endVertex = pts[seg + 1]!;
    const cornerIdx = seg; // corners[seg] 对应顶点 pts[seg+1]
    const corner = seg < corners.length ? corners[cornerIdx] : null;
    const tangentOut = corner ? tangents[cornerIdx]! : 0;

    // 本段直线：从 cursor 到（顶点 − 切线长）
    const target = corner
      ? {
          x: endVertex.x - Math.cos(dir) * tangentOut,
          y: endVertex.y - Math.sin(dir) * tangentOut,
        }
      : endVertex;

    const straightLen = distance(cursor, target);
    // 用点积判断 target 是否在前进方向上，避免切线长过大时产生反向直线
    const forward =
      (target.x - cursor.x) * Math.cos(dir) + (target.y - cursor.y) * Math.sin(dir);

    if (straightLen > MIN_SEGMENT && forward > 0) {
      geometries.push({
        type: 'line',
        s,
        x: cursor.x,
        y: cursor.y,
        hdg: dir,
        length: straightLen,
      });
      s += straightLen;
      cursor = target;
    } else if (forward <= 0) {
      // 切线长吞掉了整段直线，直接跳到切点
      cursor = target;
    }

    if (corner) {
      const built = corner.fit.build(cursor, dir, s);
      for (const g of built) {
        geometries.push(g);
        s += g.length;
      }
      const last = built[built.length - 1];
      if (last) {
        const end = evaluateGeometry(last, last.length);
        cursor = { x: end.x, y: end.y };
      }
    }
  }

  return { geometries, degradedCorners: degraded, totalLength: s };
}

/**
 * 由两点与两端航向生成单段几何（用于交叉口转向连接道路）。
 * 采用 paramPoly3 的 Hermite 形式，可精确满足两端位姿。
 *
 * `tangentScale` 控制曲线饱满度，默认取弦长（曲率接近圆弧）。掉头连接的弦长
 * 只有一个车道宽，按弦长取切线会缩成半径不足 2 m 的死弯，需显式放大。
 */
export function fitHermiteConnector(
  start: Vec2,
  startHdg: number,
  end: Vec2,
  endHdg: number,
  sBase = 0,
  tangentScale?: number,
): Geometry {
  const chord = distance(start, end);
  const scale = tangentScale !== undefined && tangentScale > 0 ? tangentScale : chord;
  const d0 = fromAngle(startHdg, scale);
  const d1 = fromAngle(endHdg, scale);

  // 转到以 start 为原点、startHdg 为 u 轴的局部系
  const cos = Math.cos(-startHdg);
  const sin = Math.sin(-startHdg);
  const toLocal = (v: Vec2): Vec2 => ({
    x: v.x * cos - v.y * sin,
    y: v.x * sin + v.y * cos,
  });

  const p1 = toLocal({ x: end.x - start.x, y: end.y - start.y });
  const t0 = toLocal(d0);
  const t1 = toLocal(d1);

  // Hermite: P(p) = h00·P0 + h10·T0 + h01·P1 + h11·T1，P0 = 0
  // 展开为 p 的三次多项式系数
  const aU = 0;
  const bU = t0.x;
  const cU = 3 * p1.x - 2 * t0.x - t1.x;
  const dU = -2 * p1.x + t0.x + t1.x;
  const aV = 0;
  const bV = t0.y;
  const cV = 3 * p1.y - 2 * t0.y - t1.y;
  const dV = -2 * p1.y + t0.y + t1.y;

  const geom: Geometry = {
    type: 'paramPoly3',
    s: sBase,
    x: start.x,
    y: start.y,
    hdg: normalizeAngle(startHdg),
    length: 1, // 占位，下面用弧长替换
    aU,
    bU,
    cU,
    dU,
    aV,
    bV,
    cV,
    dV,
    pRange: 'normalized',
  };

  // 弧长 = ∫₀¹√(u'²+v'²)dp。折线累加会系统性低估，改用分段 Gauss–Legendre 求积。
  geom.length = gaussLegendreSegmented(
    (p) => {
      const du = bU + p * (2 * cU + 3 * p * dU);
      const dv = bV + p * (2 * cV + 3 * p * dV);
      return Math.hypot(du, dv);
    },
    0,
    1,
    8,
  );
  return geom;
}
