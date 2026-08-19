import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import {
  crsFromGeoReference,
  gaussKruger,
  localTmerc,
  Projector,
  utm,
  utmZoneOf,
} from '../src/geo/projection.ts';
import {
  bd09ToWgs84,
  gcj02ToWgs84,
  outOfChina,
  wgs84ToBd09,
  wgs84ToGcj02,
} from '../src/geo/gcj02.ts';
import {
  groundResolution,
  lonLatToTileXY,
  tileCorners,
  tileUrl,
  tileXYToLonLat,
  tilesInBounds,
  zoomForResolution,
  TILE_SOURCES,
} from '../src/geo/tiles.ts';
import { reprojectDocument, snapshotEndpoints } from '../src/geo/reproject.ts';
import { fitAlignment } from '../src/core/geometry/alignment.ts';
import { evaluateGeometry } from '../src/core/geometry/evaluate.ts';
import { createEmptyDocument } from '../src/core/model/document.ts';
import { buildRoad, DEFAULT_TEMPLATE } from '../src/editor/roadFactory.ts';
import { validateDocument, summarizeIssues } from '../src/core/model/validate.ts';
import type { AlignmentRecord } from '../src/editor/store.ts';

const BEIJING = { lon: 116.397428, lat: 39.90923 };

describe('投影', () => {
  test('局部 TM 在原点处尺度为 1', () => {
    const p = new Projector(localTmerc(BEIJING));
    const origin = p.project(BEIJING);
    assert.ok(Math.abs(origin.x) < 1e-6, `原点 x=${origin.x}`);
    assert.ok(Math.abs(origin.y) < 1e-6, `原点 y=${origin.y}`);
    assert.ok(Math.abs(p.scaleFactorAt(BEIJING) - 1) < 1e-4);
  });

  test('project / unproject 互逆', () => {
    const p = new Projector(localTmerc(BEIJING));
    for (const d of [0, 0.001, 0.05, 0.3]) {
      const ll = { lon: BEIJING.lon + d, lat: BEIJING.lat + d * 0.7 };
      const back = p.unproject(p.project(ll));
      assert.ok(Math.abs(back.lon - ll.lon) < 1e-9, `lon 往返差 ${Math.abs(back.lon - ll.lon)}`);
      assert.ok(Math.abs(back.lat - ll.lat) < 1e-9);
    }
  });

  test('局部 TM 下量得的距离等于真实距离', () => {
    const p = new Projector(localTmerc(BEIJING));
    // 沿子午线 1000 m 对应的纬度增量
    const dLat = 1000 / 111132.95;
    const a = p.project(BEIJING);
    const b = p.project({ lon: BEIJING.lon, lat: BEIJING.lat + dLat });
    const measured = Math.hypot(b.x - a.x, b.y - a.y);
    // 允许 0.3% 误差（子午线弧长用的是常数近似）
    assert.ok(Math.abs(measured - 1000) < 3, `实测 ${measured} m`);
  });

  test('Web Mercator 在中纬度存在显著尺度膨胀（瓦片需 warp 的依据）', () => {
    // Web Mercator 尺度因子 = 1/cos(φ)
    const factor = 1 / Math.cos((BEIJING.lat * Math.PI) / 180);
    assert.ok(factor > 1.29 && factor < 1.31, `北京处膨胀 ${factor}`);
    // 若直接把米当 Web Mercator 米，1 km 会画成 1.3 km——这正是必须反投影的原因
    assert.ok(Math.abs(factor - 1) > 0.25);
  });

  test('UTM 带号计算', () => {
    assert.equal(utmZoneOf(116.4), 50);
    assert.equal(utmZoneOf(-122.4), 10);
    assert.equal(utmZoneOf(0), 31);
    assert.equal(utmZoneOf(179.9), 60);
    assert.equal(utmZoneOf(-180), 1);
  });

  test('UTM 东坐标落在合理区间', () => {
    const p = new Projector(utm(BEIJING));
    const xy = p.project(BEIJING);
    // UTM 中央经线处东坐标为 500000，向东递增
    assert.ok(xy.x > 1e5 && xy.x < 9e5, `东坐标 ${xy.x}`);
    assert.ok(xy.y > 4e6 && xy.y < 4.6e6, `北坐标 ${xy.y}`);
    const back = p.unproject(xy);
    assert.ok(Math.abs(back.lon - BEIJING.lon) < 1e-9);
  });

  test('高斯克吕格 3° 带中央经线正确', () => {
    const crs = gaussKruger(BEIJING, 3);
    // 116.397 → 最近的 3° 倍数为 117
    assert.ok(crs.proj.includes('+lon_0=117'), crs.proj);
    const p = new Projector(crs);
    const xy = p.project(BEIJING);
    // 默认 x_0=500000
    assert.ok(Math.abs(xy.x - 500000) < 60000, `东坐标 ${xy.x}`);
  });

  test('从 geoReference 反推坐标系', () => {
    const tm = crsFromGeoReference(
      '+proj=tmerc +lat_0=39.90923 +lon_0=116.397428 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m',
    );
    assert.equal(tm.kind, 'local-tmerc');
    assert.ok(Math.abs(tm.origin.lat - 39.90923) < 1e-9);
    assert.ok(Math.abs(tm.origin.lon - 116.397428) < 1e-9);

    const u = crsFromGeoReference('+proj=utm +zone=50 +datum=WGS84 +units=m +no_defs');
    assert.equal(u.kind, 'utm');
    assert.ok(u.label.includes('50'));

    const other = crsFromGeoReference('+proj=merc +datum=WGS84');
    assert.equal(other.kind, 'custom');
  });
});

