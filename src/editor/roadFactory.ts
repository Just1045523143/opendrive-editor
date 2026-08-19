/**
 * 道路构造与修改：由线形生成完整道路（含车道、标线），以及车道增删改。
 */

import { fitAlignment, type FitOptions } from '../core/geometry/alignment.ts';
import type { Geometry } from '../core/geometry/types.ts';
import type { Vec2 } from '../core/math/vec.ts';
import type { OdrDocument } from '../core/model/document.ts';
import { createCenterLane, createLane, type Lane, type LaneSection, type LaneType } from '../core/model/lane.ts';
import type { Road } from '../core/model/road.ts';

export interface RoadTemplate {
  /** 单向车道数（左右各自） */
  leftLanes: number;
  rightLanes: number;
  laneWidth: number;
  laneType: LaneType;
  /** 是否加人行道 */
  sidewalk: boolean;
  sidewalkWidth: number;
  /** 恒定高程（米） */
  elevation: number;
  /** 设计限速（km/h），0 表示不写入 */
  speedLimit: number;
  roadType: string;
}

export const DEFAULT_TEMPLATE: RoadTemplate = {
  leftLanes: 1,
  rightLanes: 1,
  laneWidth: 3.5,
  laneType: 'driving',
  sidewalk: false,
  sidewalkWidth: 2,
  elevation: 0,
  speedLimit: 50,
  roadType: 'town',
};

/** 按模板构造车道段 */
export function buildLaneSection(template: RoadTemplate, s = 0): LaneSection {
  const left: Lane[] = [];
  const right: Lane[] = [];

  for (let i = 1; i <= template.leftLanes; i++) {
    left.push(createLane(i, template.laneType, template.laneWidth));
  }
  for (let i = 1; i <= template.rightLanes; i++) {
    right.push(createLane(-i, template.laneType, template.laneWidth));
  }

  if (template.sidewalk) {
    if (template.leftLanes > 0) {
      left.push(createLane(template.leftLanes + 1, 'sidewalk', template.sidewalkWidth));
    }
    if (template.rightLanes > 0) {
      right.push(createLane(-(template.rightLanes + 1), 'sidewalk', template.sidewalkWidth));
    }
  }

  // 最外侧车道画实线边线，内侧画虚线分道线
  applyDefaultMarks(left);
  applyDefaultMarks(right);

  const center = createCenterLane();
  // 双向道路中心为黄实线，单向为白虚线
  const bidirectional = template.leftLanes > 0 && template.rightLanes > 0;
  center.roadMarks = [
    {
      sOffset: 0,
      type: bidirectional ? 'solid' : 'broken',
      color: bidirectional ? 'yellow' : 'white',
      width: 0.15,
    },
  ];

  return { s, left, center, right };
}

/** 为一侧车道设置默认标线：最外侧实线，其余虚线 */
function applyDefaultMarks(lanes: Lane[]): void {
  for (let i = 0; i < lanes.length; i++) {
    const lane = lanes[i]!;
    const isOutermost = i === lanes.length - 1;
    const isSidewalk = lane.type === 'sidewalk';
    lane.roadMarks = [
      {
        sOffset: 0,
        type: isSidewalk ? 'none' : isOutermost ? 'solid' : 'broken',
        color: 'standard',
        width: 0.15,
      },
    ];
  }
}

/** 由几何图元链与模板构造道路 */
export function buildRoad(
  id: string,
  geometries: Geometry[],
  template: RoadTemplate,
  name?: string,
): Road {
  const last = geometries[geometries.length - 1];
  const length = last ? last.s + last.length : 0;

  const road: Road = {
    id,
    name: name ?? `Road ${id}`,
    length,
    junction: '-1',
    link: {},
    types: [
      {
        s: 0,
        type: template.roadType,
        ...(template.speedLimit > 0
          ? { speedMax: template.speedLimit, speedUnit: 'km/h' }
          : {}),
      },
    ],
    planView: geometries,
    elevations:
      template.elevation !== 0
        ? [{ s: 0, a: template.elevation, b: 0, c: 0, d: 0 }]
        : [{ s: 0, a: 0, b: 0, c: 0, d: 0 }],
    superelevations: [],
    laneOffsets: [],
    laneSections: [buildLaneSection(template)],
    objects: [],
    signals: [],
  };

  return road;
}

