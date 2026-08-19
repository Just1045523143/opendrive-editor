/**
 * 渲染数据提取：把道路模型转为可直接绘制的多边形与折线。
 *
 * 采样沿参考线自适应加密（弦高容差驱动），保证曲线段在任意缩放下都足够光滑，
 * 同时在直线段不浪费顶点。
 */

import type { Vec2 } from '../core/math/vec.ts';
import { crossSectionAt, type CrossSection } from '../core/model/lanes.ts';
import { referencePoint, sampleStations, stToXyz, type RefPoint } from '../core/model/reference.ts';
import { laneSectionIndexAt, laneSectionRange, type Road } from '../core/model/road.ts';
import { findLane, type Lane, type LaneType, type RoadMark } from '../core/model/lane.ts';
import type { WorldBox } from './viewport.ts';

/** 一条车道在某车道段内的面多边形 */
export interface LanePolygon {
  roadId: string;
  sectionIndex: number;
  laneId: number;
  laneType: LaneType;
  /** 闭合外轮廓（内边界正序 + 外边界逆序） */
  outline: Vec2[];
  /** 车道中心线，用于标注与拾取 */
  centerline: Vec2[];
}

/** 车道线折线 */
export interface RoadMarkLine {
  roadId: string;
  laneId: number;
  mark: RoadMark;
  polyline: Vec2[];
}

export interface RoadRenderData {
  roadId: string;
  /** 参考线折线 */
  referenceLine: Vec2[];
  lanePolygons: LanePolygon[];
  roadMarks: RoadMarkLine[];
  /** 路面外缘（左右各一条），用于描边 */
  leftEdge: Vec2[];
  rightEdge: Vec2[];
  box: WorldBox;
}

function emptyBox(): WorldBox {
  return {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  };
}

function grow(box: WorldBox, p: Vec2): void {
  if (p.x < box.minX) box.minX = p.x;
  if (p.x > box.maxX) box.maxX = p.x;
  if (p.y < box.minY) box.minY = p.y;
  if (p.y > box.maxY) box.maxY = p.y;
}

/** 沿参考线在给定 t 处取平面点 */
function pointAt(ref: RefPoint, t: number): Vec2 {
  const p = stToXyz(ref, t);
  return { x: p.x, y: p.y };
}

/** 每条车道在采样过程中累积的边界点 */
interface LaneAccum {
  laneId: number;
  laneType: LaneType;
  inner: Vec2[];
  outer: Vec2[];
  center: Vec2[];
}

/**
 * 提取一条道路的全部渲染几何。
 *
 * 车道段之间车道数可能变化，故按 (sectionIndex, laneId) 分组累积；
 * 跨段时结束上一段的多边形，避免不同段的车道被错误连成一片。
 */
