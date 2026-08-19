/**
 * 选择/编辑工具。
 *
 * 行为：
 *   左键点击      选择车道 / 道路 / 控制点
 *   左键拖控制点  实时重拟合该道路参考线（整个拖拽合并为一条撤销记录）
 *   中键 / 空格   平移视图
 *   Delete        删除选中道路
 */

import { distance, fromAngle, type Vec2 } from '../../core/math/vec.ts';
import { pickAll, pickControlPoint, snapToGrid, snapToRoadEnds } from '../picking.ts';
import { deleteRoad } from '../roadEdit.ts';
import { refitRoad } from '../roadFactory.ts';
import { referencePoint } from '../../core/model/reference.ts';
import { crossSectionAt, laneWidthAt, laneBoundaryAt } from '../../core/model/lanes.ts';
import { laneSectionRange, type Road } from '../../core/model/road.ts';
import { MIN_TAPER_LENGTH, taperLaneWidth, type TaperResult } from '../laneTaper.ts';
import type { PointerInput, Tool, ToolContext } from './types.ts';

type DragMode = 'none' | 'pan' | 'controlPoint' | 'taperStart' | 'taperEnd';

export class SelectTool implements Tool {
  readonly id = 'select' as const;
  readonly label = '选择';
  readonly hint = '点击选中；拖动方形控制点改线形；中键或按住空格平移；Delete 删除道路';

  private mode: DragMode = 'none';
  private lastScreen: Vec2 = { x: 0, y: 0 };
  private dragRoadId: string | null = null;
  private dragPointIndex = -1;
  private movedSinceDown = false;
  spacePressed = false;

  // 渐变拖拽状态
  private dragLaneId = 0;
  private dragSectionIndex = -1;
  private initialTaperStart = 0;
  private initialTaperLength = 0;
  private initialFromWidth = 0;
  private initialToWidth = 0;
  private dragStartWorld: Vec2 | null = null;
  private previewTaperStart = 0;  // 拖动时的预览参数
  private previewTaperLength = 0;

  onPointerDown(ctx: ToolContext, e: PointerInput): void {
    this.lastScreen = { ...e.screen };
    this.movedSinceDown = false;

    // 中键或空格拖拽 → 平移
    if (e.button === 1 || this.spacePressed) {
      this.mode = 'pan';
      return;
    }
    if (e.button !== 0) return;

    const tolMeters = ctx.viewport.pixelsToMeters(ctx.snap.radiusPx);
    const activeRoadId = ctx.store.selectedRoadId;
    const rec = activeRoadId ? ctx.store.getAlignment(activeRoadId) : undefined;

    // 优先命中控制点
    if (activeRoadId && rec) {
      const cp = pickControlPoint(e.world, activeRoadId, rec.points, tolMeters * 1.5);
      if (cp && cp.selection.kind === 'controlPoint') {
        ctx.store.select(cp.selection);
        this.mode = 'controlPoint';
        this.dragRoadId = activeRoadId;
        this.dragPointIndex = cp.selection.pointIndex;
        ctx.store.begin();
        return;
      }
    }

    // 检查渐变手柄（仅当选中车道时）
    const sel = ctx.store.selection;
    if (sel.kind === 'lane') {
      const road = ctx.store.document.roads.find((r) => r.id === sel.roadId);
      if (road) {
        const taperHandle = this.pickTaperHandle(ctx, road, sel.laneId, e.world, tolMeters);
        if (taperHandle) {
          this.mode = taperHandle.which === 'start' ? 'taperStart' : 'taperEnd';
          this.dragRoadId = sel.roadId;
          this.dragLaneId = sel.laneId;
          this.dragSectionIndex = taperHandle.sectionIndex;
          this.initialTaperStart = taperHandle.taperStart;
          this.initialTaperLength = taperHandle.taperLength;
          this.initialFromWidth = taperHandle.fromWidth;
          this.initialToWidth = taperHandle.toWidth;
          this.dragStartWorld = { ...e.world };
          // 初始化预览参数
          this.previewTaperStart = this.initialTaperStart;
          this.previewTaperLength = this.initialTaperLength;
          ctx.store.begin();
          return;
        }
      }
    }

    const picked = pickAll(e.world, ctx.renderData(), tolMeters, activeRoadId, rec?.points);
    ctx.store.select(picked);
    ctx.requestRedraw();
  }

