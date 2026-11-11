/**
 * 属性检查器：按当前选择渲染可编辑属性。
 *
 * 编辑一律经 store.mutate 走撤销栈；涉及几何的改动同时使渲染缓存失效。
 */

import { DEFAULT_FIT, type FitMode } from '../core/geometry/alignment.ts';
import { evaluateGeometry } from '../core/geometry/evaluate.ts';
import type { Geometry } from '../core/geometry/types.ts';
import type { Vec2 } from '../core/math/vec.ts';
import { FURNITURE, furnitureItems, refreshGroundOutline, removeFurniture } from '../editor/furniture.ts';
import { findLane, type LaneType, type RoadMarkType } from '../core/model/lane.ts';
import { laneSectionRange, type Road, type RoadObject, type RoadSignal } from '../core/model/road.ts';
import { laneWidthAt } from '../core/model/lanes.ts';
import {
  addLane,
  refitRoad,
  removeLaneFromDocument,
  setLaneWidth,
  setRoadElevation,
  setRoadSuperelevation,
  type RoadTemplate,
} from '../editor/roadFactory.ts';
// 取别名：同名方法在类内会让裸调用看起来像递归，实际解析到的是这些导入
import { deleteJunction as removeJunction } from '../editor/junctionEdit.ts';
import {
  completeJunction,
  readLanePairs,
  removeLanePair,
  type LanePairRef,
  type LaneRef,
} from '../editor/laneConnect.ts';
import type { OdrDocument } from '../core/model/document.ts';
import {
  beginLaneWithTaper,
  endLaneWithTaper,
  MIN_TAPER_LENGTH,
  recommendedTaperLength,
  taperLaneWidth,
  type TaperResult,
  type TaperShape,
} from '../editor/laneTaper.ts';
import type { Store } from '../editor/store.ts';
import { button, checkRow, clear, el, kv, numberRow, panel, selectRow, textRow } from './dom.ts';

const LANE_TYPES: LaneType[] = [
  'driving', 'sidewalk', 'shoulder', 'border', 'biking', 'parking',
  'median', 'restricted', 'stop', 'curb', 'onRamp', 'offRamp', 'none',
];

const MARK_TYPES: RoadMarkType[] = [
  'none', 'solid', 'broken', 'solid solid', 'solid broken', 'broken solid',
  'broken broken', 'botts dots', 'curb', 'edge', 'grass',
];

const MARK_COLORS = ['standard', 'white', 'yellow', 'blue', 'green', 'red', 'orange'];

export interface InspectorHooks {
  invalidate: (roadId?: string) => void;
  requestRedraw: () => void;
  focusRoad: (roadId: string) => void;
  /**
   * 当前新建道路模板。取函数而非快照：模板由工具栏实时可改，
   * 快照会让面板一直用初始化时那一份。
   */
  template: () => RoadTemplate;
}

export class Inspector {
  readonly root = el('div');

  /**
   * 各车道的渐变参数，跨重渲染保留；键为 `roadId/laneId`。
   *
   * 每次改动都会触发 render() 重建 DOM，参数放局部变量的话填好的长度、站号
   * 会在点按钮的瞬间被重置回默认值。
   */
  private readonly taperParams = new Map<
    string,
    { length: number; station: number; startWidth?: number; endWidth?: number; shape: TaperShape }
  >();

  constructor(
    private readonly store: Store,
    private readonly hooks: InspectorHooks,
  ) {}

  render(): void {
    clear(this.root);
    const sel = this.store.selection;

    switch (sel.kind) {
      case 'none':
        this.root.append(
          panel('属性', el('p', { class: 'note', text: '未选中任何对象。点击路面或参考线进行选择。' })),
        );
        break;
      case 'road':
      case 'controlPoint':
        this.renderRoad(sel.roadId);
        break;
      case 'furniture':
        this.renderFurniture(sel.roadId);
        break;
      case 'geometry':
        this.renderRoad(sel.roadId);
        this.renderGeometry(sel.roadId, sel.geometryIndex);
        break;
      case 'lane':
        this.renderRoad(sel.roadId);
        this.renderLane(sel.roadId, sel.sectionIndex, sel.laneId);
        break;
      case 'junction':
        this.renderJunction(sel.junctionId);
        break;
    }
  }

  private road(roadId: string) {
    return this.store.document.roads.find((r) => r.id === roadId);
  }

  /* ---------- 道路 ---------- */

