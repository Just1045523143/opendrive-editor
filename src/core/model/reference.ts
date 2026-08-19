/**
 * 参考线求值：把道路坐标 (s, t, h) 映射到惯性系 (x, y, z)。
 *
 * OpenDRIVE 的道路坐标系定义：
 *   s —— 沿参考线的弧长
 *   t —— 垂直于参考线的横向偏移，面向 s 增大方向时左侧为正
 *   h —— 相对路面的法向高度
 *
 * 高程由 `<elevation>` 给出，横坡由 `<superelevation>` 给出（绕 s 轴的滚转角
 * φ，右手系：φ>0 时 t 正侧（左侧）下沉）。故某点高度为
 *   z = elev(s) − t·sin φ(s)
 * 横向位移在水平面内按 cos φ 收缩。
 */

import { evaluateGeometry } from '../geometry/evaluate.ts';
import type { Pose } from '../geometry/types.ts';
import { evalRecords, evalRecordsDerivative } from '../math/poly.ts';
import type { Vec3 } from '../math/vec.ts';
import type { Road } from './road.ts';

/** 参考线上某站号处的完整状态 */
export interface RefPoint {
  s: number;
  /** 参考线平面位置 */
  x: number;
  y: number;
  /** 参考线高程 */
  z: number;
  /** 平面航向角（弧度） */
  hdg: number;
  /** 平面曲率（1/m） */
  curvature: number;
  /** 纵坡 dz/ds */
  grade: number;
  /** 横坡滚转角（弧度） */
  superelevation: number;
  /** 车道横断面相对参考线的整体横移（`<laneOffset>`） */
  laneOffset: number;
}

/** 在图元链上二分定位站号 s 所属图元的下标 */
export function geometryIndexAt(road: Road, s: number): number {
  const pv = road.planView;
  let lo = 0;
  let hi = pv.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pv[mid]!.s <= s) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** 求参考线在站号 s 处的平面位姿 */
export function referencePose(road: Road, s: number): Pose {
  const pv = road.planView;
  if (pv.length === 0) {
    return { x: 0, y: 0, hdg: 0, curvature: 0 };
  }
  const clamped = s < 0 ? 0 : s > road.length ? road.length : s;
  const i = geometryIndexAt(road, clamped);
  const g = pv[i]!;
  return evaluateGeometry(g, clamped - g.s);
}

/** 求参考线在站号 s 处的完整状态 */
export function referencePoint(road: Road, s: number): RefPoint {
  const clamped = s < 0 ? 0 : s > road.length ? road.length : s;
  const pose = referencePose(road, clamped);
  return {
    s: clamped,
    x: pose.x,
    y: pose.y,
    z: evalRecords(road.elevations, clamped),
    hdg: pose.hdg,
    curvature: pose.curvature,
    grade: evalRecordsDerivative(road.elevations, clamped),
    superelevation: evalRecords(road.superelevations, clamped),
    laneOffset: evalRecords(road.laneOffsets, clamped),
  };
}

/**
 * 道路坐标 (s, t, h) → 惯性系 (x, y, z)。
 * t 已包含 laneOffset 时应传入绝对 t；本函数不再叠加 laneOffset。
 */
export function stToXyz(ref: RefPoint, t: number, h = 0): Vec3 {
  const cosPhi = Math.cos(ref.superelevation);
  const sinPhi = Math.sin(ref.superelevation);
  // 法向：航向左转 90°
  const nx = -Math.sin(ref.hdg);
  const ny = Math.cos(ref.hdg);
  // 横向在水平面内的投影长度按 cos φ 收缩；h 沿路面法向叠加
  const lateral = t * cosPhi - h * sinPhi;
  return {
    x: ref.x + nx * lateral,
    y: ref.y + ny * lateral,
    z: ref.z - t * sinPhi + h * cosPhi,
  };
}

/** 便捷形式：直接由 road 与 (s,t,h) 求惯性系坐标 */
export function roadToWorld(road: Road, s: number, t: number, h = 0): Vec3 {
  return stToXyz(referencePoint(road, s), t, h);
}

/**
 * 沿参考线按弦高容差自适应采样站号。
 *
 * 曲率越大采样越密：以最大弦高误差 tol 为约束，曲率 κ 下的允许步长
 * 约为 2√(2·tol/κ)。直线段则一步到位。
 */
export function sampleStations(road: Road, tol = 0.05, maxStep = 25, minStep = 0.2): number[] {
  const out: number[] = [];
  const total = road.length;
  if (total <= 0) return [0];

  let s = 0;
  out.push(0);
  // 图元边界必须落在采样点上，否则曲率突变处会被拉直
  const breaks = new Set<number>();
  for (const g of road.planView) breaks.add(g.s);
  for (const ls of road.laneSections) breaks.add(ls.s);
  for (const e of road.elevations) breaks.add(e.s);
  for (const e of road.superelevations) breaks.add(e.s);
  const sortedBreaks = [...breaks].filter((b) => b > 0 && b < total).sort((a, b) => a - b);
  let bi = 0;

  let guard = 0;
  while (s < total && guard++ < 200000) {
    const k = Math.abs(referencePose(road, s).curvature);
    let step = k < 1e-7 ? maxStep : Math.min(maxStep, Math.max(minStep, 2 * Math.sqrt((2 * tol) / k)));
    let next = s + step;

    // 遇到结构断点时先落在断点上
    while (bi < sortedBreaks.length && sortedBreaks[bi]! <= s + 1e-9) bi++;
    if (bi < sortedBreaks.length && sortedBreaks[bi]! < next) {
      next = sortedBreaks[bi]!;
      bi++;
    }

    if (next >= total - 1e-9) break;
    out.push(next);
    s = next;
  }

  out.push(total);
  return out;
}
