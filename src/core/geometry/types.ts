/**
 * OpenDRIVE 参考线几何图元（`<planView>/<geometry>` 的五种子元素）。
 *
 * 所有图元共享起点位姿 (x, y, hdg) 与弧长 length，s 为其在参考线上的起始站号。
 * 单位：米 / 弧度。
 */

export interface GeometryBase {
  /** 该图元起点在参考线上的站号 s（米） */
  s: number;
  /** 起点惯性系坐标 */
  x: number;
  y: number;
  /** 起点航向角（弧度，x 轴正方向为 0，逆时针为正） */
  hdg: number;
  /** 图元弧长（米） */
  length: number;
}

/** 直线 */
export interface LineGeometry extends GeometryBase {
  type: 'line';
}

/** 定曲率圆弧。curvature > 0 左转，< 0 右转，单位 1/m */
export interface ArcGeometry extends GeometryBase {
  type: 'arc';
  curvature: number;
}

/** 回旋线（clothoid）：曲率随弧长线性变化 */
export interface SpiralGeometry extends GeometryBase {
  type: 'spiral';
  curvStart: number;
  curvEnd: number;
}

/**
 * 三次多项式（OpenDRIVE 1.4 及更早；1.6 起标记为废弃，但需保持读入兼容）。
 * 在以起点为原点、起点切向为 u 轴的局部系中 v = a + b·u + c·u² + d·u³。
 */
export interface Poly3Geometry extends GeometryBase {
  type: 'poly3';
  a: number;
  b: number;
  c: number;
  d: number;
}

/** 参数三次多项式：u(p)、v(p) 各自为三次多项式 */
export interface ParamPoly3Geometry extends GeometryBase {
  type: 'paramPoly3';
  aU: number;
  bU: number;
  cU: number;
  dU: number;
  aV: number;
  bV: number;
  cV: number;
  dV: number;
  /** 'normalized' 时 p∈[0,1]；'arcLength' 时 p∈[0,length] */
  pRange: 'normalized' | 'arcLength';
}

export type Geometry =
  | LineGeometry
  | ArcGeometry
  | SpiralGeometry
  | Poly3Geometry
  | ParamPoly3Geometry;

export type GeometryKind = Geometry['type'];

/** 参考线上某一站号处的位姿 */
export interface Pose {
  x: number;
  y: number;
  /** 航向角（弧度） */
  hdg: number;
  /** 该处曲率（1/m）。多项式类图元由二阶导求得 */
  curvature: number;
}

/** 曲率近似为零的阈值：半径 10⁶ m 以上按直线处理 */
export const CURVATURE_EPS = 1e-6;

/** 弧长/长度比较用的通用容差 */
export const LENGTH_EPS = 1e-9;
