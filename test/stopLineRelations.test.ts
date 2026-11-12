import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createEmptyDocument } from '../src/core/model/document.ts';
import type { RoadObject, RoadSignal } from '../src/core/model/road.ts';
import { parseXml } from '../src/core/xml/dom.ts';
import { parseOpenDrive } from '../src/core/xml/parse.ts';
import { serializeOpenDrive } from '../src/core/xml/serialize.ts';
import { addFurniture, refreshGroundOutline, removeFurniture } from '../src/editor/furniture.ts';
import { parseProject, serializeProject } from '../src/editor/project.ts';
import { buildRoad, DEFAULT_TEMPLATE } from '../src/editor/roadFactory.ts';
import { setStopLineLight, stopLineLights, trafficLights } from '../src/editor/stopLineRelations.ts';
import { Store } from '../src/editor/store.ts';
import { localTmerc } from '../src/geo/projection.ts';

function setup() {
  const doc = createEmptyDocument();
  const road = buildRoad('1', [{ type: 'line', s: 0, x: 0, y: 0, hdg: 0, length: 100 }], DEFAULT_TEMPLATE);
  doc.roads.push(road);
  const light = addFurniture(doc, road, 'light', { s: 70, t: -5 }) as RoadSignal;
  const line = addFurniture(doc, road, 'stopLine', { s: 65, t: -1.75 }) as RoadObject;
  return { doc, road, light, line };
}

function refs(signal: RoadSignal) {
  return parseXml(`<signal>${signal.rawChildren ?? ''}</signal>`).children.filter(node => node.tag === 'reference');
}

test('绑定写入标准 object reference，XODR 和工程往返保留关系及独立 s/t', () => {
  const { doc, road, light, line } = setup();
  setStopLineLight(road, line, light, true);
  assert.deepEqual(refs(light).map(node => node.attrs), [{ elementId: line.id, elementType: 'object', type: 'stopline' }]);
  const copies = [parseOpenDrive(serializeOpenDrive(doc)).document,
    parseProject(serializeProject(doc, new Map(), localTmerc({ lon: 116.4, lat: 39.9 }), DEFAULT_TEMPLATE)).document];
  for (const copy of copies) {
    const result = copy.roads[0]!;
    assert.deepEqual(stopLineLights(result, result.objects[0]!).map(s => s.id), [light.id]);
    assert.equal(result.objects[0]!.s, 65);
    assert.equal(result.signals[0]!.s, 70);
    assert.match(result.objects[0]!.rawChildren!, /cornerLocal/);
  }
});

test('多灯多线、重复绑定及解绑保留其他关系和未知子元素', () => {
  const { doc, road, light, line } = setup();
  const otherLight = addFurniture(doc, road, 'light') as RoadSignal;
  const otherLine = addFurniture(doc, road, 'stopLine') as RoadObject;
  light.rawChildren = '<validity fromLane="-2" toLane="-1"/>'
    + '<dependency id="upstream" type="custom"/>'
    + '<reference elementId="unrelated" elementType="signal" type="custom"/>'
    + '<userData code="vendor"><custom value="保留"/></userData>';
  setStopLineLight(road, line, light, true);
  setStopLineLight(road, line, light, true);
  setStopLineLight(road, otherLine, light, true);
  setStopLineLight(road, line, otherLight, true);
  assert.equal(refs(light).length, 3);
  assert.deepEqual(stopLineLights(road, line), [light, otherLight]);
  assert.ok(light.rawChildren!.indexOf('<reference') < light.rawChildren!.indexOf('<userData'));
  setStopLineLight(road, line, light, false);
  assert.deepEqual(stopLineLights(road, line), [otherLight]);
  assert.deepEqual(stopLineLights(road, otherLine), [light]);
  assert.match(light.rawChildren!, /<validity fromLane="-2" toLane="-1"/);
  assert.match(light.rawChildren!, /<dependency id="upstream" type="custom"/);
  assert.match(light.rawChildren!, /<custom value="保留"/);
  assert.equal(refs(light)[0]!.attrs.elementId, 'unrelated');
});

