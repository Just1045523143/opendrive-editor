import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createEmptyDocument } from '../src/core/model/document.ts';
import { buildRoad, DEFAULT_TEMPLATE } from '../src/editor/roadFactory.ts';
import { FURNITURE, addFurniture, furnitureItems, groundPolygons } from '../src/editor/furniture.ts';
import { parseOpenDrive } from '../src/core/xml/parse.ts';
import { serializeOpenDrive } from '../src/core/xml/serialize.ts';
import { Store } from '../src/editor/store.ts';
import { Mesh, PerspectiveCamera, Scene, Sprite, Vector3 } from 'three';
import { buildFurniture3D, disposeFurniture3D, updateFurnitureBadges } from '../src/editor/furniture3d.ts';
import { Preview3D } from '../src/editor/preview3d.ts';
import { App } from '../src/editor/app.ts';
import { Renderer } from '../src/editor/renderer.ts';
import { Viewport } from '../src/editor/viewport.ts';
import type { TileLayer } from '../src/editor/tileLayer.ts';
import { FurnitureTool, locateFurniture } from '../src/editor/tools/furnitureTool.ts';
import { referencePoint } from '../src/core/model/reference.ts';
import type { PointerInput, ToolContext } from '../src/editor/tools/types.ts';

function fixture() {
  const doc = createEmptyDocument();
  const road = buildRoad('1', [{ type: 'line', s: 0, x: 449000, y: -963000, hdg: Math.PI / 2, length: 100 }], DEFAULT_TEMPLATE);
  doc.roads.push(road);
  return { doc, road };
}
test('全部预设通过 XODR 往返保留类型、位置、轮廓、限速单位', () => {
  const { doc, road } = fixture();
  for (const [kind] of FURNITURE) addFurniture(doc, road, kind);
  const xml = serializeOpenDrive(doc);
  const result = parseOpenDrive(xml).document;
  const items = furnitureItems(result.roads[0]!);
  assert.deepEqual(items.map(i => i.kind), FURNITURE.map(([k]) => k));
  assert.equal(new Set(items.map(i => i.source.id)).size, FURNITURE.length);
  assert.equal(items.find(i => i.kind === 'speed')?.source.extraAttrs?.unit, 'km/h');
  assert.match(xml, /subtype="arrowStraight"/);
  assert.match(xml, /subtype="zebra"/);
  assert.match(xml, /cornerLocal/);
  assert.match(items.find(i => i.kind === 'arrowLeft')!.source.rawChildren!, /code="opendrive-editor"/);
  assert.equal(serializeOpenDrive(parseOpenDrive(serializeOpenDrive(result)).document), serializeOpenDrive(result));
});
test('灯位参考线高程和朝向不受 laneOffset、横坡误叠加', () => {
  const { doc, road } = fixture();
  road.elevations = [{ s: 0, a: 10, b: 0.1, c: 0, d: 0 }];
  road.laneOffsets = [{ s: 0, a: 3, b: 0, c: 0, d: 0 }];
  road.superelevations = [{ s: 0, a: 0.2, b: 0, c: 0, d: 0 }];
  addFurniture(doc, road, 'light');
  const sg = road.signals[0]!;
  sg.extraAttrs = { hOffset: '0.3', pitch: '0.1', roll: '-0.2' };
  const item = furnitureItems(road)[0]!;
  assert.equal(item.x, 449005); assert.equal(item.y, -962950); assert.equal(item.z, 18);
  assert.equal(item.heading, Math.PI * 1.5 + 0.3);
  assert.equal(item.pitch, 0.1); assert.equal(item.roll, -0.2);
  sg.orientation = '-'; assert.equal(furnitureItems(road)[0]!.heading, Math.PI / 2 + 0.3);
});
test('道路限速不是实体牌；未知国家编号不误判，越界设施不显示', () => {
  const { doc, road } = fixture();
  assert.equal(furnitureItems(road).length, 0);
  addFurniture(doc, road, 'speed');
  road.signals[0]!.country = 'CN'; assert.equal(furnitureItems(road).length, 0);
  road.signals[0]!.country = 'DE'; road.signals[0]!.s = 200;
  assert.equal(furnitureItems(road).length, 0);
});
test('添加与编辑设施支持撤销重做', () => {
  const { doc } = fixture(); const store = new Store(doc);
  store.mutate(() => addFurniture(store.document, store.document.roads[0]!, 'arrowLeft'));
  store.mutate(() => { store.document.roads[0]!.objects[0]!.t = -5; });
  store.undo(); assert.equal(store.document.roads[0]!.objects[0]!.t, -1.75);
  store.undo(); assert.equal(store.document.roads[0]!.objects.length, 0);
  store.redo(); store.redo(); assert.equal(store.document.roads[0]!.objects[0]!.t, -5);
});
test('左右箭头镜像，组合箭头与斑马线有独立轮廓', () => {
  assert.deepEqual(groundPolygons('arrowRight'), groundPolygons('arrowLeft').map(p => p.map(([u,v]) => [u,-v!])));
  assert.equal(groundPolygons('arrowStraightLeft').length, 2);
  assert.equal(groundPolygons('crosswalk').length, 6);
});
test('项目 Town01 的灯与 Speed_N 对象均可识别', () => {
  const doc = parseOpenDrive(readFileSync(new URL('../../apollo_map/opendrive/Town01.xodr', import.meta.url), 'utf8')).document;
  const items = doc.roads.flatMap(furnitureItems);
  assert.ok(items.filter(i => i.kind === 'light').length > 0);
  assert.ok(items.some(i => i.kind === 'speed' && i.value === 30));
});

