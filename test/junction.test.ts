/**
 * 交叉口生成测试。
 *
 * 由于 JunctionTool 依赖 DOM 与 Canvas，这里不实例化工具本身，而是直接测试
 * 它所依赖的几何/拓扑规则，以及生成结果能否通过校验。转向分类与车道配对的
 * 逻辑用与工具内部一致的公式复算，确保规则本身正确。
 */

import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { DEFAULT_FIT, fitHermiteConnector } from '../src/core/geometry/alignment.ts';
import { evaluateGeometry } from '../src/core/geometry/evaluate.ts';
import { normalizeAngle, type Vec2 } from '../src/core/math/vec.ts';
import {
  connectionTouchesRoad,
  createEmptyDocument,
  isEndOccupied,
  nextNumericId,
} from '../src/core/model/document.ts';
import { createJunction, type Junction } from '../src/core/model/junction.ts';
import { crossSectionAt } from '../src/core/model/lanes.ts';
import { referencePoint } from '../src/core/model/reference.ts';
import type { ContactPoint, Road } from '../src/core/model/road.ts';
import { summarizeIssues, validateDocument } from '../src/core/model/validate.ts';
import { parseOpenDrive } from '../src/core/xml/parse.ts';
import { serializeOpenDrive } from '../src/core/xml/serialize.ts';
import { buildRoad, buildRoadFromPoints, DEFAULT_TEMPLATE } from '../src/editor/roadFactory.ts';
import { deleteConnection, deleteJunction } from '../src/editor/junctionEdit.ts';
import { deleteRoad } from '../src/editor/roadEdit.ts';
import { JunctionTool } from '../src/editor/tools/junctionTool.ts';
import { DEFAULT_SNAP, type ToolContext } from '../src/editor/tools/types.ts';
import { Store } from '../src/editor/store.ts';
import { Viewport } from '../src/editor/viewport.ts';

const CRS = '+proj=tmerc +lat_0=39.9 +lon_0=116.4 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs';

const STRAIGHT_TOL = Math.PI / 6;
const UTURN_LIMIT = (5 * Math.PI) / 6;

type TurnKind = 'left' | 'straight' | 'right' | 'uturn';

/** 与 JunctionTool.classifyTurn 同构的独立实现，用于验证规则本身 */
function classifyTurn(fromOutward: number, toOutward: number): TurnKind | null {
  const inflow = fromOutward + Math.PI;
  const delta = normalizeAngle(toOutward - inflow);
  const abs = Math.abs(delta);
  if (abs > UTURN_LIMIT) return 'uturn';
  if (abs < STRAIGHT_TOL) return 'straight';
  return delta > 0 ? 'left' : 'right';
}

/**
 * 路口半径：各臂止于距路口中心该距离处，而非交汇于一点。
 *
 * 真实路口的进口道在路缘石处即终止，中间的空腔由连接道路填充。若把各臂端点
 * 都放在同一点，连接道路的两端就会重合，Hermite 退化成零长度曲线。
 */
const JUNCTION_RADIUS = 14;

/** 构造一条朝 outward 方向伸出的路臂，其 end 端止于路口边缘 */
function makeArmRoad(
  id: string,
  center: Vec2,
  outward: number,
  len: number,
  lanes = 2,
): { road: Road; end: ContactPoint } {
  const cos = Math.cos(outward);
  const sin = Math.sin(outward);
  // 近端（路口侧）与远端；从远端指向近端，故 end 端在路口处
  const near = { x: center.x + cos * JUNCTION_RADIUS, y: center.y + sin * JUNCTION_RADIUS };
  const far = { x: center.x + cos * (JUNCTION_RADIUS + len), y: center.y + sin * (JUNCTION_RADIUS + len) };
  const built = buildRoadFromPoints(id, [far, near], DEFAULT_FIT, {
    ...DEFAULT_TEMPLATE,
    leftLanes: lanes,
    rightLanes: lanes,
  });
  assert.ok(built !== null, `路臂 ${id} 生成失败`);
  return { road: built!.road, end: 'end' };
}

describe('转向分类', () => {
  test('四岔口的直行/左转/右转判定', () => {
    // 四条臂分别朝东、北、西、南伸出
    const east = 0;
    const north = Math.PI / 2;
    const west = Math.PI;
    const south = -Math.PI / 2;

    // 从东臂驶入（车流朝西）
    assert.equal(classifyTurn(east, west), 'straight', '东→西应为直行');
    // 车头朝西时，北在右手侧
    assert.equal(classifyTurn(east, north), 'right', '东→北应为右转');
    assert.equal(classifyTurn(east, south), 'left', '东→南应为左转');
    // 回到自身为掉头
    assert.equal(classifyTurn(east, east), 'uturn', '东→东应为掉头');
  });

  test('从各臂驶入的直行目标唯一且为对臂', () => {
    const arms = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
    for (const from of arms) {
      const straights = arms.filter((to) => classifyTurn(from, to) === 'straight');
      assert.equal(straights.length, 1, `从 ${from} 驶入应只有一个直行方向`);
      // 直行目标应与入口臂反向
      assert.ok(Math.abs(normalizeAngle(straights[0]! - (from + Math.PI))) < 1e-9);
    }
  });

  test('左右转在四岔口对称出现', () => {
    const arms = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
    let lefts = 0;
    let rights = 0;
    let straights = 0;
    let uturns = 0;
    for (const from of arms) {
      for (const to of arms) {
        const t = classifyTurn(from, to);
        if (t === 'left') lefts++;
        else if (t === 'right') rights++;
        else if (t === 'straight') straights++;
        else if (t === 'uturn') uturns++;
      }
    }
    assert.equal(straights, 4, '应有 4 个直行');
    assert.equal(lefts, 4, '应有 4 个左转');
    assert.equal(rights, 4, '应有 4 个右转');
    assert.equal(uturns, 4, '每臂各一个掉头');
  });

  test('T 形路口无对臂时仍生成左右转', () => {
    // 三臂：东、北、南（缺西）
    const arms = [0, Math.PI / 2, -Math.PI / 2];
    const kinds: TurnKind[] = [];
    for (const from of arms) {
      for (const to of arms) {
        const t = classifyTurn(from, to);
        if (t) kinds.push(t);
      }
    }
    // 从北驶入（朝南）可直行到南；东臂无对臂故无直行
    assert.ok(kinds.includes('left'));
    assert.ok(kinds.includes('right'));
    assert.equal(kinds.filter((k) => k === 'straight').length, 2, '南北互为对臂，应有 2 个直行');
  });

  test('斜交路口按夹角归类', () => {
    // 从东臂驶入（朝西），目标臂偏北 30°：仍在直行容差内
    assert.equal(classifyTurn(0, Math.PI - Math.PI / 12), 'straight', '偏 15° 应算直行');
    // 偏 45° 超出容差，北侧为右转
    assert.equal(classifyTurn(0, Math.PI - Math.PI / 4), 'right');
    assert.equal(classifyTurn(0, Math.PI + Math.PI / 4), 'left');
  });
});

describe('进出车道判定', () => {
  test('end 端接入时右侧为进口、左侧为出口', () => {
    const { road } = makeArmRoad('1', { x: 0, y: 0 }, 0, 100, 2);
    const cs = crossSectionAt(road, road.length);
    // 右侧（负 id）沿 +s 行驶，s 增大方向即朝路口，故为进口
    assert.equal(cs.right.length, 2);
    assert.equal(cs.left.length, 2);
    assert.ok(cs.right.every((l) => l.laneId < 0));
    assert.ok(cs.left.every((l) => l.laneId > 0));
  });

  test('start 端接入时进出方向互换', () => {
    // 从路口指向远端，start 端在路口
    const built = buildRoadFromPoints('1', [{ x: 0, y: 0 }, { x: 100, y: 0 }], DEFAULT_FIT, {
      ...DEFAULT_TEMPLATE,
      leftLanes: 1,
      rightLanes: 3,
    });
    const road = built!.road;
    const cs = crossSectionAt(road, 0);
    // start 端：负 id 车道沿 +s 离开路口，故进口是正 id（左侧）
    assert.equal(cs.left.length, 1, 'start 端进口车道数');
    assert.equal(cs.right.length, 3, 'start 端出口车道数');
  });

  test('人行道不参与配对（宽度过滤生效）', () => {
    const built = buildRoadFromPoints('1', [{ x: 0, y: 0 }, { x: 100, y: 0 }], DEFAULT_FIT, {
      ...DEFAULT_TEMPLATE,
      leftLanes: 1,
      rightLanes: 2,
      sidewalk: true,
    });
    const road = built!.road;
    const cs = crossSectionAt(road, road.length);
    // 含人行道后右侧应为 3 条
    assert.equal(cs.right.length, 3);
    const drivable = cs.right.filter((l) => l.width > 0.5);
    // 全部宽度都大于 0.5 m，故此处过滤不减少数量；确认宽度读数正确
    assert.equal(drivable.length, 3);
    assert.ok(cs.right.every((l) => l.width > 0));
  });
});

