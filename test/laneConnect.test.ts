/**
 * 车道级手工连接测试。
 *
 * 重点不在几何精度（那部分由 junction.test.ts 覆盖），而在以车道对为唯一事实
 * 来源的那套增删语义：合并、拆分、删中间一条、id 复用、往返反读一致。这些正是
 * 「整体重建」这个做法最容易出错的地方。
 */

import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { DEFAULT_FIT } from '../src/core/geometry/alignment.ts';
import type { Vec2 } from '../src/core/math/vec.ts';
import { createEmptyDocument, type OdrDocument } from '../src/core/model/document.ts';
import { createJunction } from '../src/core/model/junction.ts';
import { referencePoint } from '../src/core/model/reference.ts';
import type { ContactPoint, Road } from '../src/core/model/road.ts';
import { summarizeIssues, validateDocument } from '../src/core/model/validate.ts';
import { parseOpenDrive } from '../src/core/xml/parse.ts';
import { serializeOpenDrive } from '../src/core/xml/serialize.ts';
import { buildRoadFromPoints, DEFAULT_TEMPLATE } from '../src/editor/roadFactory.ts';
import {
  addLanePair,
  completeJunction,
  laneHandlesNear,
  readLanePairs,
  rebuildJunction,
  removeLanePair,
  sameLaneRef,
  type LanePairRef,
  type LaneRef,
} from '../src/editor/laneConnect.ts';

const CRS =
  '+proj=tmerc +lat_0=39.9 +lon_0=116.4 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs';

const JUNCTION_RADIUS = 14;
const TEMPLATE = { ...DEFAULT_TEMPLATE };

/** 朝 outward 伸出的路臂，end 端止于路口边缘 */
function makeArm(id: string, outward: number, lanes: number): Road {
  const cos = Math.cos(outward);
  const sin = Math.sin(outward);
  const near = { x: cos * JUNCTION_RADIUS, y: sin * JUNCTION_RADIUS };
  const far = { x: cos * (JUNCTION_RADIUS + 80), y: sin * (JUNCTION_RADIUS + 80) };
  const built = buildRoadFromPoints(id, [far, near], DEFAULT_FIT, {
    ...TEMPLATE,
    leftLanes: lanes,
    rightLanes: lanes,
  });
  assert.ok(built !== null, `路臂 ${id} 生成失败`);
  return built!.road;
}

/** 四臂（东北西南）空路口，未建立任何车道连接 */
function makeDoc(laneCounts = [3, 3, 3, 3]): { doc: OdrDocument; jid: string } {
  const doc = createEmptyDocument(CRS);
  const outwards = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
  outwards.forEach((out, i) => {
    doc.roads.push(makeArm(String(i + 1), out, laneCounts[i] ?? 3));
  });
  doc.junctions.push(createJunction('1', '交叉口 1'));
  return { doc, jid: '1' };
}

/** 简写：R@end.lane */
function ref(roadId: string, end: ContactPoint, laneId: number): LaneRef {
  return { roadId, end, laneId };
}

function errorsOf(doc: OdrDocument): string {
  const issues = validateDocument(doc);
  return issues
    .filter((i) => i.level === 'error')
    .map((i) => i.message)
    .join(' | ');
}

function connectorsOf(doc: OdrDocument, jid: string): Road[] {
  return doc.roads.filter((r) => r.junction === jid);
}

/** 某条连接道路的车道 id 列表（右侧，由内向外） */
function laneIdsOf(road: Road): number[] {
  return (road.laneSections[0]?.right ?? []).map((l) => l.id);
}

function hasPair(pairs: readonly LanePairRef[], p: LanePairRef): boolean {
  return pairs.some((x) => sameLaneRef(x.from, p.from) && sameLaneRef(x.to, p.to));
}

