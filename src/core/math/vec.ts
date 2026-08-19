/** 平面/空间向量与角度工具。全部为纯函数，坐标单位统一为米，角度统一为弧度。 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 extends Vec2 {
  z: number;
}

export const TWO_PI = Math.PI * 2;

export function vec2(x: number, y: number): Vec2 {
  return { x, y };
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(a: Vec2, k: number): Vec2 {
  return { x: a.x * k, y: a.y * k };
}

export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

/** 二维叉积的标量值（z 分量），符号表示 b 相对 a 的旋向 */
export function cross(a: Vec2, b: Vec2): number {
  return a.x * b.y - a.y * b.x;
}

export function length(a: Vec2): number {
  return Math.hypot(a.x, a.y);
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function normalize(a: Vec2): Vec2 {
  const len = Math.hypot(a.x, a.y);
  return len < 1e-12 ? { x: 0, y: 0 } : { x: a.x / len, y: a.y / len };
}

/** 逆时针旋转 90°，用于从切向求法向（OpenDRIVE 中 t 轴正方向为参考线左侧） */
export function perpLeft(a: Vec2): Vec2 {
  return { x: -a.y, y: a.x };
}

export function fromAngle(hdg: number, len = 1): Vec2 {
  return { x: Math.cos(hdg) * len, y: Math.sin(hdg) * len };
}

export function angleOf(a: Vec2): number {
  return Math.atan2(a.y, a.x);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpVec(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 归一化到 (-π, π] */
export function normalizeAngle(a: number): number {
  let r = a % TWO_PI;
  if (r > Math.PI) r -= TWO_PI;
  else if (r <= -Math.PI) r += TWO_PI;
  return r;
}

/** 归一化到 [0, 2π) */
export function normalizeAngle2Pi(a: number): number {
  const r = a % TWO_PI;
  return r < 0 ? r + TWO_PI : r;
}

/** 从 a 转到 b 的最小有向角差，结果落在 (-π, π] */
export function angleDelta(a: number, b: number): number {
  return normalizeAngle(b - a);
}

/** 点到线段的最近距离及参数 t∈[0,1] */
export function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): { t: number; point: Vec2; dist: number } {
  const ab = sub(b, a);
  const denom = dot(ab, ab);
  const t = denom < 1e-18 ? 0 : clamp(dot(sub(p, a), ab) / denom, 0, 1);
  const point = add(a, scale(ab, t));
  return { t, point, dist: distance(p, point) };
}

/**
 * 两条射线的交点。用于切线圆弧构造中求顶点。
 * 返回 null 表示近似平行。
 */
export function rayIntersect(p1: Vec2, d1: Vec2, p2: Vec2, d2: Vec2): Vec2 | null {
  const den = cross(d1, d2);
  if (Math.abs(den) < 1e-12) return null;
  const t = cross(sub(p2, p1), d2) / den;
  return add(p1, scale(d1, t));
}