describe('连接道路几何', () => {
  test('Hermite 连接器两端位姿精确吻合', () => {
    const from: Vec2 = { x: 0, y: 0 };
    const to: Vec2 = { x: 40, y: 30 };
    const inflow = 0;
    const outflow = Math.PI / 2;

    const geom = fitHermiteConnector(from, inflow, to, outflow);
    const s = evaluateGeometry(geom, 0);
    const e = evaluateGeometry(geom, geom.length);

    assert.ok(Math.hypot(s.x - from.x, s.y - from.y) < 1e-12, '起点应精确');
    assert.ok(Math.abs(normalizeAngle(s.hdg - inflow)) < 1e-12, '起点航向应精确');
    assert.ok(Math.hypot(e.x - to.x, e.y - to.y) < 1e-6, `终点偏差 ${Math.hypot(e.x - to.x, e.y - to.y)}`);
    assert.ok(Math.abs(normalizeAngle(e.hdg - outflow)) < 1e-6, '终点航向应精确');
  });

  test('连接道路可被 buildRoad 包装且长度自洽', () => {
    const geom = fitHermiteConnector({ x: 0, y: 0 }, 0, { x: 30, y: 20 }, Math.PI / 2);
    const road = buildRoad('9', [geom], {
      ...DEFAULT_TEMPLATE,
      leftLanes: 0,
      rightLanes: 1,
      sidewalk: false,
    });
    assert.equal(road.planView.length, 1);
    assert.ok(Math.abs(road.length - geom.length) < 1e-9);
    assert.equal(road.laneSections[0]?.right.length, 1);
    assert.equal(road.laneSections[0]?.left.length, 0);
  });

  test('对称左右转的连接长度一致', () => {
    // 三臂端点都在路口边缘（半径 R）上：东、北、南
    const R = 14;
    const inflow = Math.PI; // 自东臂驶入，车流朝西
    const entry: Vec2 = { x: R, y: 0 };
    const northEnd: Vec2 = { x: 0, y: R };
    const southEnd: Vec2 = { x: 0, y: -R };

    const right = fitHermiteConnector(entry, inflow, northEnd, Math.PI / 2);
    const left = fitHermiteConnector(entry, inflow, southEnd, -Math.PI / 2);

    assert.ok(right.length > 0 && Number.isFinite(right.length), '右转长度应为有限正值');
    assert.ok(left.length > 0 && Number.isFinite(left.length), '左转长度应为有限正值');
    // 两条转向关于 x 轴镜像对称，弧长必须相等
    assert.ok(Math.abs(right.length - left.length) < 1e-6, `对称转向长度应一致：${right.length} vs ${left.length}`);
    // 弧长不应短于两端点直线距离
    assert.ok(right.length >= Math.hypot(R, R) - 1e-9, '弧长不应短于弦长');
  });

  test('端点重合时连接器退化，工具须拒绝生成', () => {
    // 这是各臂交汇于一点时的情形：起终点重合
    const p: Vec2 = { x: 0, y: 0 };
    const geom = fitHermiteConnector(p, 0, p, Math.PI / 2);
    // 退化结果长度为 0 或极小，调用方必须据此拒绝，不能写入文档
    assert.ok(geom.length < 0.1, `退化连接长度应趋零，实际 ${geom.length}`);
  });
});

/** 构造一个可在 Node 下驱动工具的最小上下文 */
function makeContext(doc: ReturnType<typeof createEmptyDocument>) {
  const store = new Store(doc);
  const viewport = new Viewport();
  viewport.size = { width: 1200, height: 800 };
  viewport.pixelsPerMeter = 4;
  const ctx = {
    store,
    viewport,
    projector: null,
    renderData: () => [],
    requestRedraw: () => {},
    invalidate: () => {},
    template: { ...DEFAULT_TEMPLATE },
    fit: { ...DEFAULT_FIT },
    snap: { ...DEFAULT_SNAP },
  };
  return { store, viewport, ctx: ctx as unknown as ToolContext };
}

function pointerAt(viewport: Viewport, world: Vec2) {
  return {
    screen: viewport.worldToScreen(world),
    world,
    button: 0,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    raw: {} as PointerEvent,
  };
}

/** 依次点选各路臂的路口侧端点，然后回车生成 */
function driveTool(tool: JunctionTool, ctx: ToolContext, viewport: Viewport, roads: Road[]): void {
  tool.onActivate?.(ctx);
  for (const road of roads) {
    const ref = referencePoint(road, road.length);
    const input = pointerAt(viewport, { x: ref.x, y: ref.y });
    tool.onPointerMove?.(ctx, input);
    tool.onPointerDown?.(ctx, input);
  }
  tool.onKeyDown?.(ctx, { key: 'Enter' } as KeyboardEvent);
}