  private renderRoad(roadId: string): void {
    const road = this.road(roadId);
    if (!road) return;

    const body = el('div');

    body.append(
      kv([
        ['id', road.id],
        ['长度', `${road.length.toFixed(3)} m`],
        ['图元数', String(road.planView.length)],
        ['车道段', String(road.laneSections.length)],
        ['所属交叉口', road.junction === '-1' ? '（无）' : road.junction],
      ]),
    );

    body.append(
      textRow('名称', road.name ?? '', (v) => {
        this.store.mutate(() => {
          road.name = v;
        });
        this.hooks.requestRedraw();
      }),
    );

    body.append(
      selectRow(
        '通行规则',
        road.rule ?? 'RHT',
        [
          { value: 'RHT' as const, label: '右侧通行 RHT' },
          { value: 'LHT' as const, label: '左侧通行 LHT' },
        ],
        (v) => {
          this.store.mutate(() => {
            road.rule = v;
          });
        },
      ),
    );

    // 高程：单段时提供常量编辑，多段时仅提示
    if (road.elevations.length <= 1) {
      const current = road.elevations[0]?.a ?? 0;
      body.append(
        numberRow('高程 (m)', current, (v) => {
          this.store.mutate(() => setRoadElevation(road, v));
          this.hooks.invalidate(roadId);
          this.hooks.requestRedraw();
        }, { step: 0.1, title: '整条道路的恒定高程，写入 <elevationProfile>' }),
      );
    } else {
      body.append(
        el('p', { class: 'note', text: `高程为 ${road.elevations.length} 段变化曲线，此处不做简化编辑。` }),
      );
    }

    if (road.superelevations.length <= 1) {
      const rad = road.superelevations[0]?.a ?? 0;
      body.append(
        numberRow('横坡 (°)', (rad * 180) / Math.PI, (v) => {
          this.store.mutate(() => setRoadSuperelevation(road, v));
          this.hooks.invalidate(roadId);
          this.hooks.requestRedraw();
        }, { step: 0.1, title: '正值使左侧（t>0）下沉' }),
      );
    }

    // 连接关系
    const linkText = (which: 'predecessor' | 'successor'): string => {
      const l = road.link[which];
      if (!l) return '（无）';
      return `${l.elementType === 'junction' ? 'J' : 'R'}${l.elementId}${l.contactPoint ? `@${l.contactPoint}` : ''}`;
    };
    body.append(kv([['前驱', linkText('predecessor')], ['后继', linkText('successor')]]));

    this.root.append(panel(`道路 ${road.id}`, body));
    this.renderFurniture(roadId);
    this.renderAlignment(roadId);
    this.renderLaneList(roadId);
  }

  private renderFurniture(roadId: string): void {
    const road = this.road(roadId);
    if (!road) return;
    const body = el('div');
    body.append(el('p', { class: 'note', text: '使用左侧 🚦 交通设施工具在地图上点选添加（F）。在这里调整已有设施的位置和属性。' }));
    for (const item of furnitureItems(road)) {
      const source = item.source;
      const selection = this.store.selection;
      const selected = selection.kind === 'furniture' && selection.roadId === roadId && selection.furnitureId === source.id
        && selection.sourceType === (road.signals.includes(source) ? 'signal' : 'object');
      if (selection.kind === 'furniture' && !selected) continue;
      const edit = (fn: () => void) => {
        this.store.mutate(fn); this.hooks.invalidate(roadId); this.hooks.requestRedraw(); this.render();
      };
      const fields = el('div');
      fields.append(
        numberRow('s (m)', source.s, v => edit(() => { source.s = Math.max(0, Math.min(road.length, v)); }), { min: 0, max: road.length, step: 1 }),
        numberRow('t (m)', source.t, v => edit(() => { source.t = v; }), { step: 0.25 }),
        numberRow('zOffset (m)', source.zOffset ?? 0, v => edit(() => { source.zOffset = v; }), { step: 0.1 }),
      );
      const isSignal = road.signals.includes(source);
      if (isSignal) fields.append(selectRow('适用方向', (source as RoadSignal).orientation ?? '+',
        [{ value: '+' as const, label: '沿 +s' }, { value: '-' as const, label: '沿 −s' }, { value: 'none' as const, label: '双向' }],
        v => edit(() => { (source as RoadSignal).orientation = v; })));
      const angle = isSignal ? 'hOffset' : 'hdg';
      for (const key of [angle, 'pitch', 'roll']) {
        const raw = key === 'hdg' ? (source as RoadObject).hdg : Number(source.extraAttrs?.[key]);
        fields.append(numberRow(`${key} (°)`, (raw || 0) * 180 / Math.PI, v => edit(() => {
          if (key === 'hdg') (source as RoadObject).hdg = v * Math.PI / 180;
          else { source.extraAttrs ??= {}; source.extraAttrs[key] = String(v * Math.PI / 180); }
        }), { step: 5 }));
      }
      if (item.kind === 'speed' && isSignal) fields.append(numberRow('限速 (km/h)', item.value ?? 50, v => edit(() => {
        const sg = source as RoadSignal;
        sg.value = Math.max(1, v); sg.subtype = String(sg.value);
        sg.extraAttrs = { ...sg.extraAttrs, unit: 'km/h' };
      }), { min: 1 }));
      if (item.ground && source.rawChildren?.includes('code="opendrive-editor"')) {
        const object = source as RoadObject;
        for (const key of ['length', 'width'] as const) fields.append(numberRow(`${key} (m)`, object[key] ?? 1, v => edit(() => {
          object[key] = Math.max(0.1, v);
          refreshGroundOutline(object, item.kind);
        }), { min: 0.1, step: 0.1 }));
      }
      fields.append(button('删除设施', () => edit(() => {
        removeFurniture(this.store.document, road, source);
        if (selected) this.store.select({ kind: 'road', roadId });
      })));
      body.append(panel(`${FURNITURE.find(([k]) => k === item.kind)![1]} #${source.id}`, fields, { collapsed: !selected }));
    }
    this.root.append(panel('交通设施 / 路面标记', body));
  }