describe('车道连接的增删语义', () => {
  test('单条车道对生成一条单车道连接道路', () => {
    const { doc, jid } = makeDoc();
    // 东臂内侧车道 → 西臂内侧车道：直行
    const p: LanePairRef = { from: ref('1', 'end', -1), to: ref('3', 'end', 1) };
    const res = addLanePair(doc, jid, p, TEMPLATE);
    assert.ok(res.ok, res.error ?? '');
    assert.equal(res.roads, 1, '应只生成一条连接道路');

    const roads = connectorsOf(doc, jid);
    assert.equal(roads.length, 1);
    assert.deepEqual(laneIdsOf(roads[0]!), [-1], '连接道路应只有一条车道');
    assert.equal(doc.junctions[0]!.connections.length, 1);
    assert.equal(errorsOf(doc), '', errorsOf(doc));
  });

  test('相邻车道合并成一条多车道连接道路', () => {
    const { doc, jid } = makeDoc();
    for (const n of [1, 2, 3]) {
      const res = addLanePair(
        doc,
        jid,
        { from: ref('1', 'end', -n), to: ref('3', 'end', n) },
        TEMPLATE,
      );
      assert.ok(res.ok, res.error ?? '');
    }

    const roads = connectorsOf(doc, jid);
    assert.equal(roads.length, 1, '三条相邻车道应合并为一条连接道路');
    assert.deepEqual(laneIdsOf(roads[0]!), [-1, -2, -3], '车道 id 应由内向外连续');

    const conn = doc.junctions[0]!.connections[0]!;
    assert.equal(conn.laneLinks.length, 3);
    // laneLink 应把进口车道按内外顺序映到连接道路的 -1/-2/-3
    assert.deepEqual(
      conn.laneLinks.map((l) => [l.from, l.to]),
      [
        [-1, -1],
        [-2, -2],
        [-3, -3],
      ],
    );
    assert.equal(errorsOf(doc), '', errorsOf(doc));
  });

  /**
   * 连续性要求两端同时递进一格。进口 −1,−3（缺 −2）若并进一条道路，
   * 连接道路只会铺 −1,−2 两条车道，−3 那一路就悄悄接到了错的车道上。
   */
  test('进口车道不连续时拆成两条连接道路', () => {
    const { doc, jid } = makeDoc();
    for (const n of [1, 3]) {
      assert.ok(
        addLanePair(doc, jid, { from: ref('1', 'end', -n), to: ref('3', 'end', n) }, TEMPLATE).ok,
      );
    }

    const roads = connectorsOf(doc, jid);
    assert.equal(roads.length, 2, '断开的车道对不能合并');
    for (const r of roads) assert.deepEqual(laneIdsOf(r), [-1], '各自为单车道');
    assert.equal(errorsOf(doc), '', errorsOf(doc));
  });

  test('出口车道不连续时同样拆开', () => {
    const { doc, jid } = makeDoc();
    // 进口 −1,−2 连续，出口 1,3 断开
    assert.ok(addLanePair(doc, jid, { from: ref('1', 'end', -1), to: ref('3', 'end', 1) }, TEMPLATE).ok);
    assert.ok(addLanePair(doc, jid, { from: ref('1', 'end', -2), to: ref('3', 'end', 3) }, TEMPLATE).ok);

    assert.equal(connectorsOf(doc, jid).length, 2, '出口侧断开也必须拆');
    assert.equal(errorsOf(doc), '', errorsOf(doc));
  });

  /** 删中间一条 = 原地把一条道路拆成两条，是整体重建这套做法的关键用例 */
  test('删掉三车道连接的中间一条后拆成两条单车道', () => {
    const { doc, jid } = makeDoc();
    for (const n of [1, 2, 3]) {
      assert.ok(
        addLanePair(doc, jid, { from: ref('1', 'end', -n), to: ref('3', 'end', n) }, TEMPLATE).ok,
      );
    }
    assert.equal(connectorsOf(doc, jid).length, 1);

    const res = removeLanePair(
      doc,
      jid,
      { from: ref('1', 'end', -2), to: ref('3', 'end', 2) },
      TEMPLATE,
    );
    assert.ok(res.ok, res.error ?? '');
    assert.equal(res.roads, 2, '−1 与 −3 之间断开，应成两条');

    const roads = connectorsOf(doc, jid);
    assert.equal(roads.length, 2);
    for (const r of roads) assert.deepEqual(laneIdsOf(r), [-1]);

    const pairs = readLanePairs(doc, jid);
    assert.equal(pairs.length, 2);
    assert.equal(
      hasPair(pairs, { from: ref('1', 'end', -2), to: ref('3', 'end', 2) }),
      false,
      '被删的那一对不应还在',
    );
    assert.equal(errorsOf(doc), '', errorsOf(doc));
  });

  test('删掉多车道连接的最外侧一条时其余仍并作一条', () => {
    const { doc, jid } = makeDoc();
    for (const n of [1, 2, 3]) {
      assert.ok(
        addLanePair(doc, jid, { from: ref('1', 'end', -n), to: ref('3', 'end', n) }, TEMPLATE).ok,
      );
    }

    assert.ok(
      removeLanePair(doc, jid, { from: ref('1', 'end', -3), to: ref('3', 'end', 3) }, TEMPLATE).ok,
    );
    const roads = connectorsOf(doc, jid);
    assert.equal(roads.length, 1, '剩下 −1,−2 仍连续');
    assert.deepEqual(laneIdsOf(roads[0]!), [-1, -2]);
    assert.equal(errorsOf(doc), '', errorsOf(doc));
  });

  test('一条进口车道可连到多个出口', () => {
    const { doc, jid } = makeDoc();
    // 东臂 −1 既直行到西臂，又左转到南臂
    assert.ok(addLanePair(doc, jid, { from: ref('1', 'end', -1), to: ref('3', 'end', 1) }, TEMPLATE).ok);
    const res = addLanePair(doc, jid, { from: ref('1', 'end', -1), to: ref('4', 'end', 1) }, TEMPLATE);
    assert.ok(res.ok, res.error ?? '');

    assert.equal(connectorsOf(doc, jid).length, 2, '不同出口臂必然是两条连接道路');
    assert.equal(readLanePairs(doc, jid).length, 2);
    assert.equal(errorsOf(doc), '', errorsOf(doc));
  });

  test('完全重复的车道对被拒', () => {
    const { doc, jid } = makeDoc();
    const p: LanePairRef = { from: ref('1', 'end', -1), to: ref('3', 'end', 1) };
    assert.ok(addLanePair(doc, jid, p, TEMPLATE).ok);
    const again = addLanePair(doc, jid, p, TEMPLATE);
    assert.equal(again.ok, false);
    assert.match(again.error ?? '', /已存在/);
    assert.equal(connectorsOf(doc, jid).length, 1, '被拒不应改动文档');
  });

  test('删除不存在的车道对报错且不改动文档', () => {
    const { doc, jid } = makeDoc();
    assert.ok(addLanePair(doc, jid, { from: ref('1', 'end', -1), to: ref('3', 'end', 1) }, TEMPLATE).ok);
    const before = connectorsOf(doc, jid).map((r) => r.id);

    const res = removeLanePair(
      doc,
      jid,
      { from: ref('1', 'end', -2), to: ref('3', 'end', 2) },
      TEMPLATE,
    );
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /不存在/);
    assert.deepEqual(connectorsOf(doc, jid).map((r) => r.id), before);
  });
});

