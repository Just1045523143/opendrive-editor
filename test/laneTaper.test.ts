/**
 * 车道渐变测试：宽度渐变、渐变消失、渐变出现。
 */

import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { DEFAULT_FIT } from '../src/core/geometry/alignment.ts';
import { buildRoadFromPoints, DEFAULT_TEMPLATE, type RoadTemplate } from '../src/editor/roadFactory.ts';
import { createEmptyDocument } from '../src/core/model/document.ts';
import { createJunction } from '../src/core/model/junction.ts';
import { laneWidthAt } from '../src/core/model/lanes.ts';
import { laneSectionIndexAt, laneSectionRange, type Road } from '../src/core/model/road.ts';
import {
  beginLaneWithTaper,
  endLaneWithTaper,
  MIN_TAPER_LENGTH,
  recommendedTaperLength,
  taperLaneWidth,
  taperPoly,
} from '../src/editor/laneTaper.ts';
import type { Vec2 } from '../src/core/math/vec.ts';

const STRAIGHT: Vec2[] = [
  { x: 0, y: 0 },
  { x: 400, y: 0 },
];

/** 单向 4 车道模板 */
function template(rightLanes = 4): RoadTemplate {
  return { ...DEFAULT_TEMPLATE, leftLanes: 0, rightLanes, laneWidth: 3.5, sidewalk: false };
}

/** 一条 400 m 的直路，单向 4 车道 */
function scene(rightLanes = 4) {
  const doc = createEmptyDocument();
  const built = buildRoadFromPoints('1', STRAIGHT, DEFAULT_FIT, template(rightLanes));
  const road = built!.road;
  doc.roads.push(road);
  return { doc, road };
}

/** 车道在给定站号处的宽度；车道不存在返回 null */
function widthAtStation(road: Road, laneId: number, s: number): number | null {
  const idx = laneSectionIndexAt(road, s);
  const section = road.laneSections[idx];
  if (!section) return null;
  const side = laneId > 0 ? section.left : section.right;
  const lane = side.find((l) => l.id === laneId);
  if (!lane) return null;
  return laneWidthAt(lane, s - laneSectionRange(road, idx).start);
}

/** 车道在给定站号处是否存在 */
function laneExistsAt(road: Road, laneId: number, s: number): boolean {
  return widthAtStation(road, laneId, s) !== null;
}

describe('渐变长度推荐值', () => {
  test('速度越高渐变越长', () => {
    const w = 3.5;
    const l30 = recommendedTaperLength(w, 30);
    const l50 = recommendedTaperLength(w, 50);
    const l70 = recommendedTaperLength(w, 70);
    const l100 = recommendedTaperLength(w, 100);
    assert.ok(l30 < l50 && l50 < l70 && l70 < l100, `应单调递增，实际 ${[l30, l50, l70, l100]}`);
  });

  test('3.5 m 车道 50 km/h 取 70 m（1:20）', () => {
    assert.equal(recommendedTaperLength(3.5, 50), 70);
  });

  test('取整到 5 m 的倍数且不短于下限', () => {
    for (const speed of [20, 40, 60, 80, 120]) {
      for (const w of [0.5, 2.75, 3.5, 3.75]) {
        const l = recommendedTaperLength(w, speed);
        assert.equal(l % 5, 0, `${w}m@${speed} → ${l} 应是 5 的倍数`);
        assert.ok(l >= MIN_TAPER_LENGTH);
      }
    }
  });
});

