/**
 * 连接道路的几何构造。
 *
 * 手工连线与自动补全共用这一份实现。此前这些规则写在 junctionTool 内部，
 * 手工连线要用就得复制一遍——横向定位那几条极易写错，复制出去必然漂移。
 *
 * ── 四条容易写错的规则 ──
 *
 * 1. 参考线必须落在**所配对最内侧车道的内边界**上。连接道路的车道全在右侧
 *    （负 id，由 t=0 向外铺），参考线留在入口道路中心时，右转连接会横向偏出
 *    好几米，三车道路上偏差可达 10 m。
 *
 * 2. 把 t 换算成世界坐标要用**参考线航向** refHdg，不能用背离路口方向
 *    outward——start 端接入时两者相差 π，用错会把连接甩到路对面。
 *
 * 3. 可否通行看**车道类型**，不能看宽度。人行道 2 m、路肩 2.5 m 都能过宽度
 *    阈值，按宽度筛会把右转接到人行道上。
 *
 * 4. 掉头是例外：进出口最内侧车道的内边界都在中心线上，两点重合会让 Hermite
 *    退化。改把参考线放在车道中心，再用 laneOffset 把车道整体移回半个车道宽。
 */

import { fitHermiteConnector } from '../core/geometry/alignment.ts';
import { distance, fromAngle, normalizeAngle, type Vec2 } from '../core/math/vec.ts';
import { classifyTurnAngle, type TurnKind } from '../core/model/junction.ts';
import type { LaneType } from '../core/model/lane.ts';
import { crossSectionAt, type LaneBoundary } from '../core/model/lanes.ts';
import { referencePoint } from '../core/model/reference.ts';
import type { ContactPoint, Road } from '../core/model/road.ts';
import { buildRoad, type RoadTemplate } from './roadFactory.ts';

/** 参与转向连接的车道类型。人行道、路肩、绿化带等不可通行，不参与配对 */
export const DRIVABLE_TYPES = new Set<LaneType>([
  'driving', 'onRamp', 'offRamp', 'entry', 'exit', 'connectingRamp', 'bidirectional',
]);

/**
 * 掉头连接的 Hermite 切线长系数（乘以进出口车道中心的横向间距 w）。
 *
 * 掉头两端位姿反向平行、横向只隔 w，这个曲线族里半径由切线长 scale 单参数决定：
 *   端点曲率   κ_end  = 6w / scale²      （scale 越小，两端越尖）
 *   顶点曲率   κ_apex = 0.888·scale / w² （scale 越大，折返顶点越尖）
 * 两者相等时最小半径最大，解得 scale ≈ 1.89·w，此时 R_min ≈ 0.6·w。
 *
 * 也就是说 3.5 m 车道的掉头半径上限只有约 2.1 m——这是「进出口只隔一个车道宽」
 * 的几何必然，不是参数没调好。真实路口的掉头能有 7～8 m 半径，是因为车辆借用了
 * 对向车道的横向空间；连接道路两端被进出口车道钉死，给不出那个空间。
 */
export const UTURN_TANGENT_FACTOR = 1.89;

/** 两端点的最小间距（米）。小于此值 Hermite 退化成零长度曲线 */
export const MIN_CONNECTOR_SPAN = 1;

/** 连接道路的最小弧长（米） */
export const MIN_CONNECTOR_LENGTH = 0.5;

/** 一条道路接入路口的那一端 */
export interface ArmEnd {
  roadId: string;
  /** 该道路的哪一端接入路口 */
  end: ContactPoint;
  /** 端点平面位置 */
  pos: Vec2;
  /**
   * 背离路口的方向（沿本路远离路口中心）。
   * 驶入路口的车流方向为 outward + π，驶出为 outward。
   */
  outward: number;
  /** 本路参考线在该端点处的航向（沿 +s）。t 换算成世界坐标必须用它 */
  refHdg: number;
  /** 驶入路口的可通行车道（由内向外） */
  entry: LaneBoundary[];
  /** 驶出路口的可通行车道（由内向外） */
  exit: LaneBoundary[];
}

