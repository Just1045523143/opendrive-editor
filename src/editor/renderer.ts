/**
 * 2D Canvas 渲染器。
 *
 * 绘制顺序：卫星影像 → 网格 → 路面 → 车道线 → 参考线 → 选中高亮 → 控制点 → 比例尺。
 *
 * 车道线的虚线间隔按**真实米制**换算成像素（而非固定屏幕像素），使缩放时
 * 线型比例与实际路面一致——这对判断标线是否合规很关键。
 */

import { evaluateGeometry } from '../core/geometry/evaluate.ts';
import { furnitureItems } from './furniture.ts';
import { drawFurnitureItem, selectedFurniture } from './furnitureInteraction.ts';
import type { Vec2 } from '../core/math/vec.ts';
import { fromAngle } from '../core/math/vec.ts';
import type { OdrDocument } from '../core/model/document.ts';
import { referencePoint } from '../core/model/reference.ts';
import { laneBoundaryAt } from '../core/model/lanes.ts';
import type { Road } from '../core/model/road.ts';
import type { Projector } from '../geo/projection.ts';
import {
  buildRoadRenderData,
  laneColor,
  markColor,
  type RoadRenderData,
} from './renderData.ts';
import type { Selection, Store } from './store.ts';
import type { TileLayer } from './tileLayer.ts';
import { niceScaleValue, type Viewport, type WorldBox } from './viewport.ts';

export interface RenderOptions {
  showTiles: boolean;
  showGrid: boolean;
  showLaneFill: boolean;
  showRoadMarks: boolean;
  showReferenceLine: boolean;
  showControlPoints: boolean;
  showLaneIds: boolean;
  showRoadIds: boolean;
  /** 交叉口范围与编号 */
  showJunctions: boolean;
  showFurniture: boolean;
  /** 采样弦高容差（米），越小越平滑越慢 */
  tolerance: number;
}

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  showTiles: true,
  showGrid: true,
  showLaneFill: true,
  showRoadMarks: true,
  showReferenceLine: true,
  showControlPoints: true,
  showLaneIds: false,
  showRoadIds: true,
  showJunctions: true,
  showFurniture: true,
  tolerance: 0.05,
};

/** 虚线线型（米）：[线长, 间隔] */
const DASH_PATTERNS: Record<string, [number, number]> = {
  broken: [3, 6],
  'broken broken': [3, 6],
  'botts dots': [0.6, 1.2],
};

export class Renderer {
  options: RenderOptions = { ...DEFAULT_RENDER_OPTIONS };

  private cache = new Map<string, RoadRenderData>();
  private cacheTolerance = DEFAULT_RENDER_OPTIONS.tolerance;

  constructor(
    private readonly store: Store,
    private readonly viewport: Viewport,
    private readonly tileLayer: TileLayer,
  ) {}

  /** 文档变更后清缓存 */
  invalidate(roadId?: string): void {
    if (roadId) this.cache.delete(roadId);
    else this.cache.clear();
  }

  private renderData(roadId: string): RoadRenderData | undefined {
    if (this.cacheTolerance !== this.options.tolerance) {
      this.cache.clear();
      this.cacheTolerance = this.options.tolerance;
    }
    const hit = this.cache.get(roadId);
    if (hit) return hit;
    const road = this.store.document.roads.find((r) => r.id === roadId);
    if (!road) return undefined;
    const data = buildRoadRenderData(road, this.options.tolerance);
    this.cache.set(roadId, data);
    return data;
  }

  draw(ctx: CanvasRenderingContext2D, projector: Projector | null): void {
    const vp = this.viewport;
    const w = vp.size.width * vp.dpr;
    const h = vp.size.height * vp.dpr;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#1a1a1f';
    ctx.fillRect(0, 0, w, h);

    // 后续绘制统一在 CSS 像素坐标下进行
    ctx.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);

    if (this.options.showTiles && projector) {
      this.tileLayer.draw(ctx, vp, projector);
    }

    if (this.options.showGrid) this.drawGrid(ctx);

    const doc = this.store.document;
    // junction 内的连接道路后画，使其压在主路之上，便于看清转向关系
    const ordered = [...doc.roads].sort((a, b) => {
      const ja = a.junction !== '-1' ? 1 : 0;
      const jb = b.junction !== '-1' ? 1 : 0;
      return ja - jb;
    });

    for (const road of ordered) {
      const data = this.renderData(road.id);
      if (!data) continue;
      if (!vp.intersectsBox(data.box, 64)) continue;
      this.drawRoad(ctx, data);
    }

    if (this.options.showJunctions) this.drawJunctions(ctx, doc);
    if (this.options.showFurniture) this.drawFurniture(ctx, doc);