describe('车道连接的方向与类型校验', () => {
  test('两条都驶出的车道不能相连', () => {
    const { doc, jid } = makeDoc();
    // 各臂均以 end 端接入路口，故正 id 车道是驶出的
    const res = addLanePair(doc, jid, { from: ref('1', 'end', 1), to: ref('3', 'end', 1) }, TEMPLATE);
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /驶出路口/);
  });

  test('终点选了驶入车道时报错', () => {
    const { doc, jid } = makeDoc();
    const res = addLanePair(doc, jid, { from: ref('1', 'end', -1), to: ref('3', 'end', -1) }, TEMPLATE);
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /驶入路口/);
  });

  test('不存在的车道报错', () => {
    const { doc, jid } = makeDoc();
    const res = addLanePair(doc, jid, { from: ref('1', 'end', -9), to: ref('3', 'end', 1) }, TEMPLATE);
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /不存在/);
  });

  test('不存在的道路报错', () => {
    const { doc, jid } = makeDoc();
    const res = addLanePair(doc, jid, { from: ref('9', 'end', -1), to: ref('3', 'end', 1) }, TEMPLATE);
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /不存在/);
  });

  test('不存在的交叉口报错', () => {
    const { doc } = makeDoc();
    const res = addLanePair(doc, '7', { from: ref('1', 'end', -1), to: ref('3', 'end', 1) }, TEMPLATE);
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /交叉口 7 不存在/);
  });

  test('人行道不可参与转向', () => {
    const { doc, jid } = makeDoc();
    const road = doc.roads.find((r) => r.id === '1')!;
    const section = road.laneSections[0]!;
    const outer = section.right[section.right.length - 1]!;
    outer.type = 'sidewalk';

    const res = addLanePair(
      doc,
      jid,
      { from: ref('1', 'end', outer.id), to: ref('3', 'end', 1) },
      TEMPLATE,
    );
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /sidewalk/);
  });
});