/** 由道路端点构造路臂，同时按接入端确定进/出车道 */
export function makeArmEnd(road: Road, end: ContactPoint): ArmEnd | null {
  if (road.length <= 0) return null;

  const s = end === 'start' ? 0 : road.length;
  const ref = referencePoint(road, s);
  const cs = crossSectionAt(road, s, ref);

  // 背离路口方向：start 端沿 +s 离开，end 端沿 −s 离开
  const outward = end === 'start' ? ref.hdg : normalizeAngle(ref.hdg + Math.PI);

  // end 端接入：右侧（负 id，沿 +s）驶入路口；start 端接入则相反
  const rawEntry = end === 'end' ? cs.right : cs.left;
  const rawExit = end === 'end' ? cs.left : cs.right;

  const drivable = (ls: LaneBoundary[]) =>
    ls.filter((l) => DRIVABLE_TYPES.has(l.type) && l.width > 0.5);

  return {
    roadId: road.id,
    end,
    pos: { x: ref.x, y: ref.y },
    outward,
    refHdg: ref.hdg,
    entry: drivable(rawEntry),
    exit: drivable(rawExit),
  };
}

/**
 * 某条车道在该端点是驶入路口还是驶出。
 *
 * 右行制下负 id 车道沿 +s 行驶：end 端接入时负 id 驶入路口，start 端接入时
 * 负 id 反而驶出。判断连线方向合法性全靠这一条。
 */
export function laneFlow(end: ContactPoint, laneId: number): 'entry' | 'exit' {
  if (end === 'end') return laneId < 0 ? 'entry' : 'exit';
  return laneId < 0 ? 'exit' : 'entry';
}

/** 把道路坐标 t 换算成世界坐标点。t 的正方向是参考线航向的左手侧 */
export function tToWorld(arm: ArmEnd, t: number): Vec2 {
  const left = fromAngle(arm.refHdg + Math.PI / 2, t);
  return { x: arm.pos.x + left.x, y: arm.pos.y + left.y };
}

/** 一对配对车道 */
export interface LanePair {
  entry: LaneBoundary;
  exit: LaneBoundary;
}

/**
 * 按转向类别给出建议的车道配对（启发式）。
 *
 * 沿用实际交规的车道功能划分：
 *   右转  取最外侧一条（不跨车道，避免与直行冲突）
 *   直行  由内向外逐条对齐，条数取两侧较小值
 *   左转  取最内侧一条（左转专用道通常在最内侧）
 *   掉头  取最内侧一条（与左转同车道，实际路口也是共用的）
 *
 * **这只是猜。** 哪条车道能左转、有没有专用转向道、是否允许多车道同时左转，
 * 全由渠化决定，几何里没有这个信息。所以它只用于「补全缺失转向」这个便利入口，
 * 不是唯一通路——真实渠化请手工连线（见 laneConnect.ts）。
 */
export function suggestPairs(from: ArmEnd, to: ArmEnd, turn: TurnKind): LanePair[] {
  const entry = from.entry;
  const exit = to.exit;
  if (entry.length === 0 || exit.length === 0) return [];

  if (turn === 'right') {
    return [{ entry: entry[entry.length - 1]!, exit: exit[exit.length - 1]! }];
  }
  // 掉头与左转同样占最内侧，各取一条
  if (turn === 'left' || turn === 'uturn') {
    return [{ entry: entry[0]!, exit: exit[0]! }];
  }

  const n = Math.min(entry.length, exit.length);
  const out: LanePair[] = [];
  for (let i = 0; i < n; i++) out.push({ entry: entry[i]!, exit: exit[i]! });
  return out;
}

/**
 * 转向分类：驶入方向 = from.outward + π，驶出方向 = to.outward，两者之差即转角。
 *
 * 以四岔口为例：A 臂 outward=0（朝东），车流向西（π）驶入；转到 B 臂
 * outward=π/2（朝北）时差值为 −π/2，面朝西时北在右手侧，故为右转。
 */
