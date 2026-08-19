/**
 * 车道渐变（taper）。
 *
 * 三件事：车道宽度渐变、车道渐变消失（4 车道变 3）、车道渐变出现。
 *
 * 表示方式：渐变独占一个 laneSection。渐变段内该车道的 `<width>` 是一条三次
 * 多项式，段末车道被真正删除，而不是留一条零宽车道继续往下走——OpenDRIVE
 * 允许零宽车道，但很多下游工具（仿真器、地图匹配）把它当成真车道处理，会凭空
 * 多出一条贴着路缘的幽灵车道。
 *
 * 形状默认三次（smoothstep）：
 *
 *     w(ds) = w₀ + Δ·(3τ² − 2τ³)，  τ = ds / L
 *
 * 展开即 a = w₀, b = 0, c = 3Δ/L², d = −2Δ/L³。两端斜率为零，车道边界在接缝
 * 处与前后相切，不会出现折角。线性（b = Δ/L）留作备选：渠化岛、收费广场那类
 * 位置的实际标线就是直的。
 */

import type { LaneWidth } from '../core/model/lane.ts';
import { laneWidthAt } from '../core/model/lanes.ts';
import { laneSectionRange, type Road } from '../core/model/road.ts';
import type { OdrDocument } from '../core/model/document.ts';
import { removeLaneFromDocument, splitLaneSection } from './roadFactory.ts';

/** 渐变形状 */
export type TaperShape = 'cubic' | 'linear';

/** 渐变段的最小长度（米）。再短的段在几何上没有意义，也无法画出标线 */
export const MIN_TAPER_LENGTH = 2;

/** 渐变操作结果 */
export interface TaperResult {
  ok: boolean;
  /** 失败原因，用于直接呈现给用户 */
  reason?: string;
  /** 实际采用的渐变长度（可能被夹紧） */
  length?: number;
  /** 长度是否被道路剩余长度夹紧过 */
  clamped?: boolean;
  /** 因车道消失而丢弃的 junction laneLink 数 */
  droppedLinks?: number;
  /** 因车道重编号而改写的 junction laneLink 数 */
  remappedLinks?: number;
}

/**
 * 渐变率表（JTG D20 公路路线设计规范，车道渐变段长度取值）。
 * L = 车道宽度 × 渐变率，速度越高渐变越缓。
 */
const TAPER_RATE: Array<{ maxSpeed: number; rate: number }> = [
  { maxSpeed: 40, rate: 15 },
  { maxSpeed: 60, rate: 20 },
  { maxSpeed: 80, rate: 30 },
  { maxSpeed: Infinity, rate: 45 },
];

/** 按车道宽度与设计速度推荐渐变长度（米） */
export function recommendedTaperLength(width: number, speedKmh: number): number {
  const entry = TAPER_RATE.find((r) => speedKmh <= r.maxSpeed) ?? TAPER_RATE[TAPER_RATE.length - 1]!;
  const raw = Math.max(0.1, width) * entry.rate;
  // 取整到 5 m，设计图上不会出现 67.375 m 这种长度
  return Math.max(MIN_TAPER_LENGTH, Math.round(raw / 5) * 5);
}

/** 构造从 from 渐变到 to 的宽度多项式（sOffset 相对渐变段起点为 0） */
export function taperPoly(from: number, to: number, length: number, shape: TaperShape): LaneWidth {
  const delta = to - from;
  if (shape === 'linear') {
    return { sOffset: 0, a: from, b: delta / length, c: 0, d: 0 };
  }
  return {
    sOffset: 0,
    a: from,
    b: 0,
    c: (3 * delta) / (length * length),
    d: (-2 * delta) / (length * length * length),
  };
}

/* ---------- 内部工具 ---------- */

/** 该车道是否是本侧最外一条（渐变出现/消失目前只支持最外侧） */
function isOutermost(road: Road, sectionIndex: number, laneId: number): boolean {
  const section = road.laneSections[sectionIndex];
  if (!section) return false;
  const side = laneId > 0 ? section.left : section.right;
  const last = side[side.length - 1];
  return last !== undefined && last.id === laneId;
}

/** 在指定段中取车道 */
function findLaneIn(road: Road, sectionIndex: number, laneId: number) {
  const section = road.laneSections[sectionIndex];
  if (!section) return undefined;
  const side = laneId > 0 ? section.left : section.right;
  return side.find((l) => l.id === laneId);
}

/**
 * 保证 s 处存在车道段边界，返回以 s 起始的段下标。
 *
 * s 已经是某段起点时直接返回该段；否则切分。落在道路首尾 1e-6 内无法切分，
 * 返回 −1。
 */
function ensureBoundary(road: Road, s: number): number {
  const existing = road.laneSections.findIndex((sec) => Math.abs(sec.s - s) < 1e-6);
  if (existing >= 0) return existing;
  if (!splitLaneSection(road, s)) return -1;
  return road.laneSections.findIndex((sec) => Math.abs(sec.s - s) < 1e-6);
}

