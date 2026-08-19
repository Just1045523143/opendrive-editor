import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { fitAlignment, fitHermiteConnector } from '../src/core/geometry/alignment.ts';
import { evaluateGeometry } from '../src/core/geometry/evaluate.ts';
import type { Geometry } from '../src/core/geometry/types.ts';
import { createEmptyDocument } from '../src/core/model/document.ts';
import { buildRoad, DEFAULT_TEMPLATE, splitLaneSection, addLane, removeLane } from '../src/editor/roadFactory.ts';
import { parseOpenDrive } from '../src/core/xml/parse.ts';
import { fmt, serializeOpenDrive } from '../src/core/xml/serialize.ts';
import { parseXml, serializeRaw } from '../src/core/xml/dom.ts';
import { crossSectionAt, laneWidthAt } from '../src/core/model/lanes.ts';
import { laneSectionIndexAt, laneSectionRange } from '../src/core/model/road.ts';
import { endLaneWithTaper } from '../src/editor/laneTaper.ts';
import type { Road } from '../src/core/model/road.ts';
import { referencePoint, stToXyz } from '../src/core/model/reference.ts';
import { validateDocument, summarizeIssues } from '../src/core/model/validate.ts';
import { computeBounds } from '../src/core/model/bounds.ts';
import type { OdrDocument } from '../src/core/model/document.ts';

const GEO_REF = '+proj=tmerc +lat_0=39.90923 +lon_0=116.397428 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs';

/** 构造一份含多种图元与多车道段的测试文档 */
function makeDocument(): OdrDocument {
  const doc = createEmptyDocument(GEO_REF);
  doc.header.name = 'test-net';

  // 道路 1：缓和曲线线形（含 line/spiral/arc）
  const fit1 = fitAlignment(
    [{ x: 0, y: 0 }, { x: 200, y: 30 }, { x: 340, y: 210 }, { x: 560, y: 260 }],
    { mode: 'spiral', radius: 60, spiralLength: 25 },
  );
  const road1 = buildRoad('1', fit1.geometries, {
    ...DEFAULT_TEMPLATE,
    leftLanes: 2,
    rightLanes: 2,
    sidewalk: true,
    elevation: 12.5,
  });
  splitLaneSection(road1, road1.length / 2);
  const section2 = road1.laneSections[1]!;
  addLane(section2, 'right', 'parking', 2.4);
  doc.roads.push(road1);

  // 道路 2：圆角线形，与道路 1 相接
  const fit2 = fitAlignment(
    [{ x: 560, y: 260 }, { x: 760, y: 260 }, { x: 900, y: 400 }],
    { mode: 'arc', radius: 45, spiralLength: 0 },
  );
  const road2 = buildRoad('2', fit2.geometries, { ...DEFAULT_TEMPLATE, leftLanes: 1, rightLanes: 1 });
  road2.link.predecessor = { elementType: 'road', elementId: '1', contactPoint: 'end' };
  road1.link.successor = { elementType: 'road', elementId: '2', contactPoint: 'start' };
  road2.superelevations = [{ s: 0, a: 0.03, b: 0, c: 0, d: 0 }];
  road2.objects.push({ id: 'obj1', type: 'pole', s: 10, t: -8, zOffset: 0, height: 4 });
  road2.signals.push({ id: 'sig1', s: 20, t: -9, type: '274', subtype: '50', dynamic: 'no' });
  doc.roads.push(road2);

  // 道路 3：手工构造 poly3 与 paramPoly3，验证这两类图元的往返。
  // 第二个图元的起点位姿由第一个图元的终点求得，保证几何链连续。
  const g3a: Geometry = {
    type: 'poly3', s: 0, x: 1000, y: 0, hdg: 0.3, length: 80,
    a: 0, b: 0, c: 0.0015, d: -8e-6,
  };
  const g3aEnd = evaluateGeometry(g3a, g3a.length);
  const g3b: Geometry = {
    type: 'paramPoly3', s: g3a.length, x: g3aEnd.x, y: g3aEnd.y, hdg: g3aEnd.hdg, length: 60,
    aU: 0, bU: 58, cU: 3, dU: -1, aV: 0, bV: 0, cV: 8, dV: -3, pRange: 'normalized',
  };
  const road3 = buildRoad('3', [g3a, g3b], {
    ...DEFAULT_TEMPLATE,
    leftLanes: 0,
    rightLanes: 3,
  });
  doc.roads.push(road3);

  // 交叉口
  /*
   * 交叉口。按 ASAM 规范装配：
   *   - 连接道路（road 4）的 junction 属性必须指向所属路口
   *   - 入口道路（road 1）须经 link 指向 junction，而非直连连接道路
   *   - laneLink 的 to 指向连接道路自身的车道
   *
   * 用道路 1 的**起点**端作路口臂——其终点端已与道路 2 直连，那条直连是
   * 「接续点间隙」测试所依赖的，不能改动。
   */
  const road1Start = evaluateGeometry(road1.planView[0]!, 0);
  const connGeom = fitHermiteConnector(
    { x: road1Start.x, y: road1Start.y },
    // 从道路 1 起点驶出路口的方向即其起点航向
    road1Start.hdg,
    { x: road1Start.x - 40, y: road1Start.y - 25 },
    road1Start.hdg + 0.6,
  );
  const road4 = buildRoad('4', [connGeom], {
    ...DEFAULT_TEMPLATE,
    leftLanes: 0,
    rightLanes: 1,
    sidewalk: false,
  });
  road4.junction = '100';
  road4.link.predecessor = { elementType: 'road', elementId: '1', contactPoint: 'start' };
  const connLane = road4.laneSections[0]!.right[0]!;
  connLane.link.predecessorIds = [1];
  doc.roads.push(road4);

  road1.link.predecessor = { elementType: 'junction', elementId: '100' };

  doc.junctions.push({
    id: '100',
    name: 'J100',
    type: 'default',
    connections: [
      {
        id: '0',
        incomingRoad: '1',
        connectingRoad: '4',
        contactPoint: 'start',
        // 道路 1 以 start 端接入，其进口车道为正 id（左侧）
        laneLinks: [{ from: 1, to: connLane.id }],
      },
    ],
    priorities: [{ high: '1', low: '4' }],
    controllers: [],
  });

  return doc;
}