  /** 线形参数与重拟合 */
  private renderAlignment(roadId: string): void {
    const rec = this.store.getAlignment(roadId);
    const road = this.road(roadId);
    if (!road) return;

    const body = el('div');

    if (!rec) {
      body.append(
        el('p', {
          class: 'note',
          text: '该道路无控制点记录（来自导入文件）。可用"提取控制点"从现有几何反推，之后即可拖拽调整。',
        }),
      );
      body.append(
        el('div', { class: 'btn-row' },
          button('提取控制点', () => this.extractControlPoints(roadId)),
        ),
      );
      this.root.append(panel('线形', body));
      return;
    }

    const applyFit = (): void => {
      this.store.mutate(() => {
        if (!refitRoad(road, rec.points, rec.fit)) {
          this.store.notify('warn', '重拟合失败');
        }
      });
      this.hooks.invalidate(roadId);
      this.hooks.requestRedraw();
      this.render();
    };

    body.append(
      selectRow<FitMode>(
        '拟合方式',
        rec.fit.mode,
        [
          { value: 'spiral', label: '缓和曲线（曲率连续）' },
          { value: 'arc', label: '切线圆弧（圆角）' },
        ],
        (v) => {
          rec.fit.mode = v;
          applyFit();
        },
        '缓和曲线在直线与圆弧之间插入回旋线，使曲率连续，更接近实际道路设计',
      ),
      numberRow('半径 (m)', rec.fit.radius, (v) => {
        rec.fit.radius = Math.max(1, v);
        applyFit();
      }, { min: 1, step: 5 }),
    );

    if (rec.fit.mode === 'spiral') {
      body.append(
        numberRow('缓和段长 (m)', rec.fit.spiralLength, (v) => {
          rec.fit.spiralLength = Math.max(0, v);
          applyFit();
        }, { min: 0, step: 5, title: '过长时会被自动裁剪到转角允许的上限' }),
      );
    }

    body.append(kv([['控制点数', String(rec.points.length)]]));
    body.append(
      el('p', { class: 'note', text: '拖拽画面上的方形控制点可实时调整线形；选中道路后按 Insert 可加密控制点。' }),
    );

    this.root.append(panel('线形', body));
  }

  /**
   * 从既有几何反推控制点：取各图元的端点。
   *
   * 这不是原始点击序列，但作为可拖拽的锚点足够——圆弧/回旋线的端点正是
   * 线形的切点，用它们重新拟合能保持大致走向。
   */
  private extractControlPoints(roadId: string): void {
    const road = this.road(roadId);
    if (!road || road.planView.length === 0) return;

    const pv = road.planView;
    const pts: Vec2[] = [{ x: pv[0]!.x, y: pv[0]!.y }];

    // 保留曲线段端点（即线形切点）；连续直线之间的分界点可省略
    for (let i = 0; i + 1 < pv.length; i++) {
      const g = pv[i]!;
      const next = pv[i + 1]!;
      if (g.type === 'line' && next.type === 'line') continue;
      pts.push({ x: next.x, y: next.y });
    }

    // 末点取真实终点位姿
    const lastG = pv[pv.length - 1]!;
    const end = evaluateGeometry(lastG, lastG.length);
    pts.push({ x: end.x, y: end.y });

    // 圆角/缓和曲线的切点会被重新拟合"削掉"一部分，用原半径作初值最接近原状
    const radius = estimateRadius(pv) ?? DEFAULT_FIT.radius;
    this.store.setAlignment(roadId, {
      points: pts,
      fit: { ...DEFAULT_FIT, radius },
    });
    this.store.notify('info', `已提取 ${pts.length} 个控制点，可拖拽调整`);
    this.render();
    this.hooks.requestRedraw();
  }

  /* ---------- 车道列表 ---------- */

