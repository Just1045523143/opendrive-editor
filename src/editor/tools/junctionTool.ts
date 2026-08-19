/**
 * 交叉口工具：点选多条道路端点，按启发式一次生成 junction 与全部转向连接。
 *
 *   点击端点     加入/移出待连接集合
 *   Tab          重叠端点间轮换候选
 *   回车 / 空格   生成交叉口
 *   Esc          清空选区
 *
 * ── 它是便利入口，不是唯一通路 ──
 *
 * 车道配对在这里只能按几何猜（右转取最外侧、左转取最内侧……），而哪条车道能
 * 左转、有没有专用转向道、是否允许多车道同时左转，全由渠化决定，几何里没有这个
 * 信息。所以真实渠化请用车道连接工具逐条连（见 laneConnect.ts），本工具适合
 * 规则十字口的快速铺底，铺完再逐条改。
 *
 * 几何与横向定位的规则全在 connector.ts，与手工连线共用一份实现——那几条规则
 * 极易写错，复制出去必然漂移。
 *
 * ── 关键语义（ASAM OpenDRIVE 第 10 章）──
 *
 * 1. 进/出车道由「哪一端接入路口」决定。右行制下负 id 车道沿 +s 行驶，故
 *    某道路以 end 端接入时，右侧车道是**驶入**路口的；以 start 端接入时，
 *    右侧车道反而是**驶出**的，此时进口车道为左侧（正 id）。
 *
 * 2. `<laneLink from to>` 的 to 指向**连接道路自身**的车道 id，而非目标道路
 *    的车道。目标侧的车道衔接由连接道路各车道的 `<link><successor>` 表达。
 *
 * 3. `road@junction` 只标记「本路是该 junction 的连接道路」。入口道路不属于
 *    junction，其 junction 必须保持 -1，仅通过 link 指向 junction。
 */

import { distance, fromAngle, normalizeAngle, type Vec2 } from '../../core/math/vec.ts';
import { isEndOccupied, nextNumericId } from '../../core/model/document.ts';
import {
  createJunction,
  type Junction,
  type JunctionConnection,
  type TurnKind,
} from '../../core/model/junction.ts';
import type { ContactPoint, Road } from '../../core/model/road.ts';
import {
  buildConnector,
  classifyTurn,
  makeArmEnd,
  suggestPairs,
  tToWorld,
  MIN_CONNECTOR_SPAN,
  type ArmEnd,
} from '../connector.ts';
import { snapToRoadEndsAll } from '../picking.ts';
import type { PointerInput, Tool, ToolContext } from './types.ts';

/** 一条待生成的转向 */
interface ConnectionPlan {
  road: Road;
  connection: JunctionConnection;
  turn: TurnKind;
}

export class JunctionTool implements Tool {
  readonly id = 'junction' as const;
  readonly label = '交叉口';
  readonly hint = '点击道路端点选中（≥3 个），Tab 切换重叠端点，回车生成交叉口，Esc 清空';

  private arms: ArmEnd[] = [];
  /** 光标容差内的全部端点候选，按距离升序 */
  private candidates: ArmEnd[] = [];
  /** 当前生效的候选下标，由 Tab 轮换 */
  private candidateIndex = 0;

  /** 当前指向的路臂即候选列表中被选中的那个 */
  private get hover(): ArmEnd | null {
    return this.candidates[this.candidateIndex] ?? null;
  }

  /** 候选集合的身份，用于判断鼠标微动后是否还是同一批端点 */
  private candidateKey(): string {
    return this.candidates.map((a) => `${a.roadId}@${a.end}`).join(',');
  }

  onActivate(ctx: ToolContext): void {
    this.reset();
    ctx.store.select({ kind: 'none' });
  }

  onDeactivate(ctx: ToolContext): void {
    this.reset();
    ctx.requestRedraw();
  }

  private reset(): void {
    this.arms = [];
    this.candidates = [];
    this.candidateIndex = 0;
  }

  /* ---------- 交互 ---------- */

  onPointerMove(ctx: ToolContext, e: PointerInput): void {
    const tol = ctx.viewport.pixelsToMeters(ctx.snap.radiusPx * 1.6);
    const prevKey = this.candidateKey();

    this.candidates = snapToRoadEndsAll(e.world, ctx.store.document, tol)
      .map((s) => this.makeArm(ctx, s.roadId, s.end))
      .filter((a): a is ArmEnd => a !== null);

    // 候选集合没变就保留 Tab 选好的下标，否则手一抖就跳回最近端点
    if (this.candidateKey() !== prevKey) this.candidateIndex = 0;
    else if (this.candidateIndex >= this.candidates.length) this.candidateIndex = 0;

    ctx.requestRedraw();
  }

