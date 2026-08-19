/**
 * 道路工厂与车道横断面测试。
 */

import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { DEFAULT_FIT } from '../src/core/geometry/alignment.ts';
import {
  addLane,
  buildLaneSection,
  buildRoadFromPoints,
  DEFAULT_TEMPLATE,
  refitRoad,
  removeLane,
  removeLaneFromDocument,
  setLaneWidth,
  setRoadElevation,
  setRoadSuperelevation,
  splitLaneSection,
  type RoadTemplate,
} from '../src/editor/roadFactory.ts';
import { createJunction } from '../src/core/model/junction.ts';
import {
  crossSectionAt,
  laneBoundaryAt,
  laneCenterT,
  laneWidthAt,
  totalWidthAt,
} from '../src/core/model/lanes.ts';
import { referencePoint, stToXyz } from '../src/core/model/reference.ts';
import { summarizeIssues, validateDocument } from '../src/core/model/validate.ts';
import { createEmptyDocument } from '../src/core/model/document.ts';
import type { Vec2 } from '../src/core/math/vec.ts';

const STRAIGHT: Vec2[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
];

const CURVED: Vec2[] = [
  { x: 0, y: 0 },
  { x: 150, y: 20 },
  { x: 280, y: 160 },
];

function template(over: Partial<RoadTemplate> = {}): RoadTemplate {
  return { ...DEFAULT_TEMPLATE, ...over };
}

describe('车道段构造', () => {
  test('按模板生成左右车道', () => {
    const sec = buildLaneSection(template({ leftLanes: 2, rightLanes: 3 }));
    assert.equal(sec.left.length, 2);
    assert.equal(sec.right.length, 3);
    assert.equal(sec.center.id, 0);
    // 由内向外编号
    assert.deepEqual(sec.left.map((l) => l.id), [1, 2]);
    assert.deepEqual(sec.right.map((l) => l.id), [-1, -2, -3]);
  });

  test('单向道路中心线为白虚线，双向为黄实线', () => {
    const oneWay = buildLaneSection(template({ leftLanes: 0, rightLanes: 2 }));
    assert.equal(oneWay.center.roadMarks[0]?.type, 'broken');
    assert.equal(oneWay.center.roadMarks[0]?.color, 'white');

    const twoWay = buildLaneSection(template({ leftLanes: 1, rightLanes: 1 }));
    assert.equal(twoWay.center.roadMarks[0]?.type, 'solid');
    assert.equal(twoWay.center.roadMarks[0]?.color, 'yellow');
  });

  test('最外侧车道为实线边线，内侧为虚线', () => {
    const sec = buildLaneSection(template({ leftLanes: 0, rightLanes: 3 }));
    assert.equal(sec.right[0]?.roadMarks[0]?.type, 'broken', '内侧应为虚线');
    assert.equal(sec.right[1]?.roadMarks[0]?.type, 'broken');
    assert.equal(sec.right[2]?.roadMarks[0]?.type, 'solid', '最外侧应为实线');
  });

  test('人行道追加在最外侧且不画标线', () => {
    const sec = buildLaneSection(template({ leftLanes: 1, rightLanes: 1, sidewalk: true }));
    assert.equal(sec.right.length, 2);
    const outer = sec.right[1]!;
    assert.equal(outer.type, 'sidewalk');
    assert.equal(outer.roadMarks[0]?.type, 'none');
  });

  test('中心车道无宽度记录', () => {
    const sec = buildLaneSection(template());
    assert.equal(sec.center.widths.length, 0);
  });
});

