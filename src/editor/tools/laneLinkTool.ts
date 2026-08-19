/**
 * 车道连接工具：在交叉口内逐条建立「进口车道 → 出口车道」。
 *
 *   N          新建空交叉口并设为当前
 *   点击       第一下选进口车道，第二下选出口车道，成对即建连接
 *   Tab        重叠手柄间轮换候选
 *   Esc        取消当前待连接的起点
 *
 * ── 为什么要有这个工具 ──
 *
 * 自动生成只能按几何猜车道配对，而渠化信息（哪条车道能左转、有无专用转向道、
 * 是否允许多车道同时左转）几何里没有。猜错了用户得逐条删，不如直接连。
 * 自动生成退化为交叉口面板上的「补全缺失转向」按钮。
 *
 * ── 当前交叉口 ──
 *
 * 工具不自己维护路口列表，当前路口取自 store 选区：选中某个 junction 就在它里面
 * 连，没选中时第一次连线自动新建一个。这样「新建路口 → 连线 → 切走 → 再回来接着连」
 * 不需要工具记住任何状态，回来只要重新选中那个路口。
 */

import { fromAngle, type Vec2 } from '../../core/math/vec.ts';
import { nextNumericId } from '../../core/model/document.ts';
import { createJunction } from '../../core/model/junction.ts';
import {
  addLanePair,
  laneHandlesNear,
  sameLaneRef,
  type LaneHandle,
  type LaneRef,
} from '../laneConnect.ts';
import type { PointerInput, Tool, ToolContext } from './types.ts';

/** 手柄命中容差（屏幕像素）。比端点吸附略大，车道中心比端点更难精确点中 */
const HANDLE_TOL_PX = 18;

export class LaneLinkTool implements Tool {
  readonly id = 'laneLink' as const;
  readonly label = '车道连接';
  readonly hint =
    'N 新建交叉口，点击进口车道再点出口车道建立连接，Tab 切换重叠手柄，Esc 取消';

  /** 待连接的起点（进口车道） */
  private pending: LaneHandle | null = null;
  /** 光标容差内的全部手柄，按距离升序 */
  private candidates: LaneHandle[] = [];
  private candidateIndex = 0;
  /** 最近一次光标位置，用于画待连接预览。不叫 cursor，那是 Tool 的方法名 */
  private cursorWorld: Vec2 | null = null;

  private get hover(): LaneHandle | null {
    return this.candidates[this.candidateIndex] ?? null;
  }

  private candidateKey(): string {
    return this.candidates.map((h) => `${h.ref.roadId}@${h.ref.end}.${h.ref.laneId}`).join(',');
  }

  onActivate(ctx: ToolContext): void {
    this.reset();
    ctx.requestRedraw();
  }

  onDeactivate(ctx: ToolContext): void {
    this.reset();
    ctx.requestRedraw();
  }

  private reset(): void {
    this.pending = null;
    this.candidates = [];
    this.candidateIndex = 0;
    this.cursorWorld = null;
  }

  /** 当前交叉口 id：取自选区，未选中则为 null */
  private currentJunction(ctx: ToolContext): string | null {
    const sel = ctx.store.selection;
    if (sel.kind === 'junction') return sel.junctionId;
    return null;
  }

  onPointerMove(ctx: ToolContext, e: PointerInput): void {
    this.cursorWorld = e.world;
    const tol = ctx.viewport.pixelsToMeters(HANDLE_TOL_PX);
    const prevKey = this.candidateKey();

    this.candidates = laneHandlesNear(ctx.store.document, e.world, tol);

    // 候选集合没变就保留 Tab 选好的下标，否则手一抖就跳回最近手柄
    if (this.candidateKey() !== prevKey) this.candidateIndex = 0;
    else if (this.candidateIndex >= this.candidates.length) this.candidateIndex = 0;

    ctx.requestRedraw();
  }

  onPointerDown(ctx: ToolContext, e: PointerInput): void {
    if (e.button !== 0) return;
    const h = this.hover;
    if (!h) return;

    // 再点一次待连接起点即取消
    if (this.pending && sameLaneRef(this.pending.ref, h.ref)) {
      this.pending = null;
      ctx.store.notify('info', '已取消起点');
      ctx.requestRedraw();
      return;
    }

    if (!this.pending) {
      if (h.flow !== 'entry') {
        ctx.store.notify(
          'warn',
          `${label(h.ref)} 是驶出路口的车道，请先点驶入路口的车道作为起点`,
        );
        return;
      }
      this.pending = h;
      ctx.store.notify('info', `起点 ${label(h.ref)}，请点选出口车道`);
      ctx.requestRedraw();
      return;
    }

    this.connect(ctx, this.pending.ref, h.ref);
  }

