/** 点击道路或路旁放置设施。先全路采样找局部区间，再精化，避免弯道/回头弯的局部极小值。 */
import { closestOnSegment, type Vec2 } from '../../core/math/vec.ts';
import { referencePoint, sampleStations } from '../../core/model/reference.ts';
import { crossSectionAt } from '../../core/model/lanes.ts';
import type { Road } from '../../core/model/road.ts';
import { addFurniture, drawFurnitureIcon, FURNITURE, groundPolygons, type FurnitureKind } from '../furniture.ts';
import type { PointerInput, Tool, ToolContext } from './types.ts';

const ROADSIDE_DISTANCE = 8; // 路面边缘以外允许放置的米数，不随缩放放大。
const END_TOLERANCE = 0.15;
export interface FurnitureLocation { road: Road; s: number; t: number; point: Vec2 }

export function locateFurniture(ctx: ToolContext, world: Vec2, roadId?: string): FurnitureLocation | null {
  let best: FurnitureLocation | null = null;
  let bestDistance = Infinity;
  for (const road of ctx.store.document.roads) {
    if (roadId !== undefined && road.id !== roadId) continue;
    if (!road.planView.length || road.length <= 0) continue;
    const stations = sampleStations(road, 0.03, 5);
    let lo = 0, hi = 0, distance = Infinity;
    for (let i = 1; i < stations.length; i++) {
      const a = referencePoint(road, stations[i - 1]!);
      const b = referencePoint(road, stations[i]!);
      const hit = closestOnSegment(world, a, b);
      if (hit.dist < distance) { distance = hit.dist; lo = a.s; hi = b.s; }
    }
    const squared = (s: number) => {
      const ref = referencePoint(road, s);
      return (world.x - ref.x) ** 2 + (world.y - ref.y) ** 2;
    };
    for (let i = 0; i < 44; i++) {
      const a = lo + (hi - lo) / 3, b = hi - (hi - lo) / 3;
      if (squared(a) < squared(b)) hi = b; else lo = a;
    }
    const s = (lo + hi) / 2, ref = referencePoint(road, s);
    const dx = world.x - ref.x, dy = world.y - ref.y;
    const along = dx * Math.cos(ref.hdg) + dy * Math.sin(ref.hdg);
    // 参考线端点以外无法用 s/t 表达原点击点，禁止静默挪到端点。
    if (Math.abs(along) > END_TOLERANCE) continue;
    const t = -dx * Math.sin(ref.hdg) + dy * Math.cos(ref.hdg);
    const cs = crossSectionAt(road, s, ref);
    const left = cs.left.at(-1)?.tOuter ?? cs.tCenter;
    const right = cs.right.at(-1)?.tOuter ?? cs.tCenter;
    if (t > left + ROADSIDE_DISTANCE || t < right - ROADSIDE_DISTANCE) continue;
    const d = Math.hypot(dx, dy);
    if (d < bestDistance - 0.001 || (Math.abs(d - bestDistance) <= 0.001 && road.id === ctx.store.selectedRoadId)) {
      bestDistance = d;
      best = { road, s, t, point: { x: ref.x - Math.sin(ref.hdg) * t, y: ref.y + Math.cos(ref.hdg) * t } };
    }
  }
  return best;
}

export class FurnitureTool implements Tool {
  readonly id = 'furniture' as const;
  readonly label = '交通设施';
  readonly hint = '选择设施类型，在道路或路旁单击放置；可连续添加，Esc 返回选择工具';
  kind: FurnitureKind = 'light';
  orientation: 'auto' | '+' | '-' = 'auto';
  private hover: FurnitureLocation | null = null;

  onDeactivate(ctx: ToolContext): void { this.hover = null; ctx.requestRedraw(); }
  onPointerMove(ctx: ToolContext, e: PointerInput): void {
    this.hover = locateFurniture(ctx, e.world); ctx.requestRedraw();
  }
  onPointerDown(ctx: ToolContext, e: PointerInput): void {
    if (e.button !== 0) return;
    const hit = locateFurniture(ctx, e.world);
    if (!hit) { ctx.store.notify('warn', '请在道路或路旁 8 米内放置设施，避开道路端点以外区域'); return; }
    const { road, s, t } = hit;
    ctx.store.mutate(() => {
      const source = addFurniture(ctx.store.document, road, this.kind, {
        s, t, ...(this.orientation === 'auto' ? {} : { orientation: this.orientation }),
      });
      ctx.store.select({ kind: 'furniture', roadId: road.id, furnitureId: source.id,
        sourceType: road.signals.includes(source) ? 'signal' : 'object' });
    });
    ctx.invalidate(road.id); ctx.requestRedraw();
    ctx.store.notify('info', `已添加${FURNITURE.find(([k]) => k === this.kind)![1]}：R${road.id}，s=${s.toFixed(2)}，t=${t.toFixed(2)}`);
  }
  draw(ctx: ToolContext, c: CanvasRenderingContext2D): void {
    if (!this.hover) return;
    const { road, s, t, point } = this.hover;
    const p = ctx.viewport.worldToScreen(point), ref = referencePoint(road, s);
    const reverse = this.orientation === '-' || (this.orientation === 'auto' && ((t > ref.laneOffset) !== (road.rule === 'LHT')));
    c.save(); c.translate(p.x, p.y); c.globalAlpha = 0.7;
    if (this.kind.startsWith('arrow') || this.kind === 'stopLine' || this.kind === 'crosswalk') {
      c.rotate(-ref.hdg - (reverse ? Math.PI : 0));
      c.scale(ctx.viewport.pixelsPerMeter * (this.kind === 'stopLine' ? 0.4 : 4), -ctx.viewport.pixelsPerMeter * (this.kind === 'crosswalk' ? 7 : 3));
      c.fillStyle = '#77e6bd';
      for (const poly of groundPolygons(this.kind)) {
        c.beginPath(); poly.forEach(([u,v], i) => { if (i === 0) c.moveTo(u!,v!); else c.lineTo(u!,v!); }); c.closePath(); c.fill();
      }
    } else { c.scale(26,26); drawFurnitureIcon(c, this.kind); }
    c.restore(); c.save();
    c.font = '12px sans-serif'; c.fillStyle = '#77e6bd';
    c.fillText(`R${road.id} s=${s.toFixed(1)} t=${t.toFixed(1)}`, p.x + 16, p.y - 18);
    c.restore();
  }
  cursor(): string { return 'crosshair'; }
}