  private renderLaneList(roadId: string): void {
    const road = this.road(roadId);
    if (!road) return;

    const sel = this.store.selection;
    const activeSection = sel.kind === 'lane' ? sel.sectionIndex : 0;
    const activeLane = sel.kind === 'lane' ? sel.laneId : null;
    const section = road.laneSections[activeSection];
    if (!section) return;

    const body = el('div');
    const { start, end } = laneSectionRange(road, activeSection);

    if (road.laneSections.length > 1) {
      body.append(
        selectRow(
          '车道段',
          String(activeSection),
          road.laneSections.map((s, i) => {
            const r = laneSectionRange(road, i);
            return { value: String(i), label: `#${i}  s ${r.start.toFixed(1)}–${r.end.toFixed(1)} m` };
          }),
          (v) => {
            const idx = Number(v);
            const target = road.laneSections[idx];
            if (!target) return;
            const firstLane = target.right[0] ?? target.left[0] ?? target.center;
            this.store.select({
              kind: 'lane',
              roadId,
              sectionIndex: idx,
              laneId: firstLane.id,
            });
          },
        ),
      );
    }

    const list = el('div', { class: 'list' });
    const order = [...[...section.left].reverse(), section.center, ...section.right];
    const sOffsetMid = (end - start) / 2;

    for (const lane of order) {
      const width = lane.id === 0 ? 0 : laneWidthAt(lane, sOffsetMid);
      const item = el(
        'div',
        {
          class: `list-item${lane.id === activeLane ? ' selected' : ''}`,
          onclick: () => {
            this.store.select({ kind: 'lane', roadId, sectionIndex: activeSection, laneId: lane.id });
          },
        },
        el('span', { text: String(lane.id).padStart(3, ' ') }),
        el('span', { class: 'badge', text: lane.type }),
        el('span', { class: 'spacer' }),
        el('span', { text: lane.id === 0 ? '—' : `${width.toFixed(2)} m` }),
      );
      list.append(item);
    }
    body.append(list);

    const add = (side: 'left' | 'right') => {
      this.store.mutate(() => addLane(section, side, 'driving', 3.5));
      const pool = side === 'left' ? section.left : section.right;
      this.store.notify(
        'info',
        `已加${side === 'left' ? '左' : '右'}侧车道 ${pool[pool.length - 1]!.id}（该侧共 ${pool.length} 条）`,
      );
      this.afterLaneChange(roadId);
    };

    /** 删该侧最外侧一条 */
    const drop = (side: 'left' | 'right') => {
      const pool = side === 'left' ? section.left : section.right;
      const outer = pool[pool.length - 1];
      if (!outer) return;
      this.removeLaneAt(roadId, activeSection, outer.id);
    };

    body.append(
      el('div', { class: 'btn-row' },
        button('+ 左侧车道', () => add('left')),
        button('+ 右侧车道', () => add('right')),
        button('− 左侧车道', () => drop('left'), {
          disabled: section.left.length === 0,
          title: section.left.length === 0 ? '左侧已无车道' : '删除左侧最外侧一条',
        }),
        button('− 右侧车道', () => drop('right'), {
          disabled: section.right.length === 0,
          title: section.right.length === 0 ? '右侧已无车道' : '删除右侧最外侧一条',
        }),
      ),
      el('p', { class: 'note', text: '增删都作用在该侧最外侧。要删中间某条，点选它再用「删除该车道」。' }),
    );

    this.root.append(panel(`车道（段 #${activeSection}）`, body));
  }

  private afterLaneChange(roadId: string): void {
    this.hooks.invalidate(roadId);
    this.hooks.requestRedraw();
    this.render();
  }

  /**
   * 删除一条车道。走 document 级入口以同步修正 junction 的 laneLink，
   * 并在选中车道失效时把选区退回道路级。
   */
  private removeLaneAt(roadId: string, sectionIndex: number, laneId: number): void {
    const road = this.road(roadId);
    if (!road) return;

    let result = { ok: false, droppedLinks: 0, remappedLinks: 0 };
    this.store.mutate(() => {
      result = removeLaneFromDocument(this.store.document, road, sectionIndex, laneId);
    });

    if (!result.ok) {
      this.store.notify('warn', `无法删除车道 ${laneId}`);
      return;
    }

    const side = laneId > 0 ? '左' : '右';
    const remaining = (laneId > 0 ? road.laneSections[sectionIndex]?.left : road.laneSections[sectionIndex]?.right)?.length ?? 0;
    this.store.notify('info', `已删除${side}侧车道 ${laneId}（该侧剩 ${remaining} 条）`);

    // 路口引用的变化必须说出来，否则用户不会想到去看校验面板
    if (result.droppedLinks > 0 || result.remappedLinks > 0) {
      const parts: string[] = [];
      if (result.droppedLinks > 0) parts.push(`移除 ${result.droppedLinks} 条失效转向`);
      if (result.remappedLinks > 0) parts.push(`重映射 ${result.remappedLinks} 条`);
      this.store.notify('warn', `交叉口连接已同步：${parts.join('，')}。请复核路口转向关系`);
    }

    // 选中的车道可能已被删除或重编号
    const sel = this.store.selection;
    if (sel.kind === 'lane' && sel.roadId === roadId) {
      const section = road.laneSections[sel.sectionIndex];
      const stillThere =
        section && (sel.laneId === 0 ||
          (sel.laneId > 0 ? section.left : section.right).some((l) => l.id === sel.laneId));
      if (!stillThere) this.store.select({ kind: 'road', roadId });
    }

    this.afterLaneChange(roadId);
  }