describe('XML 解析器', () => {
  test('属性、自闭合、嵌套', () => {
    const root = parseXml('<a x="1" y="2"><b/><c k="v">text</c></a>');
    assert.equal(root.tag, 'a');
    assert.equal(root.attrs.x, '1');
    assert.equal(root.children.length, 2);
    assert.equal(root.children[1]!.text, 'text');
  });

  test('CDATA 内容', () => {
    const root = parseXml('<h><geoReference><![CDATA[+proj=utm +zone=50]]></geoReference></h>');
    assert.equal(root.children[0]!.text, '+proj=utm +zone=50');
  });

  test('注释与声明被跳过', () => {
    const root = parseXml('<?xml version="1.0"?><!-- c --><a><!-- inner --><b/></a>');
    assert.equal(root.tag, 'a');
    assert.equal(root.children.length, 1);
  });

  test('实体解码与编码', () => {
    const root = parseXml('<a t="&lt;&amp;&gt;&quot;"/>');
    assert.equal(root.attrs.t, '<&>"');
    const raw = serializeRaw(parseXml('<a t="a&amp;b"/>'));
    assert.ok(raw.includes('a&amp;b'));
  });

  test('缺失根元素时抛错', () => {
    assert.throws(() => parseXml('   '), /未找到根元素/);
  });
});

describe('数值格式化', () => {
  test('可精确回读', () => {
    for (const v of [0, 1, -1, 0.1, 1 / 3, 123456.789012345, 1e-7, -2.5e-9, 500000.123456789]) {
      const s = fmt(v);
      assert.ok(!s.includes('e'), `${s} 含指数记法`);
      // 极小值归零是有意行为
      if (Math.abs(v) >= 1e-12) {
        assert.ok(Math.abs(Number(s) - v) <= Math.abs(v) * 1e-10 + 1e-11, `${v} → ${s}`);
      }
    }
  });

  test('浮点噪声归零', () => {
    assert.equal(fmt(5.551115123125783e-17), '0');
    assert.equal(fmt(-0), '0');
  });

  test('整数不带小数点', () => {
    assert.equal(fmt(42), '42');
    assert.equal(fmt(-7), '-7');
  });
});