  onPointerMove(ctx: ToolContext, e: PointerInput): void {
    const dx = e.screen.x - this.lastScreen.x;
    const dy = e.screen.y - this.lastScreen.y;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) this.movedSinceDown = true;

    if (this.mode === 'pan') {
      ctx.viewport.panByPixels(dx, dy);
      this.lastScreen = { ...e.screen };
      ctx.requestRedraw();
      return;
    }

    if (this.mode === 'controlPoint' && this.dragRoadId) {
      const rec = ctx.store.getAlignment(this.dragRoadId);
      const road = ctx.store.document.roads.find((r) => r.id === this.dragRoadId);
      if (!rec || !road) return;

      let target = e.world;
      if (ctx.snap.toGrid) target = snapToGrid(target, ctx.snap.gridSpacing);
      if (ctx.snap.toRoadEnds) {
        const snap = snapToRoadEnds(
          target,
          ctx.store.document,
          ctx.viewport.pixelsToMeters(ctx.snap.radiusPx),
          this.dragRoadId,
        );
        if (snap) target = snap.point;
      }

      const roadId = this.dragRoadId;
      const index = this.dragPointIndex;
      ctx.store.mutate(() => {
        rec.points[index] = { ...target };
        if (!refitRoad(road, rec.points, rec.fit)) {
          ctx.store.notify('warn', '当前控制点位置无法生成有效线形');
        }
      });
      ctx.invalidate(roadId);
      this.lastScreen = { ...e.screen };
      ctx.requestRedraw();
      return;
    }