  /* ---------- 单条车道 ---------- */

  private renderLane(roadId: string, sectionIndex: number, laneId: number): void {
    const road = this.road(roadId);
    if (!road) return;
    const section = road.laneSections[sectionIndex];
    if (!section) return;
    const lane = findLane(section, laneId);
    if (!lane) return;

    const body = el('div');
    const { start, end } = laneSectionRange(road, sectionIndex);
    const mid = (end - start) / 2;

    body.append(
      kv([
        ['车道 id', String(lane.id)],
        ['所在段 s', `${start.toFixed(2)} – ${end.toFixed(2)} m`],
        ['宽度记录', String(lane.widths.length)],
      ]),
    );

    body.append(
      selectRow('类型', lane.type as LaneType, LANE_TYPES.map((t) => ({ value: t, label: t })), (v) => {
        this.store.mutate(() => {
          lane.type = v;
        });
        this.hooks.invalidate(roadId);
        this.hooks.requestRedraw();
        this.render();
      }),
    );

    if (lane.id !== 0) {
      if (lane.widths.length <= 1) {
        body.append(
          numberRow('宽度 (m)', laneWidthAt(lane, mid), (v) => {
            this.store.mutate(() => setLaneWidth(lane, v));
            this.hooks.invalidate(roadId);
            this.hooks.requestRedraw();
          }, { min: 0.1, step: 0.25 }),
        );
      } else {
        body.append(
          el('p', { class: 'note', text: `该车道宽度为 ${lane.widths.length} 段变化，未做简化编辑。` }),
        );
      }
    }

    // 标线
    const mark = lane.roadMarks[0];
    body.append(
      selectRow(
        '标线类型',
        (mark?.type ?? 'none') as RoadMarkType,
        MARK_TYPES.map((t) => ({ value: t, label: t })),
        (v) => {
          this.store.mutate(() => {
            if (lane.roadMarks.length === 0) {
              lane.roadMarks.push({ sOffset: 0, type: v, color: 'standard', width: 0.15 });
            } else {
              lane.roadMarks[0]!.type = v;
            }
          });
          this.hooks.invalidate(roadId);
          this.hooks.requestRedraw();
        },
      ),
      selectRow(
        '标线颜色',
        mark?.color ?? 'standard',
        MARK_COLORS.map((c) => ({ value: c, label: c })),
        (v) => {
          this.store.mutate(() => {
            if (lane.roadMarks.length === 0) {
              lane.roadMarks.push({ sOffset: 0, type: 'solid', color: v, width: 0.15 });
            } else {
              lane.roadMarks[0]!.color = v;
            }
          });
          this.hooks.invalidate(roadId);
          this.hooks.requestRedraw();
        },
      ),
      numberRow('标线宽 (m)', mark?.width ?? 0.15, (v) => {
        this.store.mutate(() => {
          if (lane.roadMarks.length === 0) {
            lane.roadMarks.push({ sOffset: 0, type: 'solid', color: 'standard', width: v });
          } else {
            lane.roadMarks[0]!.width = v;
          }
        });
        this.hooks.invalidate(roadId);
        this.hooks.requestRedraw();
      }, { min: 0.05, step: 0.05 }),
    );

    if (lane.id !== 0) {
      body.append(
        el('div', { class: 'btn-row' },
          button('删除该车道', () => {
            this.removeLaneAt(roadId, sectionIndex, lane.id);
          }),
        ),
      );
    }

    this.root.append(panel(`车道 ${lane.id}`, body));

    if (lane.id !== 0) this.appendTaperControls(road, sectionIndex, lane.id, start, end);
  }

  /** 取该车道的渐变参数，首次访问时按设计速度推荐 */
  private taperState(road: Road, laneId: number, width: number, sectionStart: number, sectionEnd: number) {
    const key = `${road.id}/${laneId}`;
    let st = this.taperParams.get(key);
    if (!st) {
      const recLength = recommendedTaperLength(width, designSpeedKmh(road));
      // 默认从段中点开始，确保渐变不会从段起点创建（避免意外空挡）
      const midPoint = (sectionStart + sectionEnd) / 2;
      st = {
        length: sectionEnd - sectionStart,
        station: sectionStart,
        startWidth: width,
        endWidth: 0,
        shape: 'cubic',
      };
      this.taperParams.set(key, st);
    } else {
      // 即使有缓存，也要确保 station 和 length 在当前段范围内有效
      st.station = Math.max(sectionStart, Math.min(st.station, sectionEnd - MIN_TAPER_LENGTH));
      st.length = Math.min(st.length, sectionEnd - st.station);
      // 如果缓存值无效，重置为默认值
      if (st.station < sectionStart || st.station > sectionEnd - MIN_TAPER_LENGTH) {
        st.station = sectionStart;
        st.length = sectionEnd - sectionStart;
      }
    }
    return st;
  }

