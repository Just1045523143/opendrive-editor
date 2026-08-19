/** 道路模型（`<road>`）及其纵/横断面、连接关系、物体与信号。 */

import type { Geometry } from '../geometry/types.ts';
import type { PolyRecord } from '../math/poly.ts';
import type { LaneOffset, LaneSection } from './lane.ts';

/** 前驱/后继指向的元素类型 */
export type LinkElementType = 'road' | 'junction';

/** 接续点：'start' 表示接在对方参考线起点，'end' 表示终点 */
export type ContactPoint = 'start' | 'end';

export interface RoadLinkEnd {
  elementType: LinkElementType;
  elementId: string;
  /** elementType='road' 时必需 */
  contactPoint?: ContactPoint;
  /** 1.7 起可选：连接到对方参考线的具体 s 与方向 */
  elementS?: number;
  elementDir?: '+' | '-';
}

export interface RoadLink {
  predecessor?: RoadLinkEnd;
  successor?: RoadLinkEnd;
}

/** 纵断面高程记录（`<elevation>`），a..d 为相对 s 的三次多项式 */
export type Elevation = PolyRecord;

/** 横坡记录（`<superelevation>`），值为绕参考线的滚转角（弧度） */
export type Superelevation = PolyRecord;

/** 横向坡度（`<shape>`），按 s 与 t 双参数定义 */
export interface RoadShape extends PolyRecord {
  t: number;
}

/** 道路类型段（`<type>`） */
export interface RoadTypeRecord {
  s: number;
  type: string;
  /** 该段默认限速 */
  speedMax?: number;
  speedUnit?: string;
}

/** 道路物体（`<object>`）。仅建模常用字段，其余原样保留 */
export interface RoadObject {
  id: string;
  type?: string;
  name?: string;
  s: number;
  t: number;
  zOffset?: number;
  hdg?: number;
  length?: number;
  width?: number;
  radius?: number;
  height?: number;
  /** 未建模属性，导出时回写 */
  extraAttrs?: Record<string, string>;
  /** 未建模子元素的原始 XML 片段 */
  rawChildren?: string;
}

/** 交通标志/信号（`<signal>`） */
export interface RoadSignal {
  id: string;
  s: number;
  t: number;
  name?: string;
  dynamic?: 'yes' | 'no';
  orientation?: '+' | '-' | 'none';
  zOffset?: number;
  country?: string;
  type?: string;
  subtype?: string;
  value?: number;
  height?: number;
  width?: number;
  text?: string;
  extraAttrs?: Record<string, string>;
  rawChildren?: string;
}

/**
 * 一条道路。参考线由 planView 中的图元链构成，各图元 s 连续、首尾位姿相接。
 */
export interface Road {
  id: string;
  name?: string;
  /** 参考线总长（米），应等于末图元 s + length */
  length: number;
  /** 所属 junction 的 id，'-1' 表示不属于任何 junction */
  junction: string;
  /** 交通规则（左行/右行） */
  rule?: 'RHT' | 'LHT';
  link: RoadLink;
  types: RoadTypeRecord[];
  /** 参考线几何图元链，按 s 升序 */
  planView: Geometry[];
  elevations: Elevation[];
  superelevations: Superelevation[];
  shapes?: RoadShape[];
  laneOffsets: LaneOffset[];
  /** 车道段，按 s 升序，至少一段且首段 s=0 */
  laneSections: LaneSection[];
  objects: RoadObject[];
  signals: RoadSignal[];
  extraAttrs?: Record<string, string>;
}

/** 定位某站号 s 所属的车道段索引 */
export function laneSectionIndexAt(road: Road, s: number): number {
  const sections = road.laneSections;
  let lo = 0;
  let hi = sections.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sections[mid]!.s <= s) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** 定位某站号 s 所属的车道段 */
export function laneSectionAt(road: Road, s: number): LaneSection | undefined {
  return road.laneSections[laneSectionIndexAt(road, s)];
}

/** 车道段的 s 区间 [start, end) */
export function laneSectionRange(road: Road, index: number): { start: number; end: number } {
  const section = road.laneSections[index];
  if (!section) return { start: 0, end: road.length };
  const next = road.laneSections[index + 1];
  return { start: section.s, end: next ? next.s : road.length };
}