describe('道路构造', () => {
  test('由控制点生成完整道路', () => {
    const built = buildRoadFromPoints('1', CURVED, DEFAULT_FIT, template());
    assert.ok(built !== null);
    const road = built!.road;

    assert.equal(road.id, '1');
    assert.equal(road.junction, '-1');
    assert.ok(road.planView.length > 0);
    assert.equal(road.laneSections.length, 1);
    // 长度应等于末图元 s + length
    const last = road.planView[road.planView.length - 1]!;
    assert.ok(Math.abs(road.length - (last.s + last.length)) < 1e-9);
  });

  test('限速与道路类型写入 types', () => {
    const built = buildRoadFromPoints('1', STRAIGHT, DEFAULT_FIT, template({
      speedLimit: 80,
      roadType: 'motorway',
    }));
    const road = built!.road;
    assert.equal(road.types[0]?.type, 'motorway');
    assert.equal(road.types[0]?.speedMax, 80);
    assert.equal(road.types[0]?.speedUnit, 'km/h');
  });

  test('限速为 0 时不写 speedMax', () => {
    const built = buildRoadFromPoints('1', STRAIGHT, DEFAULT_FIT, template({ speedLimit: 0 }));
    assert.equal(built!.road.types[0]?.speedMax, undefined);
  });

  test('点数不足时返回 null', () => {
    assert.equal(buildRoadFromPoints('1', [{ x: 0, y: 0 }], DEFAULT_FIT, template()), null);
    assert.equal(buildRoadFromPoints('1', [], DEFAULT_FIT, template()), null);
  });

  test('新建道路通过校验', () => {
    const doc = createEmptyDocument('+proj=tmerc +lat_0=0 +lon_0=0 +k=1 +datum=WGS84 +units=m');
    const built = buildRoadFromPoints('1', CURVED, DEFAULT_FIT, template({
      leftLanes: 2,
      rightLanes: 2,
      sidewalk: true,
    }));
    doc.roads.push(built!.road);
    const { errors } = summarizeIssues(validateDocument(doc));
    assert.equal(errors, 0);
  });
});

describe('车道横断面', () => {
  test('单车道边界 t 值正确', () => {
    const built = buildRoadFromPoints('1', STRAIGHT, DEFAULT_FIT, template({
      leftLanes: 0,
      rightLanes: 1,
      laneWidth: 3.5,
    }));
    const road = built!.road;
    const cs = crossSectionAt(road, road.length / 2);

    assert.equal(cs.left.length, 0);
    assert.equal(cs.right.length, 1);
    const lane = cs.right[0]!;
    // 右侧车道 t 为负，由内（0）向外（-3.5）
    assert.ok(Math.abs(lane.tInner) < 1e-12);
    assert.ok(Math.abs(lane.tOuter + 3.5) < 1e-12);
    assert.ok(Math.abs(lane.width - 3.5) < 1e-12);
  });

  test('多车道 t 区间不重叠且连续', () => {
    const built = buildRoadFromPoints('1', CURVED, DEFAULT_FIT, template({
      leftLanes: 2,
      rightLanes: 3,
      laneWidth: 3.25,
    }));
    const road = built!.road;
    const cs = crossSectionAt(road, road.length * 0.4);

    // 左侧：0 → +3.25 → +6.5
    let expected = cs.tCenter;
    for (const b of cs.left) {
      assert.ok(Math.abs(b.tInner - expected) < 1e-12, `左侧内边界应接前一条外边界`);
      expected = b.tOuter;
    }
    assert.ok(Math.abs(expected - 6.5) < 1e-12, `左侧最外应为 6.5，实际 ${expected}`);

    // 右侧：0 → -3.25 → -6.5 → -9.75
    expected = cs.tCenter;
    for (const b of cs.right) {
      assert.ok(Math.abs(b.tInner - expected) < 1e-12);
      expected = b.tOuter;
    }
    assert.ok(Math.abs(expected + 9.75) < 1e-12, `右侧最外应为 -9.75，实际 ${expected}`);
  });

  test('车道中心 t 为内外边界均值', () => {
    const built = buildRoadFromPoints('1', STRAIGHT, DEFAULT_FIT, template({
      leftLanes: 0,
      rightLanes: 2,
      laneWidth: 4,
    }));
    const road = built!.road;
    const b = laneBoundaryAt(road, -2, 50)!;
    assert.ok(Math.abs(laneCenterT(b) - -6) < 1e-12, '第二条右车道中心应在 t=-6');
  });

  test('总宽度反映左右最外缘', () => {
    const built = buildRoadFromPoints('1', STRAIGHT, DEFAULT_FIT, template({
      leftLanes: 1,
      rightLanes: 2,
      laneWidth: 3,
    }));
    const { tLeft, tRight } = totalWidthAt(built!.road, 50);
    assert.ok(Math.abs(tLeft - 3) < 1e-12);
    assert.ok(Math.abs(tRight + 6) < 1e-12);
  });

  test('不存在的车道返回 null', () => {
    const built = buildRoadFromPoints('1', STRAIGHT, DEFAULT_FIT, template({
      leftLanes: 0,
      rightLanes: 1,
    }));
    assert.equal(laneBoundaryAt(built!.road, -99, 50), null);
  });

  test('中心车道边界宽度为零', () => {
    const built = buildRoadFromPoints('1', STRAIGHT, DEFAULT_FIT, template());
    const b = laneBoundaryAt(built!.road, 0, 50)!;
    assert.equal(b.width, 0);
    assert.equal(b.tInner, b.tOuter);
  });
});

