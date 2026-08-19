/**
 * 绘制工具：在影像上逐点点击生成道路。
 *
 *   左键点击     追加控制点（可吸附到既有道路端点/网格）
 *   双击 / 回车   完成绘制
 *   Backspace    撤掉上一个点
 *   右键 / Esc    放弃本次绘制
 *
 * 绘制过程中实时预览拟合结果，使用户即时看到缓和曲线与半径约束的效果。
 */

import { fitAlignment } from '../../core/geometry/alignment.ts';
import { evaluateGeometry } from '../../core/geometry/evaluate.ts';
import type { Geometry } from '../../core/geometry/types.ts';
import { distance, type Vec2 } from '../../core/math/vec.ts';
import { nextNumericId } from '../../core/model/document.ts';
import type { ContactPoint, Road } from '../../core/model/road.ts';
import { snapToGrid, snapToRoadEnds, type SnapTarget } from '../picking.ts';
import { buildRoadFromPoints } from '../roadFactory.ts';
import type { PointerInput, Tool, ToolContext } from './types.ts';

export class DrawTool implements Tool {
  readonly id = 'draw' as const;
  readonly label = '绘制道路';
  readonly hint = '左键加点，双击或回车完成，Backspace 退一点，右键或 Esc 取消';

  private points: Vec2[] = [];
  private hover: Vec2 | null = null;
  /** 首/末点吸附到的既有道路，用于自动建立连接 */
  private startSnap: SnapTarget | null = null;
  private endSnap: SnapTarget | null = null;

  onActivate(ctx: ToolContext): void {
    this.reset();
    ctx.store.select({ kind: 'none' });
  }

  onDeactivate(ctx: ToolContext): void {
    this.reset();
    ctx.requestRedraw();
  }

  private reset(): void {
    this.points = [];
    this.hover = null;
    this.startSnap = null;
    this.endSnap = null;
  }

  /**
   * 放弃本次绘制。右键与 Esc 共用，两者行为完全一致。
   *
   * 右键比 Esc 更容易误触，丢掉已点的控制点时给一句提示，
   * 免得用户以为是程序卡了。未开始绘制时静默返回。
   */
  private cancel(ctx: ToolContext): void {
    const discarded = this.points.length;
    if (discarded === 0) return;
    this.reset();
    ctx.store.notify('info', `已取消绘制（放弃 ${discarded} 个控制点）`);
    ctx.requestRedraw();
  }

  /** 应用吸附，返回落点与吸附目标 */
  private resolve(ctx: ToolContext, world: Vec2): { point: Vec2; snap: SnapTarget | null } {
    let p = world;
    let snap: SnapTarget | null = null;

    if (ctx.snap.toRoadEnds) {
      const tol = ctx.viewport.pixelsToMeters(ctx.snap.radiusPx);
      snap = snapToRoadEnds(p, ctx.store.document, tol);
      if (snap) return { point: snap.point, snap };
    }
    if (ctx.snap.toGrid) p = snapToGrid(p, ctx.snap.gridSpacing);
    return { point: p, snap: null };
  }

  onPointerDown(ctx: ToolContext, e: PointerInput): void {
    // 右键放弃本次绘制，与 Esc 等价（画布已屏蔽浏览器右键菜单）
    if (e.button === 2) {
      this.cancel(ctx);
      return;
    }
    if (e.button !== 0) return;
    const { point, snap } = this.resolve(ctx, e.world);

    // 与上一点重合则忽略，避免双击时误加重复点
    const prev = this.points[this.points.length - 1];
    if (prev && distance(prev, point) < ctx.viewport.pixelsToMeters(3)) return;

    if (this.points.length === 0) this.startSnap = snap;
    this.endSnap = snap;
    this.points.push(point);
    ctx.requestRedraw();
  }

  onPointerMove(ctx: ToolContext, e: PointerInput): void {
    if (this.points.length === 0) {
      this.hover = null;
      return;
    }
    this.hover = this.resolve(ctx, e.world).point;
    ctx.requestRedraw();
  }