  onPointerDown(ctx: ToolContext, e: PointerInput): void {
    if (e.button !== 0 || !this.hover) return;
    const h = this.hover;
    const name = `R${h.roadId}@${h.end === 'start' ? '起' : '终'}`;
    const idx = this.arms.findIndex((a) => a.roadId === h.roadId && a.end === h.end);
    if (idx >= 0) {
      this.arms.splice(idx, 1);
      // 端点重叠时很容易点到已选中的那个，取消选中必须说一声
      ctx.store.notify('info', `已移出 ${name}，当前选中 ${this.arms.length} 条路臂`);
    } else {
      this.arms.push(h);
      ctx.store.notify(
        'info',
        `已选中 ${name}（进${h.entry.length}/出${h.exit.length}），共 ${this.arms.length} 条路臂`,
      );
    }
    ctx.requestRedraw();
  }

  onKeyDown(ctx: ToolContext, e: KeyboardEvent): boolean {
    if (e.key === 'Escape') {
      this.reset();
      ctx.requestRedraw();
      return true;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      this.commit(ctx);
      return true;
    }
    // 重叠端点靠 Tab 轮换：屏幕上重合的参考线光靠移鼠标区分不开
    if (e.key === 'Tab' && this.candidates.length > 1) {
      const n = this.candidates.length;
      this.candidateIndex = (this.candidateIndex + (e.shiftKey ? n - 1 : 1)) % n;
      const h = this.hover!;
      ctx.store.notify(
        'info',
        `候选 ${this.candidateIndex + 1}/${n}：R${h.roadId}@${h.end === 'start' ? '起' : '终'}`,
      );
      ctx.requestRedraw();
      return true;
    }
    return false;
  }

  /** 由道路端点构造路臂。进/出车道判定与车道类型筛选在 connector.ts 内 */
  private makeArm(ctx: ToolContext, roadId: string, end: ContactPoint): ArmEnd | null {
    const road = ctx.store.document.roads.find((r) => r.id === roadId);
    if (!road) return null;
    return makeArmEnd(road, end);
  }

  /* ---------- 生成 ---------- */

  private commit(ctx: ToolContext): void {
    if (this.arms.length < 3) {
      ctx.store.notify('warn', `交叉口至少需要 3 条路臂，当前选中 ${this.arms.length} 条`);
      return;
    }

    // 端点已被占用的路臂无法接入（需先断开原有连接）。
    // 判据不能只看 link 存不存在：指向已删除路口的悬空 link 会让端点永判占用，
    // 用户明明删光了连接却再也建不了新路口，详见 isEndOccupied。
    const occupied = this.arms.filter((a) => {
      const road = ctx.store.document.roads.find((r) => r.id === a.roadId);
      if (!road) return false;
      return isEndOccupied(ctx.store.document, road, a.end);
    });
    if (occupied.length > 0) {
      const list = occupied.map((a) => `R${a.roadId}@${a.end}`).join('、');
      ctx.store.notify('error', `以下端点已有连接，请先删除后重试：${list}`);
      return;
    }

    // 全部路臂都挤在一点时必须在成方案之前拦下：掉头连接的起终点相隔一个车道宽，
    // 就算所有路臂重合它也能通过退化检查，于是会写出一个只有掉头的畸形路口。
    //
    // 判据是**最大**间距而非最小。只要有一对路臂离得够开，那一对就能生成正常
    // 转向，不该因为另有一对端点重合（相邻路段在分割点处、或吸附到同一点）
    // 就否决整个路口——重合的那一对由 buildConnectingRoad 逐条跳过即可。
    if (this.maxArmSpan() < MIN_CONNECTOR_SPAN) {
      ctx.store.notify('error', this.diagnose());
      return;
    }

    // 先纯计算出全部方案，确认可行再落库——避免中途失败留下半成品
    const plan = this.planConnections(ctx);

    if (plan.length === 0) {
      ctx.store.notify('error', this.diagnose());
      return;
    }

    const juncId = nextNumericId(ctx.store.document.junctions);
    const junction: Junction = createJunction(juncId, `交叉口 ${juncId}`);
    for (const p of plan) {
      p.road.junction = juncId;
      junction.connections.push(p.connection);
    }

    // 支路让行：车道数少的路臂优先级低
    junction.priorities = this.derivePriorities();

    const armSnapshot = this.arms.map((a) => ({ roadId: a.roadId, end: a.end }));

    ctx.store.mutate(() => {
      const doc = ctx.store.document;
      doc.junctions.push(junction);
      doc.roads.push(...plan.map((p) => p.road));

      // 入口道路仅链接到 junction，其 junction 属性保持 -1（非连接道路）
      for (const a of armSnapshot) {
        const road = doc.roads.find((r) => r.id === a.roadId);
        if (!road) continue;
        road.link[a.end === 'start' ? 'predecessor' : 'successor'] = {
          elementType: 'junction',
          elementId: juncId,
        };
      }
    });

    const counts = plan.reduce<Record<TurnKind, number>>(
      (acc, p) => {
        acc[p.turn]++;
        return acc;
      },
      { left: 0, straight: 0, right: 0, uturn: 0 },
    );

    ctx.store.select({ kind: 'junction', junctionId: juncId });
    ctx.invalidate();
    const parts = [`直行 ${counts.straight}`, `左转 ${counts.left}`, `右转 ${counts.right}`];
    // 掉头未必都需要，单列出来便于用户核对后删掉不该有的
    if (counts.uturn > 0) parts.push(`掉头 ${counts.uturn}`);
    ctx.store.notify(
      'info',
      `已生成交叉口 ${juncId}：${plan.length} 条连接道路（${parts.join('、')}）`,
    );

    // 重合的路臂对被静默跳过，不说一声用户只会觉得「生成的连接不全」
    const coincident = this.coincidentPairs();
    if (coincident.length > 0) {
      ctx.store.notify(
        'warn',
        `以下路臂端点几乎重合，其间的转向已跳过：${coincident.join('、')}。` +
          '如需这些转向，请把端点退到路缘石位置留出路口空间。',
      );
    }

    this.reset();
    ctx.requestRedraw();
  }

