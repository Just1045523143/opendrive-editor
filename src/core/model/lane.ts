/** 车道相关模型：车道段、车道、车道线。字段命名对齐 ASAM OpenDRIVE 1.7。 */

import type { Poly3, PolyRecord } from '../math/poly.ts';

/** ASAM 定义的车道类型（常用子集 + 兼容任意字符串） */
export type LaneType =
  | 'none'
  | 'driving'
  | 'stop'
  | 'shoulder'
  | 'biking'
  | 'sidewalk'
  | 'border'
  | 'restricted'
  | 'parking'
  | 'bidirectional'
  | 'median'
  | 'special1'
  | 'special2'
  | 'special3'
  | 'roadWorks'
  | 'tram'
  | 'rail'
  | 'entry'
  | 'exit'
  | 'offRamp'
  | 'onRamp'
  | 'connectingRamp'
  | 'curb'
  | (string & {});

export type RoadMarkType =
  | 'none'
  | 'solid'
  | 'broken'
  | 'solid solid'
  | 'solid broken'
  | 'broken solid'
  | 'broken broken'
  | 'botts dots'
  | 'grass'
  | 'curb'
  | 'edge'
  | (string & {});

export type RoadMarkWeight = 'standard' | 'bold';

export type RoadMarkLaneChange = 'increase' | 'decrease' | 'both' | 'none';

/** 车道线（`<roadMark>`），sOffset 相对所属 laneSection 起点 */
export interface RoadMark {
  sOffset: number;
  type: RoadMarkType;
  weight?: RoadMarkWeight;
  /** 颜色，'standard' 视作白色 */
  color: string;
  /** 线宽（米） */
  width?: number;
  laneChange?: RoadMarkLaneChange;
  /** 相对车道中心的横向偏移（米） */
  tOffset?: number;
  material?: string;
  height?: number;
}

/** 车道宽度记录（`<width>`），a..d 为相对 sOffset 的三次多项式系数 */
export interface LaneWidth extends Poly3 {
  /** 相对所属 laneSection 起点的偏移 */
  sOffset: number;
}

/** 车道边界记录（`<border>`），相对参考线的 t 值多项式；与 width 二者择一 */
export interface LaneBorder extends Poly3 {
  sOffset: number;
}

/** 车道限速（`<speed>`） */
export interface LaneSpeed {
  sOffset: number;
  max: number;
  unit?: 'm/s' | 'mph' | 'km/h';
}

/** 车道级前后连接（引用相邻 laneSection 内的车道 id） */
export interface LaneLink {
  predecessorIds: number[];
  successorIds: number[];
}

/** 单条车道。id：0 为中心线，正数为左侧（由内向外递增），负数为右侧 */
export interface Lane {
  id: number;
  type: LaneType;
  /** true 表示不参与超高倾斜 */
  level?: boolean;
  link: LaneLink;
  /** 宽度多项式序列，按 sOffset 升序 */
  widths: LaneWidth[];
  /** 边界多项式序列（与 widths 互斥，解析时保留原样） */
  borders?: LaneBorder[];
  roadMarks: RoadMark[];
  speeds?: LaneSpeed[];
  material?: string;
  /** 保留解析时未建模的属性，导出时原样回写 */
  extraAttrs?: Record<string, string>;
}

/**
 * 车道段（`<laneSection>`）。s 为在参考线上的起始站号。
 * left/right 按 |id| 升序（由内向外）存放，center 为 id=0 的车道。
 */
export interface LaneSection {
  s: number;
  /** true 表示左右侧车道在此段独立（`singleSide` 属性） */
  singleSide?: boolean;
  left: Lane[];
  center: Lane;
  right: Lane[];
}

/** 参考线横向偏移（`<laneOffset>`）：整个车道横断面相对参考线的平移 */
export type LaneOffset = PolyRecord;

/** 新建一条默认车道 */
export function createLane(id: number, type: LaneType, width: number): Lane {
  return {
    id,
    type,
    link: { predecessorIds: [], successorIds: [] },
    widths: id === 0 ? [] : [{ sOffset: 0, a: width, b: 0, c: 0, d: 0 }],
    roadMarks: [],
  };
}

/** 新建中心车道（id=0，无宽度，默认黄实线） */
export function createCenterLane(): Lane {
  return {
    id: 0,
    type: 'none',
    link: { predecessorIds: [], successorIds: [] },
    widths: [],
    roadMarks: [{ sOffset: 0, type: 'broken', color: 'yellow', width: 0.15 }],
  };
}

/** 按 id 在车道段内查找车道 */
export function findLane(section: LaneSection, id: number): Lane | undefined {
  if (id === 0) return section.center;
  const pool = id > 0 ? section.left : section.right;
  return pool.find((l) => l.id === id);
}

/** 车道段内全部车道，顺序为：左侧由外向内、中心、右侧由内向外 */
export function allLanes(section: LaneSection): Lane[] {
  return [...[...section.left].reverse(), section.center, ...section.right];
}
