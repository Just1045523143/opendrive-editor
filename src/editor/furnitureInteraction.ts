/** 设施在俯视画布中的绘制和拾取共用相同尺寸、朝向。 */
import { drawFurnitureIcon, furnitureItems, groundPolygons, type FurnitureItem } from './furniture.ts';
import type { OdrDocument } from '../core/model/document.ts';
import type { Road } from '../core/model/road.ts';
import type { Vec2 } from '../core/math/vec.ts';
import type { Selection } from './store.ts';
import type { Viewport } from './viewport.ts';

export type FurnitureSelection = Extract<Selection, { kind: 'furniture' }>;
export function furnitureSelection(road: Road, item: FurnitureItem): FurnitureSelection {
  return { kind: 'furniture', roadId: road.id, furnitureId: item.source.id,
    sourceType: road.signals.includes(item.source) ? 'signal' : 'object' };
}
export function selectedFurniture(doc: OdrDocument, sel: Selection): { road: Road; item: FurnitureItem } | null {
  if (sel.kind !== 'furniture') return null;
  const road = doc.roads.find(r => r.id === sel.roadId);
  if (!road) return null;
  const source = (sel.sourceType === 'signal' ? road.signals : road.objects).find(o => o.id === sel.furnitureId);
  const item = furnitureItems(road).find(i => i.source === source);
  return item ? { road, item } : null;
}

export function pickFurniture(doc: OdrDocument, vp: Viewport, screen: Vec2): FurnitureSelection | null {
  let best: FurnitureSelection | null = null, score = Infinity;
  // 后绘制的对象在重叠时优先。
  for (const road of doc.roads) for (const item of furnitureItems(road)) {
    const p = vp.worldToScreen(item), dx = screen.x - p.x, dy = screen.y - p.y;
    let hit: boolean;
    if (item.ground) {
      const u = dx * Math.cos(item.heading) - dy * Math.sin(item.heading);
      const v = dx * Math.sin(item.heading) + dy * Math.cos(item.heading);
      hit = Math.abs(u) <= item.length * vp.pixelsPerMeter / 2 + 4
        && Math.abs(v) <= item.width * vp.pixelsPerMeter / 2 + 4;
    } else hit = Math.abs(dx) <= 16 && Math.abs(dy) <= 16;
    const d = Math.hypot(dx, dy);
    if (hit && d <= score) { best = furnitureSelection(road, item); score = d; }
  }
  return best;
}

export function drawFurnitureItem(ctx: CanvasRenderingContext2D, vp: Viewport, item: FurnitureItem, selected = false): void {
  const p = vp.worldToScreen(item);
  ctx.save(); ctx.translate(p.x, p.y);
  if (item.ground) {
    ctx.rotate(-item.heading);
    const length = vp.pixelsPerMeter * item.length, width = vp.pixelsPerMeter * item.width;
    if (selected) {
      ctx.strokeStyle = '#ffd24d'; ctx.lineWidth = 2;
      ctx.strokeRect(-length / 2 - 4, -width / 2 - 4, length + 8, width + 8);
    }
    ctx.scale(length, -width); ctx.fillStyle = '#ffffff';
    for (const poly of groundPolygons(item.kind)) {
      ctx.beginPath(); poly.forEach(([u, v], i) => { if (i === 0) ctx.moveTo(u!, v!); else ctx.lineTo(u!, v!); });
      ctx.closePath(); ctx.fill();
    }
  } else {
    if (selected) { ctx.strokeStyle = '#ffd24d'; ctx.lineWidth = 2; ctx.strokeRect(-17, -17, 34, 34); }
    ctx.scale(26, 26); drawFurnitureIcon(ctx, item.kind, item.value);
  }
  ctx.restore();
}
