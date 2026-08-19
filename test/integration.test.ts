/**
 * 端到端集成测试：绘制 → 建路 → 导出 → 导入 → 重投影 → 工程文件往返。
 *
 * 这一层验证的是各模块拼接后的整体自洽性，而非单点算法正确性。
 */

import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { DEFAULT_FIT } from '../src/core/geometry/alignment.ts';
import { createEmptyDocument, nextNumericId } from '../src/core/model/document.ts';
import { referencePoint } from '../src/core/model/reference.ts';
import { crossSectionAt } from '../src/core/model/lanes.ts';
import { summarizeIssues, validateDocument } from '../src/core/model/validate.ts';
import { parseOpenDrive } from '../src/core/xml/parse.ts';
import { serializeOpenDrive } from '../src/core/xml/serialize.ts';
import { buildRoadFromPoints, DEFAULT_TEMPLATE } from '../src/editor/roadFactory.ts';
import { parseProject, serializeProject } from '../src/editor/project.ts';
import { localTmerc, Projector, utm } from '../src/geo/projection.ts';
import type { AlignmentRecord } from '../src/editor/store.ts';
import type { Vec2 } from '../src/core/math/vec.ts';
import { buildRoadRenderData } from '../src/editor/renderData.ts';
import { pickLane, pointInPolygon, snapToRoadEnds, snapToRoadEndsAll } from '../src/editor/picking.ts';

const ORIGIN = { lon: 116.397428, lat: 39.90923 };
const CRS = localTmerc(ORIGIN);

/** 模拟用户在影像上点出的一条路 */
const TRACE: Vec2[] = [
  { x: 0, y: 0 },
  { x: 120, y: 25 },
  { x: 260, y: 140 },
  { x: 420, y: 175 },
];

describe('绘制到导出全链路', () => {
  test('控制点 → 道路 → xodr → 再导入，几何逐点一致', () => {
    const doc = createEmptyDocument(CRS.proj);
    const built = buildRoadFromPoints('1', TRACE, DEFAULT_FIT, {
      ...DEFAULT_TEMPLATE,
      leftLanes: 2,
      rightLanes: 2,
      sidewalk: true,
    });
    assert.ok(built !== null, '应成功建路');
    doc.roads.push(built!.road);

    // 导出前无校验错误
    assert.equal(summarizeIssues(validateDocument(doc)).errors, 0);

    const xml = serializeOpenDrive(doc);
    assert.ok(xml.startsWith('<?xml'), '应为合法 XML 头');
    assert.ok(xml.includes('<OpenDRIVE>'), '应含根元素');
    assert.ok(xml.includes('geoReference'), '应写入坐标系');

    const reparsed = parseOpenDrive(xml);
    assert.deepEqual(reparsed.warnings, [], '不应有解析警告');
    assert.equal(reparsed.document.roads.length, 1);

    // 沿全程逐点比对参考线与车道边界
    const a = doc.roads[0]!;
    const b = reparsed.document.roads[0]!;
    for (let i = 0; i <= 20; i++) {
      const s = (a.length * i) / 20;
      const pa = referencePoint(a, s);
      const pb = referencePoint(b, s);
      assert.ok(
        Math.hypot(pa.x - pb.x, pa.y - pb.y) < 1e-9,
        `s=${s.toFixed(2)} 参考线偏差`,
      );

      const ca = crossSectionAt(a, s, pa);
      const cb = crossSectionAt(b, s, pb);
      assert.equal(cb.left.length, ca.left.length);
      assert.equal(cb.right.length, ca.right.length);
      for (let k = 0; k < ca.right.length; k++) {
        assert.ok(Math.abs(ca.right[k]!.tOuter - cb.right[k]!.tOuter) < 1e-9);
      }
    }
  });

  test('导出的 xodr 可被再次导出且字节一致（幂等）', () => {
    const doc = createEmptyDocument(CRS.proj);
    doc.roads.push(buildRoadFromPoints('1', TRACE, DEFAULT_FIT, DEFAULT_TEMPLATE)!.road);
    const xml1 = serializeOpenDrive(doc);
    const xml2 = serializeOpenDrive(parseOpenDrive(xml1).document);
    assert.equal(xml1, xml2);
  });

  test('多条道路 id 递增且互不干扰', () => {
    const doc = createEmptyDocument(CRS.proj);
    for (let i = 0; i < 4; i++) {
      const id = nextNumericId(doc.roads);
      const pts: Vec2[] = [
        { x: i * 300, y: 0 },
        { x: i * 300 + 140, y: 40 },
        { x: i * 300 + 260, y: 30 },
      ];
      const built = buildRoadFromPoints(id, pts, DEFAULT_FIT, DEFAULT_TEMPLATE);
      assert.ok(built !== null);
      doc.roads.push(built!.road);
    }

    assert.deepEqual(doc.roads.map((r) => r.id), ['1', '2', '3', '4']);
    assert.equal(summarizeIssues(validateDocument(doc)).errors, 0);

    const back = parseOpenDrive(serializeOpenDrive(doc)).document;
    assert.deepEqual(back.roads.map((r) => r.id), ['1', '2', '3', '4']);
    for (let i = 0; i < 4; i++) {
      assert.ok(Math.abs(back.roads[i]!.length - doc.roads[i]!.length) < 1e-9);
    }
  });

  test('空文档导出导入不报错', () => {
    const doc = createEmptyDocument(CRS.proj);
    const back = parseOpenDrive(serializeOpenDrive(doc));
    assert.equal(back.document.roads.length, 0);
    assert.equal(back.document.header.geoReference, CRS.proj);
  });
});