    if ((this.mode === 'taperStart' || this.mode === 'taperEnd') && this.dragRoadId) {
      const road = ctx.store.document.roads.find((r) => r.id === this.dragRoadId);
      if (!road) return;

      const located = this.locateOnRoad(road, e.world);
      if (!located) return;

      // 计算预览参数（不修改文档）
      if (this.mode === 'taperStart') {
        const fixedEnd = this.initialTaperStart + this.initialTaperLength;
        this.previewTaperStart = Math.max(0, Math.min(fixedEnd - MIN_TAPER_LENGTH, located.s));
        this.previewTaperLength = fixedEnd - this.previewTaperStart;
      } else {
        const newEnd = Math.max(
          this.initialTaperStart + MIN_TAPER_LENGTH,
          Math.min(road.length, located.s),
        );
        this.previewTaperStart = this.initialTaperStart;
        this.previewTaperLength = newEnd - this.initialTaperStart;
      }

      this.previewTaperLength = Math.max(MIN_TAPER_LENGTH, this.previewTaperLength);
      this.lastScreen = { ...e.screen };
      ctx.requestRedraw();
    }
  }

  onPointerUp(ctx: ToolContext, e: PointerInput): void {
    if (this.mode === 'controlPoint') {
      ctx.store.commit();
    }

    if (this.mode === 'taperStart' || this.mode === 'taperEnd') {
      // 直接修改当前渐变段的宽度多项式，不重新切分
      const roadId = this.dragRoadId;
      const road = roadId ? ctx.store.document.roads.find((r) => r.id === roadId) : undefined;
      if (road && roadId && this.movedSinceDown && this.previewTaperLength > 0) {
        const laneId = this.dragLaneId;
        const sectionIdx = this.dragSectionIndex;

        ctx.store.mutate(() => {
          // 获取当前段
          const section = road.laneSections[sectionIdx];
          if (!section) return;

          const side = laneId > 0 ? section.left : section.right;
          const lane = side.find((l) => l.id === laneId);
          if (!lane || lane.widths.length === 0) return;

          // 更新段的起点位置
          section.s = this.previewTaperStart;

          // 重新计算渐变多项式系数
          const fromWidth = this.initialFromWidth;
          const toWidth = this.initialToWidth;
          const length = this.previewTaperLength;

          // 使用三次多项式：w(ds) = a + b·ds + c·ds² + d·ds³
          const delta = toWidth - fromWidth;
          const L = length;
          lane.widths = [{
            sOffset: 0,
            a: fromWidth,
            b: 0,
            c: (3 * delta) / (L * L),
            d: (-2 * delta) / (L * L * L),
          }];

          // 更新后续段的起点（如果有的话）
          if (sectionIdx + 1 < road.laneSections.length) {
            const nextSection = road.laneSections[sectionIdx + 1]!;
            nextSection.s = this.previewTaperStart + length;

            // 更新后续段的恒定宽度
            const nextSide = laneId > 0 ? nextSection.left : nextSection.right;
            const nextLane = nextSide.find((l) => l.id === laneId);
            if (nextLane && nextLane.widths.length > 0) {
              nextLane.widths = [{
                sOffset: 0,
                a: toWidth,
                b: 0,
                c: 0,
                d: 0,
              }];
            }
          }
        });

        ctx.invalidate(roadId);
        ctx.requestRedraw();
      }
      ctx.store.commit();
    }

    this.mode = 'none';
    this.dragRoadId = null;
    this.dragPointIndex = -1;
    this.dragLaneId = 0;
    this.dragSectionIndex = -1;
    this.dragStartWorld = null;
    this.previewTaperStart = 0;
    this.previewTaperLength = 0;
  }

  onKeyDown(ctx: ToolContext, e: KeyboardEvent): boolean {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const roadId = ctx.store.selectedRoadId;
      if (!roadId) return false;

      // 连带清理走 deleteRoad，与交叉口面板上的删除共用同一套引用清理
      let removed: string[] = [];
      let junctions: string[] = [];
      ctx.store.mutate(() => {
        const res = deleteRoad(ctx.store.document, roadId);
        removed = res.removedRoads;
        junctions = res.removedJunctions;
      });
      for (const id of removed) ctx.store.deleteAlignment(id);

      ctx.store.select({ kind: 'none' });
      ctx.invalidate();
      ctx.requestRedraw();

      // 连带删除的条数必须说出来，否则用户看不出图上少了一片连接道路
      const extra = removed.length - 1;
      let msg = `已删除道路 ${roadId}`;
      if (extra > 0) msg += `，连带移除 ${extra} 条连接道路`;
      if (junctions.length > 0) msg += `，交叉口 ${junctions.join('、')} 已无连接一并删除`;
      ctx.store.notify('info', msg);
      return true;
    }

    // 在选中道路上按 Insert 在最近处插入控制点
    if (e.key === 'Insert') {
      return this.insertControlPoint(ctx);
    }

    return false;
  }

  /** 在离视图中心最近的线段中点插入一个控制点 */
  private insertControlPoint(ctx: ToolContext): boolean {
    const roadId = ctx.store.selectedRoadId;
    if (!roadId) return false;
    const rec = ctx.store.getAlignment(roadId);
    const road = ctx.store.document.roads.find((r) => r.id === roadId);
    if (!rec || !road || rec.points.length < 2) return false;

    // 找最长的一段插入中点，通常最符合"加密控制点"的意图
    let bestIdx = 0;
    let bestLen = -1;
    for (let i = 0; i < rec.points.length - 1; i++) {
      const d = distance(rec.points[i]!, rec.points[i + 1]!);
      if (d > bestLen) {
        bestLen = d;
        bestIdx = i;
      }
    }
    const a = rec.points[bestIdx]!;
    const b = rec.points[bestIdx + 1]!;
    const mid: Vec2 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

    ctx.store.mutate(() => {
      rec.points.splice(bestIdx + 1, 0, mid);
      refitRoad(road, rec.points, rec.fit);
    });
    ctx.store.select({ kind: 'controlPoint', roadId, pointIndex: bestIdx + 1 });
    ctx.invalidate(roadId);
    ctx.requestRedraw();
    return true;
  }

  cursor(ctx: ToolContext): string {
    if (this.mode === 'pan' || this.spacePressed) return 'grabbing';
    if (this.mode === 'controlPoint' || this.mode === 'taperStart' || this.mode === 'taperEnd') {
      return 'grabbing';
    }
    return 'default';
  }

  draw(ctx: ToolContext, canvas: CanvasRenderingContext2D): void {
    // 绘制渐变拖拽预览
    if ((this.mode === 'taperStart' || this.mode === 'taperEnd') && this.dragRoadId && this.previewTaperLength > 0) {
      const road = ctx.store.document.roads.find((r) => r.id === this.dragRoadId);
      if (!road) return;

      // 计算预览手柄位置
      const startPos = this.taperHandlePosition(road, this.dragLaneId, this.previewTaperStart);
      const endPos = this.taperHandlePosition(road, this.dragLaneId, this.previewTaperStart + this.previewTaperLength);

      canvas.save();
      canvas.strokeStyle = '#ffd24d';
      canvas.lineWidth = 2;
      canvas.setLineDash([4, 4]);

      // 绘制预览手柄连线
      if (startPos && endPos) {
        const ss = ctx.viewport.worldToScreen(startPos);
        const se = ctx.viewport.worldToScreen(endPos);
        canvas.beginPath();
        canvas.moveTo(ss.x, ss.y);
        canvas.lineTo(se.x, se.y);
        canvas.stroke();
      }

      // 绘制预览手柄（黄色圆圈）
      canvas.setLineDash([]);
      if (startPos && ctx.viewport.isVisible(startPos)) {
        const s = ctx.viewport.worldToScreen(startPos);
        canvas.beginPath();
        canvas.arc(s.x, s.y, 7, 0, Math.PI * 2);
        canvas.fillStyle = 'rgba(255, 210, 77, 0.3)';
        canvas.fill();
        canvas.strokeStyle = '#ffd24d';
        canvas.lineWidth = 2;
        canvas.stroke();
      }

      if (endPos && ctx.viewport.isVisible(endPos)) {
        const s = ctx.viewport.worldToScreen(endPos);
        canvas.beginPath();
        canvas.arc(s.x, s.y, 7, 0, Math.PI * 2);
        canvas.fillStyle = 'rgba(255, 210, 77, 0.3)';
        canvas.fill();
        canvas.strokeStyle = '#ffd24d';
        canvas.lineWidth = 2;
        canvas.stroke();
      }

      canvas.restore();
    }
  }

  /**
   * 拾取渐变手柄：检测世界坐标是否在某个渐变段的起点或终点手柄附近。
   * 只对当前选中的车道生效。
   */
  private pickTaperHandle(
    ctx: ToolContext,
    road: Road,
    laneId: number,
    world: Vec2,
    tolerance: number,
  ): { which: 'start' | 'end'; sectionIndex: number; taperStart: number; taperLength: number; fromWidth: number; toWidth: number } | null {
    // 遍历所有车道段，找到该车道存在渐变的段
    for (let i = 0; i < road.laneSections.length; i++) {
      const section = road.laneSections[i]!;
      const range = laneSectionRange(road, i);
      const side = laneId > 0 ? section.left : section.right;
      const lane = side.find((l) => l.id === laneId);
      if (!lane || lane.widths.length === 0) continue;

      // 检测渐变：宽度记录超过1个，或单个记录是非常量多项式
      const w = lane.widths[0]!;
      const isTaper =
        lane.widths.length > 1 ||
        Math.abs(w.b) > 1e-6 ||
        Math.abs(w.c) > 1e-6 ||
        Math.abs(w.d) > 1e-6;

      if (!isTaper) continue;

      const taperStart = range.start;
      const taperLength = range.end - range.start;
      const fromWidth = laneWidthAt(lane, 0);
      const toWidth = laneWidthAt(lane, taperLength - 0.01);

      // 计算起点和终点的世界坐标（落在车道外边界上）
      const startHandle = this.taperHandlePosition(road, laneId, taperStart);
      const endHandle = this.taperHandlePosition(road, laneId, taperStart + taperLength);

      // 起点手柄优先：两者重合时拖起点更符合直觉
      if (startHandle && distance(world, startHandle) <= tolerance) {
        return { which: 'start', sectionIndex: i, taperStart, taperLength, fromWidth, toWidth };
      }
      if (endHandle && distance(world, endHandle) <= tolerance) {
        return { which: 'end', sectionIndex: i, taperStart, taperLength, fromWidth, toWidth };
      }
    }
    return null;
  }

  /**
   * 计算渐变手柄在世界坐标系中的位置（车道内边界中点）。
   */
  private taperHandlePosition(road: Road, laneId: number, s: number): Vec2 | null {
    const ref = referencePoint(road, s);
    const cs = crossSectionAt(road, s, ref);
    const boundary = laneBoundaryAt(road, laneId, s);
    if (!boundary) return null;

    const t = boundary.tInner;
    const left = fromAngle(ref.hdg + Math.PI / 2, t);
    return { x: ref.x + left.x, y: ref.y + left.y };
  }

  /**
   * 找到世界坐标在道路参考线上最近的站号（复用 SplitTool 的逻辑）。
   */
  private locateOnRoad(road: Road, world: Vec2): { s: number; point: Vec2 } | null {
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
    return { s, point: { x: rp.x, y: rp.y } };
  }
}