    this.drawSelection(ctx, doc);
    if (this.options.showControlPoints) this.drawControlPoints(ctx);
    this.drawTaperHandles(ctx, doc);
    this.drawScaleBar(ctx);
  }

  /* ---------- 基础绘制工具 ---------- */

  private drawFurniture(ctx: CanvasRenderingContext2D, doc: OdrDocument): void {
    for (const road of doc.roads) for (const item of furnitureItems(road)) {
      const p = this.viewport.worldToScreen(item);
      if (p.x < -40 || p.y < -40 || p.x > this.viewport.size.width + 40 || p.y > this.viewport.size.height + 40) continue;
      drawFurnitureItem(ctx, this.viewport, item);
    }
  }

  private path(ctx: CanvasRenderingContext2D, pts: readonly Vec2[]): void {
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const s = this.viewport.worldToScreen(pts[i]!);
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    }
  }

  private strokePolyline(
    ctx: CanvasRenderingContext2D,
    pts: readonly Vec2[],
    color: string,
    widthPx: number,
    dashMeters?: [number, number],
  ): void {
    if (pts.length < 2) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = widthPx;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt';
    if (dashMeters) {
      const px = dashMeters.map((m) => Math.max(1, this.viewport.metersToPixels(m)));
      ctx.setLineDash(px);
    }
    this.path(ctx, pts);
    ctx.stroke();
    ctx.restore();
  }

  private fillPolygon(
    ctx: CanvasRenderingContext2D,
    pts: readonly Vec2[],
    color: string,
    alpha = 1,
  ): void {
    if (pts.length < 3) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    this.path(ctx, pts);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /* ---------- 路网绘制 ---------- */

  private drawRoad(ctx: CanvasRenderingContext2D, data: RoadRenderData): void {
    const vp = this.viewport;

    if (this.options.showLaneFill) {
      for (const poly of data.lanePolygons) {
        this.fillPolygon(ctx, poly.outline, laneColor(poly.laneType), 0.92);
      }
    }

    // 路面外缘描边，低缩放下也能看清路网走向
    const edgeWidth = Math.max(0.7, Math.min(1.6, vp.pixelsPerMeter * 0.12));
    this.strokePolyline(ctx, data.leftEdge, '#84848f', edgeWidth);
    this.strokePolyline(ctx, data.rightEdge, '#84848f', edgeWidth);

    if (this.options.showRoadMarks) {
      for (const m of data.roadMarks) {
        const widthM = m.mark.width && m.mark.width > 0 ? m.mark.width : 0.15;
        const widthPx = Math.max(1, vp.metersToPixels(widthM));
        const dash = DASH_PATTERNS[m.mark.type];
        this.strokePolyline(ctx, m.polyline, markColor(m.mark.color), widthPx, dash);
      }
    }

    if (this.options.showReferenceLine) {
      this.strokePolyline(ctx, data.referenceLine, 'rgba(255,140,60,0.55)', 1, [2, 3]);
    }

    if (this.options.showRoadIds && vp.pixelsPerMeter > 0.6) {
      this.drawRoadLabel(ctx, data);
    }

    if (this.options.showLaneIds && vp.pixelsPerMeter > 3) {
      this.drawLaneLabels(ctx, data);
    }
  }

  private drawRoadLabel(ctx: CanvasRenderingContext2D, data: RoadRenderData): void {
    const line = data.referenceLine;
    if (line.length === 0) return;
    const mid = line[Math.floor(line.length / 2)]!;
    const s = this.viewport.worldToScreen(mid);
    ctx.save();
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const text = `R${data.roadId}`;
    const w = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(20,20,26,0.75)';
    ctx.fillRect(s.x - w / 2 - 3, s.y - 8, w + 6, 15);
    ctx.fillStyle = '#ffb066';
    ctx.fillText(text, s.x, s.y);
    ctx.restore();
  }

  private drawLaneLabels(ctx: CanvasRenderingContext2D, data: RoadRenderData): void {
    ctx.save();
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(230,230,240,0.85)';
    for (const poly of data.lanePolygons) {
      const c = poly.centerline;
      if (c.length === 0) continue;
      const p = c[Math.floor(c.length / 2)]!;
      if (!this.viewport.isVisible(p)) continue;
      const s = this.viewport.worldToScreen(p);
      ctx.fillText(String(poly.laneId), s.x, s.y);
    }
    ctx.restore();
  }

  /* ---------- 交叉口 ---------- */

  /**
   * 交叉口标示：范围虚框 + 编号。
   *
   * 范围由该路口全部连接道路的包围盒并集得出——OpenDRIVE 不存储路口的几何
   * 边界，只有连接道路，故范围只能反推。
   */
  private drawJunctions(ctx: CanvasRenderingContext2D, doc: OdrDocument): void {
    const vp = this.viewport;

    for (const j of doc.junctions) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let count = 0;

      for (const road of doc.roads) {
        if (road.junction !== j.id) continue;
        const data = this.renderData(road.id);
        if (!data) continue;
        if (!Number.isFinite(data.box.minX)) continue;
        minX = Math.min(minX, data.box.minX);
        minY = Math.min(minY, data.box.minY);
        maxX = Math.max(maxX, data.box.maxX);
        maxY = Math.max(maxY, data.box.maxY);
        count++;
      }

      if (count === 0 || !Number.isFinite(minX)) continue;
      const box = { minX, minY, maxX, maxY };
      if (!vp.intersectsBox(box, 32)) continue;

      const tl = vp.worldToScreen({ x: minX, y: maxY });
      const br = vp.worldToScreen({ x: maxX, y: minY });

      ctx.save();
      ctx.strokeStyle = 'rgba(176,122,224,0.5)';
      ctx.lineWidth = 1.2;
      ctx.setLineDash([6, 5]);
      ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
      ctx.setLineDash([]);

      if (this.options.showRoadIds && vp.pixelsPerMeter > 0.4) {
        const text = `J${j.id} · ${j.connections.length} 连接`;
        ctx.font = '11px ui-monospace, monospace';
        const w = ctx.measureText(text).width;
        ctx.fillStyle = 'rgba(20,20,26,0.82)';
        ctx.fillRect(tl.x, tl.y - 17, w + 8, 16);
        ctx.fillStyle = '#c9a6f0';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, tl.x + 4, tl.y - 9);
      }
      ctx.restore();
    }
  }

  /* ---------- 选中高亮 ---------- */

  private drawSelection(ctx: CanvasRenderingContext2D, doc: OdrDocument): void {
    const sel: Selection = this.store.selection;
    if (sel.kind === 'none') return;
    if (sel.kind === 'furniture') {
      const hit = this.options.showFurniture ? selectedFurniture(doc, sel) : null;
      if (hit) drawFurnitureItem(ctx, this.viewport, hit.item, true);
      return;
    }

    if (sel.kind === 'road' || sel.kind === 'controlPoint') {
      const data = this.renderData(sel.roadId);
      if (!data) return;
      // 整条路面外缘加亮
      this.strokePolyline(ctx, data.leftEdge, '#4da6ff', 2.2);
      this.strokePolyline(ctx, data.rightEdge, '#4da6ff', 2.2);
      this.strokePolyline(ctx, data.referenceLine, 'rgba(77,166,255,0.9)', 1.4, [4, 3]);
      return;
    }

    if (sel.kind === 'lane') {
      const data = this.renderData(sel.roadId);
      if (!data) return;
      for (const poly of data.lanePolygons) {
        if (poly.laneId !== sel.laneId || poly.sectionIndex !== sel.sectionIndex) continue;
        this.fillPolygon(ctx, poly.outline, '#4da6ff', 0.35);
        this.strokePolyline(ctx, poly.outline, '#4da6ff', 1.8);
      }
      return;
    }

    if (sel.kind === 'geometry') {
      const road = doc.roads.find((r) => r.id === sel.roadId);
      if (!road) return;
      const g = road.planView[sel.geometryIndex];
      if (!g) return;
      // 直接对该图元采样，而非在参考线折线上按比例截取（采样在 s 上非均匀）
      const n = Math.max(2, Math.ceil(g.length / 2));
      const pts: Vec2[] = [];
      for (let i = 0; i <= n; i++) {
        const p = evaluateGeometry(g, (g.length * i) / n);
        pts.push({ x: p.x, y: p.y });
      }
      this.strokePolyline(ctx, pts, '#ffd24d', 3);
      return;
    }

    if (sel.kind === 'junction') {
      // 高亮该 junction 下所有连接道路
      for (const road of doc.roads) {
        if (road.junction !== sel.junctionId) continue;
        const data = this.renderData(road.id);
        if (!data) continue;
        for (const poly of data.lanePolygons) {
          this.fillPolygon(ctx, poly.outline, '#b07ae0', 0.3);
        }
      }
    }
  }

  /* ---------- 线形控制点 ---------- */

  private drawControlPoints(ctx: CanvasRenderingContext2D): void {
    const roadId = this.store.selectedRoadId;
    if (!roadId) return;
    const rec = this.store.getAlignment(roadId);
    if (!rec) return;

    const sel = this.store.selection;
    const activeIndex = sel.kind === 'controlPoint' ? sel.pointIndex : -1;

    // 控制点之间的辅助折线
    this.strokePolyline(ctx, rec.points, 'rgba(77,166,255,0.4)', 1, [3, 3]);

    ctx.save();
    for (let i = 0; i < rec.points.length; i++) {
      const s = this.viewport.worldToScreen(rec.points[i]!);
      const active = i === activeIndex;
      const r = active ? 6 : 4.5;
      ctx.beginPath();
      ctx.rect(s.x - r, s.y - r, r * 2, r * 2);
      ctx.fillStyle = active ? '#ffd24d' : '#4da6ff';
      ctx.fill();
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = '#12121a';
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ---------- 渐变手柄 ---------- */

  /**
   * 绘制车道渐变的拖拽手柄（仅当选中车道时）。
   *
   * 每个渐变段显示两个手柄：起点（圆形）和终点（圆形），落在车道外边界上。
   */
  drawTaperHandles(ctx: CanvasRenderingContext2D, doc: OdrDocument): void {
    const sel = this.store.selection;
    if (sel.kind !== 'lane') return;

    const road = doc.roads.find((r) => r.id === sel.roadId);
    if (!road) return;

    ctx.save();
    for (let i = 0; i < road.laneSections.length; i++) {
      const section = road.laneSections[i]!;
      const side = sel.laneId > 0 ? section.left : section.right;
      const lane = side.find((l) => l.id === sel.laneId);
      if (!lane || lane.widths.length === 0) continue;

      // 检测渐变：宽度记录超过1个，或单个记录是非常量多项式
      const w = lane.widths[0]!;
      const isTaper =
        lane.widths.length > 1 ||
        Math.abs(w.b) > 1e-6 ||
        Math.abs(w.c) > 1e-6 ||
        Math.abs(w.d) > 1e-6;

      if (!isTaper) continue;

      // 渐变的实际范围：段的起点和终点
      const sStart = section.s;
      const sEnd = i < road.laneSections.length - 1 ? road.laneSections[i + 1]!.s : road.length;

      // 段太短时两个手柄会叠在一起，画一个就够
      if (sEnd - sStart < 0.5) continue;

      this.drawTaperHandle(ctx, road, sel.laneId, sStart, '#6EE7B7');
      this.drawTaperHandle(ctx, road, sel.laneId, sEnd, '#FF6B6B');
    }
    ctx.restore();
  }

  private drawTaperHandle(
    ctx: CanvasRenderingContext2D,
    road: Road,
    laneId: number,
    s: number,
    color: string,
  ): void {
    const ref = referencePoint(road, s);
    const boundary = laneBoundaryAt(road, laneId, s);
    if (!boundary) return;

    const t = boundary.tInner;
    const left = fromAngle(ref.hdg + Math.PI / 2, t);
    const world = { x: ref.x + left.x, y: ref.y + left.y };

    if (!this.viewport.isVisible(world)) return;

    const screen = this.viewport.worldToScreen(world);
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, 7, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#0a0d12';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  /* ---------- 网格与比例尺 ---------- */

  private drawGrid(ctx: CanvasRenderingContext2D): void {
    const vp = this.viewport;
    // 目标：网格线间距约 80 屏幕像素
    const spacing = niceScaleValue(vp.pixelsToMeters(80));
    const box: WorldBox = vp.visibleBox();

    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.beginPath();

    const x0 = Math.floor(box.minX / spacing) * spacing;
    for (let x = x0; x <= box.maxX; x += spacing) {
      const a = vp.worldToScreen({ x, y: box.minY });
      const b = vp.worldToScreen({ x, y: box.maxY });
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }

    const y0 = Math.floor(box.minY / spacing) * spacing;
    for (let y = y0; y <= box.maxY; y += spacing) {
      const a = vp.worldToScreen({ x: box.minX, y });
      const b = vp.worldToScreen({ x: box.maxX, y });
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }

    ctx.stroke();
    ctx.restore();
  }

  private drawScaleBar(ctx: CanvasRenderingContext2D): void {
    const vp = this.viewport;
    const targetPx = 120;
    const meters = niceScaleValue(vp.pixelsToMeters(targetPx));
    const px = vp.metersToPixels(meters);

    const x = 16;
    const y = vp.size.height - 24;

    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.moveTo(x, y - 5);
    ctx.lineTo(x, y);
    ctx.lineTo(x + px, y);
    ctx.lineTo(x + px, y - 5);
    ctx.stroke();

    ctx.font = '11px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    const label = meters >= 1000 ? `${meters / 1000} km` : `${meters} m`;
    ctx.fillText(label, x, y - 7);
    ctx.restore();
  }
}