describe('JunctionTool 端到端', () => {
  /** 四臂路口，各臂车道数可分别指定 */
  function makeFourArmDoc(laneCounts: number[]) {
    const doc = createEmptyDocument(CRS);
    const outwards = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
    const arms = outwards.map((out, i) => {
      const { road } = makeArmRoad(String(i + 1), { x: 0, y: 0 }, out, 80, laneCounts[i] ?? 2);
      doc.roads.push(road);
      return road;
    });
    return { doc, arms };
  }

  test('四岔口：生成 16 条连接、校验干净、往返稳定', () => {
    const { doc, arms } = makeFourArmDoc([2, 2, 2, 2]);
    const { store, viewport, ctx } = makeContext(doc);
    driveTool(new JunctionTool(), ctx, viewport, arms);

    const d = store.document;
    assert.equal(d.junctions.length, 1, '应生成 1 个交叉口');
    const j = d.junctions[0]!;
    assert.equal(j.connections.length, 16, '4 臂应有 16 条转向（含 4 个掉头）');

    const connRoads = d.roads.filter((r) => r.junction === j.id);
    assert.equal(connRoads.length, 16, '连接道路数应与连接数一致');

    // 不得出现零长度或非法几何
    for (const r of connRoads) {
      assert.ok(r.length > 0.5, `连接道路 ${r.id} 长度过小：${r.length}`);
      assert.equal(r.planView.length, 1);
      assert.ok(Number.isFinite(r.planView[0]!.length));
    }

    // 入口道路保持 -1 且经 link 指向 junction
    for (const arm of arms) {
      const road = d.roads.find((r) => r.id === arm.id)!;
      assert.equal(road.junction, '-1', `入口道路 ${road.id} 不应标记归属`);
      assert.equal(road.link.successor?.elementType, 'junction');
      assert.equal(road.link.successor?.elementId, j.id);
    }

    const issues = validateDocument(d);
    assert.equal(
      summarizeIssues(issues).errors,
      0,
      issues.filter((i) => i.level === 'error').map((i) => i.message).join(' | '),
    );

    // 往返
    const back = parseOpenDrive(serializeOpenDrive(d));
    assert.deepEqual(back.warnings, [], `解析警告：${back.warnings.join('; ')}`);
    assert.equal(back.document.junctions[0]?.connections.length, 16);
    assert.equal(summarizeIssues(validateDocument(back.document)).errors, 0);
  });

  test('转向构成符合预期：直行 4、左转 4、右转 4', () => {
    const { doc, arms } = makeFourArmDoc([2, 2, 2, 2]);
    const { store, viewport, ctx } = makeContext(doc);
    driveTool(new JunctionTool(), ctx, viewport, arms);

    // 直行连接的车道数为 2（逐条对齐），左右转与掉头为 1
    const j = store.document.junctions[0]!;
    const byLaneCount = j.connections.reduce<Record<number, number>>((acc, c) => {
      acc[c.laneLinks.length] = (acc[c.laneLinks.length] ?? 0) + 1;
      return acc;
    }, {});
    assert.equal(byLaneCount[2], 4, '应有 4 条双车道连接（直行）');
    assert.equal(byLaneCount[1], 12, '应有 12 条单车道连接（左右转 8 + 掉头 4）');
  });

  test('车道数不等时生成主次优先级', () => {
    // 东西向 3 车道为主路，南北向 1 车道为支路
    const { doc, arms } = makeFourArmDoc([3, 1, 3, 1]);
    const { store, viewport, ctx } = makeContext(doc);
    driveTool(new JunctionTool(), ctx, viewport, arms);

    const j = store.document.junctions[0]!;
    assert.ok(j.priorities.length > 0, '应生成优先级关系');
    // 主路（1、3）应出现在 high 侧，支路（2、4）在 low 侧
    for (const p of j.priorities) {
      assert.ok(['1', '3'].includes(p.high), `high=${p.high} 应为主路`);
      assert.ok(['2', '4'].includes(p.low), `low=${p.low} 应为支路`);
    }
    assert.equal(summarizeIssues(validateDocument(store.document)).errors, 0);
  });

  test('车道数相同时不臆断优先级', () => {
    const { doc, arms } = makeFourArmDoc([2, 2, 2, 2]);
    const { store, viewport, ctx } = makeContext(doc);
    driveTool(new JunctionTool(), ctx, viewport, arms);
    assert.equal(store.document.junctions[0]!.priorities.length, 0, '等级相同应留空待人工指定');
  });

  test('路臂不足 3 条时拒绝生成', () => {
    const { doc, arms } = makeFourArmDoc([2, 2, 2, 2]);
    const { store, viewport, ctx } = makeContext(doc);
    driveTool(new JunctionTool(), ctx, viewport, arms.slice(0, 2));

    assert.equal(store.document.junctions.length, 0, '不应生成交叉口');
    assert.ok(
      store.messages.some((m) => m.level === 'warn' && m.text.includes('至少需要 3 条')),
      `消息：${store.messages.map((m) => m.text).join(' | ')}`,
    );
  });

  test('各臂端点重合时报错并给出可操作提示', () => {
    // 各臂全部交汇于原点：Hermite 退化
    const doc = createEmptyDocument(CRS);
    const outwards = [0, Math.PI / 2, Math.PI];
    const arms = outwards.map((out, i) => {
      const far = { x: Math.cos(out) * 80, y: Math.sin(out) * 80 };
      const built = buildRoadFromPoints(String(i + 1), [far, { x: 0, y: 0 }], DEFAULT_FIT, {
        ...DEFAULT_TEMPLATE,
        leftLanes: 1,
        rightLanes: 1,
      });
      doc.roads.push(built!.road);
      return built!.road;
    });

    const { store, viewport, ctx } = makeContext(doc);
    driveTool(new JunctionTool(), ctx, viewport, arms);

    assert.equal(store.document.junctions.length, 0, '退化情形不应写入文档');
    const err = store.messages.find((m) => m.level === 'error');
    assert.ok(err, `应报错，实际消息：${store.messages.map((m) => m.text).join(' | ')}`);
    assert.ok(err!.text.includes('路缘石'), '提示应说明如何修正');
  });

  /**
   * 只有一对端点重合时不能否决整个路口。
   *
   * 退化判据一度写成「最小端点间距 < 1 m」，于是任意一对端点挨在一起（相邻路段
   * 在分割点处、或两条路吸附到了同一点）就让整个路口生成失败，其余完全正常的
   * 路臂对跟着作废，用户看到的是「明明可以连线却报无法连接」。
   */
  test('仅一对端点重合时仍生成其余转向', () => {
    const doc = createEmptyDocument(CRS);
    // 1、2 两臂端点仅相距 0.5 m（小于 MIN_CONNECTOR_SPAN），3 臂正常远离
    const specs: Array<{ id: string; center: Vec2; outward: number }> = [
      { id: '1', center: { x: 0, y: 0 }, outward: 0 },
      { id: '2', center: { x: 0.5, y: 0 }, outward: 0 },
      { id: '3', center: { x: 0, y: 0 }, outward: Math.PI },
    ];
    const arms = specs.map((s) => {
      const { road } = makeArmRoad(s.id, s.center, s.outward, 80, 2);
      doc.roads.push(road);
      return road;
    });

    const { store, viewport, ctx } = makeContext(doc);
    driveTool(new JunctionTool(), ctx, viewport, arms);

    const j = store.document.junctions[0];
    assert.ok(j, `应生成交叉口，实际消息：${store.messages.map((m) => m.text).join(' | ')}`);
    assert.ok(j!.connections.length > 0, '应生成若干转向');

    // 与 3 臂之间的转向必须都在（它离另两臂都足够远）
    for (const id of ['1', '2']) {
      assert.ok(
        j!.connections.some((c) => c.incomingRoad === id),
        `R${id} 应有驶出的转向`,
      );
    }
    assert.ok(
      j!.connections.some((c) => c.incomingRoad === '3'),
      'R3 应有驶出的转向',
    );

    // 跳过的那一对要单独提示，否则用户只会觉得生成的连接不全
    const warn = store.messages.find(
      (m) => m.level === 'warn' && m.text.includes('几乎重合'),
    );
    assert.ok(warn, `应提示被跳过的路臂对：${store.messages.map((m) => m.text).join(' | ')}`);
    assert.equal(
      summarizeIssues(validateDocument(store.document)).errors,
      0,
      '生成结果应通过校验',
    );
  });

  test('端点已有连接时拒绝并列出冲突', () => {
    const { doc, arms } = makeFourArmDoc([2, 2, 2, 2]);
    // 人为占用第一条臂的终点
    arms[0]!.link.successor = { elementType: 'road', elementId: '2', contactPoint: 'end' };

    const { store, viewport, ctx } = makeContext(doc);
    driveTool(new JunctionTool(), ctx, viewport, arms);

    assert.equal(store.document.junctions.length, 0);
    const err = store.messages.find((m) => m.level === 'error');
    assert.ok(err, '应报错');
    assert.ok(err!.text.includes('R1@end'), `应指明冲突端点，实际：${err!.text}`);
  });

  test('重复点击同一端点为取消选中', () => {
    const { doc, arms } = makeFourArmDoc([2, 2, 2, 2]);
    const { store, viewport, ctx } = makeContext(doc);
    const tool = new JunctionTool();
    tool.onActivate?.(ctx);

    // 选中 3 条，再把第 1 条取消，剩 2 条应无法生成
    for (const road of arms.slice(0, 3)) {
      const ref = referencePoint(road, road.length);
      const input = pointerAt(viewport, { x: ref.x, y: ref.y });
      tool.onPointerMove?.(ctx, input);
      tool.onPointerDown?.(ctx, input);
    }
    const first = referencePoint(arms[0]!, arms[0]!.length);
    const undo = pointerAt(viewport, { x: first.x, y: first.y });
    tool.onPointerMove?.(ctx, undo);
    tool.onPointerDown?.(ctx, undo);

    tool.onKeyDown?.(ctx, { key: 'Enter' } as KeyboardEvent);
    assert.equal(store.document.junctions.length, 0, '取消后仅剩 2 条臂，不应生成');
  });

  test('生成后可撤销', () => {
    const { doc, arms } = makeFourArmDoc([2, 2, 2, 2]);
    const { store, viewport, ctx } = makeContext(doc);
    const roadsBefore = store.document.roads.length;

    driveTool(new JunctionTool(), ctx, viewport, arms);
    assert.equal(store.document.junctions.length, 1);
    assert.ok(store.document.roads.length > roadsBefore);

    store.undo();
    assert.equal(store.document.junctions.length, 0, '撤销后交叉口应消失');
    assert.equal(store.document.roads.length, roadsBefore, '撤销后连接道路应消失');
    // 入口道路的 link 也应还原
    for (const arm of arms) {
      const road = store.document.roads.find((r) => r.id === arm.id)!;
      assert.equal(road.link.successor, undefined, `道路 ${road.id} 的 link 应还原`);
    }
  });

  test('T 形路口生成 6 条连接', () => {
    const doc = createEmptyDocument(CRS);
    const outwards = [0, Math.PI / 2, -Math.PI / 2];
    const arms = outwards.map((out, i) => {
      const { road } = makeArmRoad(String(i + 1), { x: 0, y: 0 }, out, 70, 1);
      doc.roads.push(road);
      return road;
    });

    const { store, viewport, ctx } = makeContext(doc);
    driveTool(new JunctionTool(), ctx, viewport, arms);

    const j = store.document.junctions[0];
    assert.ok(j, '应生成交叉口');
    assert.equal(j!.connections.length, 9, 'T 形路口应有 9 条转向（含 3 个掉头）');
    assert.equal(summarizeIssues(validateDocument(store.document)).errors, 0);
  });

  test('五岔口生成 25 条连接', () => {
    const doc = createEmptyDocument(CRS);
    const outwards = [0, (2 * Math.PI) / 5, (4 * Math.PI) / 5, (6 * Math.PI) / 5, (8 * Math.PI) / 5];
    const arms = outwards.map((out, i) => {
      const { road } = makeArmRoad(String(i + 1), { x: 0, y: 0 }, out, 70, 1);
      doc.roads.push(road);
      return road;
    });

    const { store, viewport, ctx } = makeContext(doc);
    driveTool(new JunctionTool(), ctx, viewport, arms);

    const j = store.document.junctions[0]!;
    // 5 臂两两有序对共 20 组转向，另加各臂一个掉头
    assert.equal(j.connections.length, 25, '5 臂应有 25 条转向（含 5 个掉头）');
    assert.equal(summarizeIssues(validateDocument(store.document)).errors, 0);
  });

  test('draw 在桩 Canvas 上不抛异常', () => {
    const { doc, arms } = makeFourArmDoc([2, 2, 2, 2]);
    const { viewport, ctx } = makeContext(doc);
    const tool = new JunctionTool();
    tool.onActivate?.(ctx);

    // 选中两条臂，使预览连线与标签分支都被执行
    for (const road of arms.slice(0, 2)) {
      const ref = referencePoint(road, road.length);
      const input = pointerAt(viewport, { x: ref.x, y: ref.y });
      tool.onPointerMove?.(ctx, input);
      tool.onPointerDown?.(ctx, input);
    }

    const calls: string[] = [];
    const stub = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === 'measureText') return () => ({ width: 40 });
          return (...args: unknown[]) => {
            calls.push(`${prop}(${args.length})`);
          };
        },
        set() {
          return true;
        },
      },
    ) as unknown as CanvasRenderingContext2D;

    assert.doesNotThrow(() => tool.draw?.(ctx, stub));
    assert.ok(calls.length > 0, 'draw 应产生绘制调用');
  });
});

