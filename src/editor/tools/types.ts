/** 工具接口与上下文。工具负责把指针/键盘事件翻译成文档变更。 */

import type { Vec2 } from '../../core/math/vec.ts';
import type { Projector } from '../../geo/projection.ts';
import type { RoadRenderData } from '../renderData.ts';
import type { RoadTemplate } from '../roadFactory.ts';
import type { FitOptions } from '../../core/geometry/alignment.ts';
import type { Store } from '../store.ts';
import type { Viewport } from '../viewport.ts';

export type ToolId =
  | 'select'
  | 'draw'
  | 'lane'
  | 'split'
  | 'measure'
  | 'junction'
  | 'laneLink';

/** 吸附设置 */
export interface SnapSettings {
  /** 吸附到既有道路端点 */
  toRoadEnds: boolean;
  /** 吸附到网格 */
  toGrid: boolean;
  gridSpacing: number;
  /** 吸附判定半径（屏幕像素） */
  radiusPx: number;
}

export const DEFAULT_SNAP: SnapSettings = {
  toRoadEnds: true,
  toGrid: false,
  gridSpacing: 1,
  radiusPx: 14,
};

export interface ToolContext {
  store: Store;
  viewport: Viewport;
  projector: Projector | null;
  /** 当前全部道路的渲染数据，供拾取使用 */
  renderData: () => RoadRenderData[];
  /** 请求重绘 */
  requestRedraw: () => void;
  /** 渲染缓存失效 */
  invalidate: (roadId?: string) => void;
  /** 新建道路使用的模板 */
  template: RoadTemplate;
  /** 线形拟合参数 */
  fit: FitOptions;
  snap: SnapSettings;
}

/** 指针事件（已换算到工程坐标） */
export interface PointerInput {
  /** 屏幕坐标（CSS 像素） */
  screen: Vec2;
  /** 工程坐标（米） */
  world: Vec2;
  button: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  /** 原始事件，供需要时调用 preventDefault */
  raw: PointerEvent;
}

export interface Tool {
  readonly id: ToolId;
  readonly label: string;
  /** 状态栏提示 */
  readonly hint: string;

  onActivate?(ctx: ToolContext): void;
  onDeactivate?(ctx: ToolContext): void;

  onPointerDown?(ctx: ToolContext, e: PointerInput): void;
  onPointerMove?(ctx: ToolContext, e: PointerInput): void;
  onPointerUp?(ctx: ToolContext, e: PointerInput): void;
  onDoubleClick?(ctx: ToolContext, e: PointerInput): void;
  onKeyDown?(ctx: ToolContext, e: KeyboardEvent): boolean;

  /** 绘制工具自身的临时图形（预览线、量测标注等） */
  draw?(ctx: ToolContext, canvas: CanvasRenderingContext2D): void;

  /** 鼠标样式 */
  cursor?(ctx: ToolContext): string;
}