/** 由控制点直接构造道路（拟合 + 建车道） */
export function buildRoadFromPoints(
  id: string,
  points: readonly Vec2[],
  fit: FitOptions,
  template: RoadTemplate,
): { road: Road; degradedCorners: number[] } | null {
  const result = fitAlignment(points, fit);
  if (result.geometries.length === 0) return null;
  return {
    road: buildRoad(id, result.geometries, template),
    degradedCorners: result.degradedCorners,
  };
}

/**
 * 用新的控制点重新拟合已有道路的参考线，保留车道配置。
 *
 * 车道宽度记录的 sOffset 以车道段起点为基准，道路长度变化后若某车道段起点
 * 已超出新长度，则需裁剪——否则会产生 s 越界的车道段。
 */
export function refitRoad(road: Road, points: readonly Vec2[], fit: FitOptions): boolean {
  const result = fitAlignment(points, fit);
  if (result.geometries.length === 0) return false;

  const newLength = result.totalLength;
  road.planView = result.geometries;
  road.length = newLength;

  // 裁掉起点越界的车道段，至少保留首段
  road.laneSections = road.laneSections.filter((sec, i) => i === 0 || sec.s < newLength - 1e-6);

  // 同理处理各类分段记录
  road.elevations = clampRecords(road.elevations, newLength);
  road.superelevations = clampRecords(road.superelevations, newLength);
  road.laneOffsets = clampRecords(road.laneOffsets, newLength);

  // 越界的物体与信号一并裁剪
  road.objects = road.objects.filter((o) => o.s <= newLength + 1e-6);
  road.signals = road.signals.filter((sg) => sg.s <= newLength + 1e-6);

  return true;
}

function clampRecords<T extends { s: number }>(records: T[], length: number): T[] {
  const kept = records.filter((r, i) => i === 0 || r.s < length - 1e-6);
  return kept.length > 0 ? kept : records.slice(0, 1);
}

/** 在指定侧追加一条车道（在最外侧） */
export function addLane(
  section: LaneSection,
  side: 'left' | 'right',
  type: LaneType,
  width: number,
): Lane {
  const pool = side === 'left' ? section.left : section.right;
  const sign = side === 'left' ? 1 : -1;
  const nextIndex = pool.length + 1;
  const lane = createLane(sign * nextIndex, type, width);
  lane.roadMarks = [{ sOffset: 0, type: 'solid', color: 'standard', width: 0.15 }];

  // 原最外侧车道的实线改虚线
  const prevOuter = pool[pool.length - 1];
  if (prevOuter && prevOuter.type !== 'sidewalk') {
    prevOuter.roadMarks = [{ sOffset: 0, type: 'broken', color: 'standard', width: 0.15 }];
  }

  pool.push(lane);
  return lane;
}

/**
 * 删除车道并重编号，保持 id 连续（OpenDRIVE 要求同侧 id 由内向外连续）。
 * 返回是否成功。
 */
export function removeLane(section: LaneSection, laneId: number): boolean {
  if (laneId === 0) return false;
  const pool = laneId > 0 ? section.left : section.right;
  const idx = pool.findIndex((l) => l.id === laneId);
  if (idx < 0) return false;

  pool.splice(idx, 1);
  const sign = laneId > 0 ? 1 : -1;
  for (let i = 0; i < pool.length; i++) {
    pool[i]!.id = sign * (i + 1);
  }

  // 重编号后最外侧应为实线
  applyDefaultMarks(pool);
  return true;
}

/**
 * 删除车道，并同步修正 junction 中指向该道路的 laneLink。
 *
 * 必须走这个入口而不是裸调 `removeLane`：删除会触发同侧重编号，
 * 删掉 -1 之后原来的 -2 变成 -1。若不修正引用，laneLink 里存的旧 id
 * 会**静默指向另一条车道**——id 依然存在，校验器查不出来，
 * 导出的文件转向关系是错的。
 *
 * 只有首/末车道段与路口相接，中间段的删除不涉及 laneLink。
 *
 * 返回删除结果与受影响的 laneLink 计数。
 */