export function buildRoadRenderData(road: Road, tolerance = 0.05): RoadRenderData {
  const box = emptyBox();
  const referenceLine: Vec2[] = [];
  const lanePolygons: LanePolygon[] = [];
  const roadMarks: RoadMarkLine[] = [];
  const leftEdge: Vec2[] = [];
  const rightEdge: Vec2[] = [];

  if (road.planView.length === 0 || road.length <= 0) {
    return { roadId: road.id, referenceLine, lanePolygons, roadMarks, leftEdge, rightEdge, box };
  }

  const stations = sampleStations(road, tolerance);
  // 每个车道段各自累积
  let currentSection = -1;
  let accum = new Map<number, LaneAccum>();
  /** 车道线累积：key 为 laneId，值为按 mark 分段的折线列表 */
  let markAccum = new Map<number, Array<{ mark: RoadMark; points: Vec2[] }>>();

  const flush = (sectionIndex: number): void => {
    for (const a of accum.values()) {
      if (a.inner.length < 2) continue;
      const outline = [...a.inner, ...[...a.outer].reverse()];
      lanePolygons.push({
        roadId: road.id,
        sectionIndex,
        laneId: a.laneId,
        laneType: a.laneType,
        outline,
        centerline: a.center,
      });
    }
    for (const [laneId, segments] of markAccum) {
      for (const seg of segments) {
        if (seg.points.length < 2) continue;
        roadMarks.push({ roadId: road.id, laneId, mark: seg.mark, polyline: seg.points });
      }
    }
    accum = new Map();
    markAccum = new Map();
  };

  // 累积一个站号的横断面几何到当前 accum，提取为闭包便于边界处调用两次
  const accumulate = (s: number, secIdx: number): void => {
    const ref = referencePoint(road, s);
    const cs = crossSectionAt(road, s, ref);
    const refPt = pointAt(ref, cs.tCenter);
    referenceLine.push(refPt);
    grow(box, refPt);

    const section = road.laneSections[secIdx];
    if (!section) return;
    const { start } = laneSectionRange(road, secIdx);
    const sOffset = s - start;

    // 中心车道的 roadMark 落在参考线（含 laneOffset）上
    const centerMark = pickMark(section.center, sOffset);
    if (centerMark && centerMark.type !== 'none') {
      accumulateMark(markAccum, 0, centerMark, pointAt(ref, cs.tCenter + (centerMark.tOffset ?? 0)));
    }

    for (const side of [cs.left, cs.right]) {
      for (const b of side) {
        const lane = findLane(section, b.laneId);
        if (!lane) continue;

        let a = accum.get(b.laneId);
        if (!a) {
          a = { laneId: b.laneId, laneType: lane.type, inner: [], outer: [], center: [] };
          accum.set(b.laneId, a);
        }

        const pi = pointAt(ref, b.tInner);
        const po = pointAt(ref, b.tOuter);
        a.inner.push(pi);
        a.outer.push(po);
        a.center.push(pointAt(ref, (b.tInner + b.tOuter) / 2));
        grow(box, pi);
        grow(box, po);

        // 车道线画在车道外边界
        const mark = pickMark(lane, sOffset);
        if (mark && mark.type !== 'none') {
          accumulateMark(markAccum, b.laneId, mark, pointAt(ref, b.tOuter + (mark.tOffset ?? 0)));
        }
      }
    }

    // 路面外缘
    const tLeft = cs.left.length > 0 ? cs.left[cs.left.length - 1]!.tOuter : cs.tCenter;
    const tRight = cs.right.length > 0 ? cs.right[cs.right.length - 1]!.tOuter : cs.tCenter;
    leftEdge.push(pointAt(ref, tLeft));
    rightEdge.push(pointAt(ref, tRight));
  };

  for (const s of stations) {
    const secIdx = laneSectionIndexAt(road, s);

    // 跨段：让边界点同时属于两段，先完成旧段，再启动新段
    if (secIdx !== currentSection) {
      if (currentSection >= 0) {
        accumulate(s, currentSection); // 旧段的闭合点
        flush(currentSection);
      }
      currentSection = secIdx;
    }

    accumulate(s, secIdx);
  }

  if (currentSection >= 0) flush(currentSection);

  return { roadId: road.id, referenceLine, lanePolygons, roadMarks, leftEdge, rightEdge, box };
}

/** 取在给定 sOffset 生效的 roadMark */
function pickMark(lane: Lane, sOffset: number): RoadMark | undefined {
  const list = lane.roadMarks;
  if (list.length === 0) return undefined;
  let found: RoadMark | undefined;
  for (const m of list) {
    if (m.sOffset <= sOffset + 1e-9) found = m;
    else break;
  }
  return found ?? list[0];
}

/**
 * 累积车道线点。
 *
 * roadMark 在中途换型（如实线转虚线）时须断成两条折线，否则样式会串。
 * 新段以旧段末点起始，使视觉上无缝衔接。
 */
function accumulateMark(
  store: Map<number, Array<{ mark: RoadMark; points: Vec2[] }>>,
  laneId: number,
  mark: RoadMark,
  p: Vec2,
): void {
  let segments = store.get(laneId);
  if (!segments) {
    segments = [];
    store.set(laneId, segments);
  }

  const last = segments[segments.length - 1];
  if (last && last.mark === mark) {
    last.points.push(p);
    return;
  }

  // 换型：开新段，并把旧段末点作为新段首点以保持连续
  const seed = last && last.points.length > 0 ? [last.points[last.points.length - 1]!, p] : [p];
  segments.push({ mark, points: seed });
}

/** 车道类型对应的填充色 */
export const LANE_COLORS: Record<string, string> = {
  driving: '#4a4a52',
  sidewalk: '#6b6b73',
  shoulder: '#5a5a52',
  border: '#55555c',
  biking: '#3f5147',
  parking: '#4b4b56',
  median: '#3d4a3d',
  restricted: '#5c4a4a',
  stop: '#52424a',
  none: '#3a3a40',
  curb: '#6f6f78',
  bidirectional: '#4a4a52',
  onRamp: '#474750',
  offRamp: '#474750',
  connectingRamp: '#474750',
  entry: '#474750',
  exit: '#474750',
};

export function laneColor(type: LaneType): string {
  return LANE_COLORS[type] ?? '#44444c';
}

/** roadMark 颜色映射；'standard' 按白色处理 */
export function markColor(color: string): string {
  switch (color) {
    case 'yellow':
      return '#e8c84a';
    case 'blue':
      return '#5a9fe0';
    case 'green':
      return '#5ac07a';
    case 'red':
      return '#e05a5a';
    case 'orange':
      return '#e0955a';
    case 'violet':
      return '#b07ae0';
    case 'white':
    case 'standard':
    default:
      return '#e8e8ec';
  }
}
