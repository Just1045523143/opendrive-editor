/**
 * 拾取与吸附。
 *
 * 车道命中用点在多边形内测试（射线交叉法）；参考线与控制点用距离阈值。
 * 端点吸附同时返回该端点的航向，使新绘道路能与既有道路相切衔接。
 */

import { evaluateGeometry } from '../core/geometry/evaluate.ts';
import { closestOnSegment, distance, type Vec2 } from '../core/math/vec.ts';
import type { OdrDocument } from '../core/model/document.ts';
import type { Road } from '../core/model/road.ts';
import type { RoadRenderData } from './renderData.ts';
import type { Selection } from './store.ts';

/** 射线交叉法判断点是否在多边形内 */
export function pointInPolygon(p: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    // 判断水平射线是否穿过边 ab
    if (a.y > p.y !== b.y > p.y) {
      const t = (p.y - a.y) / (b.y - a.y);
      if (p.x < a.x + t * (b.x - a.x)) inside = !inside;
    }
  }
  return inside;
}

/** 点到折线的最近距离 */
export function distanceToPolyline(p: Vec2, line: readonly Vec2[]): number {
  if (line.length === 0) return Infinity;
  if (line.length === 1) return distance(p, line[0]!);
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const d = closestOnSegment(p, line[i]!, line[i + 1]!).dist;
    if (d < best) best = d;
  }
  return best;
}

export interface PickResult {
  selection: Selection;
  /** 命中处到目标的距离（米），用于在多个候选间取最近 */
  distance: number;
}

/**
 * 在渲染数据中拾取车道。返回命中的最内层车道（多边形可能重叠时取先命中者）。
 */
export function pickLane(
  world: Vec2,
  dataList: readonly RoadRenderData[],
): PickResult | null {
  for (const data of dataList) {
    if (
      world.x < data.box.minX ||
      world.x > data.box.maxX ||
      world.y < data.box.minY ||
      world.y > data.box.maxY
    ) {
      continue;
    }
    for (const poly of data.lanePolygons) {
      if (pointInPolygon(world, poly.outline)) {
        return {
          selection: {
            kind: 'lane',
            roadId: poly.roadId,
            sectionIndex: poly.sectionIndex,
            laneId: poly.laneId,
          },
          distance: 0,
        };
      }
    }
  }
  return null;
}

/** 拾取参考线（用于点击路面之外但靠近道路时仍能选中） */
export function pickReferenceLine(
  world: Vec2,
  dataList: readonly RoadRenderData[],
  tolerance: number,
): PickResult | null {
  let best: PickResult | null = null;
  for (const data of dataList) {
    const d = distanceToPolyline(world, data.referenceLine);
    if (d <= tolerance && (!best || d < best.distance)) {
      best = { selection: { kind: 'road', roadId: data.roadId }, distance: d };
    }
  }
  return best;
}

/** 拾取几何图元（在选中道路内细分到具体图元） */
export function pickGeometry(road: Road, world: Vec2, tolerance: number): PickResult | null {
  let best: PickResult | null = null;
  for (let i = 0; i < road.planView.length; i++) {
    const g = road.planView[i]!;
    const n = Math.max(2, Math.ceil(g.length / 3));
    const pts: Vec2[] = [];
    for (let k = 0; k <= n; k++) {
      const p = evaluateGeometry(g, (g.length * k) / n);
      pts.push({ x: p.x, y: p.y });
    }
    const d = distanceToPolyline(world, pts);
    if (d <= tolerance && (!best || d < best.distance)) {
      best = { selection: { kind: 'geometry', roadId: road.id, geometryIndex: i }, distance: d };
    }
  }
  return best;
}

/** 拾取控制点 */
export function pickControlPoint(
  world: Vec2,
  roadId: string,
  points: readonly Vec2[],
  tolerance: number,
): PickResult | null {
  let best: PickResult | null = null;
  for (let i = 0; i < points.length; i++) {
    const d = distance(world, points[i]!);
    if (d <= tolerance && (!best || d < best.distance)) {
      best = { selection: { kind: 'controlPoint', roadId, pointIndex: i }, distance: d };
    }
  }
  return best;
}

