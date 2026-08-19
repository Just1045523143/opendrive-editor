/**
 * 辅助工具：量测、车道段切分。
 */

import { distance, normalizeAngle2Pi, type Vec2 } from '../../core/math/vec.ts';
import { referencePoint } from '../../core/model/reference.ts';
import { distanceToPolyline } from '../picking.ts';
import { splitLaneSection } from '../roadFactory.ts';
import type { PointerInput, Tool, ToolContext } from './types.ts';

/** 量测工具：两点间距离与方位角 */
export class MeasureTool implements Tool {
  readonly id = 'measure' as const;
  readonly label = '量测';
  readonly hint = '点击起点与终点量测距离；再次点击重新开始；Esc 清除';

  private a: Vec2 | null = null;
  private b: Vec2 | null = null;
  private hover: Vec2 | null = null;

  onDeactivate(ctx: ToolContext): void {
    this.a = null;
    this.b = null;
    this.hover = null;
    ctx.requestRedraw();
  }

  onPointerDown(ctx: ToolContext, e: PointerInput): void {
    if (e.button !== 0) return;
    if (this.a === null || this.b !== null) {
      this.a = { ...e.world };
      this.b = null;
    } else {
      this.b = { ...e.world };
    }
    ctx.requestRedraw();
  }

  onPointerMove(ctx: ToolContext, e: PointerInput): void {
    if (this.a !== null && this.b === null) {
      this.hover = { ...e.world };
      ctx.requestRedraw();
    }
  }

  onKeyDown(ctx: ToolContext, e: KeyboardEvent): boolean {
    if (e.key === 'Escape') {
      this.a = null;
      this.b = null;
      this.hover = null;
      ctx.requestRedraw();
      return true;
    }
    return false;
  }

  draw(ctx: ToolContext, c: CanvasRenderingContext2D): void {
    if (!this.a) return;
    const end = this.b ?? this.hover;
    if (!end) return;

    const vp = ctx.viewport;
    const p1 = vp.worldToScreen(this.a);
    const p2 = vp.worldToScreen(end);

    c.save();
    c.strokeStyle = '#ffd24d';
    c.lineWidth = 1.6;
    c.setLineDash([6, 4]);
    c.beginPath();
    c.moveTo(p1.x, p1.y);
    c.lineTo(p2.x, p2.y);
    c.stroke();
    c.setLineDash([]);

    for (const p of [p1, p2]) {
      c.beginPath();
      c.arc(p.x, p.y, 4, 0, Math.PI * 2);
      c.fillStyle = '#ffd24d';
      c.fill();
    }

    const d = distance(this.a, end);
    // 方位角：正北为 0，顺时针增大
    const bearing = normalizeAngle2Pi(Math.atan2(end.x - this.a.x, end.y - this.a.y));
    const text = `${d.toFixed(3)} m   方位 ${((bearing * 180) / Math.PI).toFixed(2)}°`;

    c.font = '12px ui-monospace, monospace';
    const w = c.measureText(text).width;
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    c.fillStyle = 'rgba(18,18,26,0.88)';
    c.fillRect(mx - w / 2 - 5, my - 20, w + 10, 18);
    c.fillStyle = '#ffd24d';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(text, mx, my - 11);
    c.restore();
  }

  cursor(): string {
    return 'crosshair';
  }
}

/** 车道段切分工具：在点击处按站号切出新的 laneSection */
export class SplitTool implements Tool {
  readonly id = 'split' as const;
  readonly label = '切分车道段';
  readonly hint = '点击道路上任意位置，在该站号处切分车道段（用于变宽、增减车道）';

  private preview: { roadId: string; s: number; point: Vec2 } | null = null;

  onDeactivate(ctx: ToolContext): void {
    this.preview = null;
    ctx.requestRedraw();
  }

  onPointerMove(ctx: ToolContext, e: PointerInput): void {
    this.preview = this.locate(ctx, e.world);
    ctx.requestRedraw();
  }