describe('GCJ-02 纠偏', () => {
  test('中国境内偏移量在预期量级', () => {
    const g = wgs84ToGcj02(BEIJING);
    const dLon = g.lon - BEIJING.lon;
    const dLat = g.lat - BEIJING.lat;
    // 典型偏移几百米，换算成度约 1e-3 量级
    const meters = Math.hypot(dLon * 85000, dLat * 111000);
    assert.ok(meters > 100 && meters < 1000, `偏移 ${meters} m`);
  });

  test('境外不做偏移', () => {
    const ny = { lon: -74.006, lat: 40.7128 };
    assert.ok(outOfChina(ny.lon, ny.lat));
    const g = wgs84ToGcj02(ny);
    assert.equal(g.lon, ny.lon);
    assert.equal(g.lat, ny.lat);
  });

  test('GCJ-02 往返精度优于 1 mm', () => {
    for (const p of [
      BEIJING,
      { lon: 121.4737, lat: 31.2304 },
      { lon: 113.2644, lat: 23.1291 },
      { lon: 87.6168, lat: 43.8256 },
    ]) {
      const back = gcj02ToWgs84(wgs84ToGcj02(p));
      const errMeters = Math.hypot(
        (back.lon - p.lon) * 85000,
        (back.lat - p.lat) * 111000,
      );
      assert.ok(errMeters < 1e-3, `往返误差 ${errMeters * 1000} mm @ ${p.lat},${p.lon}`);
    }
  });

  test('BD-09 往返精度优于 1 cm', () => {
    for (const p of [BEIJING, { lon: 121.4737, lat: 31.2304 }]) {
      const back = bd09ToWgs84(wgs84ToBd09(p));
      const errMeters = Math.hypot((back.lon - p.lon) * 85000, (back.lat - p.lat) * 111000);
      assert.ok(errMeters < 0.01, `往返误差 ${errMeters} m`);
    }
  });

  test('BD-09 相对 GCJ-02 有额外偏移', () => {
    const g = wgs84ToGcj02(BEIJING);
    const b = wgs84ToBd09(BEIJING);
    assert.ok(Math.hypot(b.lon - g.lon, b.lat - g.lat) > 1e-4);
  });
});