describe('xodr 往返', () => {
  const original = makeDocument();
  const xml = serializeOpenDrive(original);
  const reparsed = parseOpenDrive(xml);

  test('无解析警告', () => {
    assert.deepEqual(reparsed.warnings, [], `警告：${reparsed.warnings.join('; ')}`);
  });

  test('header 与 geoReference 保留', () => {
    assert.equal(reparsed.document.header.geoReference, GEO_REF);
    assert.equal(reparsed.document.header.name, 'test-net');
    assert.equal(reparsed.document.header.revMajor, 1);
    assert.equal(reparsed.document.header.revMinor, 7);
  });

  test('道路数量与 id 一致', () => {
    assert.equal(reparsed.document.roads.length, original.roads.length);
    assert.deepEqual(
      reparsed.document.roads.map((r) => r.id),
      original.roads.map((r) => r.id),
    );
  });

  test('几何图元逐一等价', () => {
    for (let i = 0; i < original.roads.length; i++) {
      const a = original.roads[i]!;
      const b = reparsed.document.roads[i]!;
      assert.equal(b.planView.length, a.planView.length, `道路 ${a.id} 图元数不符`);
      assert.ok(Math.abs(b.length - a.length) < 1e-9, `道路 ${a.id} 长度不符`);

      for (let k = 0; k < a.planView.length; k++) {
        const ga = a.planView[k]!;
        const gb = b.planView[k]!;
        assert.equal(gb.type, ga.type);
        for (const key of ['s', 'x', 'y', 'hdg', 'length'] as const) {
          assert.ok(
            Math.abs(gb[key] - ga[key]) < 1e-9,
            `道路 ${a.id} 图元 ${k} 的 ${key}: ${gb[key]} vs ${ga[key]}`,
          );
        }
        if (ga.type === 'arc' && gb.type === 'arc') {
          assert.ok(Math.abs(gb.curvature - ga.curvature) < 1e-15);
        }
        if (ga.type === 'spiral' && gb.type === 'spiral') {
          assert.ok(Math.abs(gb.curvStart - ga.curvStart) < 1e-15);
          assert.ok(Math.abs(gb.curvEnd - ga.curvEnd) < 1e-15);
        }
        if (ga.type === 'poly3' && gb.type === 'poly3') {
          for (const key of ['a', 'b', 'c', 'd'] as const) {
            assert.ok(Math.abs(gb[key] - ga[key]) < 1e-15, `poly3 ${key}`);
          }
        }
        if (ga.type === 'paramPoly3' && gb.type === 'paramPoly3') {
          for (const key of ['aU', 'bU', 'cU', 'dU', 'aV', 'bV', 'cV', 'dV'] as const) {
            assert.ok(Math.abs(gb[key] - ga[key]) < 1e-15, `paramPoly3 ${key}`);
          }
          assert.equal(gb.pRange, ga.pRange);
        }
      }
    }
  });

  test('车道段与车道保留', () => {
    for (let i = 0; i < original.roads.length; i++) {
      const a = original.roads[i]!;
      const b = reparsed.document.roads[i]!;
      assert.equal(b.laneSections.length, a.laneSections.length, `道路 ${a.id} 车道段数`);

      for (let k = 0; k < a.laneSections.length; k++) {
        const sa = a.laneSections[k]!;
        const sb = b.laneSections[k]!;
        assert.ok(Math.abs(sb.s - sa.s) < 1e-9);
        assert.equal(sb.left.length, sa.left.length, `道路 ${a.id} 段 ${k} 左侧车道数`);
        assert.equal(sb.right.length, sa.right.length, `道路 ${a.id} 段 ${k} 右侧车道数`);
        assert.deepEqual(sb.left.map((l) => l.id), sa.left.map((l) => l.id));
        assert.deepEqual(sb.right.map((l) => l.id), sa.right.map((l) => l.id));
        assert.deepEqual(sb.left.map((l) => l.type), sa.left.map((l) => l.type));

        for (const lane of sa.right) {
          const other = sb.right.find((l) => l.id === lane.id)!;
          assert.ok(
            Math.abs(laneWidthAt(other, 1) - laneWidthAt(lane, 1)) < 1e-12,
            `道路 ${a.id} 车道 ${lane.id} 宽度不符`,
          );
        }
      }
    }
  });

  test('高程、横坡、连接、物体、信号保留', () => {
    const r1 = reparsed.document.roads[0]!;
    assert.ok(Math.abs((r1.elevations[0]?.a ?? 0) - 12.5) < 1e-12);
    assert.equal(r1.link.successor?.elementId, '2');
    assert.equal(r1.link.successor?.contactPoint, 'start');

    const r2 = reparsed.document.roads[1]!;
    assert.ok(Math.abs((r2.superelevations[0]?.a ?? 0) - 0.03) < 1e-12);
    assert.equal(r2.objects.length, 1);
    assert.equal(r2.objects[0]!.id, 'obj1');
    assert.ok(Math.abs(r2.objects[0]!.t - -8) < 1e-12);
    assert.equal(r2.signals.length, 1);
    assert.equal(r2.signals[0]!.type, '274');
    assert.equal(r2.signals[0]!.subtype, '50');
  });

  test('交叉口保留', () => {
    const j = reparsed.document.junctions[0]!;
    assert.equal(j.id, '100');
    assert.equal(j.connections.length, 1);
    assert.equal(j.connections[0]!.incomingRoad, '1');
    assert.equal(j.connections[0]!.connectingRoad, '4');
    assert.equal(j.connections[0]!.contactPoint, 'start');
    assert.deepEqual(j.connections[0]!.laneLinks, [{ from: 1, to: -1 }]);
    assert.deepEqual(j.priorities, [{ high: '1', low: '4' }]);
  });

  test('连接道路的 junction 归属与车道衔接保留', () => {
    const road4 = reparsed.document.roads.find((r) => r.id === '4')!;
    assert.equal(road4.junction, '100', '连接道路应声明归属');
    assert.equal(road4.planView[0]?.type, 'paramPoly3', 'Hermite 连接器应导出为 paramPoly3');
    const lane = road4.laneSections[0]!.right[0]!;
    assert.deepEqual(lane.link.predecessorIds, [1], '车道级前驱应保留');

    const road1 = reparsed.document.roads.find((r) => r.id === '1')!;
    assert.equal(road1.junction, '-1', '入口道路不应标记归属');
    assert.equal(road1.link.predecessor?.elementType, 'junction');
    assert.equal(road1.link.predecessor?.elementId, '100');
  });

  test('几何求值结果一致（端到端一致性）', () => {
    for (let i = 0; i < original.roads.length; i++) {
      const a = original.roads[i]!;
      const b = reparsed.document.roads[i]!;
      for (const frac of [0, 0.23, 0.5, 0.77, 1]) {
        const s = a.length * frac;
        const pa = referencePoint(a, s);
        const pb = referencePoint(b, s);
        assert.ok(
          Math.hypot(pa.x - pb.x, pa.y - pb.y) < 1e-9,
          `道路 ${a.id} 在 s=${s} 处位置不一致`,
        );
        // 车道边界也须一致
        const ca = crossSectionAt(a, s, pa);
        const cb = crossSectionAt(b, s, pb);
        assert.equal(cb.right.length, ca.right.length);
        for (let k = 0; k < ca.right.length; k++) {
          assert.ok(Math.abs(ca.right[k]!.tOuter - cb.right[k]!.tOuter) < 1e-9);
        }
      }
    }
  });

  test('二次往返稳定（序列化幂等）', () => {
    const xml2 = serializeOpenDrive(reparsed.document);
    assert.equal(xml2, xml, '第二次序列化结果与第一次不同');
  });

  test('bounds 覆盖全部车道外缘', () => {
    const bounds = computeBounds(reparsed.document)!;
    assert.ok(bounds !== null);
    // 抽样若干车道外缘点，必须落在 bounds 内
    for (const road of reparsed.document.roads) {
      for (const frac of [0, 0.5, 1]) {
        const ref = referencePoint(road, road.length * frac);
        const cs = crossSectionAt(road, ref.s, ref);
        const ts = [
          cs.left.length > 0 ? cs.left[cs.left.length - 1]!.tOuter : cs.tCenter,
          cs.right.length > 0 ? cs.right[cs.right.length - 1]!.tOuter : cs.tCenter,
        ];
        for (const t of ts) {
          const p = stToXyz(ref, t);
          assert.ok(p.x >= bounds.west - 1e-6 && p.x <= bounds.east + 1e-6, 'x 越界');
          assert.ok(p.y >= bounds.south - 1e-6 && p.y <= bounds.north + 1e-6, 'y 越界');
        }
      }
    }
  });
});