  onDoubleClick(ctx: ToolContext, _e: PointerInput): void {
    this.finish(ctx);
  }

  onKeyDown(ctx: ToolContext, e: KeyboardEvent): boolean {
    if (e.key === 'Enter') {
      this.finish(ctx);
      return true;
    }
    if (e.key === 'Escape') {
      this.cancel(ctx);
      return true;
    }
    if (e.key === 'Backspace') {
      this.points.pop();
      if (this.points.length === 0) this.startSnap = null;
      ctx.requestRedraw();
      return true;
    }
    return false;
  }

  /** 提交道路 */
  private finish(ctx: ToolContext): void {
    if (this.points.length < 2) {
      if (this.points.length === 1) {
        ctx.store.notify('warn', '至少需要两个控制点');
      }
      return;
    }

    const doc = ctx.store.document;
    const id = nextNumericId(doc.roads);
    const built = buildRoadFromPoints(id, this.points, ctx.fit, ctx.template);

    if (!built) {
      ctx.store.notify('error', '线形拟合失败，请调整控制点');
      return;
    }

    const points = this.points.map((p) => ({ ...p }));
    const startSnap = this.startSnap;
    const endSnap = this.endSnap;

    ctx.store.mutate(() => {
      doc.roads.push(built.road);
      linkIfSnapped(doc.roads, built.road, startSnap, 'predecessor', ctx);
      linkIfSnapped(doc.roads, built.road, endSnap, 'successor', ctx);
    });

    ctx.store.setAlignment(id, { points, fit: { ...ctx.fit } });
    ctx.store.select({ kind: 'road', roadId: id });
    ctx.invalidate();

    if (built.degradedCorners.length > 0) {
      ctx.store.notify(
        'warn',
        `道路 ${id} 有 ${built.degradedCorners.length} 处转角因间距不足自动缩小了半径`,
      );
    } else {
      ctx.store.notify('info', `已创建道路 ${id}，长度 ${built.road.length.toFixed(2)} m`);
    }

    this.reset();
    ctx.requestRedraw();
  }

  /** 预览：控制折线 + 拟合结果 */
  draw(ctx: ToolContext, c: CanvasRenderingContext2D): void {
    if (this.points.length === 0) return;
    const vp = ctx.viewport;
    const preview = this.hover ? [...this.points, this.hover] : this.points;

    // 控制折线
    c.save();
    c.strokeStyle = 'rgba(120,200,255,0.5)';
    c.lineWidth = 1;
    c.setLineDash([4, 4]);
    c.beginPath();
    for (let i = 0; i < preview.length; i++) {
      const s = vp.worldToScreen(preview[i]!);
      if (i === 0) c.moveTo(s.x, s.y);
      else c.lineTo(s.x, s.y);
    }
    c.stroke();
    c.restore();

    // 拟合结果
    if (preview.length >= 2) {
      const result = fitAlignment(preview, ctx.fit);
      if (result.geometries.length > 0) {
        this.strokeGeometries(c, vp, result.geometries, ctx);
        this.drawLengthLabel(c, vp, result.geometries, result.totalLength);
      }
    }

    // 控制点
    c.save();
    for (let i = 0; i < preview.length; i++) {
      const s = vp.worldToScreen(preview[i]!);
      const isHover = this.hover !== null && i === preview.length - 1;
      c.beginPath();
      c.arc(s.x, s.y, isHover ? 4 : 5, 0, Math.PI * 2);
      c.fillStyle = isHover ? 'rgba(255,210,77,0.8)' : '#4da6ff';
      c.fill();
      c.lineWidth = 1.2;
      c.strokeStyle = '#12121a';
      c.stroke();
    }
    c.restore();
  }