describe('瓦片数学', () => {
  test('经纬度与瓦片坐标互逆', () => {
    for (const z of [2, 10, 16, 19]) {
      const t = lonLatToTileXY(BEIJING, z);
      const back = tileXYToLonLat(t.x, t.y, z);
      assert.ok(Math.abs(back.lon - BEIJING.lon) < 1e-9, `z=${z} lon`);
      assert.ok(Math.abs(back.lat - BEIJING.lat) < 1e-9, `z=${z} lat`);
    }
  });

  test('z=0 时整个世界为一块瓦片', () => {
    const t = lonLatToTileXY({ lon: 0, lat: 0 }, 0);
    assert.ok(t.x > 0.49 && t.x < 0.51);
    assert.ok(t.y > 0.49 && t.y < 0.51);
  });

  test('瓦片四角顺序为左上→右上→右下→左下', () => {
    const [tl, tr, br, bl] = tileCorners({ x: 100, y: 50, z: 8 });
    assert.ok(tr.lon > tl.lon, '右上经度应大于左上');
    assert.ok(bl.lat < tl.lat, '左下纬度应小于左上');
    assert.ok(Math.abs(tl.lat - tr.lat) < 1e-12, '上边两角纬度相同');
    assert.ok(Math.abs(tl.lon - bl.lon) < 1e-12, '左边两角经度相同');
    assert.ok(br.lon > bl.lon && br.lat < tr.lat);
  });

  test('地面分辨率符合已知值', () => {
    // 赤道 z=0 时约 156543 m/px
    assert.ok(Math.abs(groundResolution(0, 0) - 156543.03) < 1);
    // 每升一级减半
    assert.ok(Math.abs(groundResolution(0, 1) - groundResolution(0, 0) / 2) < 1e-6);
    // 纬度 60° 处为赤道的一半
    assert.ok(Math.abs(groundResolution(60, 10) - groundResolution(0, 10) / 2) < 1e-6);
  });

  test('层级选择与分辨率自洽', () => {
    for (const mpp of [0.1, 0.5, 2, 20]) {
      const z = zoomForResolution(mpp, BEIJING.lat, 22);
      const actual = groundResolution(BEIJING.lat, z);
      // 取整后允许 2 倍以内偏差
      assert.ok(actual / mpp > 0.4 && actual / mpp < 2.5, `mpp=${mpp} z=${z} 实际=${actual}`);
    }
  });

  test('瓦片列举受上限保护', () => {
    const wide = tilesInBounds({ minLon: -180, maxLon: 180, minLat: -80, maxLat: 80 }, 12, 400);
    assert.equal(wide.length, 0, '超限时应返回空数组而非海量请求');

    const small = tilesInBounds(
      { minLon: 116.39, maxLon: 116.41, minLat: 39.9, maxLat: 39.92 },
      16,
    );
    assert.ok(small.length > 0 && small.length < 100, `瓦片数 ${small.length}`);
    for (const t of small) assert.equal(t.z, 16);
  });

  test('URL 模板展开', () => {
    const esri = TILE_SOURCES.find((s) => s.id === 'esri-imagery')!;
    const url = tileUrl(esri, { x: 5, y: 6, z: 7 });
    assert.ok(url.includes('/7/6/5'), url);
    assert.ok(!url.includes('{'), '仍有未替换的占位符');

    const osm = TILE_SOURCES.find((s) => s.id === 'osm')!;
    const u2 = tileUrl(osm, { x: 1, y: 2, z: 3 });
    assert.ok(/https:\/\/[abc]\.tile\.openstreetmap\.org\/3\/1\/2\.png/.test(u2), u2);

    const tdt = TILE_SOURCES.find((s) => s.id === 'tianditu-img')!;
    const u3 = tileUrl(tdt, { x: 1, y: 2, z: 3 }, 'MYKEY');
    assert.ok(u3.includes('tk=MYKEY'), u3);
  });

  test('内置影像源均声明署名', () => {
    for (const s of TILE_SOURCES) {
      assert.ok(s.attribution.length > 0, `${s.id} 缺少 attribution`);
      assert.ok(s.maxZoom >= 15, `${s.id} maxZoom 过低`);
    }
  });
});