describe('渐变多项式', () => {
  test('三次形状两端精确、斜率为零', () => {
    const L = 60;
    const p = taperPoly(3.5, 0, L, 'cubic');
    const w = (ds: number) => p.a + p.b * ds + p.c * ds * ds + p.d * ds ** 3;
    const dw = (ds: number) => p.b + 2 * p.c * ds + 3 * p.d * ds * ds;

    assert.ok(Math.abs(w(0) - 3.5) < 1e-12, '起点宽度');
    assert.ok(Math.abs(w(L)) < 1e-9, '终点宽度应为 0');
    assert.ok(Math.abs(dw(0)) < 1e-12, '起点斜率应为 0');
    assert.ok(Math.abs(dw(L)) < 1e-12, '终点斜率应为 0');
    assert.ok(Math.abs(w(L / 2) - 1.75) < 1e-9, '中点应为两端均值');
  });

  test('三次形状单调收窄', () => {
    const L = 60;
    const p = taperPoly(3.5, 0, L, 'cubic');
    const w = (ds: number) => p.a + p.b * ds + p.c * ds * ds + p.d * ds ** 3;
    let prev = Infinity;
    for (let ds = 0; ds <= L; ds += 1) {
      const cur = w(ds);
      assert.ok(cur <= prev + 1e-12, `${ds} m 处不应回升`);
      prev = cur;
    }
  });

  test('线性形状斜率恒定', () => {
    const L = 40;
    const p = taperPoly(3.5, 1.5, L, 'linear');
    assert.equal(p.c, 0);
    assert.equal(p.d, 0);
    assert.ok(Math.abs(p.b - (1.5 - 3.5) / L) < 1e-12);
  });

  test('加宽方向系数取反', () => {
    const p = taperPoly(0, 3.5, 50, 'cubic');
    assert.equal(p.a, 0);
    assert.ok(p.c > 0 && p.d < 0, '加宽时 c 正 d 负');
  });
});

describe('宽度渐变', () => {
  test('3.5 m 渐变到 2.5 m，之后保持', () => {
    const { road } = scene();
    const r = taperLaneWidth(road, -1, 100, 50, 2.5);
    assert.ok(r.ok, r.reason ?? "");
    assert.equal(r.length, 50);

    assert.ok(Math.abs(widthAtStation(road, -1, 100)! - 3.5) < 1e-6, '渐变起点仍为原宽');
    assert.ok(Math.abs(widthAtStation(road, -1, 125)! - 3.0) < 1e-6, '中点为均值');
    assert.ok(Math.abs(widthAtStation(road, -1, 150)! - 2.5) < 1e-6, '终点为目标宽');
    assert.ok(Math.abs(widthAtStation(road, -1, 300)! - 2.5) < 1e-6, '之后保持目标宽');
  });

  test('渐变前的站号与其他车道不受影响', () => {
    const { road } = scene();
    taperLaneWidth(road, -1, 100, 50, 2.5);
    assert.ok(Math.abs(widthAtStation(road, -1, 50)! - 3.5) < 1e-6, '渐变前保持原宽');
    for (const id of [-2, -3, -4]) {
      assert.ok(Math.abs(widthAtStation(road, id, 300)! - 3.5) < 1e-6, `车道 ${id} 不应被改动`);
    }
  });

  test('长度超出道路剩余部分时夹紧', () => {
    const { road } = scene();
    const r = taperLaneWidth(road, -1, 380, 100, 2.5);
    assert.ok(r.ok, r.reason ?? "");
    assert.equal(r.clamped, true);
    assert.ok(Math.abs(r.length! - 20) < 1e-6, `应夹到 20 m，实际 ${r.length}`);
  });

  test('中心车道、负宽度、越界站号被拒绝', () => {
    const { road } = scene();
    assert.equal(taperLaneWidth(road, 0, 100, 50, 2.5).ok, false);
    assert.equal(taperLaneWidth(road, -1, 100, 50, -0.5).ok, false);
    assert.equal(taperLaneWidth(road, -1, 400, 50, 2.5).ok, false);
    assert.equal(taperLaneWidth(road, -1, -10, 50, 2.5).ok, false);
  });

  test('不存在的车道被拒绝', () => {
    const { road } = scene();
    const r = taperLaneWidth(road, -9, 100, 50, 2.5);
    assert.equal(r.ok, false);
    assert.match(r.reason!, /不存在/);
  });
});