describe('整体重建的幂等与 id 复用', () => {
  test('同一份车道对重建两次结果一致', () => {
    const { doc, jid } = makeDoc();
    const pairs: LanePairRef[] = [1, 2, 3].map((n) => ({
      from: ref('1', 'end', -n),
      to: ref('3', 'end', n),
    }));

    const first = rebuildJunction(doc, jid, pairs, TEMPLATE);
    const snapshot = serializeOpenDrive(doc);
    const second = rebuildJunction(doc, jid, pairs, TEMPLATE);

    assert.equal(second.roads, first.roads);
    assert.equal(serializeOpenDrive(doc), snapshot, '重建应幂等');
  });

  test('反读的车道对与写入的一致', () => {
    const { doc, jid } = makeDoc();
    const pairs: LanePairRef[] = [
      { from: ref('1', 'end', -1), to: ref('3', 'end', 1) },
      { from: ref('1', 'end', -2), to: ref('3', 'end', 2) },
      { from: ref('2', 'end', -1), to: ref('4', 'end', 1) },
      { from: ref('1', 'end', -1), to: ref('2', 'end', 1) },
    ];
    rebuildJunction(doc, jid, pairs, TEMPLATE);

    const back = readLanePairs(doc, jid);
    assert.equal(back.length, pairs.length, '不应丢对也不应多出');
    for (const p of pairs) assert.ok(hasPair(back, p), `丢了 ${JSON.stringify(p)}`);
  });

  /** 加一条车道不该让无关的连接道路改号，否则每次编辑都在扰动整份文档 */
  test('新增一对车道时无关连接道路的 id 不变', () => {
    const { doc, jid } = makeDoc();
    assert.ok(addLanePair(doc, jid, { from: ref('1', 'end', -1), to: ref('3', 'end', 1) }, TEMPLATE).ok);
    assert.ok(addLanePair(doc, jid, { from: ref('2', 'end', -1), to: ref('4', 'end', 1) }, TEMPLATE).ok);
    const before = connectorsOf(doc, jid).map((r) => r.id).sort();

    assert.ok(addLanePair(doc, jid, { from: ref('3', 'end', -1), to: ref('1', 'end', 1) }, TEMPLATE).ok);
    const after = connectorsOf(doc, jid).map((r) => r.id).sort();

    assert.equal(after.length, before.length + 1);
    for (const id of before) assert.ok(after.includes(id), `原有连接道路 ${id} 被改号`);
  });

  test('重建不会波及非连接道路的 id', () => {
    const { doc, jid } = makeDoc();
    const armIds = doc.roads.filter((r) => r.junction === '-1').map((r) => r.id).sort();
    rebuildJunction(
      doc,
      jid,
      [{ from: ref('1', 'end', -1), to: ref('3', 'end', 1) }],
      TEMPLATE,
    );
    assert.deepEqual(
      doc.roads.filter((r) => r.junction === '-1').map((r) => r.id).sort(),
      armIds,
    );
  });
});