describe('车道属性修改', () => {
  test('设置车道宽度', () => {
    const built = buildRoadFromPoints('1', STRAIGHT, DEFAULT_FIT, template({
      leftLanes: 0,
      rightLanes: 1,
    }));
    const road = built!.road;
    const lane = road.laneSections[0]!.right[0]!;
    setLaneWidth(lane, 5.5);
    assert.ok(Math.abs(laneWidthAt(lane, 0) - 5.5) < 1e-12);
    // 负宽被夹到最小值
    setLaneWidth(lane, -3);
    assert.ok(laneWidthAt(lane, 0) > 0);
  });

  test('增删车道后 id 保持连续', () => {
    const sec = buildLaneSection(template({ leftLanes: 0, rightLanes: 3 }));
    const added = addLane(sec, 'right', 'parking', 2.5);
    assert.equal(added.id, -4);
    assert.deepEqual(sec.right.map((l) => l.id), [-1, -2, -3, -4]);

    assert.ok(removeLane(sec, -2));
    assert.deepEqual(sec.right.map((l) => l.id), [-1, -2, -3], '删除后应重编号');
    assert.equal(sec.right.length, 3);
  });

  test('不可删除中心车道', () => {
    const sec = buildLaneSection(template());
    assert.equal(removeLane(sec, 0), false);
  });

  test('删除不存在的车道返回 false', () => {
    const sec = buildLaneSection(template({ rightLanes: 1 }));
    assert.equal(removeLane(sec, -99), false);
  });

  describe('删除车道时同步 junction 引用', () => {
    /** 一条 4 车道道路作为入口道路接入路口，laneLink 覆盖 -1..-3 */
    function scene() {
      const doc = createEmptyDocument();
      const built = buildRoadFromPoints('1', STRAIGHT, DEFAULT_FIT, template({ rightLanes: 4 }));
      const road = built!.road;
      doc.roads.push(road);

      const j = createJunction('100');
      j.connections.push({
        id: '0',
        incomingRoad: '1',
        connectingRoad: '9',
        contactPoint: 'start',
        laneLinks: [
          { from: -1, to: -1 },
          { from: -2, to: -2 },
          { from: -3, to: -3 },
        ],
      });
      doc.junctions.push(j);
      return { doc, road, links: () => doc.junctions[0]!.connections[0]!.laneLinks };
    }

    test('删最外侧只丢掉指向它的链接，其余不动', () => {
      const { doc, road, links } = scene();
      const r = removeLaneFromDocument(doc, road, 0, -3);

      assert.equal(r.ok, true);
      assert.equal(r.droppedLinks, 1);
      assert.equal(r.remappedLinks, 0);
      assert.deepEqual(links(), [
        { from: -1, to: -1 },
        { from: -2, to: -2 },
      ]);
    });

    test('删中间车道时外侧引用整体内移一位', () => {
      const { doc, road, links } = scene();
      const r = removeLaneFromDocument(doc, road, 0, -1);

      assert.equal(r.droppedLinks, 1, '指向 -1 的链接失效');
      assert.equal(r.remappedLinks, 2, '-2/-3 各内移一位');
      // to 侧属于连接道路 9，不受本次删除影响
      assert.deepEqual(links(), [
        { from: -1, to: -2 },
        { from: -2, to: -3 },
      ]);
      assert.deepEqual(road.laneSections[0]!.right.map((l) => l.id), [-1, -2, -3]);
    });

    test('删左侧车道不影响右侧的 laneLink', () => {
      const doc = createEmptyDocument();
      const built = buildRoadFromPoints('1', STRAIGHT, DEFAULT_FIT, template({ leftLanes: 2, rightLanes: 2 }));
      const road = built!.road;
      doc.roads.push(road);

      const j = createJunction('100');
      j.connections.push({
        id: '0',
        incomingRoad: '1',
        connectingRoad: '9',
        contactPoint: 'start',
        laneLinks: [{ from: -1, to: -1 }, { from: -2, to: -2 }],
      });
      doc.junctions.push(j);

      const r = removeLaneFromDocument(doc, road, 0, 2);
      assert.equal(r.droppedLinks, 0);
      assert.equal(r.remappedLinks, 0);
      assert.deepEqual(j.connections[0]!.laneLinks, [{ from: -1, to: -1 }, { from: -2, to: -2 }]);
    });

    test('作为连接道路时改写 to 侧', () => {
      const doc = createEmptyDocument();
      const built = buildRoadFromPoints('9', STRAIGHT, DEFAULT_FIT, template({ rightLanes: 3 }));
      const road = built!.road;
      doc.roads.push(road);

      const j = createJunction('100');
      j.connections.push({
        id: '0',
        incomingRoad: '1',
        connectingRoad: '9',
        contactPoint: 'start',
        laneLinks: [{ from: -1, to: -1 }, { from: -2, to: -2 }, { from: -3, to: -3 }],
      });
      doc.junctions.push(j);

      const r = removeLaneFromDocument(doc, road, 0, -1);
      assert.equal(r.droppedLinks, 1);
      assert.equal(r.remappedLinks, 2);
      // from 侧属于入口道路 1，保持原样
      assert.deepEqual(j.connections[0]!.laneLinks, [
        { from: -2, to: -1 },
        { from: -3, to: -2 },
      ]);
    });

    test('中间车道段的删除不触碰 laneLink', () => {
      const { doc, road, links } = scene();
      assert.ok(splitLaneSection(road, 30));
      assert.ok(splitLaneSection(road, 60));
      assert.equal(road.laneSections.length, 3);

      const r = removeLaneFromDocument(doc, road, 1, -3);
      assert.equal(r.ok, true);
      assert.equal(r.droppedLinks, 0, '中间段不与路口相接');
      assert.equal(r.remappedLinks, 0);
      assert.equal(links().length, 3);
    });

    test('删除失败时不改动任何 laneLink', () => {
      const { doc, road, links } = scene();
      const r = removeLaneFromDocument(doc, road, 0, 0);
      assert.equal(r.ok, false);
      assert.equal(links().length, 3);
    });
  });

  test('设置高程与横坡', () => {
    const built = buildRoadFromPoints('1', STRAIGHT, DEFAULT_FIT, template());
    const road = built!.road;

    setRoadElevation(road, 25.5);
    assert.equal(road.elevations.length, 1);
    assert.ok(Math.abs(referencePoint(road, 50).z - 25.5) < 1e-12);

    setRoadSuperelevation(road, 3);
    assert.equal(road.superelevations.length, 1);
    const rad = (3 * Math.PI) / 180;
    assert.ok(Math.abs(referencePoint(road, 50).superelevation - rad) < 1e-12);

    // 横坡为 0 时清空记录
    setRoadSuperelevation(road, 0);
    assert.equal(road.superelevations.length, 0);
  });

  test('正横坡使左侧下沉', () => {
    const built = buildRoadFromPoints('1', STRAIGHT, DEFAULT_FIT, template({
      leftLanes: 1,
      rightLanes: 1,
    }));
    const road = built!.road;
    setRoadElevation(road, 0);
    setRoadSuperelevation(road, 5);

    const ref = referencePoint(road, 50);
    const left = stToXyz(ref, 3.5);
    const right = stToXyz(ref, -3.5);
    assert.ok(left.z < 0, `左侧（t>0）应下沉，实际 z=${left.z}`);
    assert.ok(right.z > 0, `右侧（t<0）应抬升，实际 z=${right.z}`);
  });
});