  /**
   * 车道渐变面板：形状选择和三个操作按钮。
   *
   * 起点、长度、目标宽度已通过拖拽手柄在地图上直接调整，不再需要数字输入。
   * 渐变消失/出现只对本侧最外侧车道开放。
   */
  private appendTaperControls(
    road: Road,
    sectionIndex: number,
    laneId: number,
    sectionStart: number,
    sectionEnd: number,
  ): void {
    const section = road.laneSections[sectionIndex];
    if (!section) return;
    const side = laneId > 0 ? section.left : section.right;
    const outermost = side[side.length - 1]?.id === laneId;
    const lane = findLane(section, laneId);
    const curWidth = lane ? laneWidthAt(lane, (sectionEnd - sectionStart) / 2) : 3.5;
    const st = this.taperState(road, laneId, curWidth, sectionStart, sectionEnd);

    const body = el('div');

    // 渐变起终点宽度输入
    const key = `${road.id}/${laneId}`;
    const cached = this.taperParams.get(key) ?? { ...st };

    const startWidthInput = el('input', {
      type: 'number',
      min: '0.01',
      max: '10',
      step: '0.1',
      value: String((cached.startWidth ?? curWidth).toFixed(2)),
    }) as HTMLInputElement;

    const endWidthInput = el('input', {
      type: 'number',
      min: '0',
      max: '10',
      step: '0.1',
      value: String((cached.endWidth ?? 0).toFixed(2)),
    }) as HTMLInputElement;

    startWidthInput.addEventListener('change', () => {
      const key = `${road.id}/${laneId}`;
      const cached = this.taperParams.get(key) ?? { ...st };
      cached.startWidth = Math.max(0.01, parseFloat(startWidthInput.value) || curWidth);
      this.taperParams.set(key, cached);
    });

    endWidthInput.addEventListener('change', () => {
      const key = `${road.id}/${laneId}`;
      const cached = this.taperParams.get(key) ?? { ...st };
      cached.endWidth = Math.max(0, parseFloat(endWidthInput.value) || 0);
      this.taperParams.set(key, cached);
    });

    body.append(
      el('div', { class: 'field-row' },
        el('label', { text: '起点宽度 (m)' }),
        startWidthInput,
      ),
      el('div', { class: 'field-row' },
        el('label', { text: '终点宽度 (m)' }),
        endWidthInput,
      ),
      selectRow(
        '渐变形状',
        st.shape,
        [
          { value: 'cubic', label: '三次（两端相切，推荐）' },
          { value: 'linear', label: '线性（直边，渠化用）' },
        ],
        (v) => {
          st.shape = v as TaperShape;
        },
      ),
      el('p', {
        class: 'note',
        text: '点击"配置渐变"后，拖拽地图上的绿色（起点）和红色（终点）手柄调整渐变位置。',
      }),
    );

    const run = (label: string, fn: () => TaperResult) => {
      this.store.mutate(() => {
        const r = fn();
        if (!r.ok) {
          this.store.notify('error', `${label}失败：${r.reason ?? '未知原因'}`);
          return;
        }
        const parts = [`${label}完成，渐变长度 ${r.length!.toFixed(1)} m`];
        if (r.clamped) parts.push('（长度已按道路剩余长度夹紧）');
        this.store.notify('info', parts.join(''));
        if (r.droppedLinks) {
          this.store.notify('warn', `已清理 ${r.droppedLinks} 条失效的交叉口车道连接`);
        }
        if (r.remappedLinks) {
          this.store.notify('warn', `已改写 ${r.remappedLinks} 条交叉口车道连接的车道号`);
        }
      });
      this.afterLaneChange(road.id);
    };

    body.append(
      el('div', { class: 'btn-row' },
        button('配置渐变', () => {
          const key = `${road.id}/${laneId}`;
          const cached = this.taperParams.get(key) ?? { ...st };
          const startW = cached.startWidth ?? curWidth;
          const endW = cached.endWidth ?? 0;

          // 使用用户指定的起终点宽度创建渐变
          run('配置渐变', () =>
            taperLaneWidth(road, laneId, st.station, st.length, endW, st.shape, startW));
        }),
      ),
    );

    this.root.append(panel('车道渐变', body));
  }