  /** 枚举所有有序路臂对，生成可行转向方案 */
  private planConnections(ctx: ToolContext): ConnectionPlan[] {
    const plan: ConnectionPlan[] = [];
    // 已分配的 id 需连同待新建道路一起计数，否则会重号
    const allocated: Array<{ id: string }> = [...ctx.store.document.roads];

    for (const from of this.arms) {
      for (const to of this.arms) {
        // 同一路臂只允许掉头（双向路进出口在参考线两侧，是合法的掉头）
        const turn = classifyTurn(from, to);

        const pairs = this.pairLanes(from, to, turn);
        if (pairs.length === 0) continue;

        const roadId = nextNumericId(allocated);
        allocated.push({ id: roadId });

        const built = buildConnector(roadId, from, to, pairs, ctx.template);
        if (!built) continue;

        plan.push({
          road: built,
          turn,
          connection: {
            // connection id 只需在本 junction 内唯一
            id: String(plan.length),
            incomingRoad: from.roadId,
            connectingRoad: roadId,
            contactPoint: 'start',
            laneLinks: pairs.map((p, i) => ({ from: p.entry.laneId, to: -(i + 1) })),
          },
        });
      }
    }

    return plan;
  }

  /**
   * 车道配对：按转向类别取启发式建议。
   *
   * 配对结果必须是**从最内侧起连续的若干条**，buildConnector 的横向定位依赖
   * 这一点：它把参考线放在 pairs[0] 的内边界上。
   */
  private pairLanes(from: ArmEnd, to: ArmEnd, turn: TurnKind) {
    return suggestPairs(from, to, turn);
  }