describe('路臂 link 的同步', () => {
  test('用到的两端都写上指向路口的 link', () => {
    const { doc, jid } = makeDoc();
    assert.ok(addLanePair(doc, jid, { from: ref('1', 'end', -1), to: ref('3', 'end', 1) }, TEMPLATE).ok);

    for (const id of ['1', '3']) {
      const road = doc.roads.find((r) => r.id === id)!;
      assert.equal(road.link.successor?.elementType, 'junction', `R${id} 应指向路口`);
      assert.equal(road.link.successor?.elementId, jid);
      assert.equal(road.junction, '-1', '路臂本身不属于路口');
    }
    // 没用到的臂不该被写上
    for (const id of ['2', '4']) {
      const road = doc.roads.find((r) => r.id === id)!;
      assert.equal(road.link.successor, undefined, `R${id} 未参与连接，不应有 link`);
    }
  });

  /** link 指向整个路口，只有该端最后一对车道也删掉才能清 */
  test('某臂最后一对车道被删后其 link 才清掉', () => {
    const { doc, jid } = makeDoc();
    const p1: LanePairRef = { from: ref('1', 'end', -1), to: ref('3', 'end', 1) };
    const p2: LanePairRef = { from: ref('1', 'end', -2), to: ref('3', 'end', 2) };
    assert.ok(addLanePair(doc, jid, p1, TEMPLATE).ok);
    assert.ok(addLanePair(doc, jid, p2, TEMPLATE).ok);

    assert.ok(removeLanePair(doc, jid, p1, TEMPLATE).ok);
    assert.equal(
      doc.roads.find((r) => r.id === '1')!.link.successor?.elementId,
      jid,
      '还剩一对，link 应保留',
    );

    assert.ok(removeLanePair(doc, jid, p2, TEMPLATE).ok);
    assert.equal(
      doc.roads.find((r) => r.id === '1')!.link.successor,
      undefined,
      '一对不剩后 link 应清掉',
    );
    assert.equal(errorsOf(doc), '', errorsOf(doc));
  });

  /**
   * 路口被删空后保留：它是用户显式建的对象，自动消失会让人不知所措。
   * 校验器把空 junction 报成 warning，由面板上的删除按钮显式移除。
   */
  test('删空后路口保留且校验无 error', () => {
    const { doc, jid } = makeDoc();
    const p: LanePairRef = { from: ref('1', 'end', -1), to: ref('3', 'end', 1) };
    assert.ok(addLanePair(doc, jid, p, TEMPLATE).ok);
    assert.ok(removeLanePair(doc, jid, p, TEMPLATE).ok);

    assert.equal(doc.junctions.length, 1, '空路口应保留');
    assert.equal(doc.junctions[0]!.connections.length, 0);
    assert.equal(connectorsOf(doc, jid).length, 0, '连接道路应清空');
    assert.equal(errorsOf(doc), '', errorsOf(doc));
  });
});

describe('往返与校验', () => {
  test('手工连接的路口往返后车道对一致', () => {
    const { doc, jid } = makeDoc();
    const pairs: LanePairRef[] = [
      // 东进：直行两车道 + 左转 + 右转
      { from: ref('1', 'end', -1), to: ref('3', 'end', 1) },
      { from: ref('1', 'end', -2), to: ref('3', 'end', 2) },
      { from: ref('1', 'end', -1), to: ref('4', 'end', 1) },
      { from: ref('1', 'end', -3), to: ref('2', 'end', 3) },
      // 北进直行
      { from: ref('2', 'end', -1), to: ref('4', 'end', 1) },
    ];
    for (const p of pairs) {
      const res = addLanePair(doc, jid, p, TEMPLATE);
      assert.ok(res.ok, `${JSON.stringify(p)}: ${res.error}`);
    }

    assert.equal(errorsOf(doc), '', errorsOf(doc));

    const round = parseOpenDrive(serializeOpenDrive(doc));
    assert.deepEqual(round.warnings, [], `解析警告：${round.warnings.join('; ')}`);
    assert.equal(summarizeIssues(validateDocument(round.document)).errors, 0);

    const back = readLanePairs(round.document, jid);
    assert.equal(back.length, pairs.length);
    for (const p of pairs) assert.ok(hasPair(back, p), `往返后丢了 ${JSON.stringify(p)}`);
  });

  test('掉头连接可手工建立且往返稳定', () => {
    const { doc, jid } = makeDoc();
    // 东臂 −1 掉头回东臂 1
    const p: LanePairRef = { from: ref('1', 'end', -1), to: ref('1', 'end', 1) };
    const res = addLanePair(doc, jid, p, TEMPLATE);
    assert.ok(res.ok, res.error ?? '');

    const road = connectorsOf(doc, jid)[0]!;
    assert.ok(road.laneOffsets.length > 0, '掉头应用 laneOffset 把参考线挪到车道中心');
    assert.equal(errorsOf(doc), '', errorsOf(doc));

    const round = parseOpenDrive(serializeOpenDrive(doc));
    assert.equal(summarizeIssues(validateDocument(round.document)).errors, 0);
    assert.ok(hasPair(readLanePairs(round.document, jid), p));
  });
});