describe('大坐标精度', () => {
  test('UTM 量级坐标往返保持亚毫米精度', () => {
    const doc = createEmptyDocument('+proj=utm +zone=50 +datum=WGS84 +units=m +no_defs');
    // 典型 UTM 东坐标 ~4.4e5，北坐标 ~4.4e6
    const road = buildRoad('1', [
      { type: 'line', s: 0, x: 441234.56789012, y: 4418765.43210987, hdg: 0.7853981633974483, length: 123.456789 },
      {
        type: 'spiral', s: 123.456789, x: 441321.86, y: 4418852.73,
        hdg: 0.7853981633974483, length: 45.6, curvStart: 0, curvEnd: 0.008333333333333333,
      },
    ], DEFAULT_TEMPLATE);
    doc.roads.push(road);

    const back = parseOpenDrive(serializeOpenDrive(doc)).document.roads[0]!;
    const g0 = back.planView[0]!;
    assert.ok(Math.abs(g0.x - 441234.56789012) < 1e-6, `x 误差 ${Math.abs(g0.x - 441234.56789012)}`);
    assert.ok(Math.abs(g0.y - 4418765.43210987) < 1e-6);
    assert.ok(Math.abs(g0.hdg - 0.7853981633974483) < 1e-12);
    const g1 = back.planView[1]!;
    assert.ok(g1.type === 'spiral' && Math.abs(g1.curvEnd - 0.008333333333333333) < 1e-15);
  });
});