  /**
   * 一条转向都生成不出来时，指出到底是哪个环节卡住。
   *
   * 笼统说「无可行转向」等于让用户去猜。最常见的真实原因是单向路选错了端点：
   * 单向路以 start 端接入时进口车道数为 0（右侧车道此时是驶出的），
   * 这种情况下它只能当出口臂，几条单向路若全是进口或全是出口就配不出转向。
   */
  private diagnose(): string {
    // 同样看最大间距：只有连最远的一对都挨在一起，才是「全都挤在一点」。
    // 用最小间距会把「有一对重合、其余正常」误报成端点重合，让用户去挪本来
    // 没问题的端点。
    const maxSpan = this.maxArmSpan();
    if (maxSpan < MIN_CONNECTOR_SPAN) {
      return (
        `所选路臂端点全都挤在一点（最远仅相距 ${maxSpan.toFixed(2)} m），无法生成路口。` +
        '请先把各进口道的端点退到路缘石位置，留出路口空间。'
      );
    }

    // entry/exit 在 makeArm 里已按类型与宽度筛过，这里直接看条数
    const noEntry = this.arms.filter((a) => a.entry.length === 0);
    const noExit = this.arms.filter((a) => a.exit.length === 0);
    const name = (a: ArmEnd) => `R${a.roadId}@${a.end === 'start' ? '起' : '终'}`;

    if (noEntry.length === this.arms.length) {
      return (
        `所选路臂都没有驶入路口的车道（${this.arms.map(name).join('、')}）。` +
        '单向路以起点接入路口时右侧车道是驶出的，进口车道为 0——请检查是否选错了端点。'
      );
    }
    if (noExit.length === this.arms.length) {
      return (
        `所选路臂都没有驶出路口的车道（${this.arms.map(name).join('、')}）。` +
        '单向路以终点接入路口时右侧车道是驶入的，出口车道为 0——请检查是否选错了端点。'
      );
    }
    if (noEntry.length + noExit.length >= this.arms.length) {
      const parts: string[] = [];
      if (noEntry.length > 0) parts.push(`无进口车道：${noEntry.map(name).join('、')}`);
      if (noExit.length > 0) parts.push(`无出口车道：${noExit.map(name).join('、')}`);
      return (
        `车道方向配不成对（${parts.join('；')}）。` +
        '生成转向需要至少一条臂有进口车道、另一条臂有出口车道。'
      );
    }

    // 走到这里说明进出口都有可通行车道，却一条转向也建不出来，只可能是几何退化
    const withLanes = this.arms.filter((a) => a.entry.length > 0 || a.exit.length > 0).map(name);
    return (
      `这些端点之间无可行转向（${withLanes.join('、')}）：` +
      '连接曲线全部退化，通常是各臂端点过近或航向近乎平行。' +
      '请检查各进口道的端点是否留出了足够的路口空间。'
    );
  }

  /**
   * 选中路臂之间的最大端点间距，用于判断是否**全部**挤在一点。
   *
   * 退化判据必须用最大值：最小值只要有一对端点重合就归零，而那种情况下其余
   * 路臂对往往完全正常，按最小值否决整个路口是错的。
   */
  private maxArmSpan(): number {
    let max = 0;
    for (let i = 0; i < this.arms.length; i++) {
      for (let j = i + 1; j < this.arms.length; j++) {
        max = Math.max(max, distance(this.arms[i]!.pos, this.arms[j]!.pos));
      }
    }
    return max;
  }

  /**
   * 端点几乎重合、因而配不出转向的路臂对。
   *
   * 这些对被 `buildConnectingRoad` 静默跳过，生成结果里就是少了几个转向。
   * 不说一声用户只会觉得「生成的连接不全」，所以生成后单独提示。
   */
  private coincidentPairs(): string[] {
    const out: string[] = [];
    const name = (a: ArmEnd) => `R${a.roadId}@${a.end === 'start' ? '起' : '终'}`;
    for (let i = 0; i < this.arms.length; i++) {
      for (let j = i + 1; j < this.arms.length; j++) {
        const a = this.arms[i]!;
        const b = this.arms[j]!;
        if (distance(a.pos, b.pos) < MIN_CONNECTOR_SPAN) out.push(`${name(a)}↔${name(b)}`);
      }
    }
    return out;
  }

  /** 按进口车道总数推断主次：车道多者为主路 */
  private derivePriorities(): Junction['priorities'] {
    const ranked = [...this.arms]
      .map((a) => ({ id: a.roadId, lanes: a.entry.length + a.exit.length }))
      .sort((x, y) => y.lanes - x.lanes);

    const out: Junction['priorities'] = [];
    for (let i = 0; i < ranked.length; i++) {
      for (let j = i + 1; j < ranked.length; j++) {
        const hi = ranked[i]!;
        const lo = ranked[j]!;
        // 车道数相同则不表达优先关系，交由后续人工指定
        if (hi.lanes > lo.lanes) out.push({ high: hi.id, low: lo.id });
      }
    }
    return out;
  }

  /* ---------- 绘制 ---------- */