describe('工程文件往返', () => {
  test('控制点与坐标系随工程文件保留', () => {
    const doc = createEmptyDocument(CRS.proj);
    const built = buildRoadFromPoints('1', TRACE, DEFAULT_FIT, DEFAULT_TEMPLATE);
    doc.roads.push(built!.road);

    const alignments = new Map<string, AlignmentRecord>([
      ['1', { points: TRACE.map((p) => ({ ...p })), fit: { ...DEFAULT_FIT } }],
    ]);

    const text = serializeProject(doc, alignments, CRS, DEFAULT_TEMPLATE, {
      sourceId: 'esri-imagery',
      opacity: 0.8,
      zoomBias: 1,
    });

    const snap = parseProject(text);
    assert.equal(snap.document.roads.length, 1);
    assert.equal(snap.crs.proj, CRS.proj);
    assert.equal(snap.tile?.sourceId, 'esri-imagery');
    assert.ok(Math.abs((snap.tile?.opacity ?? 0) - 0.8) < 1e-12);

    const rec = snap.alignments.get('1');
    assert.ok(rec, '控制点应被保留');
    assert.equal(rec!.points.length, TRACE.length);
    for (let i = 0; i < TRACE.length; i++) {
      assert.ok(Math.abs(rec!.points[i]!.x - TRACE[i]!.x) < 1e-9);
      assert.ok(Math.abs(rec!.points[i]!.y - TRACE[i]!.y) < 1e-9);
    }
  });

  test('拒绝非本工程格式', () => {
    assert.throws(() => parseProject('{"format":"something-else"}'), /不是本编辑器/);
    assert.throws(() => parseProject('not json'), /不是有效 JSON/);
    assert.throws(
      () => parseProject('{"format":"opendrive-editor-project","version":1}'),
      /缺少路网数据/,
    );
  });

  test('缺少坐标系时从 geoReference 反推', () => {
    const doc = createEmptyDocument(CRS.proj);
    doc.roads.push(buildRoadFromPoints('1', TRACE, DEFAULT_FIT, DEFAULT_TEMPLATE)!.road);
    const full = JSON.parse(serializeProject(doc, new Map(), CRS, DEFAULT_TEMPLATE));
    delete full.crs;

    const snap = parseProject(JSON.stringify(full));
    assert.ok(snap.warnings.some((w) => w.includes('反推')));
    // 反推出的坐标系应与原始等价
    assert.ok(Math.abs(snap.crs.origin.lat - ORIGIN.lat) < 1e-6);
    assert.ok(Math.abs(snap.crs.origin.lon - ORIGIN.lon) < 1e-6);
  });

  test('控制点数不足的记录被忽略', () => {
    const doc = createEmptyDocument(CRS.proj);
    doc.roads.push(buildRoadFromPoints('1', TRACE, DEFAULT_FIT, DEFAULT_TEMPLATE)!.road);
    const full = JSON.parse(serializeProject(doc, new Map(), CRS, DEFAULT_TEMPLATE));
    full.alignments = { '1': { points: [{ x: 0, y: 0 }], fit: DEFAULT_FIT } };

    const snap = parseProject(JSON.stringify(full));
    assert.equal(snap.alignments.size, 0, '单点记录应被丢弃');
  });
});