test('导入引用按 ID 识别，特殊字符安全转义，不要求编辑器私有元数据', () => {
  const { doc, road, light, line } = setup();
  line.id = 'line<&"';
  line.rawChildren = '<userData code="vendor"/>';
  setStopLineLight(road, line, light, true);
  assert.match(light.rawChildren!, /elementId="line&lt;&amp;&quot;"/);
  const copy = parseOpenDrive(serializeOpenDrive(doc)).document.roads[0]!;
  assert.equal(stopLineLights(copy, copy.objects[0]!)[0]?.id, light.id);
  setStopLineLight(copy, copy.objects[0]!, copy.signals[0]!, false);
  assert.deepEqual(stopLineLights(copy, copy.objects[0]!), []);
});

test('移动、修改尺寸及刷新轮廓不改变灯线绑定', () => {
  const { doc, road, light, line } = setup();
  setStopLineLight(road, line, light, true);
  line.s = 40; line.t = -5.25; line.width = 10.5; line.length = 0.5;
  refreshGroundOutline(line, 'stopLine');
  light.s = 75;
  assert.deepEqual(stopLineLights(road, line), [light]);
  const copy = parseOpenDrive(serializeOpenDrive(doc)).document.roads[0]!;
  assert.equal(copy.objects[0]!.width, 10.5);
  assert.equal(copy.objects[0]!.s, 40);
  assert.deepEqual(stopLineLights(copy, copy.objects[0]!).map(s => s.id), [light.id]);
});

test('绑定、删除停止线和解除绑定均可撤销重做；删除不影响其他停止线', () => {
  const { doc, road, light, line } = setup();
  const otherLine = addFurniture(doc, road, 'stopLine') as RoadObject;
  setStopLineLight(road, otherLine, light, true);
  const store = new Store(doc);
  store.mutate(() => setStopLineLight(road, line, light, true));
  store.mutate(() => removeFurniture(doc, road, line));
  assert.equal(refs(light).length, 1);
  assert.equal(refs(light)[0]!.attrs.elementId, otherLine.id);
  store.undo();
  let current = store.document.roads[0]!;
  assert.equal(current.objects.length, 2);
  assert.equal(refs(current.signals[0]!).length, 2);
  store.undo(); current = store.document.roads[0]!;
  assert.equal(refs(current.signals[0]!).length, 1);
  store.redo(); current = store.document.roads[0]!;
  store.mutate(() => setStopLineLight(current, current.objects[0]!, current.signals[0]!, false));
  assert.deepEqual(stopLineLights(current, current.objects[0]!), []);
  store.undo(); current = store.document.roads[0]!;
  assert.equal(stopLineLights(current, current.objects[0]!).length, 1);
});

test('删除灯时保留停止线、清理信号引用，并区分 signal/object 同名 ID', () => {
  const { doc, road, light, line } = setup();
  const otherLight = addFurniture(doc, road, 'light') as RoadSignal;
  line.id = light.id; // 这两个元素属于不同 ID 命名空间。
  setStopLineLight(road, line, otherLight, true);
  otherLight.rawChildren += `<reference elementId="${light.id}" elementType="signal" type="custom"/>`
    + `<dependency id="${light.id}" type="trafficLight"/>`;
  removeFurniture(doc, road, light);
  assert.equal(road.objects.length, 1);
  assert.deepEqual(stopLineLights(road, line), [otherLight]);
  assert.equal(refs(otherLight).length, 1);
  assert.doesNotMatch(otherLight.rawChildren!, /dependency/);
  removeFurniture(doc, road, line);
  assert.equal(refs(otherLight).length, 0);
});

test('只允许绑定同一道路的交通灯，不将限速牌或其他道路的灯误绑定', () => {
  const { doc, road, line } = setup();
  const speed = addFurniture(doc, road, 'speed') as RoadSignal;
  const otherRoad = buildRoad('2', road.planView, DEFAULT_TEMPLATE);
  doc.roads.push(otherRoad);
  const otherLight = addFurniture(doc, otherRoad, 'light') as RoadSignal;
  assert.equal(trafficLights(road).length, 1);
  assert.throws(() => setStopLineLight(road, line, speed, true), /同一道路/);
  assert.throws(() => setStopLineLight(road, line, otherLight, true), /同一道路/);
  assert.equal(otherLight.rawChildren, undefined);
});