describe('补全缺失转向', () => {
  test('只在已有车道对牵涉的路臂之间补', () => {
    const { doc, jid } = makeDoc([2, 2, 2, 2]);
    // 只连东、西两臂，北南两臂未牵涉
    assert.ok(addLanePair(doc, jid, { from: ref('1', 'end', -1), to: ref('3', 'end', 1) }, TEMPLATE).ok);

    const res = completeJunction(doc, jid, TEMPLATE);
    assert.ok(res.added > 0, '同一对路臂间应还有可补的（反向、掉头）');

    for (const p of readLanePairs(doc, jid)) {
      for (const r of [p.from, p.to]) {
        assert.ok(['1', '3'].includes(r.roadId), `补到了未牵涉的路臂 R${r.roadId}`);
      }
    }
    assert.equal(errorsOf(doc), '', errorsOf(doc));
  });

  test('补全不覆盖已有车道对', () => {
    const { doc, jid } = makeDoc([2, 2, 2, 2]);
    // 手工连一条启发式不会给的组合：东臂外侧直行到西臂内侧
    const manual: LanePairRef = { from: ref('1', 'end', -2), to: ref('3', 'end', 1) };
    assert.ok(addLanePair(doc, jid, manual, TEMPLATE).ok);

    completeJunction(doc, jid, TEMPLATE);
    assert.ok(hasPair(readLanePairs(doc, jid), manual), '手工连的那一对必须保留');
  });

  test('已齐备时再补返回 0', () => {
    const { doc, jid } = makeDoc([2, 2, 2, 2]);
    assert.ok(addLanePair(doc, jid, { from: ref('1', 'end', -1), to: ref('3', 'end', 1) }, TEMPLATE).ok);
    completeJunction(doc, jid, TEMPLATE);
    const second = completeJunction(doc, jid, TEMPLATE);
    assert.equal(second.added, 0, '第二次不应再有可补的');
  });

  test('空路口无可补', () => {
    const { doc, jid } = makeDoc();
    const res = completeJunction(doc, jid, TEMPLATE);
    assert.equal(res.added, 0, '没有路臂就无从推断');
    assert.equal(res.roads, 0);
  });
});