describe('渲染数据与拾取', () => {
  test('渲染数据覆盖全部车道且包围盒有效', () => {
    const built = buildRoadFromPoints('1', TRACE, DEFAULT_FIT, {
      ...DEFAULT_TEMPLATE,
      leftLanes: 2,
      rightLanes: 2,
    });
    const data = buildRoadRenderData(built!.road);

    assert.ok(data.referenceLine.length > 2, '参考线应被采样');
    assert.equal(data.lanePolygons.length, 4, '应有 4 条车道多边形');
    assert.ok(data.leftEdge.length > 2);
    assert.ok(data.rightEdge.length > 2);
    assert.ok(data.box.maxX > data.box.minX);
    assert.ok(data.box.maxY > data.box.minY);

    // 每条车道多边形应闭合可用（顶点数为内外边界之和）
    for (const poly of data.lanePolygons) {
      assert.ok(poly.outline.length >= 6, `车道 ${poly.laneId} 顶点过少`);
      assert.ok(poly.centerline.length >= 2);
    }
  });

  test('曲线段采样比直线段密（自适应加密生效）', () => {
    const straight = buildRoadRenderData(
      buildRoadFromPoints('1', [{ x: 0, y: 0 }, { x: 400, y: 0 }], DEFAULT_FIT, DEFAULT_TEMPLATE)!.road,
    );
    const curved = buildRoadRenderData(
      buildRoadFromPoints('2', TRACE, DEFAULT_FIT, DEFAULT_TEMPLATE)!.road,
    );
    // 长度相近但曲线段顶点应显著更多
    assert.ok(
      curved.referenceLine.length > straight.referenceLine.length,
      `曲线 ${curved.referenceLine.length} 应多于直线 ${straight.referenceLine.length}`,
    );
  });

  test('点在多边形内判定', () => {
    const square = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    assert.ok(pointInPolygon({ x: 5, y: 5 }, square));
    assert.ok(!pointInPolygon({ x: 15, y: 5 }, square));
    assert.ok(!pointInPolygon({ x: -1, y: 5 }, square));
    assert.ok(!pointInPolygon({ x: 5, y: 20 }, square));
  });

  test('拾取车道命中路面内的点', () => {
    const built = buildRoadFromPoints('1', [{ x: 0, y: 0 }, { x: 200, y: 0 }], DEFAULT_FIT, {
      ...DEFAULT_TEMPLATE,
      leftLanes: 1,
      rightLanes: 1,
      laneWidth: 3.5,
    });
    const road = built!.road;
    const data = [buildRoadRenderData(road)];

    // 右侧车道中心：t = -1.75
    const ref = referencePoint(road, 100);
    const hit = pickLane({ x: ref.x, y: ref.y - 1.75 }, data);
    assert.ok(hit !== null, '应命中车道');
    assert.equal(hit!.selection.kind, 'lane');
    if (hit!.selection.kind === 'lane') {
      assert.equal(hit!.selection.laneId, -1);
    }

    // 路面之外不应命中
    assert.equal(pickLane({ x: ref.x, y: ref.y - 50 }, data), null);
  });

  test('端点吸附返回正确航向', () => {
    const doc = createEmptyDocument(CRS.proj);
    const built = buildRoadFromPoints('1', [{ x: 0, y: 0 }, { x: 100, y: 0 }], DEFAULT_FIT, DEFAULT_TEMPLATE);
    doc.roads.push(built!.road);

    // 靠近终点
    const snap = snapToRoadEnds({ x: 99, y: 1 }, doc, 5);
    assert.ok(snap !== null);
    assert.equal(snap!.end, 'end');
    assert.equal(snap!.roadId, '1');
    assert.ok(Math.abs(snap!.point.x - 100) < 1e-9);
    assert.ok(Math.abs(snap!.hdg) < 1e-9, '直线航向应为 0');

    // 超出容差不吸附
    assert.equal(snapToRoadEnds({ x: 50, y: 50 }, doc, 5), null);
    // 排除自身
    assert.equal(snapToRoadEnds({ x: 99, y: 1 }, doc, 5, '1'), null);
  });
});