/** 道路端点吸附结果 */
export interface SnapTarget {
  point: Vec2;
  /** 该端点的参考线航向（弧度） */
  hdg: number;
  roadId: string;
  end: 'start' | 'end';
  distance: number;
}

/**
 * 在既有道路的首尾端点中寻找吸附目标。
 * 绘制时把新道路端点对齐到此处，可保证网络拓扑连通。
 */
export function snapToRoadEnds(
  world: Vec2,
  doc: OdrDocument,
  tolerance: number,
  excludeRoadId?: string,
): SnapTarget | null {
  return snapToRoadEndsAll(world, doc, tolerance, excludeRoadId)[0] ?? null;
}

/**
 * 容差内的**全部**道路端点，按距离升序。
 *
 * 路口处各进口道的端点常常挤在几十厘米内，参考线在屏幕上几乎重合。只返回最近
 * 的一个时，其余端点无论怎么移动鼠标都选不中——必须把候选全部给出来，由调用方
 * 提供轮换（交叉口工具用 Tab）。
 *
 * 距离相等时按 roadId、再按 end 兜底排序，保证同一鼠标位置反复查询顺序稳定，
 * 否则 Tab 轮换的下标会指向不同端点。
 */
export function snapToRoadEndsAll(
  world: Vec2,
  doc: OdrDocument,
  tolerance: number,
  excludeRoadId?: string,
): SnapTarget[] {
  const hits: SnapTarget[] = [];

  for (const road of doc.roads) {
    if (road.id === excludeRoadId) continue;
    const pv = road.planView;
    if (pv.length === 0) continue;

    const first = pv[0]!;
    const last = pv[pv.length - 1]!;
    const startPose = evaluateGeometry(first, 0);
    const endPose = evaluateGeometry(last, last.length);

    const candidates: Array<{ p: Vec2; hdg: number; end: 'start' | 'end' }> = [
      { p: { x: startPose.x, y: startPose.y }, hdg: startPose.hdg, end: 'start' },
      { p: { x: endPose.x, y: endPose.y }, hdg: endPose.hdg, end: 'end' },
    ];

    for (const c of candidates) {
      const d = distance(world, c.p);
      if (d <= tolerance) {
        hits.push({ point: c.p, hdg: c.hdg, roadId: road.id, end: c.end, distance: d });
      }
    }
  }

  hits.sort((a, b) => {
    if (a.distance !== b.distance) return a.distance - b.distance;
    if (a.roadId !== b.roadId) return a.roadId < b.roadId ? -1 : 1;
    return a.end === b.end ? 0 : a.end === 'start' ? -1 : 1;
  });
  return hits;
}

/** 网格吸附 */
export function snapToGrid(world: Vec2, spacing: number): Vec2 {
  if (spacing <= 0) return world;
  return {
    x: Math.round(world.x / spacing) * spacing,
    y: Math.round(world.y / spacing) * spacing,
  };
}

/**
 * 综合拾取：优先控制点 → 车道面 → 参考线。
 * tolerancePx 由调用方按当前缩放换算成米。
 */
export function pickAll(
  world: Vec2,
  dataList: readonly RoadRenderData[],
  toleranceMeters: number,
  activeRoadId: string | null,
  controlPoints: readonly Vec2[] | undefined,
): Selection {
  if (activeRoadId && controlPoints && controlPoints.length > 0) {
    const cp = pickControlPoint(world, activeRoadId, controlPoints, toleranceMeters * 1.5);
    if (cp) return cp.selection;
  }

  const lane = pickLane(world, dataList);
  if (lane) return lane.selection;

  const ref = pickReferenceLine(world, dataList, toleranceMeters * 2);
  if (ref) return ref.selection;

  return { kind: 'none' };
}