describe('车道手柄拾取', () => {
  /** 某道路某端某车道中心的世界坐标 */
  function laneCenter(doc: OdrDocument, roadId: string, end: ContactPoint, laneId: number): Vec2 {
    const handles = laneHandlesNear(doc, refPointOf(doc, roadId, end), 40);
    const hit = handles.find(
      (h) => h.ref.roadId === roadId && h.ref.end === end && h.ref.laneId === laneId,
    );
    assert.ok(hit, `未找到 R${roadId}@${end}.${laneId} 的手柄`);
    return hit!.pos;
  }

  function refPointOf(doc: OdrDocument, roadId: string, end: ContactPoint): Vec2 {
    const road = doc.roads.find((r) => r.id === roadId)!;
    const p = referencePoint(road, end === 'start' ? 0 : road.length);
    return { x: p.x, y: p.y };
  }

  test('每条车道各有独立手柄，不挤在参考线上', () => {
    const { doc } = makeDoc();
    const center = refPointOf(doc, '1', 'end');
    const handles = laneHandlesNear(doc, center, 40).filter((h) => h.ref.roadId === '1');

    // 东臂 end 端：左右各 3 条可通行车道
    assert.equal(handles.length, 6, `应有 6 个手柄，实得 ${handles.length}`);
    const positions = new Set(handles.map((h) => `${h.pos.x.toFixed(3)},${h.pos.y.toFixed(3)}`));
    assert.equal(positions.size, 6, '手柄位置不应重合');
  });

  test('手柄距参考线的距离随车道序号递增', () => {
    const { doc } = makeDoc();
    const center = refPointOf(doc, '1', 'end');
    const d1 = Math.hypot(
      laneCenter(doc, '1', 'end', -1).x - center.x,
      laneCenter(doc, '1', 'end', -1).y - center.y,
    );
    const d3 = Math.hypot(
      laneCenter(doc, '1', 'end', -3).x - center.x,
      laneCenter(doc, '1', 'end', -3).y - center.y,
    );
    assert.ok(d3 > d1 + 1, `外侧车道应更远：d1=${d1} d3=${d3}`);
  });

  test('flow 正确区分驶入与驶出', () => {
    const { doc } = makeDoc();
    const handles = laneHandlesNear(doc, refPointOf(doc, '1', 'end'), 40).filter(
      (h) => h.ref.roadId === '1',
    );
    for (const h of handles) {
      // end 端接入路口：负 id 沿 +s 行驶故为驶入，正 id 为驶出
      assert.equal(h.flow, h.ref.laneId < 0 ? 'entry' : 'exit', `车道 ${h.ref.laneId} 方向判错`);
    }
  });

  test('连接道路自身不给手柄', () => {
    const { doc, jid } = makeDoc();
    assert.ok(addLanePair(doc, jid, { from: ref('1', 'end', -1), to: ref('3', 'end', 1) }, TEMPLATE).ok);
    const connector = connectorsOf(doc, jid)[0]!;

    const p = referencePoint(connector, 0);
    const handles = laneHandlesNear(doc, { x: p.x, y: p.y }, 40);
    assert.equal(
      handles.some((h) => h.ref.roadId === connector.id),
      false,
      '连接道路不应参与连线，否则会连出路口套路口',
    );
  });

  test('人行道不给手柄', () => {
    const { doc } = makeDoc();
    const road = doc.roads.find((r) => r.id === '1')!;
    const section = road.laneSections[0]!;
    const outer = section.right[section.right.length - 1]!;
    outer.type = 'sidewalk';

    const handles = laneHandlesNear(doc, refPointOf(doc, '1', 'end'), 40).filter(
      (h) => h.ref.roadId === '1',
    );
    assert.equal(
      handles.some((h) => h.ref.laneId === outer.id),
      false,
      '不可通行车道给手柄等于引诱用户点错',
    );
  });

  test('按距离升序且距离相等时下标稳定', () => {
    const { doc } = makeDoc();
    const handles = laneHandlesNear(doc, refPointOf(doc, '1', 'end'), 60);
    for (let i = 1; i < handles.length; i++) {
      assert.ok(
        handles[i]!.distance >= handles[i - 1]!.distance - 1e-9,
        '手柄未按距离升序',
      );
    }
    // 同一输入两次调用顺序必须一致，否则 Tab 轮换会跳
    const again = laneHandlesNear(doc, refPointOf(doc, '1', 'end'), 60);
    assert.deepEqual(
      again.map((h) => `${h.ref.roadId}@${h.ref.end}.${h.ref.laneId}`),
      handles.map((h) => `${h.ref.roadId}@${h.ref.end}.${h.ref.laneId}`),
    );
  });

  test('超出容差不返回', () => {
    const { doc } = makeDoc();
    const far = { x: 1000, y: 1000 };
    assert.deepEqual(laneHandlesNear(doc, far, 10), []);
  });
});