  /** 建立一条车道连接，必要时先新建交叉口 */
  private connect(ctx: ToolContext, from: LaneRef, to: LaneRef): void {
    let junctionId = this.currentJunction(ctx);

    // 未选中路口时自动新建，省掉「必须先按 N」这条无谓的门槛
    let created = false;
    if (junctionId === null) {
      junctionId = nextNumericId(ctx.store.document.junctions);
      created = true;
    }
    const jid = junctionId;

    let error: string | undefined;
    let roads = 0;
    ctx.store.mutate(() => {
      const doc = ctx.store.document;
      if (created) doc.junctions.push(createJunction(jid, `交叉口 ${jid}`));
      const res = addLanePair(doc, jid, { from, to }, ctx.template);
      error = res.error;
      roads = res.roads ?? 0;
      // 新建的空壳没连上任何东西时不该留下
      if (created && !res.ok) {
        doc.junctions = doc.junctions.filter((x) => x.id !== jid);
      }
    });

    if (error !== undefined) {
      ctx.store.notify('error', error);
      return;
    }

    this.pending = null;
    ctx.store.select({ kind: 'junction', junctionId: jid });
    ctx.invalidate();
    ctx.requestRedraw();
    ctx.store.notify(
      'info',
      `已连接 ${label(from)} → ${label(to)}${created ? `，新建交叉口 ${jid}` : ''}` +
        `（该路口现有 ${roads} 条连接道路）`,
    );
  }

  onKeyDown(ctx: ToolContext, e: KeyboardEvent): boolean {
    if (e.key === 'Escape') {
      if (this.pending) {
        this.pending = null;
        ctx.store.notify('info', '已取消起点');
        ctx.requestRedraw();
        return true;
      }
      return false;
    }

    if (e.key === 'n' || e.key === 'N') {
      const id = nextNumericId(ctx.store.document.junctions);
      ctx.store.mutate(() => {
        ctx.store.document.junctions.push(createJunction(id, `交叉口 ${id}`));
      });
      ctx.store.select({ kind: 'junction', junctionId: id });
      ctx.store.notify('info', `已新建交叉口 ${id}，现在点选车道建立连接`);
      ctx.requestRedraw();
      return true;
    }

    if (e.key === 'Tab' && this.candidates.length > 1) {
      const n = this.candidates.length;
      this.candidateIndex = (this.candidateIndex + (e.shiftKey ? n - 1 : 1)) % n;
      const h = this.hover!;
      ctx.store.notify(
        'info',
        `候选 ${this.candidateIndex + 1}/${n}：${label(h.ref)}（${h.flow === 'entry' ? '进' : '出'}）`,
      );
      ctx.requestRedraw();
      return true;
    }

    return false;
  }

  /**
   * 画车道端手柄。
   *
   * 进口画绿、出口画蓝，箭头指向车流方向——方向搞错是这个工具最容易犯的错
   * （右行制下 start 端接入时右侧车道反而是驶出的），把方向画出来比写在提示里有用。
   */
  draw(ctx: ToolContext, c: CanvasRenderingContext2D): void {
    const vp = ctx.viewport;

    // 待连接预览：从起点拉一条虚线到光标
    if (this.pending && this.cursorWorld) {
      const a = vp.worldToScreen(this.pending.pos);
      const b = vp.worldToScreen(this.hover?.pos ?? this.cursorWorld);
      c.save();
      c.strokeStyle = 'rgba(110,231,183,0.75)';
      c.lineWidth = 2;
      c.setLineDash([6, 4]);
      c.beginPath();
      c.moveTo(a.x, a.y);
      c.lineTo(b.x, b.y);
      c.stroke();
      c.restore();
    }

    for (let i = 0; i < this.candidates.length; i++) {
      const h = this.candidates[i]!;
      const p = vp.worldToScreen(h.pos);
      const active = i === this.candidateIndex;
      const isPending = this.pending !== null && sameLaneRef(this.pending.ref, h.ref);
      const color = h.flow === 'entry' ? '110,231,183' : '125,180,255';

      c.save();
      // 箭头：沿车流方向的一小段
      const tip = vp.worldToScreen(offset(h.pos, h.hdg, 4));
      c.strokeStyle = `rgba(${color},${active ? 0.95 : 0.45})`;
      c.lineWidth = active ? 2.5 : 1.5;
      c.beginPath();
      c.moveTo(p.x, p.y);
      c.lineTo(tip.x, tip.y);
      c.stroke();

      c.fillStyle = isPending
        ? 'rgba(255,214,102,0.95)'
        : `rgba(${color},${active ? 0.9 : 0.4})`;
      c.beginPath();
      c.arc(p.x, p.y, active || isPending ? 5.5 : 3.5, 0, Math.PI * 2);
      c.fill();

      if (active) {
        c.fillStyle = 'rgba(230,240,255,0.95)';
        c.font = '11px ui-monospace, monospace';
        c.fillText(`${label(h.ref)} ${h.flow === 'entry' ? '进' : '出'}`, p.x + 9, p.y - 7);
      }
      c.restore();
    }
  }

  cursor(): string {
    return 'crosshair';
  }
}

/** 沿指定航向平移若干米 */
function offset(p: Vec2, hdg: number, meters: number): Vec2 {
  const d = fromAngle(hdg, meters);
  return { x: p.x + d.x, y: p.y + d.y };
}

/** 车道的可读标识 */
function label(ref: LaneRef): string {
  return `R${ref.roadId}@${ref.end === 'start' ? '起' : '终'}.${ref.laneId}`;
}