describe('校验器', () => {
  test('正常文档无错误', () => {
    const { errors } = summarizeIssues(validateDocument(makeDocument()));
    assert.equal(errors, 0);
  });

  test('检出几何断裂', () => {
    const doc = makeDocument();
    doc.roads[0]!.planView[1]!.x += 5;
    const codes = validateDocument(doc).map((i) => i.code);
    assert.ok(codes.includes('planview-position-gap'), `实际：${codes.join(',')}`);
  });

  test('检出长度不符', () => {
    const doc = makeDocument();
    doc.roads[0]!.length += 10;
    assert.ok(validateDocument(doc).some((i) => i.code === 'road-length-mismatch'));
  });

  test('检出悬空连接', () => {
    const doc = makeDocument();
    doc.roads[0]!.link.successor = { elementType: 'road', elementId: '999', contactPoint: 'start' };
    assert.ok(validateDocument(doc).some((i) => i.code === 'dangling-link'));
  });

  test('检出缺少 contactPoint', () => {
    const doc = makeDocument();
    doc.roads[0]!.link.successor = { elementType: 'road', elementId: '2' };
    assert.ok(validateDocument(doc).some((i) => i.code === 'link-missing-contact-point'));
  });

  test('检出车道 id 不连续', () => {
    const doc = makeDocument();
    doc.roads[0]!.laneSections[0]!.right[1]!.id = -5;
    assert.ok(validateDocument(doc).some((i) => i.code === 'lane-id-not-sequential'));
  });

  test('检出负车道宽', () => {
    const doc = makeDocument();
    doc.roads[0]!.laneSections[0]!.right[0]!.widths = [{ sOffset: 0, a: -1, b: 0, c: 0, d: 0 }];
    assert.ok(validateDocument(doc).some((i) => i.code === 'negative-lane-width'));
  });

  test('检出车道段越界', () => {
    const doc = makeDocument();
    doc.roads[0]!.laneSections.push({
      s: doc.roads[0]!.length + 100,
      left: [],
      center: { id: 0, type: 'none', link: { predecessorIds: [], successorIds: [] }, widths: [], roadMarks: [] },
      right: [],
    });
    assert.ok(validateDocument(doc).some((i) => i.code === 'lane-section-out-of-range'));
  });

  test('检出接续点间隙', () => {
    const doc = makeDocument();
    // 把道路 2 整体挪开，使其与道路 1 的接续点断开
    for (const g of doc.roads[1]!.planView) g.x += 3;
    assert.ok(validateDocument(doc).some((i) => i.code === 'join-gap'));
  });

  test('检出交叉口悬空引用', () => {
    const doc = makeDocument();
    doc.junctions[0]!.connections[0]!.connectingRoad = '999';
    assert.ok(validateDocument(doc).some((i) => i.code === 'junction-dangling-road'));
  });

  test('检出重复道路 id', () => {
    const doc = makeDocument();
    doc.roads.push({ ...doc.roads[0]! });
    assert.ok(validateDocument(doc).some((i) => i.code === 'duplicate-road-id'));
  });
});