describe('重叠端点消歧', () => {
  /** 三条路的终点挤在半米内，模拟路口处参考线重合的实际情形 */
  function crowded() {
    const doc = createEmptyDocument(CRS.proj);
    const ends: Array<[string, Vec2]> = [
      ['1', { x: 200, y: 0 }],
      ['2', { x: 200.3, y: 0.2 }],
      ['3', { x: 200.1, y: -0.3 }],
    ];
    for (const [id, end] of ends) {
      const built = buildRoadFromPoints(id, [{ x: 100, y: 0 }, end], DEFAULT_FIT, DEFAULT_TEMPLATE);
      doc.roads.push(built!.road);
    }
    return doc;
  }

  test('容差内的全部端点都返回', () => {
    const doc = crowded();
    const all = snapToRoadEndsAll({ x: 200.1, y: 0 }, doc, 2);
    const ends = all.filter((s) => s.end === 'end').map((s) => s.roadId).sort();
    assert.deepEqual(ends, ['1', '2', '3'], '三个重叠终点应全部列出');
  });

  test('按距离升序，首个与 snapToRoadEnds 一致', () => {
    const doc = crowded();
    const probe = { x: 200.28, y: 0.18 };
    const all = snapToRoadEndsAll(probe, doc, 2);
    for (let i = 1; i < all.length; i++) {
      assert.ok(all[i]!.distance >= all[i - 1]!.distance, '距离必须单调不减');
    }
    const single = snapToRoadEnds(probe, doc, 2);
    assert.equal(all[0]!.roadId, single!.roadId);
    assert.equal(all[0]!.end, single!.end);
  });

  test('同一位置反复查询顺序稳定', () => {
    const doc = crowded();
    const key = (s: ReturnType<typeof snapToRoadEndsAll>) =>
      s.map((t) => `${t.roadId}@${t.end}`).join(',');
    const a = key(snapToRoadEndsAll({ x: 200.1, y: 0 }, doc, 2));
    const b = key(snapToRoadEndsAll({ x: 200.1, y: 0 }, doc, 2));
    assert.equal(a, b, '顺序不稳定会让 Tab 轮换下标指向不同端点');
  });

  test('容差之外返回空数组', () => {
    const doc = crowded();
    assert.deepEqual(snapToRoadEndsAll({ x: 150, y: 40 }, doc, 2), []);
  });

  test('零几何道路不参与', () => {
    const doc = crowded();
    doc.roads.push({ ...doc.roads[0]!, id: '9', planView: [] });
    const all = snapToRoadEndsAll({ x: 200.1, y: 0 }, doc, 2);
    assert.ok(!all.some((s) => s.roadId === '9'), '无 planView 的道路不应产生端点');
  });
});

describe('坐标系切换端到端', () => {
  test('局部 TM → UTM 后地理位置与校验均无恙', async () => {
    const from = CRS;
    const to = utm(ORIGIN);
    const doc = createEmptyDocument(from.proj);
    const built = buildRoadFromPoints('1', TRACE, DEFAULT_FIT, {
      ...DEFAULT_TEMPLATE,
      leftLanes: 1,
      rightLanes: 2,
    });
    doc.roads.push(built!.road);

    const pFrom = new Projector(from);
    const pTo = new Projector(to);
    // 记录变换前中点的经纬度
    const midBefore = referencePoint(doc.roads[0]!, doc.roads[0]!.length / 2);
    const llBefore = pFrom.unproject({ x: midBefore.x, y: midBefore.y });

    const alignments = new Map<string, AlignmentRecord>([
      ['1', { points: TRACE.map((p) => ({ ...p })), fit: { ...DEFAULT_FIT } }],
    ]);

    // 动态引入以避免测试文件顶层依赖过多
    const { reprojectDocument } = await import('../src/geo/reproject.ts');
    reprojectDocument(doc, alignments, from, to);
    doc.header.geoReference = to.proj;

    const midAfter = referencePoint(doc.roads[0]!, doc.roads[0]!.length / 2);
    const llAfter = pTo.unproject({ x: midAfter.x, y: midAfter.y });

    const errMeters = Math.hypot(
      (llAfter.lon - llBefore.lon) * 85000,
      (llAfter.lat - llBefore.lat) * 111000,
    );
    assert.ok(errMeters < 0.05, `中点地理偏差 ${errMeters} m`);
    assert.equal(summarizeIssues(validateDocument(doc)).errors, 0);

    // 切换后仍可正常导出导入
    const back = parseOpenDrive(serializeOpenDrive(doc));
    assert.equal(back.document.header.geoReference, to.proj);
    assert.deepEqual(back.warnings, []);
  });
});