test('3D 场景使用局部坐标，牌面朝向正确，重建可释放纹理和网格', () => {
  const previous = globalThis.document;
  const context = new Proxy({}, { get: () => () => {} });
  globalThis.document = { createElement: () => ({ getContext: () => context }) } as unknown as Document;
  try {
    const { doc, road } = fixture();
    for (const [kind] of FURNITURE) addFurniture(doc, road, kind);
    const group = buildFurniture3D(doc, { x: 449000, y: -963000 });
    assert.equal(group.children.length, FURNITURE.length);
    assert.deepEqual(group.children[0]!.position.toArray(), [5, 3, -50]);
    group.updateMatrixWorld(true);
    const light = group.children[0]!.children[0]!;
    const face = light.children[0]!;
    const normal = new Vector3(0, 0, 1).transformDirection(face.matrixWorld);
    assert.ok(Math.abs(normal.x) < 1e-10);
    assert.ok(normal.z > 0.99999); // +s 向北的来车，灯面向南（Three +z）。
    let meshCount = 0, disposed = 0, textureCount = 0, textureDisposed = 0;
    group.traverse(o => {
      if (!(o instanceof Mesh)) return;
      meshCount++; o.geometry.addEventListener('dispose', () => disposed++);
      if (o.material.map) { textureCount++; o.material.map.addEventListener('dispose', () => textureDisposed++); }
    });
    disposeFurniture3D(group);
    assert.equal(disposed, meshCount); assert.equal(textureDisposed, textureCount);
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'document');
    else globalThis.document = previous;
  }
});

test('俯视渲染包含限速数字和灯图标，关闭图层后隐藏', () => {
  const { doc, road } = fixture(); addFurniture(doc, road, 'speed'); addFurniture(doc, road, 'light');
  const texts: string[] = [];
  const ctx = new Proxy({}, { get: (_, key) => key === 'fillText' ? (s: string) => texts.push(s)
    : key === 'measureText' ? () => ({ width: 20 }) : () => {} }) as CanvasRenderingContext2D;
  const vp = new Viewport(); vp.center = { x: 449005, y: -962950 };
  const renderer = new Renderer(new Store(doc), vp, {} as TileLayer);
  renderer.options.showTiles = false;
  renderer.draw(ctx, null); assert.ok(texts.includes('50'));
  texts.length = 0; renderer.options.showFurniture = false;
  renderer.draw(ctx, null); assert.ok(!texts.includes('50'));
});