export function removeLaneFromDocument(
  doc: OdrDocument,
  road: Road,
  sectionIndex: number,
  laneId: number,
): { ok: boolean; droppedLinks: number; remappedLinks: number } {
  const section = road.laneSections[sectionIndex];
  if (!section) return { ok: false, droppedLinks: 0, remappedLinks: 0 };

  const isFirst = sectionIndex === 0;
  const isLast = sectionIndex === road.laneSections.length - 1;

  if (!removeLane(section, laneId)) {
    return { ok: false, droppedLinks: 0, remappedLinks: 0 };
  }

  if (!isFirst && !isLast) return { ok: true, droppedLinks: 0, remappedLinks: 0 };

  const sign = laneId > 0 ? 1 : -1;
  const removedIndex = Math.abs(laneId);
  let dropped = 0;
  let remapped = 0;

  /** 旧 id → 新 id；null 表示该引用已失效 */
  const remap = (id: number): number | null => {
    if (Math.sign(id) !== sign) return id;
    const index = Math.abs(id);
    if (index === removedIndex) return null;
    if (index < removedIndex) return id;
    return sign * (index - 1);
  };

  for (const j of doc.junctions) {
    for (const c of j.connections) {
      // from 指入口道路的车道，to 指连接道路自身的车道
      const touchesFrom = c.incomingRoad === road.id;
      const touchesTo = c.connectingRoad === road.id;
      if (!touchesFrom && !touchesTo) continue;

      const kept: typeof c.laneLinks = [];
      for (const l of c.laneLinks) {
        const from = touchesFrom ? remap(l.from) : l.from;
        const to = touchesTo ? remap(l.to) : l.to;
        if (from === null || to === null) {
          dropped++;
          continue;
        }
        if (from !== l.from || to !== l.to) remapped++;
        kept.push({ from, to });
      }
      c.laneLinks = kept;
    }
  }

  return { ok: true, droppedLinks: dropped, remappedLinks: remapped };
}

/** 设置某车道的恒定宽度 */
export function setLaneWidth(lane: Lane, width: number): void {
  const w = Math.max(0.1, width);
  lane.widths = [{ sOffset: 0, a: w, b: 0, c: 0, d: 0 }];
}

/** 设置整条道路的恒定高程 */
export function setRoadElevation(road: Road, elevation: number): void {
  road.elevations = [{ s: 0, a: elevation, b: 0, c: 0, d: 0 }];
}

/** 设置整条道路的恒定横坡（度） */
export function setRoadSuperelevation(road: Road, degrees: number): void {
  if (Math.abs(degrees) < 1e-9) {
    road.superelevations = [];
    return;
  }
  const rad = (degrees * Math.PI) / 180;
  road.superelevations = [{ s: 0, a: rad, b: 0, c: 0, d: 0 }];
}

/** 在指定站号处切分车道段，新段复制原段的车道配置 */
export function splitLaneSection(road: Road, s: number): boolean {
  if (s <= 1e-6 || s >= road.length - 1e-6) return false;
  const existing = road.laneSections.findIndex((sec) => Math.abs(sec.s - s) < 1e-6);
  if (existing >= 0) return false;

  let idx = 0;
  for (let i = 0; i < road.laneSections.length; i++) {
    if (road.laneSections[i]!.s <= s) idx = i;
  }
  const src = road.laneSections[idx]!;
  const clone = structuredClone(src);
  clone.s = s;
  // 宽度记录的 sOffset 相对新段起点重新归零
  const shift = s - src.s;
  for (const lane of [...clone.left, clone.center, ...clone.right]) {
    lane.widths = lane.widths
      .map((w) => ({ ...w, sOffset: Math.max(0, w.sOffset - shift) }))
      .filter((w, i, arr) => i === 0 || w.sOffset > 0 || arr.length === 1);
    lane.roadMarks = lane.roadMarks.map((m) => ({
      ...m,
      sOffset: Math.max(0, m.sOffset - shift),
    }));
  }

  road.laneSections.splice(idx + 1, 0, clone);
  return true;
}
