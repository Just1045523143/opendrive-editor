/**
 * 车道级手工连接。
 *
 * ── 为什么以车道对为基元 ──
 *
 * 自动配对只能看几何（航向差、车道序号、内外侧），而哪条车道能左转、有没有专用
 * 转向道、是否允许多车道同时左转，全由渠化决定，几何里没有这个信息。启发式再怎么
 * 调都只是猜，猜错了用户还得逐条删。所以基元是「进口车道 → 出口车道」这一对，
 * 自动生成退化为在它之上的一层便利（见 completeJunction）。
 *
 * ── 唯一事实来源与整体重建 ──
 *
 * 相邻车道要合并成一条多车道连接道路，于是「删掉三车道连接里中间那一条」就等于
 * 要把一条道路原地拆成两条。与其写拆分，不如让**车道对列表成为唯一事实来源**：
 * 每次增删都从文档里读回全部车道对，改完再整体重建该路口的连接道路。重建是
 * 幂等的，拆分与合并都自然落在同一条代码路径上。
 *
 * 代价是重建会重新分配连接道路 id。为此按顺序复用旧 id（见 rebuildJunction），
 * 常见的「加一条车道」不会让无关道路改号。
 *
 * ── 连续性约束 ──
 *
 * 一条连接道路的车道必须是 id 连续的（OpenDRIVE 要求同侧 id 由内向外连续），
 * 且两端都连续才能合并：进口 −1,−2 接出口 −1,−3 中间断了一条，合并后车道会
 * 整体错位。因此同一对路臂间的车道对先按内外顺序排好，再切成若干**极大连续段**，
 * 每段生成一条连接道路。
 */

import { distance, fromAngle, type Vec2 } from '../core/math/vec.ts';
import { findRoad, nextNumericId, type OdrDocument } from '../core/model/document.ts';
import type { Junction, JunctionConnection } from '../core/model/junction.ts';
import { crossSectionAt, laneBoundaryAt } from '../core/model/lanes.ts';
import { referencePoint } from '../core/model/reference.ts';
import type { ContactPoint, Road } from '../core/model/road.ts';
import {
  buildConnector,
  classifyTurn,
  DRIVABLE_TYPES,
  laneFlow,
  makeArmEnd,
  suggestPairs,
  type ArmEnd,
  type LanePair,
} from './connector.ts';
import type { RoadTemplate } from './roadFactory.ts';

/** 一条道路某一端的某条车道 */
export interface LaneRef {
  roadId: string;
  end: ContactPoint;
  laneId: number;
}

/** 一条车道级连接：进口车道 → 出口车道 */
export interface LanePairRef {
  from: LaneRef;
  to: LaneRef;
}

export function sameLaneRef(a: LaneRef, b: LaneRef): boolean {
  return a.roadId === b.roadId && a.end === b.end && a.laneId === b.laneId;
}

/** 可点击的车道端手柄 */
export interface LaneHandle {
  ref: LaneRef;
  /** 车道中心在端点处的世界坐标 */
  pos: Vec2;
  /** 该车道在此端是驶入路口还是驶出 */
  flow: 'entry' | 'exit';
  /** 车流方向（世界航向），用于画箭头 */
  hdg: number;
  distance: number;
}

/**
 * 光标附近的全部车道端手柄，按距离升序。
 *
 * 手柄落在**车道中心**而非参考线上，这样多车道路的每条车道都有独立可点的位置；
 * 落在参考线上则所有车道挤在一点，只能靠 Tab 盲选。
 *
 * 只取可通行车道：人行道、路肩不参与转向，给出手柄等于引诱用户点错。
 */