function toolContext(doc = fixture().doc): ToolContext {
  return { store: new Store(doc), viewport: new Viewport(), requestRedraw() {}, invalidate() {} } as unknown as ToolContext;
}
function pointer(x: number, y: number, button = 0): PointerInput {
  return { world: { x, y }, button } as PointerInput;
}
test('鼠标点击生成大坐标道路的实际 s/t，不落到中点，并可撤销重做', () => {
  const ctx = toolContext(), tool = new FurnitureTool(); tool.kind = 'speed';
  tool.onPointerDown(ctx, pointer(449006, -962970)); // s=30，t=-6
  const source = ctx.store.document.roads[0]!.signals[0]!;
  assert.ok(Math.abs(source.s - 30) < 1e-6); assert.ok(Math.abs(source.t + 6) < 1e-6);
  assert.equal(source.orientation, '+');
  assert.equal(ctx.store.selectedRoadId, '1');
  const xml = serializeOpenDrive(ctx.store.document);
  assert.ok(Math.abs(parseOpenDrive(xml).document.roads[0]!.signals[0]!.s - 30) < 1e-6);
  ctx.store.undo(); assert.equal(ctx.store.document.roads[0]!.signals.length, 0);
  ctx.store.redo(); assert.equal(ctx.store.document.roads[0]!.signals.length, 1);
  tool.onPointerDown(ctx, pointer(449006, -962940));
  assert.equal(ctx.store.document.roads[0]!.signals.length, 2);
});
test('空白、端点外与右键不产生设施或历史记录', () => {
  const ctx = toolContext(), tool = new FurnitureTool();
  for (const e of [pointer(0,0), pointer(449006,-963020), pointer(449006,-962970,2)]) tool.onPointerDown(ctx,e);
  assert.equal(ctx.store.document.roads[0]!.signals.length,0); assert.equal(ctx.store.canUndo,false);
  assert.equal(locateFurniture(toolContext(createEmptyDocument()), { x: 0, y: 0 }), null);
});
test('路侧范围由车道宽度确定，自动方向支持正侧、LHT与显式指定', () => {
  const { doc, road } = fixture();
  road.laneSections = buildRoad('2', road.planView, { ...DEFAULT_TEMPLATE, leftLanes: 3 }).laneSections;
  const ctx = toolContext(doc), tool = new FurnitureTool(); tool.kind = 'arrowLeft';
  tool.onPointerDown(ctx, pointer(448986,-962970)); // t=14，在宽路左侧外3.5m
  assert.equal(road.objects.length, 1); assert.equal(road.objects[0]!.hdg, Math.PI);
  road.rule = 'LHT'; tool.kind = 'light';
  tool.onPointerDown(ctx, pointer(448998,-962970));
  assert.equal(road.signals[0]!.orientation, '+');
  tool.orientation = '-'; tool.onPointerDown(ctx, pointer(448998,-962970));
  assert.equal(road.signals[1]!.orientation, '-');
});
test('闭合曲线全局定位找到点击附近的局部区间', () => {
  const doc = createEmptyDocument();
  const road = buildRoad('curve', [{ type: 'arc', s: 0, x: 20, y: 0, hdg: Math.PI / 2, curvature: 0.05, length: 40 * Math.PI }], DEFAULT_TEMPLATE);
  doc.roads.push(road);
  const ref = referencePoint(road, 100);
  const hit = locateFurniture(toolContext(doc), { x: ref.x + 2 * Math.sin(ref.hdg), y: ref.y - 2 * Math.cos(ref.hdg) });
  assert.ok(hit); assert.ok(Math.abs(hit.s - 100) < 1e-5); assert.ok(Math.abs(hit.t + 2) < 1e-5);
});
test('放置预览绘制且切换工具清除，未改变文档', () => {
  const ctx = toolContext(), tool = new FurnitureTool();
  let calls = 0;
  const canvas = new Proxy({}, { get: () => () => { calls++; } }) as CanvasRenderingContext2D;
  tool.onPointerMove(ctx, pointer(449006,-962970)); tool.draw(ctx,canvas);
  assert.ok(calls > 0); assert.equal(ctx.store.canUndo,false);
  tool.onDeactivate(ctx); calls = 0; tool.draw(ctx,canvas); assert.equal(calls,0);
});

test('长道路全览的设施图标保持 28px，模型背面与道路遮挡不会隐藏位置提示', () => {
  const previous = globalThis.document;
  const context = new Proxy({}, { get: () => () => {} });
  globalThis.document = { createElement: () => ({ getContext: () => context }) } as unknown as Document;
  try {
    const { doc, road } = fixture(); addFurniture(doc, road, 'light');
    const xml = serializeOpenDrive(doc);
    const group = buildFurniture3D(doc, { x: 449000, y: -963000 });
    const badges: Sprite[] = [];
    group.traverse(o => { if (o instanceof Sprite) badges.push(o); });
    assert.equal(badges.length, 1);
    const badge = badges[0]!;
    assert.equal(badge.material.sizeAttenuation, false);
    assert.equal(badge.material.depthTest, false);
    assert.equal(badge.material.depthWrite, false);
    const camera = new PerspectiveCamera(55, 1.5, 0.5, 40000);
    for (const height of [400, 800, 1600]) {
      for (const distance of [60, 4000, 20000]) {
        camera.position.set(0, distance, distance);
        updateFurnitureBadges(group, camera, height);
        assert.ok(Math.abs(badge.scale.y * camera.projectionMatrix.elements[5]! * height / 2 - 28) < 1e-8);
      }
    }
    let disposed = 0;
    badge.material.map!.addEventListener('dispose', () => disposed++);
    disposeFurniture3D(group);
    assert.equal(disposed, 1, '牌面和图标共享纹理仅释放一次');
    assert.equal(serializeOpenDrive(doc), xml, '位置提示不改变真实尺寸或 XODR');
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'document'); else globalThis.document = previous;
  }
});