  draw(ctx: ToolContext, c: CanvasRenderingContext2D): void {
    const vp = ctx.viewport;

    // 选中路臂之间的预览连线，直观展示将生成的转向
    if (this.arms.length >= 2) {
      c.save();
      c.strokeStyle = 'rgba(110,231,183,0.28)';
      c.lineWidth = 1.5;
      c.setLineDash([5, 4]);
      for (let i = 0; i < this.arms.length; i++) {
        for (let j = i + 1; j < this.arms.length; j++) {
          const a = vp.worldToScreen(this.arms[i]!.pos);
          const b = vp.worldToScreen(this.arms[j]!.pos);
          c.beginPath();
          c.moveTo(a.x, a.y);
          c.lineTo(b.x, b.y);
          c.stroke();
        }
      }
      c.restore();
    }

    for (const arm of this.arms) this.drawArm(c, ctx, arm, true);

    // 未激活的候选画成小点，让用户看见「这儿其实叠了好几个端点」
    if (this.candidates.length > 1) {
      c.save();
      c.fillStyle = 'rgba(255,210,77,0.45)';
      for (let i = 0; i < this.candidates.length; i++) {
        if (i === this.candidateIndex) continue;
        const p = vp.worldToScreen(this.candidates[i]!.pos);
        c.beginPath();
        c.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
        c.fill();
      }
      c.restore();
    }

    const hover = this.hover;
    if (hover && !this.arms.some((a) => a.roadId === hover.roadId && a.end === hover.end)) {
      this.drawArm(c, ctx, hover, false);
    }

    // 有重叠时把轮换提示挂在当前候选下方
    if (hover && this.candidates.length > 1) {
      const p = vp.worldToScreen(hover.pos);
      const label = `候选 ${this.candidateIndex + 1}/${this.candidates.length}  Tab 切换`;
      c.save();
      c.font = '10px ui-monospace, monospace';
      const w = c.measureText(label).width;
      c.fillStyle = 'rgba(18,18,26,0.85)';
      c.fillRect(p.x + 14, p.y + 10, w + 8, 15);
      c.fillStyle = 'rgba(255,210,77,0.95)';
      c.textBaseline = 'middle';
      c.fillText(label, p.x + 18, p.y + 18);
      c.restore();
    }

    // 计数提示
    if (this.arms.length > 0) {
      const text =
        this.arms.length < 3
          ? `已选 ${this.arms.length} 条路臂，还需 ${3 - this.arms.length} 条`
          : `已选 ${this.arms.length} 条路臂，回车生成`;
      c.save();
      c.font = '12px ui-monospace, monospace';
      const w = c.measureText(text).width;
      c.fillStyle = 'rgba(18,18,26,0.88)';
      c.fillRect(12, 12, w + 14, 22);
      c.fillStyle = this.arms.length < 3 ? '#e0b04d' : '#6ee7b7';
      c.textBaseline = 'middle';
      c.fillText(text, 19, 23);
      c.restore();
    }
  }

  private drawArm(c: CanvasRenderingContext2D, ctx: ToolContext, arm: ArmEnd, selected: boolean): void {
    const vp = ctx.viewport;
    const s = vp.worldToScreen(arm.pos);
    const color = selected ? 'rgba(110,231,183,0.95)' : 'rgba(255,210,77,0.9)';

    c.save();
    c.beginPath();
    c.arc(s.x, s.y, selected ? 11 : 9, 0, Math.PI * 2);
    c.strokeStyle = color;
    c.lineWidth = selected ? 3 : 2;
    c.stroke();

    // 驶入方向箭头（指向路口内侧）
    const inflow = normalizeAngle(arm.outward + Math.PI);
    const len = vp.pixelsToMeters(26);
    const tipWorld = { x: arm.pos.x + Math.cos(inflow) * len, y: arm.pos.y + Math.sin(inflow) * len };
    const tip = vp.worldToScreen(tipWorld);
    c.beginPath();
    c.moveTo(s.x, s.y);
    c.lineTo(tip.x, tip.y);
    c.strokeStyle = color;
    c.lineWidth = 2;
    c.stroke();

    // 箭头头部
    const back = 8;
    const spread = 0.4;
    for (const sign of [1, -1]) {
      const a = inflow + Math.PI + sign * spread;
      c.beginPath();
      c.moveTo(tip.x, tip.y);
      c.lineTo(tip.x + Math.cos(a) * back, tip.y - Math.sin(a) * back);
      c.stroke();
    }

    if (selected) {
      const label = `R${arm.roadId} 进${arm.entry.length}/出${arm.exit.length}`;
      c.font = '10px ui-monospace, monospace';
      const w = c.measureText(label).width;
      c.fillStyle = 'rgba(18,18,26,0.85)';
      c.fillRect(s.x + 14, s.y - 8, w + 8, 15);
      c.fillStyle = '#6ee7b7';
      c.textBaseline = 'middle';
      c.fillText(label, s.x + 18, s.y);
    }
    c.restore();
  }

  cursor(): string {
    return this.hover ? 'pointer' : 'crosshair';
  }
}

/** 供外部（如属性面板）复用的箭头方向计算 */
export function armInflowHeading(outward: number): number {
  return normalizeAngle(outward + Math.PI);
}

/** 由航向生成单位方向向量，导出以便测试 */
export function headingVector(hdg: number): Vec2 {
  return fromAngle(hdg, 1);
}