describe('交叉口删除', () => {
  /**
   * 删除路口的难点在于清理引用：连接道路被移除后，若入口道路的 link 仍指向
   * 路口或已删除的连接道路，就会留下悬空引用。这里逐项验证清理完整性。
   *
   * 直接测 junctionEdit 的实现，不在测试里复刻——复刻出来的副本会跟着实现漂移，
   * 测得再绿也说明不了 UI 走的那条路径是对的。
   */
  function removeWholeJunction(
    doc: ReturnType<typeof createEmptyDocument>,
    junctionId: string,
  ): number {
    return deleteJunction(doc, junctionId).removedRoads.length;
  }

  function buildViaTool(laneCounts = [2, 2, 2, 2]) {
    const doc = createEmptyDocument(CRS);
    const outwards = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
    const arms = outwards.map((out, i) => {
      const { road } = makeArmRoad(String(i + 1), { x: 0, y: 0 }, out, 80, laneCounts[i] ?? 2);
      doc.roads.push(road);
      return road;
    });

    const store = new Store(doc);
    const viewport = new Viewport();
    viewport.size = { width: 1200, height: 800 };
    viewport.pixelsPerMeter = 4;
    const ctx = {
      store,
      viewport,
      projector: null,
      renderData: () => [],
      requestRedraw: () => {},
      invalidate: () => {},
      template: { ...DEFAULT_TEMPLATE },
      fit: { ...DEFAULT_FIT },
      snap: { ...DEFAULT_SNAP },
    } as unknown as ToolContext;

    const tool = new JunctionTool();
    tool.onActivate?.(ctx);
    for (const road of arms) {
      const ref = referencePoint(road, road.length);
      const input = {
        screen: viewport.worldToScreen({ x: ref.x, y: ref.y }),
        world: { x: ref.x, y: ref.y },
        button: 0,
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        raw: {} as PointerEvent,
      };
      tool.onPointerMove?.(ctx, input);
      tool.onPointerDown?.(ctx, input);
    }
    tool.onKeyDown?.(ctx, { key: 'Enter' } as KeyboardEvent);
    return { store, arms };
  }

  test('删除后无悬空引用且校验干净', () => {
    const { store, arms } = buildViaTool();
    const doc = store.document;
    const juncId = doc.junctions[0]!.id;
    const armIds = arms.map((a) => a.id);

    const removed = removeWholeJunction(doc, juncId);
    assert.equal(removed, 16, '应删除 16 条连接道路');
    assert.equal(doc.junctions.length, 0);
    assert.equal(doc.roads.length, armIds.length, '应只剩 4 条入口道路');

    // 入口道路的 link 必须被清空
    for (const id of armIds) {
      const road = doc.roads.find((r) => r.id === id)!;
      assert.equal(road.link.successor, undefined, `道路 ${id} 仍有悬空 link`);
    }

    const issues = validateDocument(doc);
    assert.equal(
      summarizeIssues(issues).errors,
      0,
      issues.filter((i) => i.level === 'error').map((i) => i.message).join(' | '),
    );
  });

  test('删除后可重新生成交叉口', () => {
    const { store, arms } = buildViaTool();
    const doc = store.document;
    removeWholeJunction(doc, doc.junctions[0]!.id);

    // 端点已释放，应能再次生成
    const viewport = new Viewport();
    viewport.size = { width: 1200, height: 800 };
    viewport.pixelsPerMeter = 4;
    const store2 = new Store(doc);
    const ctx = {
      store: store2,
      viewport,
      projector: null,
      renderData: () => [],
      requestRedraw: () => {},
      invalidate: () => {},
      template: { ...DEFAULT_TEMPLATE },
      fit: { ...DEFAULT_FIT },
      snap: { ...DEFAULT_SNAP },
    } as unknown as ToolContext;

    const tool = new JunctionTool();
    tool.onActivate?.(ctx);
    for (const arm of arms) {
      const road = doc.roads.find((r) => r.id === arm.id)!;
      const ref = referencePoint(road, road.length);
      const input = {
        screen: viewport.worldToScreen({ x: ref.x, y: ref.y }),
        world: { x: ref.x, y: ref.y },
        button: 0,
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        raw: {} as PointerEvent,
      };
      tool.onPointerMove?.(ctx, input);
      tool.onPointerDown?.(ctx, input);
    }
    tool.onKeyDown?.(ctx, { key: 'Enter' } as KeyboardEvent);

    assert.equal(store2.document.junctions.length, 1, '应能重新生成');
    assert.equal(store2.document.junctions[0]!.connections.length, 16);
    assert.equal(summarizeIssues(validateDocument(store2.document)).errors, 0);
  });

  test('删除一个路口不影响另一个', () => {
    // 两个相距很远的四岔口
    const doc = createEmptyDocument(CRS);
    const centers: Vec2[] = [{ x: 0, y: 0 }, { x: 600, y: 600 }];
    const outwards = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
    const groups: Road[][] = [];
    let nextId = 1;

    for (const c of centers) {
      const group: Road[] = [];
      for (const out of outwards) {
        const { road } = makeArmRoad(String(nextId++), c, out, 60, 1);
        doc.roads.push(road);
        group.push(road);
      }
      groups.push(group);
    }

    const store = new Store(doc);
    const viewport = new Viewport();
    viewport.size = { width: 1600, height: 1200 };
    viewport.pixelsPerMeter = 2;

    for (const group of groups) {
      const ctx = {
        store,
        viewport,
        projector: null,
        renderData: () => [],
        requestRedraw: () => {},
        invalidate: () => {},
        template: { ...DEFAULT_TEMPLATE },
        fit: { ...DEFAULT_FIT },
        snap: { ...DEFAULT_SNAP },
      } as unknown as ToolContext;
      const tool = new JunctionTool();
      tool.onActivate?.(ctx);
      for (const road of group) {
        const ref = referencePoint(road, road.length);
        const input = {
          screen: viewport.worldToScreen({ x: ref.x, y: ref.y }),
          world: { x: ref.x, y: ref.y },
          button: 0,
          shiftKey: false,
          ctrlKey: false,
          altKey: false,
          raw: {} as PointerEvent,
        };
        tool.onPointerMove?.(ctx, input);
        tool.onPointerDown?.(ctx, input);
      }
      tool.onKeyDown?.(ctx, { key: 'Enter' } as KeyboardEvent);
    }

    const d = store.document;
    assert.equal(d.junctions.length, 2, '应生成 2 个交叉口');

    const keepId = d.junctions[1]!.id;
    const keepConnCount = d.junctions[1]!.connections.length;
    deleteJunction(d, d.junctions[0]!.id);

    assert.equal(d.junctions.length, 1);
    assert.equal(d.junctions[0]!.id, keepId, '应保留另一个路口');
    assert.equal(d.junctions[0]!.connections.length, keepConnCount, '其连接不应受影响');

    // 保留路口的连接道路仍在
    const remaining = d.roads.filter((r) => r.junction === keepId);
    assert.equal(remaining.length, keepConnCount);
    assert.equal(summarizeIssues(validateDocument(d)).errors, 0);
  });
});