  /** 描出拟合几何，并按图元类型着色以直观显示线形构成 */
  private strokeGeometries(
    c: CanvasRenderingContext2D,
    vp: ToolContext['viewport'],
    geometries: readonly Geometry[],
    ctx: ToolContext,
  ): void {
    const halfWidth =
      (ctx.template.laneWidth *
        (ctx.template.leftLanes + ctx.template.rightLanes +
          (ctx.template.sidewalk ? 2 : 0))) /
      2;

    c.save();
    for (const g of geometries) {
      const n = Math.max(2, Math.ceil(g.length / 1.5));
      const pts: Vec2[] = [];
      for (let i = 0; i <= n; i++) {
        const p = evaluateGeometry(g, (g.length * i) / n);
        pts.push({ x: p.x, y: p.y });
      }

      // 路幅预览（半透明宽带）
      c.strokeStyle = 'rgba(90,160,255,0.18)';
      c.lineWidth = Math.max(1, vp.metersToPixels(halfWidth * 2));
      c.lineCap = 'butt';
      c.setLineDash([]);
      strokePath(c, vp, pts);

      // 中心线，按图元类型区分颜色
      c.strokeStyle =
        g.type === 'line'
          ? 'rgba(120,220,255,0.95)'
          : g.type === 'arc'
            ? 'rgba(255,190,90,0.95)'
            : 'rgba(160,255,160,0.95)';
      c.lineWidth = 1.8;
      strokePath(c, vp, pts);
    }
    c.restore();
  }

  private drawLengthLabel(
    c: CanvasRenderingContext2D,
    vp: ToolContext['viewport'],
    geometries: readonly Geometry[],
    total: number,
  ): void {
    const last = geometries[geometries.length - 1];
    if (!last) return;
    const end = evaluateGeometry(last, last.length);
    const s = vp.worldToScreen({ x: end.x, y: end.y });

    const counts = new Map<string, number>();
    for (const g of geometries) counts.set(g.type, (counts.get(g.type) ?? 0) + 1);
    const parts = [...counts].map(([k, v]) => `${k}×${v}`).join(' ');
    const text = `${total.toFixed(1)} m  ${parts}`;

    c.save();
    c.font = '11px ui-monospace, monospace';
    const w = c.measureText(text).width;
    c.fillStyle = 'rgba(18,18,26,0.85)';
    c.fillRect(s.x + 10, s.y - 10, w + 8, 17);
    c.fillStyle = '#c8e8ff';
    c.textBaseline = 'middle';
    c.fillText(text, s.x + 14, s.y - 1);
    c.restore();
  }

  cursor(): string {
    return 'crosshair';
  }
}

function strokePath(
  c: CanvasRenderingContext2D,
  vp: ToolContext['viewport'],
  pts: readonly Vec2[],
): void {
  c.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const s = vp.worldToScreen(pts[i]!);
    if (i === 0) c.moveTo(s.x, s.y);
    else c.lineTo(s.x, s.y);
  }
  c.stroke();
}

/**
 * 端点吸附时自动建立道路间连接。
 *
 * 对方端点已被占用时不强行覆盖——那种情况需要建 junction 才合规，
 * 此处仅提示，避免生成拓扑非法的文件。
 */
function linkIfSnapped(
  roads: Road[],
  road: Road,
  snap: SnapTarget | null,
  which: 'predecessor' | 'successor',
  ctx: ToolContext,
): void {
  if (!snap) return;
  const other = roads.find((r) => r.id === snap.roadId);
  if (!other || other.id === road.id) return;

  const otherSide: 'predecessor' | 'successor' = snap.end === 'start' ? 'predecessor' : 'successor';
  if (other.link[otherSide]) {
    ctx.store.notify(
      'info',
      `道路 ${other.id} 的${snap.end === 'start' ? '起' : '终'}点已有连接，未自动关联；如需三岔以上请建立交叉口`,
    );
    return;
  }

  const contact: ContactPoint = snap.end;
  road.link[which] = {
    elementType: 'road',
    elementId: other.id,
    contactPoint: contact,
  };
  other.link[otherSide] = {
    elementType: 'road',
    elementId: road.id,
    contactPoint: which === 'predecessor' ? 'start' : 'end',
  };
}