describe('车道渐变消失', () => {
  test('4 车道渐变为 3 车道', () => {
    const { doc, road } = scene();
    const r = endLaneWithTaper(doc, road, -4, 200, 60);
    assert.ok(r.ok, r.reason ?? "");

    assert.ok(laneExistsAt(road, -4, 150), '渐变前仍有 4 条');
    assert.ok(Math.abs(widthAtStation(road, -4, 200)! - 3.5) < 1e-6, '渐变起点保持原宽');
    assert.ok(widthAtStation(road, -4, 230)! < 3.5, '渐变中收窄');
    assert.ok(!laneExistsAt(road, -4, 300), '渐变终点之后车道消失');
    assert.ok(laneExistsAt(road, -3, 300), '其余车道保留');
  });

  test('渐变后车道条数正确', () => {
    const { doc, road } = scene();
    endLaneWithTaper(doc, road, -4, 200, 60);
    const count = (s: number) => road.laneSections[laneSectionIndexAt(road, s)]!.right.length;
    assert.equal(count(100), 4, '渐变前 4 条');
    assert.equal(count(220), 4, '渐变段内仍是 4 条（宽度在收）');
    assert.equal(count(300), 3, '渐变后 3 条');
  });

  test('渐变段上画实线，消失后新最外侧恢复实线', () => {
    const { doc, road } = scene();
    endLaneWithTaper(doc, road, -4, 200, 60);
    const taperSection = road.laneSections[laneSectionIndexAt(road, 210)]!;
    const taperLane = taperSection.right.find((l) => l.id === -4)!;
    assert.equal(taperLane.roadMarks[0]!.type, 'solid', '收窄的楔形边线是实线');

    const after = road.laneSections[laneSectionIndexAt(road, 300)]!;
    const outer = after.right[after.right.length - 1]!;
    assert.equal(outer.id, -3);
    assert.equal(outer.roadMarks[0]!.type, 'solid', '新的最外侧车道恢复实线边线');
  });

  test('渐变全程宽度非负', () => {
    const { doc, road } = scene();
    endLaneWithTaper(doc, road, -4, 200, 60);
    for (let s = 200; s <= 260; s += 2) {
      const w = widthAtStation(road, -4, s);
      if (w === null) continue;
      assert.ok(w >= -1e-9, `${s} m 处宽度 ${w} 为负`);
    }
  });

  test('非最外侧车道与中心车道被拒绝', () => {
    const { doc, road } = scene();
    const mid = endLaneWithTaper(doc, road, -2, 200, 60);
    assert.equal(mid.ok, false);
    assert.match(mid.reason!, /最外侧/);
    assert.equal(endLaneWithTaper(doc, road, 0, 200, 60).ok, false);
  });

  test('越界站号被拒绝，长度超限时夹紧', () => {
    const a = scene();
    assert.equal(endLaneWithTaper(a.doc, a.road, -4, 400, 60).ok, false);

    const b = scene();
    const r = endLaneWithTaper(b.doc, b.road, -4, 370, 90);
    assert.ok(r.ok, r.reason ?? "");
    assert.equal(r.clamped, true);
    assert.ok(Math.abs(r.length! - 30) < 1e-6);
  });

  test('道路末端消失时同步 junction 引用', () => {
    const { doc, road } = scene();
    const j = createJunction('1', '路口');
    j.connections.push({
      id: '0',
      incomingRoad: '1',
      connectingRoad: '2',
      contactPoint: 'start',
      laneLinks: [
        { from: -3, to: -1 },
        { from: -4, to: -2 },
      ],
    });
    doc.junctions.push(j);

    const r = endLaneWithTaper(doc, road, -4, 300, 60);
    assert.ok(r.ok, r.reason ?? "");
    assert.equal(r.droppedLinks, 1, '−4 的 laneLink 应被丢弃');
    assert.deepEqual(j.connections[0]!.laneLinks, [{ from: -3, to: -1 }]);
  });
});