export function classifyTurn(from: ArmEnd, to: ArmEnd): TurnKind {
  if (from.roadId === to.roadId && from.end === to.end) return 'uturn';
  const inflow = from.outward + Math.PI;
  return classifyTurnAngle(normalizeAngle(to.outward - inflow));
}

/**
 * 构造连接道路：Hermite 曲线精确衔接两端位姿，车道数等于配对数。
 *
 * pairs 必须是**从最内侧起连续的若干条**：横向定位把参考线放在 pairs[0] 的
 * 内边界上，中间缺一条会让后续车道整体错位。调用方负责保证连续性。
 *
 * 返回 null 表示几何退化（两端过近、弧长异常），调用方应跳过该转向。
 */
export function buildConnector(
  roadId: string,
  from: ArmEnd,
  to: ArmEnd,
  pairs: readonly LanePair[],
  template: RoadTemplate,
): Road | null {
  const first = pairs[0];
  if (!first) return null;

  const inflow = normalizeAngle(from.outward + Math.PI);
  // 同一条路的进出口相接即掉头：两侧内边界都在中心线上，会重合
  const uturn = from.roadId === to.roadId && from.end === to.end;

  let startT = first.entry.tInner;
  let endT = first.exit.tInner;
  let laneOffset = 0;
  let tangentScale: number | undefined;

  if (uturn) {
    // 参考线走车道中心，车道再整体外移半宽，抵消这次平移
    const halfIn = first.entry.width / 2;
    const halfOut = first.exit.width / 2;
    startT = first.entry.tInner + (first.entry.tOuter - first.entry.tInner) / 2;
    endT = first.exit.tInner + (first.exit.tOuter - first.exit.tInner) / 2;
    laneOffset = (halfIn + halfOut) / 2;
    tangentScale = UTURN_TANGENT_FACTOR * (halfIn + halfOut);
  }

  const startPos = tToWorld(from, startT);
  const endPos = tToWorld(to, endT);

  const span = distance(startPos, endPos);
  if (span < MIN_CONNECTOR_SPAN) return null;

  const geom = fitHermiteConnector(startPos, inflow, endPos, to.outward, 0, tangentScale);

  // 弧长必须有限、正、且不短于弦长（后者可捕捉数值异常）
  if (!Number.isFinite(geom.length) || geom.length < MIN_CONNECTOR_LENGTH) return null;
  if (geom.length < span - 1e-6) return null;

  const road = buildRoad(
    roadId,
    [geom],
    {
      ...template,
      leftLanes: 0,
      rightLanes: pairs.length,
      // 逐条车道宽度下面单独覆盖，这里给个占位值
      laneWidth: (first.entry.width + first.exit.width) / 2,
      sidewalk: false,
    },
    `J连接 ${from.roadId}→${to.roadId}`,
  );
  if (laneOffset !== 0) road.laneOffsets = [{ s: 0, a: laneOffset, b: 0, c: 0, d: 0 }];

  road.link.predecessor = {
    elementType: 'road',
    elementId: from.roadId,
    contactPoint: from.end,
  };
  road.link.successor = {
    elementType: 'road',
    elementId: to.roadId,
    contactPoint: to.end,
  };

  const section = road.laneSections[0];
  if (section) {
    for (let i = 0; i < pairs.length; i++) {
      const lane = section.right[i];
      const pair = pairs[i];
      if (!lane || !pair) continue;
      lane.link.predecessorIds = [pair.entry.laneId];
      lane.link.successorIds = [pair.exit.laneId];
      // 逐条取进出口均值：进口 3.5 m 出口 3.0 m 时，统一宽度会让两端都错位
      lane.widths = [
        { sOffset: 0, a: (pair.entry.width + pair.exit.width) / 2, b: 0, c: 0, d: 0 },
      ];
    }
    // 路口内不画车道线，避免压盖导流区
    for (const lane of section.right) {
      lane.roadMarks = [{ sOffset: 0, type: 'none', color: 'standard', width: 0.15 }];
    }
    section.center.roadMarks = [{ sOffset: 0, type: 'none', color: 'standard', width: 0.15 }];
  }

  return road;
}
