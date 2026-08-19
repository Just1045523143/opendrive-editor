/**
 * 路网范围计算。
 *
 * header 的 north/south/east/west 与几何同处惯性系：north = max y，east = max x。
 * 范围取路面外缘（而非仅参考线），使消费方据此建立的场景包围盒能覆盖全部车道。
 */

import type { OdrDocument } from './document.ts';
import { crossSectionAt } from './lanes.ts';
import { referencePoint, sampleStations, stToXyz } from './reference.ts';
import type { Road } from './road.ts';

export interface Bounds {
  north: number;
  south: number;
  east: number;
  west: number;
  /** 高程范围，便于 3D 视图初始化 */
  minZ: number;
  maxZ: number;
}

export function emptyBounds(): Bounds {
  return {
    north: Number.NEGATIVE_INFINITY,
    south: Number.POSITIVE_INFINITY,
    east: Number.NEGATIVE_INFINITY,
    west: Number.POSITIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY,
  };
}

function extend(b: Bounds, x: number, y: number, z: number): void {
  if (y > b.north) b.north = y;
  if (y < b.south) b.south = y;
  if (x > b.east) b.east = x;
  if (x < b.west) b.west = x;
  if (z < b.minZ) b.minZ = z;
  if (z > b.maxZ) b.maxZ = z;
}

/** 累积单条道路的范围（含车道外缘） */
export function extendWithRoad(b: Bounds, road: Road): void {
  if (road.planView.length === 0 || road.length <= 0) return;

  for (const s of sampleStations(road, 0.2, 20)) {
    const ref = referencePoint(road, s);
    const cs = crossSectionAt(road, s, ref);
    const tLeft = cs.left.length > 0 ? cs.left[cs.left.length - 1]!.tOuter : cs.tCenter;
    const tRight = cs.right.length > 0 ? cs.right[cs.right.length - 1]!.tOuter : cs.tCenter;

    for (const t of [tLeft, tRight, cs.tCenter]) {
      const p = stToXyz(ref, t);
      extend(b, p.x, p.y, p.z);
    }
  }
}

/** 计算整份文档的范围；无有效几何时返回 null */
export function computeBounds(doc: OdrDocument): Bounds | null {
  const b = emptyBounds();
  for (const road of doc.roads) extendWithRoad(b, road);
  if (!Number.isFinite(b.north) || !Number.isFinite(b.west)) return null;
  if (!Number.isFinite(b.minZ)) {
    b.minZ = 0;
    b.maxZ = 0;
  }
  return b;
}

/** 范围中心点 */
export function boundsCenter(b: Bounds): { x: number; y: number } {
  return { x: (b.east + b.west) / 2, y: (b.north + b.south) / 2 };
}

/** 范围尺寸（米） */
export function boundsSize(b: Bounds): { width: number; height: number } {
  return { width: b.east - b.west, height: b.north - b.south };
}