  onPointerDown(ctx: ToolContext, e: PointerInput): void {
    if (e.button !== 0) return;
    const hit = this.locate(ctx, e.world);
    if (!hit) {
      ctx.store.notify('warn', '未命中道路');
      return;
    }
    const road = ctx.store.document.roads.find((r) => r.id === hit.roadId);
    if (!road) return;

    let ok = false;
    ctx.store.mutate(() => {
      ok = splitLaneSection(road, hit.s);
    });

    if (ok) {
      ctx.invalidate(hit.roadId);
      ctx.store.select({ kind: 'road', roadId: hit.roadId });
      ctx.store.notify('info', `道路 ${hit.roadId} 已在 s=${hit.s.toFixed(2)} m 处切分`);
    } else {
      ctx.store.notify('warn', '该位置过于靠近端点或已存在车道段');
    }
    ctx.requestRedraw();
  }

  /** 找到最近道路并求出对应站号 */
  private locate(
    ctx: ToolContext,
    world: Vec2,
  ): { roadId: string; s: number; point: Vec2 } | null {
    const tol = ctx.viewport.pixelsToMeters(24);
    let bestRoad: string | null = null;
    let bestDist = Infinity;

    for (const data of ctx.renderData()) {
      const d = distanceToPolyline(world, data.referenceLine);
      if (d < bestDist && d <= tol * 3) {
        bestDist = d;
        bestRoad = data.roadId;
      }
    }
    if (!bestRoad) return null;

    const road = ctx.store.document.roads.find((r) => r.id === bestRoad);
    if (!road) return null;

    // 沿参考线粗采样后局部精化，求最近站号
    let bestS = 0;
    let bestSq = Infinity;
    const coarse = Math.max(32, Math.ceil(road.length / 2));
    for (let i = 0; i <= coarse; i++) {
      const s = (road.length * i) / coarse;
      const p = referencePoint(road, s);
      const sq = (p.x - world.x) ** 2 + (p.y - world.y) ** 2;
      if (sq < bestSq) {
        bestSq = sq;
        bestS = s;
      }
    }
    // 三分法精化
    let lo = Math.max(0, bestS - road.length / coarse);
    let hi = Math.min(road.length, bestS + road.length / coarse);
    for (let iter = 0; iter < 40 && hi - lo > 1e-4; iter++) {
      const m1 = lo + (hi - lo) / 3;
      const m2 = hi - (hi - lo) / 3;
      const p1 = referencePoint(road, m1);
      const p2 = referencePoint(road, m2);
      const d1 = (p1.x - world.x) ** 2 + (p1.y - world.y) ** 2;
      const d2 = (p2.x - world.x) ** 2 + (p2.y - world.y) ** 2;
      if (d1 < d2) hi = m2;
      else lo = m1;
    }
    const s = (lo + hi) / 2;
    const rp = referencePoint(road, s);
    return { roadId: bestRoad, s, point: { x: rp.x, y: rp.y } };
  }

  draw(ctx: ToolContext, c: CanvasRenderingContext2D): void {
    if (!this.preview) return;
    const road = ctx.store.document.roads.find((r) => r.id === this.preview!.roadId);
    if (!road) return;

    const ref = referencePoint(road, this.preview.s);
    const vp = ctx.viewport;
    // 画一条垂直于参考线的切分标记
    const nx = -Math.sin(ref.hdg);
    const ny = Math.cos(ref.hdg);
    const halfLen = 14;
    const a = vp.worldToScreen({ x: ref.x + nx * halfLen, y: ref.y + ny * halfLen });
    const b = vp.worldToScreen({ x: ref.x - nx * halfLen, y: ref.y - ny * halfLen });

    c.save();
    c.strokeStyle = '#ff6b9d';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(a.x, a.y);
    c.lineTo(b.x, b.y);
    c.stroke();

    const mid = vp.worldToScreen({ x: ref.x, y: ref.y });
    const text = `s = ${this.preview.s.toFixed(2)} m`;
    c.font = '11px ui-monospace, monospace';
    const w = c.measureText(text).width;
    c.fillStyle = 'rgba(18,18,26,0.88)';
    c.fillRect(mid.x + 8, mid.y - 9, w + 8, 16);
    c.fillStyle = '#ff6b9d';
    c.textBaseline = 'middle';
    c.fillText(text, mid.x + 12, mid.y - 1);
    c.restore();
  }

  cursor(): string {
    return 'crosshair';
  }
}
