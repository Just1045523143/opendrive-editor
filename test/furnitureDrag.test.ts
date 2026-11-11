import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createEmptyDocument } from '../src/core/model/document.ts';
import { buildRoad, DEFAULT_TEMPLATE } from '../src/editor/roadFactory.ts';
import { Store } from '../src/editor/store.ts';
import { Viewport } from '../src/editor/viewport.ts';
import { addFurniture, FURNITURE, furnitureItems } from '../src/editor/furniture.ts';
import { pickFurniture } from '../src/editor/furnitureInteraction.ts';
import { SelectTool } from '../src/editor/tools/selectTool.ts';
import { DEFAULT_SNAP, type PointerInput, type ToolContext } from '../src/editor/tools/types.ts';
import { serializeOpenDrive } from '../src/core/xml/serialize.ts';
import { parseOpenDrive } from '../src/core/xml/parse.ts';
import type { RoadObject } from '../src/core/model/road.ts';

function setup() {
  const doc = createEmptyDocument();
  const road = buildRoad('1', [{ type: 'line', s: 0, x: 449000, y: -963000, hdg: Math.PI / 2, length: 100 }], DEFAULT_TEMPLATE);
  doc.roads.push(road);
  const viewport = new Viewport(); viewport.center = { x: 449000, y: -962950 }; viewport.pixelsPerMeter = 8;
  const ctx = { store: new Store(doc), viewport, snap: { ...DEFAULT_SNAP }, renderData: () => [],
    requestRedraw() {}, invalidate() {}, showFurniture: true } as unknown as ToolContext;
  const event = (x: number, y: number, button = 0) => ({ world: { x, y }, screen: viewport.worldToScreen({ x, y }), button }) as PointerInput;
  return { ctx, road, doc, event, tool: new SelectTool() };
}

test('单击图标选中设施、不改位置和历史；同 id 的 signal/object 可区分', () => {
  const { ctx, road, doc, event, tool } = setup();
  const signal = addFurniture(doc, road, 'light');
  const object = addFurniture(doc, road, 'crosswalk', { s: 20, t: -2 }); object.id = signal.id;
  const before = serializeOpenDrive(doc);
  tool.onPointerDown(ctx, event(449005, -962950)); tool.onPointerUp(ctx, event(449005, -962950));
  assert.deepEqual(ctx.store.selection, { kind: 'furniture', roadId: '1', furnitureId: signal.id, sourceType: 'signal' });
  assert.equal(ctx.store.selectedRoadId, '1');
  tool.onPointerDown(ctx, event(449002, -962980)); tool.onPointerUp(ctx, event(449002, -962980));
  assert.equal(ctx.store.selection.kind === 'furniture' && ctx.store.selection.sourceType, 'object');
  assert.equal(serializeOpenDrive(doc), before); assert.equal(ctx.store.canUndo, false);
});

test('拖动保留抓取偏移，移动中只预览，松开更新 s/t；一次撤销重做与 XODR 往返', () => {
  const { ctx, road, doc, event, tool } = setup();
  const source = addFurniture(doc, road, 'light');
  const other = { ...source }; delete (other as Partial<typeof source>).s; delete (other as Partial<typeof source>).t;
  tool.onPointerDown(ctx, event(449006, -962950)); // 在中心右侧 1m 按下
  tool.onPointerMove(ctx, event(449008, -962940));
  tool.onPointerMove(ctx, event(449009, -962935));
  assert.equal(source.s, 50); assert.equal(source.t, -5); assert.equal(ctx.store.canUndo, false);
  tool.onPointerUp(ctx, event(449009, -962935));
  assert.ok(Math.abs(source.s - 65) < 1e-6); assert.ok(Math.abs(source.t + 8) < 1e-6);
  const { s: _s, t: _t, ...rest } = source; assert.deepEqual(rest, other);
  const result = parseOpenDrive(serializeOpenDrive(doc)).document.roads[0]!.signals[0]!;
  assert.ok(Math.abs(result.s - 65) < 1e-6); assert.ok(Math.abs(result.t + 8) < 1e-6);
  ctx.store.undo(); assert.equal(ctx.store.document.roads[0]!.signals[0]!.s, 50); assert.equal(ctx.store.canUndo, false);
  ctx.store.redo(); assert.ok(Math.abs(ctx.store.document.roads[0]!.signals[0]!.s - 65) < 1e-6);
});

test('全部设施预设都可拖动，保留尺寸、灯方向和对象轮廓', () => {
  for (const [kind] of FURNITURE) {
    const { ctx, road, doc, event, tool } = setup();
    const source = addFurniture(doc, road, kind, { s: 40, t: -2 });
    const before = { ...source };
    tool.onPointerDown(ctx, event(449002, -962960));
    tool.onPointerMove(ctx, event(449003, -962950));
    tool.onPointerUp(ctx, event(449003, -962950));
    assert.ok(Math.abs(source.s - 50) < 1e-6, kind); assert.ok(Math.abs(source.t + 3) < 1e-6, kind);
    assert.deepEqual({ ...source, s: before.s, t: before.t }, before, kind);
  }
});