  /* ---------- 几何图元 ---------- */

  private renderGeometry(roadId: string, index: number): void {
    const road = this.road(roadId);
    if (!road) return;
    const g = road.planView[index];
    if (!g) return;

    const pairs: Array<[string, string]> = [
      ['类型', g.type],
      ['s', `${g.s.toFixed(4)} m`],
      ['长度', `${g.length.toFixed(4)} m`],
      ['起点 x', g.x.toFixed(4)],
      ['起点 y', g.y.toFixed(4)],
      ['起点航向', `${((g.hdg * 180) / Math.PI).toFixed(4)}°`],
    ];

    if (g.type === 'arc') {
      pairs.push(['曲率', `${g.curvature.toExponential(4)} 1/m`]);
      pairs.push(['半径', `${Math.abs(1 / g.curvature).toFixed(3)} m`]);
    } else if (g.type === 'spiral') {
      pairs.push(['起点曲率', g.curvStart.toExponential(4)]);
      pairs.push(['终点曲率', g.curvEnd.toExponential(4)]);
      if (Math.abs(g.curvEnd) > 1e-9) {
        pairs.push(['终点半径', `${Math.abs(1 / g.curvEnd).toFixed(3)} m`]);
      }
    } else if (g.type === 'paramPoly3') {
      pairs.push(['pRange', g.pRange]);
    }

    const body = el('div', {}, kv(pairs));
    body.append(
      el('p', { class: 'note', text: '几何图元由线形自动生成，请通过控制点或线形参数间接调整。' }),
    );
    this.root.append(panel(`图元 #${index}`, body));
  }

  /* ---------- 交叉口 ---------- */

  private renderJunction(junctionId: string): void {
    const doc = this.store.document;
    const j = doc.junctions.find((x) => x.id === junctionId);
    if (!j) return;

    const body = el('div');

    // 路臂由车道对隐含推出：进出口两侧都算
    const pairs = readLanePairs(doc, junctionId);
    const arms = new Set<string>();
    for (const p of pairs) {
      arms.add(`${p.from.roadId}@${p.from.end}`);
      arms.add(`${p.to.roadId}@${p.to.end}`);
    }

    body.append(
      kv([
        ['id', j.id],
        ['名称', j.name ?? '—'],
        ['路臂数', String(arms.size)],
        ['车道连接', String(pairs.length)],
        ['连接道路', String(j.connections.length)],
        ['优先级', j.priorities.length > 0 ? `${j.priorities.length} 条` : '未指定'],
      ]),
    );

    if (pairs.length === 0) {
      body.append(
        el('p', { class: 'note', text: '该交叉口还没有车道连接。切到车道连接工具（L），点选进口车道再点出口车道即可建立。' }),
      );
    } else {
      // 列表按车道对而非连接道路组织：车道对才是可编辑的基元
      const list = el('div', { class: 'list' });
      for (const p of pairs) {
        const owner = connectingRoadFor(doc, junctionId, p);
        const delBtn = button('×', () => this.removeLanePair(junctionId, p), {
          title: '删除该车道连接',
        });
        delBtn.style.cssText = 'padding:0 0.5em;margin-left:0.5em;font-size:1.1em';
        list.append(
          el('div', { class: 'list-item' },
            el('span', {
              text: `${laneLabel(p.from)} → ${laneLabel(p.to)}`,
              onclick: () => owner && this.hooks.focusRoad(owner),
              style: owner ? 'cursor:pointer' : '',
            }),
            el('span', { class: 'spacer' }),
            // 标出所属连接道路，多条车道合并成一条时能看出归属
            owner ? el('span', { class: 'badge', text: `R${owner}` }) : null,
            delBtn,
          ),
        );
      }
      body.append(list);
    }

    body.append(
      el('div', { class: 'btn-row' },
        button('补全缺失转向', () => this.completeJunction(junctionId), {
          title: '在现有路臂之间按启发式补齐未连接的转向。结果只是猜，补完请逐条核对',
        }),
      ),
    );

    if (j.priorities.length > 0) {
      const plist = el('div', { class: 'list' });
      for (const p of j.priorities) {
        plist.append(
          el('div', { class: 'list-item' },
            el('span', { text: `R${p.high} 优先` }),
            el('span', { class: 'spacer' }),
            el('span', { class: 'badge', text: `R${p.low} 让行` }),
          ),
        );
      }
      body.append(el('p', { class: 'note', text: '通行优先级' }), plist);
    }

    body.append(
      el('div', { class: 'btn-row' },
        button('删除交叉口', () => this.deleteJunction(junctionId), {
          title: '同时删除其全部连接道路，并还原入口道路的连接关系',
        }),
      ),
    );

    this.root.append(panel(`交叉口 ${j.id}`, body));
  }