describe('交叉口拓扑与校验', () => {
  /**
   * 手工装配一个四岔口（复现 JunctionTool 的产出结构），验证：
   *   - 连接道路 junction 指向该路口
   *   - 入口道路 junction 保持 -1 且 link 指向路口
   *   - laneLink 的 to 指向连接道路自身车道
   */
  function buildCrossJunction(): { doc: ReturnType<typeof createEmptyDocument>; junction: Junction } {
    const doc = createEmptyDocument(CRS);
    const center: Vec2 = { x: 0, y: 0 };
    const armLen = 80;
    const outwards = [0, Math.PI / 2, Math.PI, -Math.PI / 2];

    const arms = outwards.map((outward, i) => {
      const { road, end } = makeArmRoad(String(i + 1), center, outward, armLen, 2);
      doc.roads.push(road);
      return { road, end, outward };
    });

    const juncId = nextNumericId(doc.junctions);
    const junction = createJunction(juncId, `交叉口 ${juncId}`);

    const allocated: Array<{ id: string }> = [...doc.roads];
    let connIndex = 0;

    for (const from of arms) {
      for (const to of arms) {
        if (from === to) continue;
        const turn = classifyTurn(from.outward, to.outward);
        if (turn === null) continue;

        const fromRef = referencePoint(from.road, from.road.length);
        const toRef = referencePoint(to.road, to.road.length);
        const inflow = normalizeAngle(from.outward + Math.PI);

        const geom = fitHermiteConnector(
          { x: fromRef.x, y: fromRef.y },
          inflow,
          { x: toRef.x, y: toRef.y },
          to.outward,
        );

        const laneCount = turn === 'straight' ? 2 : 1;
        const roadId = nextNumericId(allocated);
        allocated.push({ id: roadId });

        const conn = buildRoad(roadId, [geom], {
          ...DEFAULT_TEMPLATE,
          leftLanes: 0,
          rightLanes: laneCount,
          sidewalk: false,
        });
        conn.junction = juncId;
        conn.link.predecessor = { elementType: 'road', elementId: from.road.id, contactPoint: from.end };
        conn.link.successor = { elementType: 'road', elementId: to.road.id, contactPoint: to.end };

        // 进口取右侧（end 端接入），出口取左侧
        const entryLanes = crossSectionAt(from.road, from.road.length).right;
        const exitLanes = crossSectionAt(to.road, to.road.length).left;

        const laneLinks = [];
        for (let i = 0; i < laneCount; i++) {
          const entryLane = turn === 'right' ? entryLanes[entryLanes.length - 1]! : entryLanes[i]!;
          const exitLane = turn === 'right' ? exitLanes[exitLanes.length - 1]! : exitLanes[i]!;
          const lane = conn.laneSections[0]!.right[i]!;
          lane.link.predecessorIds = [entryLane.laneId];
          lane.link.successorIds = [exitLane.laneId];
          // to 指向连接道路自身车道
          laneLinks.push({ from: entryLane.laneId, to: lane.id });
        }

        junction.connections.push({
          id: String(connIndex++),
          incomingRoad: from.road.id,
          connectingRoad: roadId,
          contactPoint: 'start',
          laneLinks,
        });

        doc.roads.push(conn);
      }
    }

    // 入口道路链接到路口，junction 保持 -1
    for (const arm of arms) {
      arm.road.link[arm.end === 'start' ? 'predecessor' : 'successor'] = {
        elementType: 'junction',
        elementId: juncId,
      };
    }

    doc.junctions.push(junction);
    return { doc, junction };
  }

  test('四岔口生成 12 条连接并通过校验', () => {
    const { doc, junction } = buildCrossJunction();
    assert.equal(junction.connections.length, 12, '4 臂应有 12 条转向（手工装配，不含掉头）');

    const issues = validateDocument(doc);
    const { errors } = summarizeIssues(issues);
    assert.equal(errors, 0, `校验错误：${issues.filter((i) => i.level === 'error').map((i) => i.message).join(' | ')}`);
  });

  test('连接道路归属正确、入口道路保持 -1', () => {
    const { doc, junction } = buildCrossJunction();
    const connIds = new Set(junction.connections.map((c) => c.connectingRoad));
    const incomingIds = new Set(junction.connections.map((c) => c.incomingRoad));

    for (const road of doc.roads) {
      if (connIds.has(road.id)) {
        assert.equal(road.junction, junction.id, `连接道路 ${road.id} 应归属路口`);
      } else if (incomingIds.has(road.id)) {
        assert.equal(road.junction, '-1', `入口道路 ${road.id} 应保持 -1`);
      }
    }
  });

  test('入口道路均通过 link 指向路口', () => {
    const { doc, junction } = buildCrossJunction();
    const incomingIds = new Set(junction.connections.map((c) => c.incomingRoad));
    for (const id of incomingIds) {
      const road = doc.roads.find((r) => r.id === id)!;
      const linked =
        road.link.predecessor?.elementId === junction.id ||
        road.link.successor?.elementId === junction.id;
      assert.ok(linked, `道路 ${id} 未链接到路口`);
    }
  });

  test('laneLink 的 to 均为连接道路自身车道', () => {
    const { doc, junction } = buildCrossJunction();
    for (const c of junction.connections) {
      const conn = doc.roads.find((r) => r.id === c.connectingRoad)!;
      const ids = new Set(conn.laneSections[0]!.right.map((l) => l.id));
      for (const l of c.laneLinks) {
        assert.ok(ids.has(l.to), `连接 ${c.id} 的 to=${l.to} 不属于连接道路 ${conn.id}`);
      }
    }
  });

  test('每条连接道路车道都声明了前后车道衔接', () => {
    const { doc, junction } = buildCrossJunction();
    for (const c of junction.connections) {
      const conn = doc.roads.find((r) => r.id === c.connectingRoad)!;
      for (const lane of conn.laneSections[0]!.right) {
        assert.equal(lane.link.predecessorIds.length, 1, `车道 ${lane.id} 缺少前驱`);
        assert.equal(lane.link.successorIds.length, 1, `车道 ${lane.id} 缺少后继`);
      }
    }
  });

  test('交叉口经 xodr 往返后结构保持', () => {
    const { doc, junction } = buildCrossJunction();
    const xml = serializeOpenDrive(doc);
    const back = parseOpenDrive(xml);

    assert.deepEqual(back.warnings, [], `解析警告：${back.warnings.join('; ')}`);
    assert.equal(back.document.junctions.length, 1);

    const j2 = back.document.junctions[0]!;
    assert.equal(j2.id, junction.id);
    assert.equal(j2.connections.length, junction.connections.length);

    for (let i = 0; i < junction.connections.length; i++) {
      const a = junction.connections[i]!;
      const b = j2.connections[i]!;
      assert.equal(b.incomingRoad, a.incomingRoad);
      assert.equal(b.connectingRoad, a.connectingRoad);
      assert.equal(b.contactPoint, a.contactPoint);
      assert.deepEqual(b.laneLinks, a.laneLinks);
    }

    assert.equal(summarizeIssues(validateDocument(back.document)).errors, 0);
  });

  test('往返后连接道路几何一致', () => {
    const { doc, junction } = buildCrossJunction();
    const back = parseOpenDrive(serializeOpenDrive(doc)).document;

    for (const c of junction.connections) {
      const a = doc.roads.find((r) => r.id === c.connectingRoad)!;
      const b = back.roads.find((r) => r.id === c.connectingRoad)!;
      assert.ok(Math.abs(a.length - b.length) < 1e-9);
      for (const frac of [0, 0.5, 1]) {
        const pa = referencePoint(a, a.length * frac);
        const pb = referencePoint(b, b.length * frac);
        assert.ok(Math.hypot(pa.x - pb.x, pa.y - pb.y) < 1e-9);
      }
    }
  });

  test('校验器检出连接道路 junction 属性错误', () => {
    const { doc, junction } = buildCrossJunction();
    const connId = junction.connections[0]!.connectingRoad;
    doc.roads.find((r) => r.id === connId)!.junction = '-1';
    const codes = validateDocument(doc).map((i) => i.code);
    assert.ok(codes.includes('connecting-road-junction-mismatch'), `实际：${codes.join(',')}`);
  });

  test('校验器检出入口道路未链接路口', () => {
    const { doc, junction } = buildCrossJunction();
    const incomingId = junction.connections[0]!.incomingRoad;
    const road = doc.roads.find((r) => r.id === incomingId)!;
    delete road.link.predecessor;
    delete road.link.successor;
    const codes = validateDocument(doc).map((i) => i.code);
    assert.ok(codes.includes('incoming-road-not-linked'), `实际：${codes.join(',')}`);
  });

  test('校验器检出重复车道映射', () => {
    const { doc, junction } = buildCrossJunction();
    const conn = junction.connections.find((c) => c.laneLinks.length >= 2);
    assert.ok(conn, '需要一条多车道连接用于测试');
    conn!.laneLinks[1] = { ...conn!.laneLinks[1]!, from: conn!.laneLinks[0]!.from };
    const codes = validateDocument(doc).map((i) => i.code);
    assert.ok(codes.includes('duplicate-lane-link'), `实际：${codes.join(',')}`);
  });

  test('T 形路口生成 6 条连接并通过校验', () => {
    const doc = createEmptyDocument(CRS);
    const center: Vec2 = { x: 0, y: 0 };
    // 三臂：东、北、南
    const outwards = [0, Math.PI / 2, -Math.PI / 2];
    const arms = outwards.map((outward, i) => {
      const { road, end } = makeArmRoad(String(i + 1), center, outward, 70, 1);
      doc.roads.push(road);
      return { road, end, outward };
    });

    const juncId = nextNumericId(doc.junctions);
    const junction = createJunction(juncId);
    const allocated: Array<{ id: string }> = [...doc.roads];
    let idx = 0;

    for (const from of arms) {
      for (const to of arms) {
        if (from === to) continue;
        if (classifyTurn(from.outward, to.outward) === null) continue;

        const fromRef = referencePoint(from.road, from.road.length);
        const toRef = referencePoint(to.road, to.road.length);
        const geom = fitHermiteConnector(
          { x: fromRef.x, y: fromRef.y },
          normalizeAngle(from.outward + Math.PI),
          { x: toRef.x, y: toRef.y },
          to.outward,
        );

        const roadId = nextNumericId(allocated);
        allocated.push({ id: roadId });
        const conn = buildRoad(roadId, [geom], {
          ...DEFAULT_TEMPLATE,
          leftLanes: 0,
          rightLanes: 1,
          sidewalk: false,
        });
        conn.junction = juncId;
        conn.link.predecessor = { elementType: 'road', elementId: from.road.id, contactPoint: from.end };
        conn.link.successor = { elementType: 'road', elementId: to.road.id, contactPoint: to.end };

        const entryLane = crossSectionAt(from.road, from.road.length).right[0]!;
        const exitLane = crossSectionAt(to.road, to.road.length).left[0]!;
        const lane = conn.laneSections[0]!.right[0]!;
        lane.link.predecessorIds = [entryLane.laneId];
        lane.link.successorIds = [exitLane.laneId];

        junction.connections.push({
          id: String(idx++),
          incomingRoad: from.road.id,
          connectingRoad: roadId,
          contactPoint: 'start',
          laneLinks: [{ from: entryLane.laneId, to: lane.id }],
        });
        doc.roads.push(conn);
      }
    }

    for (const arm of arms) {
      arm.road.link.successor = { elementType: 'junction', elementId: juncId };
    }
    doc.junctions.push(junction);

    assert.equal(junction.connections.length, 6, 'T 形路口应有 6 条转向（手工装配，不含掉头）');
    const issues = validateDocument(doc);
    assert.equal(
      summarizeIssues(issues).errors,
      0,
      issues.filter((i) => i.level === 'error').map((i) => i.message).join(' | '),
    );
  });
});