/** 把某段内某条车道的宽度整体替换为单条多项式 */
function setSectionWidth(road: Road, sectionIndex: number, laneId: number, w: LaneWidth): boolean {
  const lane = findLaneIn(road, sectionIndex, laneId);
  if (!lane) return false;
  lane.widths = [w];
  return true;
}

/** 车道在给定站号处的宽度（跨段查找，取该段内的局部偏移） */
function widthAt(road: Road, sectionIndex: number, laneId: number, s: number): number {
  const lane = findLaneIn(road, sectionIndex, laneId);
  if (!lane) return 0;
  const range = laneSectionRange(road, sectionIndex);
  return laneWidthAt(lane, Math.max(0, s - range.start));
}

/** 段起点定位：返回包含 s 的段下标 */
function sectionIndexAt(road: Road, s: number): number {
  let idx = 0;
  for (let i = 0; i < road.laneSections.length; i++) {
    if (road.laneSections[i]!.s <= s + 1e-9) idx = i;
  }
  return idx;
}

/* ---------- 宽度渐变 ---------- */

/**
 * 在 [sStart, sStart+length] 上把车道宽度渐变到 toWidth，之后保持新宽度。
 *
 * 渐变段独占一段，其后再开一段承载新的恒定宽度。
 */
export function taperLaneWidth(
  road: Road,
  laneId: number,
  sStart: number,
  length: number,
  toWidth: number,
  shape: TaperShape = 'cubic',
  fromWidth?: number,
): TaperResult {
  if (laneId === 0) return { ok: false, reason: '中心车道没有宽度，无法渐变' };
  if (toWidth < 0) return { ok: false, reason: '目标宽度不能为负' };
  if (sStart < 0 || sStart >= road.length - MIN_TAPER_LENGTH) {
    return {
      ok: false,
      reason: `渐变起点 ${sStart.toFixed(1)} m 超出可用范围（道路全长 ${road.length.toFixed(1)} m）`,
    };
  }

  const from = fromWidth ?? widthAt(road, sectionIndexAt(road, sStart), laneId, sStart);
  if (!(from > 0)) return { ok: false, reason: `车道 ${laneId} 在 ${sStart.toFixed(1)} m 处不存在` };

  // 长度不能超出道路剩余部分
  const avail = road.length - sStart;
  const clamped = length > avail - 1e-6;
  const L = Math.max(MIN_TAPER_LENGTH, Math.min(length, avail));

  const startIdx = sStart <= 1e-6 ? 0 : ensureBoundary(road, sStart);
  if (startIdx < 0) return { ok: false, reason: '无法在渐变起点切分车道段' };

  const sEnd = sStart + L;
  // 渐变终点落在道路末端时不需要再切一段
  if (sEnd < road.length - 1e-6) {
    const endIdx = ensureBoundary(road, sEnd);
    if (endIdx < 0) return { ok: false, reason: '无法在渐变终点切分车道段' };
    // 渐变之后的所有段都用新宽度
    for (let i = endIdx; i < road.laneSections.length; i++) {
      setSectionWidth(road, i, laneId, { sOffset: 0, a: toWidth, b: 0, c: 0, d: 0 });
    }
  }

  if (!setSectionWidth(road, startIdx, laneId, taperPoly(from, toWidth, L, shape))) {
    return { ok: false, reason: `车道 ${laneId} 在渐变段中不存在` };
  }

  return { ok: true, length: L, clamped };
}

/* ---------- 车道数变化 ---------- */

/**
 * 车道在 sStart 之后渐变消失（4 车道变 3）。
 *
 * 只允许本侧最外一条：中间车道消失需要让外侧车道整体内移，靠逐段 `<lane><link>`
 * 表达前后车道对应关系，这套机制现在还没有——错误地直接删中间车道会让外侧车道
 * 在接缝处横向跳变。
 */