  /** 删除交叉口：连带移除其连接道路，并清理入口道路的悬空 link */
  private deleteJunction(junctionId: string): void {
    let removed = 0;
    this.store.mutate(() => {
      const res = removeJunction(this.store.document, junctionId);
      if (!res.ok) return;
      removed = res.removedRoads.length;
      for (const id of res.removedRoads) this.store.deleteAlignment(id);
      this.store.notify('info', `已删除交叉口 ${junctionId} 及其 ${removed} 条连接道路`);
    });

    this.store.select({ kind: 'none' });
    this.hooks.invalidate();
    this.hooks.requestRedraw();
  }

  /**
   * 删除单条车道连接。
   *
   * 删的是车道对，不是连接道路——多条车道合并成一条道路时，删掉其中一条应当让
   * 那条道路少一条车道，而不是整条消失。整体重建自然做到这一点（见 laneConnect.ts）。
   *
   * 路口即使被删空也保留：它是用户显式建立的对象，自动消失会让人不知所措。
   * 空 junction 由校验器报 warning，用「删除交叉口」按钮显式移除。
   */
  private removeLanePair(junctionId: string, pair: LanePairRef): void {
    const label = `${laneLabel(pair.from)} → ${laneLabel(pair.to)}`;
    const before = new Set(
      this.store.document.roads.filter((r) => r.junction === junctionId).map((r) => r.id),
    );

    this.store.mutate(() => {
      const res = removeLanePair(this.store.document, junctionId, pair, this.hooks.template());
      if (!res.ok) {
        this.store.notify('error', res.error ?? '删除失败');
        return;
      }
      // 重建会重排连接道路，消失的那些要清掉侧车数据
      const after = new Set(
        this.store.document.roads.filter((r) => r.junction === junctionId).map((r) => r.id),
      );
      for (const id of before) if (!after.has(id)) this.store.deleteAlignment(id);
      this.store.notify('info', `已删除车道连接 ${label}（剩 ${res.roads} 条连接道路）`);
    });

    this.store.select({ kind: 'junction', junctionId });
    this.hooks.invalidate();
    this.hooks.requestRedraw();
  }

  /**
   * 按启发式补全缺失转向。
   *
   * 只在现有路臂之间补，且不覆盖已有车道对——用户手工连的才是准的。
   */
  private completeJunction(junctionId: string): void {
    this.store.mutate(() => {
      const res = completeJunction(this.store.document, junctionId, this.hooks.template());
      if (res.added === 0) {
        this.store.notify('info', '现有路臂之间的转向已齐备，没有可补的');
        return;
      }
      this.store.notify(
        'info',
        `已补全 ${res.added} 条车道连接（共 ${res.roads} 条连接道路）。` +
          '车道配对按几何推测，请对照实际渠化核对',
      );
    });

    this.store.select({ kind: 'junction', junctionId });
    this.hooks.invalidate();
    this.hooks.requestRedraw();
  }
}

/** 车道的可读标识 */
function laneLabel(ref: LaneRef): string {
  return `R${ref.roadId}@${ref.end === 'start' ? '起' : '终'}.${ref.laneId}`;
}

/** 找出承载某车道对的连接道路 id */
function connectingRoadFor(
  doc: OdrDocument,
  junctionId: string,
  pair: LanePairRef,
): string | null {
  const j = doc.junctions.find((x) => x.id === junctionId);
  if (!j) return null;
  for (const c of j.connections) {
    if (c.incomingRoad !== pair.from.roadId) continue;
    if (!c.laneLinks.some((l) => l.from === pair.from.laneId)) continue;
    const road = doc.roads.find((r) => r.id === c.connectingRoad);
    if (road?.link.successor?.elementId === pair.to.roadId) return c.connectingRoad;
  }
  return null;
}

/**
 * 道路设计速度（km/h），用于推荐渐变长度。
 *
 * 速度记在 `road.types[].speed`，单位可能是 m/s 或 mph；没有记录时按 50 km/h
 * 城市道路取值。
 */
function designSpeedKmh(road: Road): number {
  const rec = road.types.find((t) => t.speedMax !== undefined && t.speedMax > 0);
  if (!rec || rec.speedMax === undefined) return 50;
  switch (rec.speedUnit) {
    case 'm/s':
      return rec.speedMax * 3.6;
    case 'mph':
      return rec.speedMax * 1.609344;
    default:
      return rec.speedMax;
  }
}

/** 由几何链中的圆弧估计一个代表性半径，作为重拟合初值 */
function estimateRadius(pv: readonly Geometry[]): number | null {
  let best: number | null = null;
  for (const g of pv) {
    const curv =
      g.type === 'arc' ? Math.abs(g.curvature) : g.type === 'spiral' ? Math.abs(g.curvEnd) : 0;
    if (curv > 1e-9) {
      const r = 1 / curv;
      if (best === null || r < best) best = r;
    }
  }
  return best;
}