export function laneHandlesNear(
  doc: OdrDocument,
  world: Vec2,
  tolerance: number,
): LaneHandle[] {
  const out: LaneHandle[] = [];

  for (const road of doc.roads) {
    // 连接道路自身不参与连线，否则会连出路口套路口
    if (road.junction !== '-1' || road.length <= 0) continue;

    for (const end of ['start', 'end'] as const) {
      const s = end === 'start' ? 0 : road.length;
      const ref = referencePoint(road, s);
      // 先按参考线端点粗筛，省掉逐车道求解
      if (distance(world, { x: ref.x, y: ref.y }) > tolerance + 30) continue;

      const cs = crossSectionAt(road, s, ref);
      for (const boundary of [...cs.left, ...cs.right]) {
        if (!DRIVABLE_TYPES.has(boundary.type) || boundary.width <= 0.5) continue;

        const t = (boundary.tInner + boundary.tOuter) / 2;
        const left = fromAngle(ref.hdg + Math.PI / 2, t);
        const pos = { x: ref.x + left.x, y: ref.y + left.y };
        const d = distance(world, pos);
        if (d > tolerance) continue;

        const flow = laneFlow(end, boundary.laneId);
        // 驶入路口者朝向路口内侧，驶出者朝外
        const outward = end === 'start' ? ref.hdg : ref.hdg + Math.PI;
        out.push({
          ref: { roadId: road.id, end, laneId: boundary.laneId },
          pos,
          flow,
          hdg: flow === 'entry' ? outward + Math.PI : outward,
          distance: d,
        });
      }
    }
  }

  // 距离相等时按 roadId/end/laneId 兜底，保证 Tab 轮换下标稳定
  out.sort((a, b) => {
    if (a.distance !== b.distance) return a.distance - b.distance;
    if (a.ref.roadId !== b.ref.roadId) return a.ref.roadId < b.ref.roadId ? -1 : 1;
    if (a.ref.end !== b.ref.end) return a.ref.end === 'start' ? -1 : 1;
    return a.ref.laneId - b.ref.laneId;
  });
  return out;
}

/** 路臂标识：同一对路臂间的车道对才可能合并到一条连接道路 */
function armKey(from: LaneRef, to: LaneRef): string {
  return `${from.roadId}@${from.end}->${to.roadId}@${to.end}`;
}

/**
 * 从文档反读出某路口的全部车道对。
 *
 * 车道对没有单独存一份——它完整体现在「connection.laneLinks 的 from」加
 * 「连接道路对应车道的 link.successorIds」上，反读避免了同一事实存两处。
 */
export function readLanePairs(doc: OdrDocument, junctionId: string): LanePairRef[] {
  const j = doc.junctions.find((x) => x.id === junctionId);
  if (!j) return [];

  const out: LanePairRef[] = [];
  for (const c of j.connections) {
    const connecting = findRoad(doc, c.connectingRoad);
    if (!connecting) continue;

    const pre = connecting.link.predecessor;
    const suc = connecting.link.successor;
    if (pre?.elementType !== 'road' || suc?.elementType !== 'road') continue;
    const fromEnd = pre.contactPoint;
    const toEnd = suc.contactPoint;
    if (!fromEnd || !toEnd) continue;

    const section = connecting.laneSections[0];
    if (!section) continue;

    for (const link of c.laneLinks) {
      // laneLink.to 指向连接道路自身的车道，出口车道在该车道的 successorIds 上
      const lane = section.right.find((l) => l.id === link.to);
      const exitId = lane?.link.successorIds?.[0];
      if (exitId === undefined) continue;
      out.push({
        from: { roadId: c.incomingRoad, end: fromEnd, laneId: link.from },
        to: { roadId: suc.elementId, end: toEnd, laneId: exitId },
      });
    }
  }
  return out;
}

/**
 * 把同一对路臂间的车道对切成若干极大连续段。
 *
 * 连续的判据是**两端同时**递进一格：进口 −1,−2 接出口 −1,−3 时中间断了一条，
 * 合并成一条连接道路会让车道整体错位，必须切开。
 *
 * 排序按 |laneId| 升序，即由内向外——连接道路的车道也是由内向外铺（−1,−2,…），
 * 两者顺序一致才能逐位对上。
 */