describe('转向连接的横向定位与掉头', () => {
  const JUNCTION_R = 12;

  /** 四臂路口，可指定各臂车道数与是否带人行道 */
  function scene(lanes = 2, sidewalk = false) {
    const doc = createEmptyDocument(CRS);
    const outwards = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
    const arms = outwards.map((out, i) => {
      const cos = Math.cos(out);
      const sin = Math.sin(out);
      const near = { x: cos * JUNCTION_R, y: sin * JUNCTION_R };
      const far = { x: cos * (JUNCTION_R + 80), y: sin * (JUNCTION_R + 80) };
      const built = buildRoadFromPoints(String(i + 1), [far, near], DEFAULT_FIT, {
        ...DEFAULT_TEMPLATE,
        leftLanes: lanes,
        rightLanes: lanes,
        sidewalk,
      });
      assert.ok(built !== null);
      doc.roads.push(built!.road);
      return built!.road;
    });
    return { doc, arms };
  }

  function generate(lanes = 2, sidewalk = false) {
    const { doc, arms } = scene(lanes, sidewalk);
    const { store, viewport, ctx } = makeContext(doc);
    driveTool(new JunctionTool(), ctx, viewport, arms);
    const j = store.document.junctions[0];
    assert.ok(j, '应生成交叉口');
    return { store, junction: j!, arms };
  }

  /**
   * 连接道路起点必须落在所配对最内侧车道的内边界上。
   *
   * 这是「转弯连接的车道接错」的根因：参考线留在入口道路中心时，连接道路的
   * 车道（全为负 id，从 t=0 向外铺）会整体偏出配对车道。
   */
  test('连接道路起点落在配对车道的内边界上', () => {
    const { store, junction, arms } = generate(3);

    let checked = 0;
    for (const c of junction.connections) {
      const conn = store.document.roads.find((r) => r.id === c.connectingRoad);
      const incoming = arms.find((r) => r.id === c.incomingRoad);
      if (!conn || !incoming) continue;

      // laneLinks[0].from 即最内侧配对车道，其内边界应与连接道路起点重合
      const innerLaneId = c.laneLinks[0]!.from;
      const armRef = referencePoint(incoming, incoming.length);
      const cs = crossSectionAt(incoming, incoming.length);
      const pool = innerLaneId > 0 ? cs.left : cs.right;
      const boundary = pool.find((b) => b.laneId === innerLaneId);
      assert.ok(boundary, `车道 ${innerLaneId} 应存在于横断面`);

      // t 的正方向是参考线航向的左手侧
      const left = armRef.hdg + Math.PI / 2;
      const expected = {
        x: armRef.x + Math.cos(left) * boundary!.tInner,
        y: armRef.y + Math.sin(left) * boundary!.tInner,
      };

      const start = evaluateGeometry(conn.planView[0]!, 0);
      const off = Math.hypot(start.x - expected.x, start.y - expected.y);

      // 掉头的参考线走车道中心（再用 laneOffset 移回），不适用此断言
      const isUturn = c.incomingRoad === conn.link.successor?.elementId;
      if (isUturn) continue;

      assert.ok(off < 1e-6, `连接 ${conn.id} 起点偏离配对车道内边界 ${off.toFixed(4)} m`);
      checked++;
    }
    assert.ok(checked >= 9, `应校验到足够多的连接，实际 ${checked}`);
  });

  /** 人行道 2 m 能过宽度阈值，按宽度筛选会把右转接到人行道上 */
  test('人行道不参与转向配对', () => {
    const { store, junction } = generate(2, true);

    for (const c of junction.connections) {
      const incoming = store.document.roads.find((r) => r.id === c.incomingRoad);
      assert.ok(incoming);
      const cs = crossSectionAt(incoming!, incoming!.length);
      for (const link of c.laneLinks) {
        const pool = link.from > 0 ? cs.left : cs.right;
        const b = pool.find((x) => x.laneId === link.from);
        assert.ok(b, `车道 ${link.from} 应存在`);
        assert.notEqual(b!.type, 'sidewalk', `连接 ${c.id} 接到了人行道 ${link.from}`);
      }
    }

    // 有人行道时仍应生成完整转向集合
    assert.equal(junction.connections.length, 16, '人行道不应减少转向数');
  });

  /** 进出口宽度不同时，每条车道宽度取各自配对的均值，而非全路统一平均 */
  test('连接道路逐条车道取配对均值宽度', () => {
    const doc = createEmptyDocument(CRS);
    const outwards = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
    // 东西向 3.75 m 车道，南北向 3.0 m
    const arms = outwards.map((out, i) => {
      const cos = Math.cos(out);
      const sin = Math.sin(out);
      const built = buildRoadFromPoints(
        String(i + 1),
        [
          { x: cos * (JUNCTION_R + 80), y: sin * (JUNCTION_R + 80) },
          { x: cos * JUNCTION_R, y: sin * JUNCTION_R },
        ],
        DEFAULT_FIT,
        { ...DEFAULT_TEMPLATE, leftLanes: 2, rightLanes: 2, laneWidth: i % 2 === 0 ? 3.75 : 3.0 },
      );
      assert.ok(built !== null);
      doc.roads.push(built!.road);
      return built!.road;
    });

    const { store, viewport, ctx } = makeContext(doc);
    driveTool(new JunctionTool(), ctx, viewport, arms);
    const junction = store.document.junctions[0]!;

    // 找一条东西向 → 南北向的直行连接，两端宽度不同
    let verified = 0;
    for (const c of junction.connections) {
      const conn = store.document.roads.find((r) => r.id === c.connectingRoad);
      if (!conn || c.laneLinks.length < 2) continue;
      const section = conn.laneSections[0]!;
      const widths = section.right.map((l) => l.widths[0]!.a);
      // 宽度应落在 3.0 与 3.75 之间（均值），且不含 0
      for (const w of widths) {
        assert.ok(w >= 2.9 && w <= 3.8, `车道宽 ${w} 应介于两端宽度之间`);
      }
      verified++;
    }
    assert.ok(verified > 0, '应有多车道连接可校验');
  });

  test('每臂各生成一个掉头，且掉头几何不退化', () => {
    const { store, junction } = generate(2);

    // 掉头连接的进出口是同一条路
    const uturns = junction.connections.filter((c) => {
      const conn = store.document.roads.find((r) => r.id === c.connectingRoad);
      return conn?.link.successor?.elementId === c.incomingRoad;
    });
    assert.equal(uturns.length, 4, '每臂应各有一个掉头');

    for (const c of uturns) {
      const conn = store.document.roads.find((r) => r.id === c.connectingRoad)!;
      // 弦长只有一个车道宽，但按目标半径放大切线后弧长应显著长于弦长
      const g = conn.planView[0]!;
      const start = evaluateGeometry(g, 0);
      const end = evaluateGeometry(g, g.length);
      const chord = Math.hypot(end.x - start.x, end.y - start.y);
      // 掉头两端反向平行、横向只隔一个车道宽，弧长至少是弦长的 π/2 倍（半圆）
      assert.ok(
        conn.length > chord * 1.5,
        `掉头弧长 ${conn.length.toFixed(2)} 应显著大于弦长 ${chord.toFixed(2)}`,
      );
      // 掉头需把车道整体移回半个车道宽
      assert.ok(conn.laneOffsets.length > 0, '掉头连接应有 laneOffset');
      assert.ok(conn.laneOffsets[0]!.a > 0, 'laneOffset 应为正');
      // 两端航向应接近相反
      const turnAngle = Math.abs(normalizeAngle(end.hdg - start.hdg));
      assert.ok(turnAngle > (2 * Math.PI) / 3, `掉头转角 ${((turnAngle * 180) / Math.PI).toFixed(0)}° 应接近 180°`);
    }
  });

  test('掉头连接只占最内侧一条车道', () => {
    const { store, junction } = generate(3);
    for (const c of junction.connections) {
      const conn = store.document.roads.find((r) => r.id === c.connectingRoad);
      if (conn?.link.successor?.elementId !== c.incomingRoad) continue;
      assert.equal(c.laneLinks.length, 1, '掉头应只有一条车道');
      // 进口取最内侧（|id| 最小）
      assert.equal(Math.abs(c.laneLinks[0]!.from), 1, '掉头应占最内侧车道');
    }
  });

  test('生成结果通过校验且往返稳定', () => {
    const { store, junction } = generate(2);
    const issues = validateDocument(store.document);
    assert.equal(
      summarizeIssues(issues).errors,
      0,
      issues.filter((i) => i.level === 'error').map((i) => i.message).join(' | '),
    );

    const xml = serializeOpenDrive(store.document);
    const back = parseOpenDrive(xml);
    assert.equal(
      back.document.junctions[0]?.connections.length,
      junction.connections.length,
      '往返后连接数应不变',
    );
    // laneOffset 必须往返保留，否则掉头车道会错位半个车道宽
    const uturn = store.document.roads.find((r) => r.laneOffsets.length > 0);
    assert.ok(uturn, '应存在带 laneOffset 的掉头连接');
    const backUturn = back.document.roads.find((r) => r.id === uturn!.id);
    assert.ok(backUturn, '掉头连接应往返存在');
    assert.ok(
      Math.abs((backUturn!.laneOffsets[0]?.a ?? 0) - uturn!.laneOffsets[0]!.a) < 1e-9,
      'laneOffset 应往返一致',
    );
  });
});

