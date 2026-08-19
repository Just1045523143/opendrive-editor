/**
 * 车道横断面几何：由 `<width>`（或 `<border>`）序列累加出各车道的内外边界 t 值。
 *
 * 累加规则（ASAM OpenDRIVE 9.5.3）：
 *   - 中心车道 id=0 无宽度，其 t 即 laneOffset
 *   - 左侧车道按 id 升序由内向外累加，t 递增
 *   - 右侧车道按 id 降序由内向外累加，t 递减
 *   - `<border>` 直接给出相对参考线的 t（含符号），优先级高于累加宽度
 *
 * 注意 width/border 的 sOffset 相对所属 laneSection 起点，而非道路起点。
 */

import { evalPoly3 } from '../math/poly.ts';
import type { Lane, LaneSection, LaneType } from './lane.ts';
import { laneSectionIndexAt, laneSectionRange, type Road } from './road.ts';
import { referencePoint, type RefPoint } from './reference.ts';

/** 单条车道在某站号处的横向边界 */
export interface LaneBoundary {
  laneId: number;
  /** 车道类型。判断可否通行必须看类型，宽度过滤会把人行道也算进来 */
  type: LaneType;
  /** 靠参考线一侧的 t */
  tInner: number;
  /** 远离参考线一侧的 t */
  tOuter: number;
  /** 车道宽度（米），= |tOuter − tInner| */
  width: number;
}

/** 某站号处完整横断面 */
export interface CrossSection {
  s: number;
  /** 中心车道的 t（即 laneOffset） */
  tCenter: number;
  /** 左侧车道，按由内向外顺序 */
  left: LaneBoundary[];
  /** 右侧车道，按由内向外顺序 */
  right: LaneBoundary[];
}

/** 在给定 sOffset（相对 laneSection 起点）处求车道宽度 */
export function laneWidthAt(lane: Lane, sOffsetInSection: number): number {
  const list = lane.widths;
  if (list.length === 0) return 0;
  // 定位最后一条 sOffset <= 目标的记录
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.sOffset <= sOffsetInSection) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const rec = list[found < 0 ? 0 : found]!;
  const ds = found < 0 ? 0 : sOffsetInSection - rec.sOffset;
  const w = evalPoly3(rec, ds);
  return w > 0 ? w : 0;
}

/** 在给定 sOffset 处求 border 值（相对参考线的 t，含符号）；无 border 返回 null */
export function laneBorderAt(lane: Lane, sOffsetInSection: number): number | null {
  const list = lane.borders;
  if (!list || list.length === 0) return null;
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.sOffset <= sOffsetInSection) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const rec = list[found < 0 ? 0 : found]!;
  const ds = found < 0 ? 0 : sOffsetInSection - rec.sOffset;
  return evalPoly3(rec, ds);
}

/** 累加一侧车道，sign=+1 为左侧，−1 为右侧 */
function accumulateSide(
  lanes: readonly Lane[],
  sOffsetInSection: number,
  tStart: number,
  sign: 1 | -1,
): LaneBoundary[] {
  const out: LaneBoundary[] = [];
  let tInner = tStart;
  for (const lane of lanes) {
    const border = laneBorderAt(lane, sOffsetInSection);
    let tOuter: number;
    if (border !== null) {
      // border 直接定义外边界相对参考线的位置
      tOuter = sign > 0 ? Math.abs(border) : -Math.abs(border);
    } else {
      tOuter = tInner + sign * laneWidthAt(lane, sOffsetInSection);
    }
    out.push({
      laneId: lane.id,
      type: lane.type,
      tInner,
      tOuter,
      width: Math.abs(tOuter - tInner),
    });
    tInner = tOuter;
  }
  return out;
}

/** 求某站号处的完整横断面 */
export function crossSectionAt(road: Road, s: number, ref?: RefPoint): CrossSection {
  const r = ref ?? referencePoint(road, s);
  const idx = laneSectionIndexAt(road, r.s);
  const section = road.laneSections[idx];
  const { start } = laneSectionRange(road, idx);
  const sOffset = r.s - start;

  if (!section) {
    return { s: r.s, tCenter: r.laneOffset, left: [], right: [] };
  }

  return {
    s: r.s,
    tCenter: r.laneOffset,
    left: accumulateSide(section.left, sOffset, r.laneOffset, 1),
    right: accumulateSide(section.right, sOffset, r.laneOffset, -1),
  };
}

/** 查某条车道在某站号处的边界；车道不存在时返回 null */
export function laneBoundaryAt(road: Road, laneId: number, s: number): LaneBoundary | null {
  const cs = crossSectionAt(road, s);
  if (laneId === 0) {
    return { laneId: 0, type: 'none', tInner: cs.tCenter, tOuter: cs.tCenter, width: 0 };
  }
  const pool = laneId > 0 ? cs.left : cs.right;
  return pool.find((b) => b.laneId === laneId) ?? null;
}

/** 车道中心线的 t 值 */
export function laneCenterT(boundary: LaneBoundary): number {
  return (boundary.tInner + boundary.tOuter) / 2;
}

/** 整条道路在某站号处的总宽度（左右各自最外缘之差） */
export function totalWidthAt(road: Road, s: number): { tLeft: number; tRight: number } {
  const cs = crossSectionAt(road, s);
  const tLeft = cs.left.length > 0 ? cs.left[cs.left.length - 1]!.tOuter : cs.tCenter;
  const tRight = cs.right.length > 0 ? cs.right[cs.right.length - 1]!.tOuter : cs.tCenter;
  return { tLeft, tRight };
}

/** 在车道段内查找某条车道所属的一侧列表位置，用于编辑时定位 */
export function laneIndexInSection(section: LaneSection, laneId: number): number {
  const pool = laneId > 0 ? section.left : section.right;
  return pool.findIndex((l) => l.id === laneId);
}