function splitRuns(pairs: readonly LanePairRef[]): LanePairRef[][] {
  const sorted = [...pairs].sort((a, b) => {
    const d = Math.abs(a.from.laneId) - Math.abs(b.from.laneId);
    return d !== 0 ? d : Math.abs(a.to.laneId) - Math.abs(b.to.laneId);
  });

  const runs: LanePairRef[][] = [];
  let current: LanePairRef[] = [];
  for (const pair of sorted) {
    const prev = current[current.length - 1];
    const contiguous =
      prev !== undefined &&
      Math.abs(pair.from.laneId) === Math.abs(prev.from.laneId) + 1 &&
      Math.abs(pair.to.laneId) === Math.abs(prev.to.laneId) + 1;
    if (prev === undefined || contiguous) {
      current.push(pair);
    } else {
      runs.push(current);
      current = [pair];
    }
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/** 把 LaneRef 解析成几何所需的边界，顺带校验车道确实存在且方向对得上 */
function resolvePair(arms: Map<string, ArmEnd>, pair: LanePairRef): LanePair | null {
  const fromArm = arms.get(`${pair.from.roadId}@${pair.from.end}`);
  const toArm = arms.get(`${pair.to.roadId}@${pair.to.end}`);
  if (!fromArm || !toArm) return null;

  const entry = fromArm.entry.find((b) => b.laneId === pair.from.laneId);
  const exit = toArm.exit.find((b) => b.laneId === pair.to.laneId);
  if (!entry || !exit) return null;
  return { entry, exit };
}

/** 取（或缓存）某道路端点的路臂信息 */
function armFor(
  doc: OdrDocument,
  cache: Map<string, ArmEnd>,
  roadId: string,
  end: ContactPoint,
): ArmEnd | null {
  const key = `${roadId}@${end}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const road = findRoad(doc, roadId);
  if (!road) return null;
  const arm = makeArmEnd(road, end);
  if (arm) cache.set(key, arm);
  return arm;
}

export interface RebuildResult {
  /** 重建后的连接道路条数 */
  roads: number;
  /** 因几何退化而被跳过的车道对 */
  skipped: LanePairRef[];
}

/**
 * 按给定车道对整体重建某路口的全部连接道路。
 *
 * 幂等：同一份车道对列表重建两次结果一致。增、删、合并、拆分都只是「改列表再
 * 重建」，不需要各自的原地修改逻辑。
 */
export function rebuildJunction(
  doc: OdrDocument,
  junctionId: string,
  pairs: readonly LanePairRef[],
  template: RoadTemplate,
): RebuildResult {
  const j = doc.junctions.find((x) => x.id === junctionId);
  if (!j) return { roads: 0, skipped: [] };

  // 旧连接道路的 id 按顺序复用，避免加一条车道就让无关道路改号
  const recycled = j.connections.map((c) => c.connectingRoad);
  const oldIds = new Set(recycled);
  doc.roads = doc.roads.filter((r) => !oldIds.has(r.id));

  const armCache = new Map<string, ArmEnd>();
  // 先把两端路臂都解析出来，供 resolvePair 使用
  for (const p of pairs) {
    armFor(doc, armCache, p.from.roadId, p.from.end);
    armFor(doc, armCache, p.to.roadId, p.to.end);
  }

  // 按路臂对分组，组内再切连续段
  const groups = new Map<string, LanePairRef[]>();
  for (const p of pairs) {
    const key = armKey(p.from, p.to);
    const list = groups.get(key);
    if (list) list.push(p);
    else groups.set(key, [p]);
  }

  const connections: JunctionConnection[] = [];
  const newRoads: Road[] = [];
  const skipped: LanePairRef[] = [];
  // 分组顺序固定，保证重建结果与 id 分配可复现
  const keys = [...groups.keys()].sort();
  let recycleAt = 0;

  for (const key of keys) {
    for (const run of splitRuns(groups.get(key)!)) {
      const first = run[0]!;
      const fromArm = armCache.get(`${first.from.roadId}@${first.from.end}`);
      const toArm = armCache.get(`${first.to.roadId}@${first.to.end}`);
      if (!fromArm || !toArm) {
        skipped.push(...run);
        continue;
      }

      const resolved = run.map((p) => resolvePair(armCache, p));
      if (resolved.some((r) => r === null)) {
        skipped.push(...run);
        continue;
      }

      const roadId =
        recycled[recycleAt] ?? nextNumericId([...doc.roads, ...newRoads]);
      const built = buildConnector(
        roadId,
        fromArm,
        toArm,
        resolved as LanePair[],
        template,
      );
      if (!built) {
        skipped.push(...run);
        continue;
      }
      recycleAt++;

      built.junction = junctionId;
      newRoads.push(built);
      connections.push({
        id: String(connections.length),
        incomingRoad: first.from.roadId,
        connectingRoad: roadId,
        contactPoint: 'start',
        laneLinks: run.map((p, i) => ({ from: p.from.laneId, to: -(i + 1) })),
      });
    }
  }

  doc.roads.push(...newRoads);
  j.connections = connections;
  syncArmLinks(doc, j, pairs);

  return { roads: newRoads.length, skipped };
}

export interface ConnectResult {
  ok: boolean;
  /** 失败原因，可直接作为提示文案 */
  error?: string;
  roads?: number;
}

/**
 * 校验一对车道能否连接，返回失败原因。
 *
 * 方向是最容易搞错的一项：右行制下负 id 车道沿 +s 行驶，某道路以 start 端接入
 * 路口时右侧车道反而是**驶出**的。用户点了两条都驶出的车道就该说清楚，而不是
 * 静默不生成。
 */
function validatePair(doc: OdrDocument, pair: LanePairRef): string | null {
  const desc = (r: LaneRef) => `R${r.roadId}@${r.end === 'start' ? '起' : '终'}.${r.laneId}`;

  for (const ref of [pair.from, pair.to]) {
    const road = findRoad(doc, ref.roadId);
    if (!road) return `道路 ${ref.roadId} 不存在`;
    const s = ref.end === 'start' ? 0 : road.length;
    const boundary = laneBoundaryAt(road, ref.laneId, s);
    if (!boundary) return `${desc(ref)} 不存在`;
    if (!DRIVABLE_TYPES.has(boundary.type)) {
      return `${desc(ref)} 是 ${boundary.type}，不可通行车道不能参与转向`;
    }
  }

  if (laneFlow(pair.from.end, pair.from.laneId) !== 'entry') {
    return `${desc(pair.from)} 是驶出路口的车道，不能作为转向起点`;
  }
  if (laneFlow(pair.to.end, pair.to.laneId) !== 'exit') {
    return `${desc(pair.to)} 是驶入路口的车道，不能作为转向终点`;
  }
  return null;
}

/**
 * 新增一条车道级连接。
 *
 * 同一条进口车道可以连到多个出口（一条车道既可直行又可右转是常见渠化），
 * 所以只拒绝完全重复的 (from, to)。
 */
export function addLanePair(
  doc: OdrDocument,
  junctionId: string,
  pair: LanePairRef,
  template: RoadTemplate,
): ConnectResult {
  const j = doc.junctions.find((x) => x.id === junctionId);
  if (!j) return { ok: false, error: `交叉口 ${junctionId} 不存在` };

  const err = validatePair(doc, pair);
  if (err) return { ok: false, error: err };

  const pairs = readLanePairs(doc, junctionId);
  if (pairs.some((p) => sameLaneRef(p.from, pair.from) && sameLaneRef(p.to, pair.to))) {
    return { ok: false, error: '该车道连接已存在' };
  }

  pairs.push(pair);
  const res = rebuildJunction(doc, junctionId, pairs, template);
  // 新加的那一对若被跳过，说明几何退化，如实报出而不是假装成功
  if (res.skipped.some((p) => sameLaneRef(p.from, pair.from) && sameLaneRef(p.to, pair.to))) {
    return { ok: false, error: '两端过近或航向近乎平行，无法生成连接曲线' };
  }
  return { ok: true, roads: res.roads };
}

/** 删除一条车道级连接 */
export function removeLanePair(
  doc: OdrDocument,
  junctionId: string,
  pair: LanePairRef,
  template: RoadTemplate,
): ConnectResult {
  const j = doc.junctions.find((x) => x.id === junctionId);
  if (!j) return { ok: false, error: `交叉口 ${junctionId} 不存在` };

  const pairs = readLanePairs(doc, junctionId);
  const left = pairs.filter(
    (p) => !(sameLaneRef(p.from, pair.from) && sameLaneRef(p.to, pair.to)),
  );
  if (left.length === pairs.length) return { ok: false, error: '该车道连接不存在' };

  const res = rebuildJunction(doc, junctionId, left, template);
  return { ok: true, roads: res.roads };
}

export interface CompleteResult {
  /** 新增的车道对数 */
  added: number;
  roads: number;
}

/**
 * 按启发式补全该路口缺失的转向。
 *
 * 只在**已有车道对牵涉到的路臂**之间补——路臂由现有连接隐含推出，不另外声明。
 * 已存在的车道对一律保留：用户手工连的才是准的，补全不该覆盖它。
 *
 * 这是便利入口，不是唯一通路。启发式给的车道配对只是猜（见 suggestPairs），
 * 补完仍需逐条核对，不合渠化的删掉即可。
 */
export function completeJunction(
  doc: OdrDocument,
  junctionId: string,
  template: RoadTemplate,
): CompleteResult {
  const pairs = readLanePairs(doc, junctionId);

  // 路臂集合由现有车道对隐含给出
  const armRefs = new Map<string, { roadId: string; end: ContactPoint }>();
  for (const p of pairs) {
    for (const ref of [p.from, p.to]) {
      armRefs.set(`${ref.roadId}@${ref.end}`, { roadId: ref.roadId, end: ref.end });
    }
  }

  const armCache = new Map<string, ArmEnd>();
  const arms: ArmEnd[] = [];
  for (const { roadId, end } of armRefs.values()) {
    const arm = armFor(doc, armCache, roadId, end);
    if (arm) arms.push(arm);
  }

  const exists = (a: LanePairRef) =>
    pairs.some((p) => sameLaneRef(p.from, a.from) && sameLaneRef(p.to, a.to));

  let added = 0;
  for (const from of arms) {
    for (const to of arms) {
      const turn = classifyTurn(from, to);
      for (const sp of suggestPairs(from, to, turn)) {
        const candidate: LanePairRef = {
          from: { roadId: from.roadId, end: from.end, laneId: sp.entry.laneId },
          to: { roadId: to.roadId, end: to.end, laneId: sp.exit.laneId },
        };
        if (exists(candidate)) continue;
        pairs.push(candidate);
        added++;
      }
    }
  }

  const res = rebuildJunction(doc, junctionId, pairs, template);
  return { added: added - res.skipped.length, roads: res.roads };
}

/**
 * 同步各路臂指向本路口的 link。
 *
 * 入口道路的 link 指向**整个路口**而非某条转向，所以判据是「这条路还有没有
 * 车道对用到它」：用到就写上，一条不剩才清掉。出口臂同样要写——它也与路口相接。
 */
function syncArmLinks(doc: OdrDocument, j: Junction, pairs: readonly LanePairRef[]): void {
  const used = new Set<string>();
  for (const p of pairs) {
    used.add(`${p.from.roadId}@${p.from.end}`);
    used.add(`${p.to.roadId}@${p.to.end}`);
  }

  for (const road of doc.roads) {
    if (road.junction === j.id) continue; // 连接道路自身不指向 junction
    for (const which of ['predecessor', 'successor'] as const) {
      const end: ContactPoint = which === 'predecessor' ? 'start' : 'end';
      const key = `${road.id}@${end}`;
      const link = road.link[which];

      if (used.has(key)) {
        road.link[which] = { elementType: 'junction', elementId: j.id };
      } else if (link?.elementType === 'junction' && link.elementId === j.id) {
        // 该端已无车道对使用本路口，清掉否则成悬空引用
        delete road.link[which];
      }
    }
  }
}