test('Store 与 App 的真实更新链路在修改、删除、撤销重做后同步 3D 交通灯', () => {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => ({ getContext: () => new Proxy({}, { get: () => () => {} }) }) } as unknown as Document;
  try {
    const { doc } = fixture();
    const store = new Store(doc);
    let renders = 0;
    const scene = new Scene();
    const preview = Object.assign(Object.create(Preview3D.prototype), {
      scene, camera: new PerspectiveCamera(55, 1, 0.5, 40000), container: { clientHeight: 800 },
      renderer: { render: () => { renders++; }, dispose() {}, domElement: { remove() {} } }, disposed: false,
      roadMesh: null, refLines: [], grid: null, furniture: null,
      target: new Vector3(), azimuth: -Math.PI / 4, elevationAngle: 0.6,
    }) as Preview3D;
    const app = Object.assign(Object.create(App.prototype), {
      store, preview3d: preview, renderOptions: { tolerance: 0.08 },
      requestRedraw() {}, rebuildPanels() {}, inspector: { render() {} },
      updateStatus() {}, showToast() {},
    }) as { bindStore(): void };
    app.bindStore();
    const badges = () => {
      const result: Sprite[] = [];
      scene.traverse(o => { if (o instanceof Sprite) result.push(o); });
      return result;
    };
    store.mutate(() => { addFurniture(store.document, store.document.roads[0]!, 'light'); });
    assert.equal(badges().length, 1); assert.equal(renders, 1);
    const initialPosition = badges()[0]!.getWorldPosition(new Vector3());
    let oldTextureDisposed = 0;
    badges()[0]!.material.map!.addEventListener('dispose', () => oldTextureDisposed++);
    store.mutate(() => { store.document.roads[0]!.signals[0]!.t += 3; });
    assert.ok(Math.abs(badges()[0]!.getWorldPosition(new Vector3()).distanceTo(initialPosition) - 3) < 1e-7);
    assert.equal(oldTextureDisposed, 1);
    store.mutate(() => { store.document.roads[0]!.signals = []; });
    assert.equal(badges().length, 0);
    store.undo(); assert.equal(badges().length, 1);
    store.redo(); assert.equal(badges().length, 0);
    assert.equal(renders, 5);
    preview.dispose();
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'document'); else globalThis.document = previous;
  }
});

test('3D 模式按钮同步选中状态，关闭预览时取消选中', () => {
  const attributes: Record<string, string> = {};
  let active = false, removed = false, disposed = false;
  const app = Object.assign(Object.create(App.prototype), {
    preview3d: null,
    preview3dButton: { classList: { toggle: (_: string, enabled: boolean) => { active = enabled; } },
      setAttribute: (key: string, value: string) => { attributes[key] = value; } },
    preview3dHost: { remove: () => { removed = true; } }, requestRedraw() {},
  }) as { preview3d: unknown; updatePreviewModeButton(): void; togglePreview3D(): void };
  app.updatePreviewModeButton(); assert.equal(active, false); assert.equal(attributes['aria-pressed'], 'false');
  app.preview3d = { dispose: () => { disposed = true; } };
  app.updatePreviewModeButton(); assert.equal(active, true); assert.equal(attributes['aria-pressed'], 'true');
  app.togglePreview3D();
  assert.equal(active, false); assert.equal(attributes['aria-pressed'], 'false');
  assert.ok(removed && disposed); assert.equal(app.preview3d, null);
});

test('3D 初始化失败时移除遮罩、取消选中，允许再次开启', () => {
  const previous = globalThis.document;
  let appended = 0, removed = 0, attempts = 0, active = true;
  const messages: string[] = [];
  globalThis.document = {
    createElement: () => ({ remove: () => { removed++; } }),
    createElementNS: () => { attempts++; throw new Error('WebGL unavailable'); },
  } as unknown as Document;
  try {
    const app = Object.assign(Object.create(App.prototype), {
      preview3d: null, preview3dHost: null, activeToolId: 'select',
      dom: { stage: { append: () => { appended++; } } },
      preview3dButton: {
        classList: { toggle: (_: string, enabled: boolean) => { active = enabled; } },
        setAttribute() {},
      },
      requestRedraw() {}, store: { notify: (_: string, message: string) => messages.push(message) },
    }) as { preview3d: unknown; preview3dHost: unknown; togglePreview3D(): void };
    for (let i = 0; i < 2; i++) {
      assert.doesNotThrow(() => app.togglePreview3D());
      assert.equal(app.preview3d, null); assert.equal(app.preview3dHost, null);
      assert.equal(active, false);
    }
    assert.equal(attempts, 2); assert.equal(appended, 2); assert.equal(removed, 2);
    assert.equal(messages.length, 2); assert.match(messages[0]!, /3D 预览开启失败：WebGL unavailable/);
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'document'); else globalThis.document = previous;
  }
});