describe('车道渐变出现', () => {
  test('3 车道渐变为 4 车道', () => {
    const { doc, road } = scene(4);
    const r = beginLaneWithTaper(doc, road, -4, 200, 60, 3.5);
    assert.ok(r.ok, r.reason ?? "");

    assert.ok(!laneExistsAt(road, -4, 100), '渐变前没有这条车道');
    assert.ok(Math.abs(widthAtStation(road, -4, 200)!) < 1e-9, '渐变起点宽度为 0');
    assert.ok(widthAtStation(road, -4, 230)! > 0, '渐变中已有宽度');
    assert.ok(Math.abs(widthAtStation(road, -4, 260)! - 3.5) < 1e-6, '渐变终点达到目标宽');
    assert.ok(Math.abs(widthAtStation(road, -4, 380)! - 3.5) < 1e-6, '之后保持目标宽');
  });

  test('渐变前车道条数为 3，之后为 4', () => {
    const { doc, road } = scene(4);
    beginLaneWithTaper(doc, road, -4, 200, 60, 3.5);
    const count = (s: number) => road.laneSections[laneSectionIndexAt(road, s)]!.right.length;
    assert.equal(count(100), 3, '渐变前 3 条');
    assert.equal(count(300), 4, '渐变后 4 条');
  });

  test('宽度单调加宽且不越过目标值', () => {
    const { doc, road } = scene(4);
    beginLaneWithTaper(doc, road, -4, 200, 60, 3.5);
    let prev = -Infinity;
    for (let s = 200; s <= 260; s += 2) {
      const w = widthAtStation(road, -4, s)!;
      assert.ok(w >= prev - 1e-9, `${s} m 处不应回落`);
      assert.ok(w <= 3.5 + 1e-9, `${s} m 处不应超过目标宽`);
      prev = w;
    }
  });

  test('非最外侧、中心车道、非正宽度被拒绝', () => {
    const { doc, road } = scene();
    assert.equal(beginLaneWithTaper(doc, road, -2, 200, 60, 3.5).ok, false);
    assert.equal(beginLaneWithTaper(doc, road, 0, 200, 60, 3.5).ok, false);
    assert.equal(beginLaneWithTaper(doc, road, -4, 200, 60, 0).ok, false);
  });
});

describe('左侧车道对称可用', () => {
  test('左侧最外侧车道可渐变消失', () => {
    const doc = createEmptyDocument();
    const built = buildRoadFromPoints('1', STRAIGHT, DEFAULT_FIT, {
      ...DEFAULT_TEMPLATE,
      leftLanes: 3,
      rightLanes: 3,
      laneWidth: 3.5,
      sidewalk: false,
    });
    const road = built!.road;
    doc.roads.push(road);

    const r = endLaneWithTaper(doc, road, 3, 200, 60);
    assert.ok(r.ok, r.reason ?? "");
    assert.ok(laneExistsAt(road, 3, 150), '渐变前存在');
    assert.ok(!laneExistsAt(road, 3, 300), '渐变后消失');
    assert.ok(laneExistsAt(road, -3, 300), '右侧不受影响');
  });

  test('左侧宽度渐变不影响右侧', () => {
    const doc = createEmptyDocument();
    const built = buildRoadFromPoints('1', STRAIGHT, DEFAULT_FIT, {
      ...DEFAULT_TEMPLATE,
      leftLanes: 2,
      rightLanes: 2,
      laneWidth: 3.5,
      sidewalk: false,
    });
    const road = built!.road;
    doc.roads.push(road);

    assert.ok(taperLaneWidth(road, 2, 100, 50, 2.5).ok);
    assert.ok(Math.abs(widthAtStation(road, 2, 300)! - 2.5) < 1e-6);
    assert.ok(Math.abs(widthAtStation(road, -2, 300)! - 3.5) < 1e-6);
  });
});