describe('车道段切分与重拟合', () => {
  test('切分后宽度连续', () => {
    const built = buildRoadFromPoints('1', CURVED, DEFAULT_FIT, template({
      leftLanes: 1,
      rightLanes: 2,
    }));
    const road = built!.road;
    const s = road.length * 0.5;
    const widthBefore = crossSectionAt(road, s).right[0]!.width;

    assert.ok(splitLaneSection(road, s));
    assert.equal(road.laneSections.length, 2);
    const widthAfter = crossSectionAt(road, s + 1e-6).right[0]!.width;
    assert.ok(Math.abs(widthAfter - widthBefore) < 1e-9, '切分不应改变宽度');
  });

  test('重复切分同一位置失败', () => {
    const built = buildRoadFromPoints('1', CURVED, DEFAULT_FIT, template());
    const road = built!.road;
    const s = road.length * 0.5;
    assert.ok(splitLaneSection(road, s));
    assert.equal(splitLaneSection(road, s), false);
  });

  test('重拟合更新几何并裁剪越界记录', () => {
    const built = buildRoadFromPoints('1', CURVED, DEFAULT_FIT, template());
    const road = built!.road;
    const originalLength = road.length;
    splitLaneSection(road, originalLength * 0.8);
    assert.equal(road.laneSections.length, 2);

    // 缩短到只剩两点，长度大幅减少
    const shorter: Vec2[] = [{ x: 0, y: 0 }, { x: 40, y: 0 }];
    assert.ok(refitRoad(road, shorter, DEFAULT_FIT));

    assert.ok(road.length < originalLength, '长度应缩短');
    assert.equal(road.laneSections.length, 1, '越界车道段应被裁剪');
    // s 与 length 自洽
    const last = road.planView[road.planView.length - 1]!;
    assert.ok(Math.abs(road.length - (last.s + last.length)) < 1e-9);
  });

  test('重拟合保留车道配置', () => {
    const built = buildRoadFromPoints('1', CURVED, DEFAULT_FIT, template({
      leftLanes: 2,
      rightLanes: 3,
      laneWidth: 3.75,
    }));
    const road = built!.road;
    refitRoad(road, [{ x: 0, y: 0 }, { x: 200, y: 50 }], DEFAULT_FIT);

    const sec = road.laneSections[0]!;
    assert.equal(sec.left.length, 2);
    assert.equal(sec.right.length, 3);
    assert.ok(Math.abs(laneWidthAt(sec.right[0]!, 0) - 3.75) < 1e-12);
  });

  test('重拟合后仍通过校验', () => {
    const doc = createEmptyDocument('+proj=tmerc +lat_0=0 +lon_0=0 +k=1 +datum=WGS84 +units=m');
    const built = buildRoadFromPoints('1', CURVED, DEFAULT_FIT, template({ sidewalk: true }));
    const road = built!.road;
    doc.roads.push(road);
    refitRoad(road, [{ x: 0, y: 0 }, { x: 120, y: 30 }, { x: 200, y: 140 }], DEFAULT_FIT);
    assert.equal(summarizeIssues(validateDocument(doc)).errors, 0);
  });
});