test('Esc、切换工具、无效落点和鼠标轻微抖动不写历史', () => {
  for (const cancel of ['escape', 'switch', 'invalid', 'jitter', 'return']) {
    const { ctx, road, doc, event, tool } = setup();
    addFurniture(doc, road, 'light'); const before = serializeOpenDrive(doc);
    tool.onPointerDown(ctx, event(449005, -962950));
    if (cancel !== 'jitter') tool.onPointerMove(ctx, event(449006, -962940));
    if (cancel === 'escape') tool.onKeyDown(ctx, { key: 'Escape' } as KeyboardEvent);
    if (cancel === 'switch') tool.onDeactivate(ctx);
    const end = cancel === 'invalid' ? event(450000, -962940)
      : cancel === 'jitter' ? event(449005.01, -962950)
      : cancel === 'return' ? event(449005, -962950) : event(449006, -962940);
    tool.onPointerUp(ctx, end);
    assert.equal(serializeOpenDrive(doc), before, cancel); assert.equal(ctx.store.canUndo, false, cancel);
  }
});

test('右键和中键不移动设施；隐藏设施不参与拾取', () => {
  for (const button of [1, 2]) {
    const { ctx, road, doc, event, tool } = setup(); addFurniture(doc, road, 'light');
    tool.onPointerDown(ctx, event(449005, -962950, button)); tool.onPointerMove(ctx, event(449007, -962940, button));
    tool.onPointerUp(ctx, event(449007, -962940, button)); assert.equal(ctx.store.canUndo, false);
  }
  const { ctx, road, doc, event, tool } = setup(); addFurniture(doc, road, 'light'); ctx.showFurniture = false;
  tool.onPointerDown(ctx, event(449005, -962950)); assert.deepEqual(ctx.store.selection, { kind: 'none' });
});

test('曲线道路和不同缩放下按可见尺寸拾取并计算新的 s/t', () => {
  const { ctx, road, doc, event, tool } = setup();
  road.planView = [{ type: 'arc', s: 0, x: 449000, y: -963000, hdg: 0, length: 100, curvature: 0.01 }];
  const source = addFurniture(doc, road, 'arrowLeft', { s: 20, t: -2 });
  (source as RoadObject).hdg = 0.7;
  for (const scale of [0.5, 8, 30]) {
    ctx.viewport.pixelsPerMeter = scale;
    const item = furnitureItems(road)[0]!;
    const p = ctx.viewport.worldToScreen(item);
    const offset = { x: p.x + Math.cos(item.heading) * scale * 1.8, y: p.y - Math.sin(item.heading) * scale * 1.8 };
    assert.equal(pickFurniture(doc, ctx.viewport, offset)?.sourceType, 'object');
  }
  const start = furnitureItems(road)[0]!;
  source.s = 60; source.t = -3; const target = furnitureItems(road)[0]!; source.s = 20; source.t = -2;
  tool.onPointerDown(ctx, event(start.x, start.y)); tool.onPointerUp(ctx, event(target.x, target.y));
  assert.ok(Math.abs(source.s - 60) < 1e-4); assert.ok(Math.abs(source.t + 3) < 1e-4);
});

test('不跳到相邻道路；拖动期间文档被替换时丢弃旧预览', () => {
  const { ctx, road, doc, event, tool } = setup();
  const source = addFurniture(doc, road, 'light');
  doc.roads.push(buildRoad('2', [{ ...road.planView[0]!, x: 449008 }], DEFAULT_TEMPLATE));
  tool.onPointerDown(ctx, event(449005, -962950)); tool.onPointerUp(ctx, event(449008, -962940));
  assert.ok(Math.abs(source.t + 8) < 1e-6); assert.equal(doc.roads[1]!.signals.length, 0);
  tool.onPointerDown(ctx, event(449008, -962940)); ctx.store.undo();
  tool.onPointerUp(ctx, event(449009, -962930));
  assert.equal(ctx.store.document.roads[0]!.signals[0]!.s, 50);
});

test('Delete 仅删除选中设施，清理信号控制引用并可撤销', () => {
  const { ctx, road, doc, event, tool } = setup();
  const source = addFurniture(doc, road, 'light');
  doc.controllers.push({ id: 'c1', controls: [{ signalId: source.id, type: '0' }] });
  tool.onPointerDown(ctx, event(449005, -962950)); tool.onPointerUp(ctx, event(449005, -962950));
  assert.equal(tool.onKeyDown(ctx, { key: 'Delete' } as KeyboardEvent), true);
  assert.equal(doc.roads.length, 1); assert.equal(road.signals.length, 0); assert.equal(doc.controllers.length, 0);
  ctx.store.undo(); assert.equal(ctx.store.document.roads[0]!.signals.length, 1); assert.equal(ctx.store.document.controllers.length, 1);
});
