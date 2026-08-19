/** 交叉口模型（`<junction>`）。 */

/** 连接道路相对入口道路的接续方向 */
export type ConnectionContactPoint = 'start' | 'end';

/** 车道级连接（`<laneLink>`）：从入口道路车道 from 连到连接道路车道 to */
export interface JunctionLaneLink {
  from: number;
  to: number;
}

/**
 * 一条转向连接（`<connection>`）。
 * incomingRoad 经 connectingRoad 通向别处；contactPoint 指明 connectingRoad
 * 的哪一端与 incomingRoad 相接。
 */
export interface JunctionConnection {
  id: string;
  incomingRoad: string;
  connectingRoad: string;
  contactPoint: ConnectionContactPoint;
  laneLinks: JunctionLaneLink[];
  /** 1.7 起用于虚拟连接 */
  type?: 'default' | 'virtual';
  linkedRoad?: string;
}

/** 转向类别 */
export type TurnKind = 'left' | 'straight' | 'right' | 'uturn';

/** 直行判定的航向容差 */
export const STRAIGHT_TOL = Math.PI / 6;

/** 转角超过此值视为掉头 */
export const UTURN_LIMIT = (5 * Math.PI) / 6;

/**
 * 由转角（驶出方向 − 驶入方向，左正右负，已归一到 ±π）判定转向类别。
 *
 * 放在模型层而非交叉口工具里，是因为属性面板也要判定：连接道路已经生成之后，
 * 它的转向类别可以由自身两端航向之差反推（起点航向 = 驶入方向，终点航向 =
 * 驶出方向），不必把类别额外存进文档。
 */
export function classifyTurnAngle(delta: number): TurnKind {
  const abs = Math.abs(delta);
  if (abs > UTURN_LIMIT) return 'uturn';
  if (abs < STRAIGHT_TOL) return 'straight';
  return delta > 0 ? 'left' : 'right';
}

export const TURN_LABEL: Record<TurnKind, string> = {
  left: '左转',
  straight: '直行',
  right: '右转',
  uturn: '掉头',
};

/** 优先级关系（`<priority>`） */
export interface JunctionPriority {
  high: string;
  low: string;
}

/** 交叉口内的受控信号组（`<controller>` 引用） */
export interface JunctionController {
  id: string;
  type?: string;
  sequence?: number;
}

export interface Junction {
  id: string;
  name?: string;
  type?: 'default' | 'direct' | 'virtual';
  connections: JunctionConnection[];
  priorities: JunctionPriority[];
  controllers: JunctionController[];
  extraAttrs?: Record<string, string>;
}

/** 全局信号控制器（`<controller>`，与 junction 平级） */
export interface Controller {
  id: string;
  name?: string;
  sequence?: number;
  /** 受控信号 id 列表及其控制类型 */
  controls: Array<{ signalId: string; type?: string }>;
}

export function createJunction(id: string, name?: string): Junction {
  return {
    id,
    name,
    type: 'default',
    connections: [],
    priorities: [],
    controllers: [],
  };
}
