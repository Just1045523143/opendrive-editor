import type { Vec2 } from '../../core/math/vec.ts';
import { referencePoint } from '../../core/model/reference.ts';
import type { FurnitureItem } from '../furniture.ts';
import { drawFurnitureItem, pickFurniture, selectedFurniture, type FurnitureSelection } from '../furnitureInteraction.ts';
import { locateFurniture, type FurnitureLocation } from './furnitureTool.ts';
import type { PointerInput, ToolContext } from './types.ts';

/** 仅预览拖动结果，松开时写入一次；不跨道路重挂信号和控制引用。 */
export class FurnitureDrag {
  private state: { selection: FurnitureSelection; item: FurnitureItem; start: Vec2; offset: Vec2;
    s: number; t: number; moved: boolean; target: FurnitureLocation | null } | null = null;
  get active(): boolean { return this.state !== null; }

  start(ctx: ToolContext, e: PointerInput): boolean {
    if (ctx.showFurniture === false) return false;
    const selection = pickFurniture(ctx.store.document, ctx.viewport, e.screen);
    if (!selection) return false;
    const hit = selectedFurniture(ctx.store.document, selection)!;
    this.state = { selection, item: hit.item, start: { ...e.screen },
      offset: { x: hit.item.x - e.world.x, y: hit.item.y - e.world.y },
      s: hit.item.source.s, t: hit.item.source.t, moved: false, target: null };
    ctx.store.select(selection); ctx.requestRedraw();
    return true;
  }
  move(ctx: ToolContext, e: PointerInput): void {
    const state = this.state;
    if (!state) return;
    const current = selectedFurniture(ctx.store.document, state.selection);
    if (!current || current.item.source !== state.item.source || current.item.source.s !== state.s || current.item.source.t !== state.t) {
      this.cancel(ctx); return;
    }
    if (Math.hypot(e.screen.x - state.start.x, e.screen.y - state.start.y) >= 3) state.moved = true;
    state.target = state.moved ? locateFurniture(ctx,
      { x: e.world.x + state.offset.x, y: e.world.y + state.offset.y }, state.selection.roadId) : null;
    ctx.requestRedraw();
  }
  finish(ctx: ToolContext, e: PointerInput): void {
    this.move(ctx, e);
    const state = this.state;
    this.state = null;
    if (state?.moved) {
      const target = state.target;
      if (!target) ctx.store.notify('warn', '拖动位置超出所属道路可放置范围，设施保持原位');
      // 大坐标曲线的投影会产生微米级误差，回到原位不应产生空撤销记录。
      else if (Math.abs(target.s - state.s) > 1e-4 || Math.abs(target.t - state.t) > 1e-4) {
        ctx.store.mutate(() => { state.item.source.s = target.s; state.item.source.t = target.t; });
        ctx.invalidate(state.selection.roadId);
      }
    }
    ctx.requestRedraw();
  }
  cancel(ctx: ToolContext): void { this.state = null; ctx.requestRedraw(); }
  draw(ctx: ToolContext, c: CanvasRenderingContext2D): void {
    const state = this.state;
    if (!state?.moved) return;
    const target = state.target;
    if (!target) return;
    const ref = referencePoint(target.road, target.s), original = referencePoint(target.road, state.s);
    const item = { ...state.item, x: target.point.x, y: target.point.y,
      z: ref.z + (state.item.source.zOffset ?? 0), heading: state.item.heading + ref.hdg - original.hdg };
    c.save(); c.globalAlpha = 0.7;
    drawFurnitureItem(c, ctx.viewport, item, true);
    const p = ctx.viewport.worldToScreen(item);
    c.fillStyle = '#ffd24d'; c.font = '12px sans-serif';
    c.fillText(`s=${target.s.toFixed(2)} t=${target.t.toFixed(2)}`, p.x + 20, p.y - 20);
    c.restore();
  }
}