describe('坐标系重投影', () => {
  test('切换坐标系后地理位置不变', () => {
    const from = localTmerc(BEIJING);
    const to = utm(BEIJING);
    const pFrom = new Projector(from);
    const pTo = new Projector(to);

    const doc = createEmptyDocument(from.proj);
    const pts = [
      { x: 0, y: 0 },
      { x: 220, y: 40 },
      { x: 380, y: 260 },
    ];
    const fit = fitAlignment(pts, { mode: 'spiral', radius: 60, spiralLength: 25 });
    doc.roads.push(buildRoad('1', fit.geometries, DEFAULT_TEMPLATE));

    // 记录变换前各端点的经纬度
    const before = snapshotEndpoints(doc).map((s) => ({
      id: s.id,
      startLL: pFrom.unproject(s.start),
      endLL: pFrom.unproject(s.end),
    }));

    const alignments = new Map<string, AlignmentRecord>([
      ['1', { points: pts.map((p) => ({ ...p })), fit: { mode: 'spiral', radius: 60, spiralLength: 25 } }],
    ]);
    const result = reprojectDocument(doc, alignments, from, to);
    assert.equal(result.refittedRoads, 1, '应走精确重拟合路径');

    const after = snapshotEndpoints(doc);
    for (const b of before) {
      const a = after.find((x) => x.id === b.id)!;
      const startLL = pTo.unproject(a.start);
      const endLL = pTo.unproject(a.end);
      const errStart = Math.hypot(
        (startLL.lon - b.startLL.lon) * 85000,
        (startLL.lat - b.startLL.lat) * 111000,
      );
      const errEnd = Math.hypot(
        (endLL.lon - b.endLL.lon) * 85000,
        (endLL.lat - b.endLL.lat) * 111000,
      );
      assert.ok(errStart < 0.01, `起点地理偏差 ${errStart} m`);
      assert.ok(errEnd < 0.01, `终点地理偏差 ${errEnd} m`);
    }

    // 重投影后仍须通过校验
    assert.equal(summarizeIssues(validateDocument(doc)).errors, 0);
  });

  test('无控制点时走近似变换且几何链保持连续', () => {
    const from = localTmerc(BEIJING);
    const to = utm(BEIJING);
    const doc = createEmptyDocument(from.proj);
    const fit = fitAlignment(
      [{ x: 0, y: 0 }, { x: 200, y: 30 }, { x: 340, y: 210 }],
      { mode: 'spiral', radius: 60, spiralLength: 25 },
    );
    doc.roads.push(buildRoad('1', fit.geometries, DEFAULT_TEMPLATE));

    const result = reprojectDocument(doc, new Map(), from, to);
    assert.equal(result.transformedRoads, 1);
    // 局部 TM 与 UTM 在同一带内尺度差极小
    assert.ok(result.maxScaleDeviation < 0.002, `尺度偏差 ${result.maxScaleDeviation}`);

    // 链连续性：近似变换后接缝应仍在毫米级
    const road = doc.roads[0]!;
    let maxGap = 0;
    for (let i = 0; i + 1 < road.planView.length; i++) {
      const a = road.planView[i]!;
      const b = road.planView[i + 1]!;
      const end = evaluateGeometry(a, a.length);
      maxGap = Math.max(maxGap, Math.hypot(end.x - b.x, end.y - b.y));
    }
    assert.ok(maxGap < 0.01, `接缝 ${maxGap} m`);

    // s 与 length 自洽
    const last = road.planView[road.planView.length - 1]!;
    assert.ok(Math.abs(road.length - (last.s + last.length)) < 1e-9);
  });
});