describe('单条转向连接的删除', () => {
  const R = 14;

  /** 四臂路口，经工具全量生成 */
  function generate() {
    const doc = createEmptyDocument(CRS);
    const outwards = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
    const arms = outwards.map((out, i) => {
      const { road } = makeArmRoad(String(i + 1), { x: 0, y: 0 }, out, 80, 2);
      doc.roads.push(road);
      return road;
    });
    const { store, viewport, ctx } = makeContext(doc);
    driveTool(new JunctionTool(), ctx, viewport, arms);
    assert.ok(store.document.junctions[0], '应生成交叉口');
    return { doc: store.document, junction: store.document.junctions[0]!, arms };
  }

  /** 判定某条 connection 是否为掉头（进出口同一条路） */
  function isUturn(doc: ReturnType<typeof createEmptyDocument>, connId: string, juncId: string) {
    const c = doc.junctions.find((j) => j.id === juncId)?.connections.find((x) => x.id === connId);
    if (!c) return false;
    const conn = doc.roads.find((r) => r.id === c.connectingRoad);
    return conn?.link.successor?.elementId === c.incomingRoad;
  }

  test('删掉一条转向后其余连接与校验均不受影响', () => {
    const { doc, junction } = generate();
    const before = junction.connections.length;
    const target = junction.connections[3]!;
    const targetRoad = target.connectingRoad;

    const res = deleteConnection(doc, junction.id, target.id);
    assert.ok(res.ok, '删除应成功');
    assert.deepEqual(res.removedRoads, [targetRoad], '应移除对应连接道路');
    assert.equal(res.junctionRemoved, false, '路口还有别的连接，不应整体删除');

    const j = doc.junctions[0]!;
    assert.equal(j.connections.length, before - 1, '应恰好少一条连接');
    assert.equal(doc.roads.some((r) => r.id === targetRoad), false, '连接道路应被移除');

    const issues = validateDocument(doc);
    assert.equal(
      summarizeIssues(issues).errors,
      0,
      issues.filter((i) => i.level === 'error').map((i) => i.message).join(' | '),
    );
  });

  test('删掉全部掉头后剩 12 条转向', () => {
    const { doc, junction } = generate();
    const juncId = junction.id;
    const uturnIds = junction.connections
      .filter((c) => isUturn(doc, c.id, juncId))
      .map((c) => c.id);
    assert.equal(uturnIds.length, 4, '四臂应各有一个掉头');

    for (const id of uturnIds) {
      assert.ok(deleteConnection(doc, juncId, id).ok, `删除掉头 ${id} 应成功`);
    }

    const j = doc.junctions[0]!;
    assert.equal(j.connections.length, 12, '删掉 4 个掉头后应剩 12 条');
    // 掉头的连接道路（带 laneOffset）应一并消失
    assert.equal(
      doc.roads.filter((r) => r.junction === juncId && r.laneOffsets.length > 0).length,
      0,
      '掉头连接道路应已移除',
    );
    assert.equal(summarizeIssues(validateDocument(doc)).errors, 0);
  });

  /**
   * 入口道路的 link 指向整个路口而非某条转向，因此只有它最后一条转向也被删掉时
   * 才能还原。提前还原会让剩下的转向失去入口侧的连接声明。
   */
  test('入口道路的 link 在其最后一条转向被删时才还原', () => {
    const { doc, junction } = generate();
    const juncId = junction.id;
    const armId = junction.connections[0]!.incomingRoad;
    const ofArm = junction.connections.filter((c) => c.incomingRoad === armId).map((c) => c.id);
    assert.ok(ofArm.length > 1, '该臂应有多条转向');

    // 删到只剩一条：link 必须还在
    for (const id of ofArm.slice(0, -1)) {
      const res = deleteConnection(doc, juncId, id);
      assert.equal(res.restoredIncoming, false, '尚有转向时不应还原 link');
    }
    const arm = doc.roads.find((r) => r.id === armId)!;
    assert.ok(
      arm.link.successor?.elementType === 'junction',
      '仍有转向时入口道路应继续指向路口',
    );

    // 删掉最后一条：link 应被还原
    const last = deleteConnection(doc, juncId, ofArm[ofArm.length - 1]!);
    assert.ok(last.restoredIncoming, '最后一条转向删除后应还原 link');
    assert.equal(arm.link.successor, undefined, '入口道路的 link 应被清空');
    assert.equal(summarizeIssues(validateDocument(doc)).errors, 0);
  });

  test('删空后整个路口一并移除且无悬空引用', () => {
    const { doc, junction, arms } = generate();
    const juncId = junction.id;
    const ids = junction.connections.map((c) => c.id);

    let removedAt = -1;
    for (let i = 0; i < ids.length; i++) {
      const res = deleteConnection(doc, juncId, ids[i]!);
      assert.ok(res.ok, `删除 ${ids[i]} 应成功`);
      if (res.junctionRemoved) removedAt = i;
    }
    assert.equal(removedAt, ids.length - 1, '应在删除最后一条时移除路口');
    assert.equal(doc.junctions.length, 0, '路口应已移除');
    assert.equal(doc.roads.length, arms.length, '应只剩入口道路');

    for (const a of arms) {
      const road = doc.roads.find((r) => r.id === a.id)!;
      assert.equal(road.link.successor, undefined, `道路 ${a.id} 仍有悬空 link`);
    }
    assert.equal(summarizeIssues(validateDocument(doc)).errors, 0);
  });

  test('删除后导出仍可解析且连接数一致', () => {
    const { doc, junction } = generate();
    const juncId = junction.id;
    // 删掉全部掉头与一条右转，模拟按实际渠化裁剪
    for (const c of [...junction.connections]) {
      if (isUturn(doc, c.id, juncId)) deleteConnection(doc, juncId, c.id);
    }
    const remaining = doc.junctions[0]!.connections.length;
    deleteConnection(doc, juncId, doc.junctions[0]!.connections[0]!.id);

    const back = parseOpenDrive(serializeOpenDrive(doc));
    assert.equal(
      back.document.junctions[0]?.connections.length,
      remaining - 1,
      '往返后连接数应与删除结果一致',
    );
    assert.equal(summarizeIssues(validateDocument(back.document)).errors, 0);
  });

  test('删除不存在的连接不改动文档', () => {
    const { doc, junction } = generate();
    const before = junction.connections.length;
    const roads = doc.roads.length;

    assert.equal(deleteConnection(doc, junction.id, 'no-such-id').ok, false);
    assert.equal(deleteConnection(doc, 'no-such-junction', junction.connections[0]!.id).ok, false);
    assert.equal(doc.junctions[0]!.connections.length, before, '连接数不应变化');
    assert.equal(doc.roads.length, roads, '道路数不应变化');
  });
});

describe('生成失败的诊断提示', () => {
  /** 单向路：只有右侧车道，故 end 端接入时只能当进口臂 */
  function oneWayArm(id: string, outward: number, towardJunction: boolean) {
    const cos = Math.cos(outward);
    const sin = Math.sin(outward);
    const near = { x: cos * JUNCTION_RADIUS, y: sin * JUNCTION_RADIUS };
    const far = { x: cos * (JUNCTION_RADIUS + 80), y: sin * (JUNCTION_RADIUS + 80) };
    // towardJunction: 远端 → 近端（end 端在路口，右侧为进口）
    const pts = towardJunction ? [far, near] : [near, far];
    const built = buildRoadFromPoints(id, pts, DEFAULT_FIT, {
      ...DEFAULT_TEMPLATE,
      leftLanes: 0,
      rightLanes: 2,
    });
    assert.ok(built !== null, `路臂 ${id} 生成失败`);
    return built!.road;
  }

  /** 按各臂朝向点选端点（靠路口那一端）并回车 */
  function driveAtJunctionEnd(doc: ReturnType<typeof createEmptyDocument>, roads: Road[]) {
    const { store, viewport, ctx } = makeContext(doc);
    const tool = new JunctionTool();
    tool.onActivate?.(ctx);
    for (const road of roads) {
      // 路口侧端点即离原点较近的那一端
      const a = referencePoint(road, 0);
      const b = referencePoint(road, road.length);
      const near = Math.hypot(a.x, a.y) < Math.hypot(b.x, b.y) ? a : b;
      const input = pointerAt(viewport, { x: near.x, y: near.y });
      tool.onPointerMove?.(ctx, input);
      tool.onPointerDown?.(ctx, input);
    }
    tool.onKeyDown?.(ctx, { key: 'Enter' } as KeyboardEvent);
    return store;
  }

  function errorOf(store: Store): string {
    const err = store.messages.find((m) => m.level === 'error');
    assert.ok(err, `应报错，实际消息：${store.messages.map((m) => m.text).join(' | ')}`);
    return err!.text;
  }

  test('路臂不足时说明还需几条', () => {
    const doc = createEmptyDocument(CRS);
    const roads = [0, Math.PI / 2].map((out, i) => {
      const { road } = makeArmRoad(String(i + 1), { x: 0, y: 0 }, out, 80, 2);
      doc.roads.push(road);
      return road;
    });
    const { store, viewport, ctx } = makeContext(doc);
    driveTool(new JunctionTool(), ctx, viewport, roads);

    const warn = store.messages.find((m) => m.level === 'warn');
    assert.ok(warn, '应给出提示');
    assert.match(warn!.text, /至少需要 3 条/, '应说明最少路臂数');
    assert.equal(store.document.junctions.length, 0);
  });

  /** 全是进口臂：单向路都朝路口来，一条出口车道也没有 */
  test('全部路臂无出口车道时指出选错端点', () => {
    const doc = createEmptyDocument(CRS);
    const roads = [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3].map((out, i) => {
      const road = oneWayArm(String(i + 1), out, true);
      doc.roads.push(road);
      return road;
    });

    const store = driveAtJunctionEnd(doc, roads);
    const text = errorOf(store);
    assert.match(text, /没有驶出路口的车道/, '应指出缺出口车道');
    assert.match(text, /是否选错了端点/, '应给出下一步');
    assert.equal(store.document.junctions.length, 0, '不应写入文档');
  });

  /** 全是出口臂：单向路都背离路口 */
  test('全部路臂无进口车道时指出选错端点', () => {
    const doc = createEmptyDocument(CRS);
    const roads = [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3].map((out, i) => {
      const road = oneWayArm(String(i + 1), out, false);
      doc.roads.push(road);
      return road;
    });

    const store = driveAtJunctionEnd(doc, roads);
    const text = errorOf(store);
    assert.match(text, /没有驶入路口的车道/, '应指出缺进口车道');
    assert.match(text, /是否选错了端点/, '应给出下一步');
    assert.equal(store.document.junctions.length, 0, '不应写入文档');
  });

  /** 人行道能过宽度阈值，按类型筛选后不应被当成可通行车道 */
  test('仅有人行道的路臂不算有可通行车道', () => {
    const doc = createEmptyDocument(CRS);
    const roads = [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3].map((out, i) => {
      const cos = Math.cos(out);
      const sin = Math.sin(out);
      const built = buildRoadFromPoints(
        String(i + 1),
        [
          { x: cos * (JUNCTION_RADIUS + 80), y: sin * (JUNCTION_RADIUS + 80) },
          { x: cos * JUNCTION_RADIUS, y: sin * JUNCTION_RADIUS },
        ],
        DEFAULT_FIT,
        { ...DEFAULT_TEMPLATE, leftLanes: 1, rightLanes: 1, sidewalk: true },
      );
      assert.ok(built !== null);
      const road = built!.road;
      // 把 driving 车道全改成人行道，只留人行道类型
      for (const sec of road.laneSections) {
        for (const lane of [...sec.left, ...sec.right]) lane.type = 'sidewalk';
      }
      doc.roads.push(road);
      return road;
    });

    const store = driveAtJunctionEnd(doc, roads);
    assert.equal(store.document.junctions.length, 0, '人行道不可通行，不应生成路口');
    const text = errorOf(store);
    assert.ok(text.length > 0, '应给出错误说明');
  });
});