describe('车道编辑', () => {
  test('删除车道后 id 重新连续', () => {
    const doc = makeDocument();
    const section = doc.roads[0]!.laneSections[0]!;
    const before = section.right.length;
    assert.ok(removeLane(section, -1));
    assert.equal(section.right.length, before - 1);
    assert.deepEqual(
      section.right.map((l) => l.id),
      Array.from({ length: before - 1 }, (_, i) => -(i + 1)),
    );
    assert.equal(summarizeIssues(validateDocument(doc)).errors, 0);
  });

  test('新增车道 id 递增且校验通过', () => {
    const doc = makeDocument();
    const section = doc.roads[2]!.laneSections[0]!;
    const lane = addLane(section, 'left', 'driving', 3.25);
    assert.equal(lane.id, 1);
    assert.equal(summarizeIssues(validateDocument(doc)).errors, 0);
  });

  test('切分车道段保持校验通过且宽度连续', () => {
    const doc = makeDocument();
    const road = doc.roads[1]!;
    const sBefore = road.length * 0.4;
    const widthBefore = (() => {
      const cs = crossSectionAt(road, sBefore);
      return cs.right[0]!.width;
    })();

    assert.ok(splitLaneSection(road, sBefore));
    const cs = crossSectionAt(road, sBefore + 1e-6);
    assert.ok(Math.abs(cs.right[0]!.width - widthBefore) < 1e-9, '切分后宽度跳变');
    assert.equal(summarizeIssues(validateDocument(doc)).errors, 0);
  });

  test('端点处不可切分', () => {
    const doc = makeDocument();
    assert.equal(splitLaneSection(doc.roads[1]!, 0), false);
    assert.equal(splitLaneSection(doc.roads[1]!, doc.roads[1]!.length), false);
  });
});

/** 车道在给定站号的宽度；车道不存在返回 null */
function widthOf(road: Road, laneId: number, s: number): number | null {
  const idx = laneSectionIndexAt(road, s);
  const section = road.laneSections[idx];
  if (!section) return null;
  const side = laneId > 0 ? section.left : section.right;
  const lane = side.find((l) => l.id === laneId);
  if (!lane) return null;
  return laneWidthAt(lane, s - laneSectionRange(road, idx).start);
}

describe('车道渐变', () => {
  /** 在道路 2（多车道直路）上做一次车道渐变消失 */
  function tapered() {
    const doc = makeDocument();
    const road = doc.roads[1]!;
    const side = road.laneSections[0]!.right;
    const outer = side[side.length - 1]!.id;
    const sStart = road.length * 0.4;
    const r = endLaneWithTaper(doc, road, outer, sStart, 40);
    return { doc, road, outer, sStart, ok: r.ok, reason: r.reason };
  }

  test('往返后逐站宽度一致', () => {
    const { doc, road, outer, ok, reason } = tapered();
    assert.ok(ok, reason ?? '');

    const xml = serializeOpenDrive(doc);
    const back = parseOpenDrive(xml).document;
    const road2 = back.roads.find((r) => r.id === road.id)!;

    for (let s = 0; s <= road.length; s += 2) {
      for (const id of [outer, outer + 1, -1]) {
        const a = widthOf(road, id, s);
        const b = widthOf(road2, id, s);
        if (a === null || b === null) {
          assert.equal(a === null, b === null, `车道 ${id} 在 ${s.toFixed(1)} m 处存在性不一致`);
          continue;
        }
        assert.ok(Math.abs(a - b) < 1e-6, `车道 ${id} 在 ${s.toFixed(1)} m 处宽度 ${a} ≠ ${b}`);
      }
    }
  });

  test('往返后消失点之后仍无该车道', () => {
    const { doc, road, outer, sStart, ok } = tapered();
    assert.ok(ok);
    const back = parseOpenDrive(serializeOpenDrive(doc)).document;
    const road2 = back.roads.find((r) => r.id === road.id)!;
    assert.equal(widthOf(road2, outer, sStart + 60), null, '渐变终点之后不应重新出现');
    assert.ok(widthOf(road2, outer, sStart - 10) !== null, '渐变之前应存在');
  });

  test('三次系数写进 XML，未被压平成常量', () => {
    const { doc, ok } = tapered();
    assert.ok(ok);
    const xml = serializeOpenDrive(doc);
    const widths = xml.match(/<width[^>]*\/>/g) ?? [];
    const cubic = widths.filter((w) => /c="(?!0")[^"]*"/.test(w) && /d="(?!0")[^"]*"/.test(w));
    assert.ok(cubic.length > 0, '渐变段的 <width> 应带非零 c、d 系数');
  });
});