export function endLaneWithTaper(
  doc: OdrDocument,
  road: Road,
  laneId: number,
  sStart: number,
  length: number,
  shape: TaperShape = 'cubic',
): TaperResult {
  if (laneId === 0) return { ok: false, reason: '中心车道不能消失' };
  if (sStart < 0 || sStart >= road.length - MIN_TAPER_LENGTH) {
    return {
      ok: false,
      reason: `渐变起点 ${sStart.toFixed(1)} m 超出可用范围（道路全长 ${road.length.toFixed(1)} m）`,
    };
  }

  const startSection = sectionIndexAt(road, sStart);
  if (!isOutermost(road, startSection, laneId)) {
    return {
      ok: false,
      reason:
        `只有本侧最外侧车道可以渐变消失，车道 ${laneId} 不是最外侧。` +
        '中间车道消失需要外侧车道整体内移并逐段建立车道对应关系，暂不支持。',
    };
  }

  const from = widthAt(road, startSection, laneId, sStart);
  if (!(from > 0)) return { ok: false, reason: `车道 ${laneId} 在 ${sStart.toFixed(1)} m 处不存在` };

  const avail = road.length - sStart;
  const clamped = length > avail - 1e-6;
  const L = Math.max(MIN_TAPER_LENGTH, Math.min(length, avail));

  const startIdx = sStart <= 1e-6 ? 0 : ensureBoundary(road, sStart);
  if (startIdx < 0) return { ok: false, reason: '无法在渐变起点切分车道段' };

  const sEnd = sStart + L;
  // 渐变段内宽度收到 0；OpenDRIVE 允许零宽，但零宽只出现在这一个点上
  if (!setSectionWidth(road, startIdx, laneId, taperPoly(from, 0, L, shape))) {
    return { ok: false, reason: `车道 ${laneId} 在渐变段中不存在` };
  }

  // 渐变段上画实线：这就是地面上那道收窄的白色楔形边线
  const taperLane = findLaneIn(road, startIdx, laneId);
  if (taperLane) {
    taperLane.roadMarks = [{ sOffset: 0, type: 'solid', color: 'standard', width: 0.15 }];
  }

  let dropped = 0;
  let remapped = 0;

  if (sEnd < road.length - 1e-6) {
    const endIdx = ensureBoundary(road, sEnd);
    if (endIdx < 0) return { ok: false, reason: '无法在渐变终点切分车道段' };
    // 从渐变终点起真正删除该车道，并同步 junction 引用
    for (let i = road.laneSections.length - 1; i >= endIdx; i--) {
      const r = removeLaneFromDocument(doc, road, i, laneId);
      dropped += r.droppedLinks;
      remapped += r.remappedLinks;
    }
    // 车道消失后新的最外侧车道恢复实线边线
    const section = road.laneSections[endIdx];
    if (section) {
      const side = laneId > 0 ? section.left : section.right;
      const outer = side[side.length - 1];
      if (outer) {
        outer.roadMarks = [{ sOffset: 0, type: 'solid', color: 'standard', width: 0.15 }];
      }
    }
  }

  return { ok: true, length: L, clamped, droppedLinks: dropped, remappedLinks: remapped };
}

/**
 * 车道在 sStart 处渐变出现（3 车道变 4），宽度从 0 渐变到 toWidth。
 *
 * 与 {@link endLaneWithTaper} 对称，同样限制在本侧最外侧。
 */
export function beginLaneWithTaper(
  doc: OdrDocument,
  road: Road,
  laneId: number,
  sStart: number,
  length: number,
  toWidth: number,
  shape: TaperShape = 'cubic',
): TaperResult {
  if (laneId === 0) return { ok: false, reason: '中心车道不能新增' };
  if (!(toWidth > 0)) return { ok: false, reason: '目标宽度必须大于 0' };
  if (sStart < 0 || sStart >= road.length - MIN_TAPER_LENGTH) {
    return {
      ok: false,
      reason: `渐变起点 ${sStart.toFixed(1)} m 超出可用范围（道路全长 ${road.length.toFixed(1)} m）`,
    };
  }

  const startSection = sectionIndexAt(road, sStart);
  if (!isOutermost(road, startSection, laneId)) {
    return {
      ok: false,
      reason:
        `只有本侧最外侧车道可以渐变出现，车道 ${laneId} 不是最外侧。` +
        '中间插入车道需要外侧车道整体外移并逐段建立车道对应关系，暂不支持。',
    };
  }

  const avail = road.length - sStart;
  const clamped = length > avail - 1e-6;
  const L = Math.max(MIN_TAPER_LENGTH, Math.min(length, avail));

  const startIdx = sStart <= 1e-6 ? 0 : ensureBoundary(road, sStart);
  if (startIdx < 0) return { ok: false, reason: '无法在渐变起点切分车道段' };

  const sEnd = sStart + L;
  if (sEnd < road.length - 1e-6) {
    const endIdx = ensureBoundary(road, sEnd);
    if (endIdx < 0) return { ok: false, reason: '无法在渐变终点切分车道段' };
    for (let i = endIdx; i < road.laneSections.length; i++) {
      setSectionWidth(road, i, laneId, { sOffset: 0, a: toWidth, b: 0, c: 0, d: 0 });
    }
  }

  if (!setSectionWidth(road, startIdx, laneId, taperPoly(0, toWidth, L, shape))) {
    return { ok: false, reason: `车道 ${laneId} 在渐变段中不存在` };
  }

  const taperLane = findLaneIn(road, startIdx, laneId);
  if (taperLane) {
    taperLane.roadMarks = [{ sOffset: 0, type: 'solid', color: 'standard', width: 0.15 }];
  }

  // 渐变段之前该车道不应存在
  let dropped = 0;
  let remapped = 0;
  for (let i = startIdx - 1; i >= 0; i--) {
    const r = removeLaneFromDocument(doc, road, i, laneId);
    dropped += r.droppedLinks;
    remapped += r.remappedLinks;
  }

  return { ok: true, length: L, clamped, droppedLinks: dropped, remappedLinks: remapped };
}