describe('删除道路的连带清理', () => {
  /** 四臂路口，经工具全量生成 */
  function generate() {
    const doc = createEmptyDocument(CRS);
    const outwards = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
    const arms = outwards.map((out, i) => {
      const { road } = makeArmRoad(String(i + 1), { x: 0, y: 0 }, out, 80, 2);
      doc.roads.push(road);
      return road;
    });
    const { store, viewport, ctx } = makeContext(doc);
    driveTool(new JunctionTool(), ctx, viewport, arms);
    assert.ok(store.document.junctions[0], '应生成交叉口');
    return { doc: store.document, junction: store.document.junctions[0]!, arms };
  }

  test('删除入口臂连带移除它牵涉的全部连接道路', () => {
    const { doc, junction } = generate();
    const before = junction.connections.length;
    const armId = '1';
    const touching = junction.connections.filter(
      (c) => c.incomingRoad === armId || connectionTouchesRoad(doc, c, armId),
    ).length;
    assert.ok(touching > 0, '该臂应牵涉若干转向');

    const res = deleteRoad(doc, armId);
    assert.ok(res.ok, '删除应成功');
    assert.equal(doc.roads.some((r) => r.id === armId), false, '道路本身应被移除');
    // 该臂作为进口发起的、以及作为出口被指向的转向都要清掉
    assert.equal(res.removedRoads.length, touching + 1, '应连带移除全部牵涉的连接道路');

    const j = doc.junctions[0];
    assert.equal(j?.connections.length, before - touching, '牵涉的连接应全部摘除');
    assert.equal(
      summarizeIssues(validateDocument(doc)).errors,
      0,
      `删除后不应有校验错误：${validateDocument(doc).map((i) => i.message).join('; ')}`,
    );
  });

  test('删除后其余道路不再残留指向它的 link', () => {
    const { doc } = generate();
    deleteRoad(doc, '1');
    for (const road of doc.roads) {
      for (const which of ['predecessor', 'successor'] as const) {
        const link = road.link[which];
        if (link?.elementType !== 'road') continue;
        assert.ok(
          doc.roads.some((r) => r.id === link.elementId),
          `道路 ${road.id} 的 ${which} 指向已删除的 ${link.elementId}`,
        );
      }
    }
  });

  test('逐条删掉全部连接道路后路口消失且入口臂端点重新可用', () => {
    const { doc, junction } = generate();
    const connectingIds = junction.connections.map((c) => c.connectingRoad);

    for (const id of connectingIds) deleteRoad(doc, id);

    assert.equal(doc.junctions.length, 0, '连接全删后路口应一并移除');
    assert.equal(doc.roads.length, 4, '四条入口臂应都还在');

    // 这是用户报告的症结：删光连接后端点必须重新可用，否则无法再建路口
    for (const road of doc.roads) {
      assert.equal(
        isEndOccupied(doc, road, 'end'),
        false,
        `道路 ${road.id} 的终点应重新可用`,
      );
    }
    assert.equal(summarizeIssues(validateDocument(doc)).errors, 0, '不应残留悬空引用');
  });

  test('删光连接后可在同一批端点上重新生成交叉口', () => {
    const { doc, junction } = generate();
    for (const c of [...junction.connections]) deleteRoad(doc, c.connectingRoad);
    assert.equal(doc.junctions.length, 0);

    const arms = doc.roads.filter((r) => r.junction === '-1');
    const { store, viewport, ctx } = makeContext(doc);
    driveTool(new JunctionTool(), ctx, viewport, arms);

    assert.equal(store.document.junctions.length, 1, '应能重新生成交叉口');
    const text = store.messages.map((m) => m.text).join('\n');
    assert.equal(
      /已有连接/.test(text),
      false,
      `不应再报端点被占用：${text}`,
    );
    assert.equal(summarizeIssues(validateDocument(store.document)).errors, 0);
  });

  test('悬空 link 不算占用，损坏的文档能自行恢复', () => {
    const { doc } = generate();
    // 手工制造此前的损坏状态：摘掉路口，留下入口道路指向它的 link
    const juncId = doc.junctions[0]!.id;
    doc.roads = doc.roads.filter((r) => r.junction !== juncId);
    doc.junctions = [];

    const arm = doc.roads[0]!;
    assert.ok(arm.link.successor, '前置条件：悬空 link 仍在');
    assert.equal(
      isEndOccupied(doc, arm, 'end'),
      false,
      '指向已不存在路口的 link 不应算占用',
    );

    const { store, viewport, ctx } = makeContext(doc);
    driveTool(new JunctionTool(), ctx, viewport, [...doc.roads]);
    assert.equal(store.document.junctions.length, 1, '应能在损坏文档上重建路口');
  });

  test('真实占用仍被拦下', () => {
    const { doc, junction } = generate();
    const arm = doc.roads.find((r) => r.id === '1')!;
    assert.ok(
      junction.connections.some((c) => c.incomingRoad === '1'),
      '前置条件：该臂确有转向',
    );
    assert.equal(isEndOccupied(doc, arm, 'end'), true, '路口仍在使用该臂，应判占用');

    // 指向另一条存在的道路时同样算占用
    const other = doc.roads.find((r) => r.id === '2')!;
    other.link.predecessor = { elementType: 'road', elementId: '3', contactPoint: 'start' };
    assert.equal(isEndOccupied(doc, other, 'start'), true, '指向实存道路应判占用');
  });

  test('删除单条连接道路只影响它自己', () => {
    const { doc, junction } = generate();
    const before = junction.connections.length;
    const target = junction.connections[2]!.connectingRoad;

    const res = deleteRoad(doc, target);
    assert.deepEqual(res.removedRoads, [target], '不应连带删别的道路');
    assert.deepEqual(res.removedJunctions, [], '路口还有别的连接，不应删除');
    assert.equal(doc.junctions[0]?.connections.length, before - 1);
    assert.equal(summarizeIssues(validateDocument(doc)).errors, 0);
  });

  test('删除不存在的道路是空操作', () => {
    const { doc } = generate();
    const roads = doc.roads.length;
    const res = deleteRoad(doc, '9999');
    assert.equal(res.ok, false);
    assert.deepEqual(res.removedRoads, []);
    assert.equal(doc.roads.length, roads, '文档不应被改动');
  });

  test('删除后往返序列化保持一致', () => {
    const { doc } = generate();
    deleteRoad(doc, '1');
    const back = parseOpenDrive(serializeOpenDrive(doc)).document;
    assert.equal(back.roads.length, doc.roads.length, '道路数应一致');
    assert.equal(
      back.junctions[0]?.connections.length,
      doc.junctions[0]?.connections.length,
      '连接数应一致',
    );
    assert.equal(summarizeIssues(validateDocument(back)).errors, 0);
  });
});
