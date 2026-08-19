/**
 * 视口相机：工程坐标（米，y 向北）↔ 屏幕像素（y 向下）。
 *
 * 保持"每像素代表固定米数"的等比缩放（不做各向异性缩放），以免几何形状失真。
 */

import type { Vec2 } from '../core/math/vec.ts';

export interface ViewportRect {
  width: number;
  height: number;
}

/** 工程坐标下的可视矩形 */
export interface WorldBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export class Viewport {
  /** 视口中心的工程坐标 */
  center: Vec2 = { x: 0, y: 0 };
  /** 缩放：每米对应的屏幕像素数 */
  pixelsPerMeter = 2;
  /** 画布尺寸（CSS 像素） */
  size: ViewportRect = { width: 800, height: 600 };
  /** 设备像素比，用于高分屏 */
  dpr = 1;

  minPixelsPerMeter = 1e-4;
  maxPixelsPerMeter = 400;

  /** 每屏幕像素代表的米数 */
  get metersPerPixel(): number {
    return 1 / this.pixelsPerMeter;
  }

  /** 工程坐标 → 屏幕像素 */
  worldToScreen(p: Vec2): Vec2 {
    return {
      x: (p.x - this.center.x) * this.pixelsPerMeter + this.size.width / 2,
      // y 轴翻转：工程 y 向北，屏幕 y 向下
      y: this.size.height / 2 - (p.y - this.center.y) * this.pixelsPerMeter,
    };
  }

  /** 屏幕像素 → 工程坐标 */
  screenToWorld(p: Vec2): Vec2 {
    return {
      x: (p.x - this.size.width / 2) / this.pixelsPerMeter + this.center.x,
      y: (this.size.height / 2 - p.y) / this.pixelsPerMeter + this.center.y,
    };
  }

  /** 米 → 屏幕像素长度 */
  metersToPixels(m: number): number {
    return m * this.pixelsPerMeter;
  }

  /** 屏幕像素长度 → 米 */
  pixelsToMeters(px: number): number {
    return px / this.pixelsPerMeter;
  }

  /** 当前可视范围（工程坐标） */
  visibleBox(paddingPx = 0): WorldBox {
    const halfW = (this.size.width / 2 + paddingPx) / this.pixelsPerMeter;
    const halfH = (this.size.height / 2 + paddingPx) / this.pixelsPerMeter;
    return {
      minX: this.center.x - halfW,
      maxX: this.center.x + halfW,
      minY: this.center.y - halfH,
      maxY: this.center.y + halfH,
    };
  }

  /** 平移（屏幕像素增量） */
  panByPixels(dx: number, dy: number): void {
    this.center.x -= dx / this.pixelsPerMeter;
    // 屏幕 y 向下对应工程 y 减小，故此处为 +
    this.center.y += dy / this.pixelsPerMeter;
  }

  /**
   * 以屏幕上某锚点为中心缩放，保持锚点下的地物不动。
   * factor > 1 放大。
   */
  zoomAt(anchorScreen: Vec2, factor: number): void {
    const before = this.screenToWorld(anchorScreen);
    const next = this.pixelsPerMeter * factor;
    this.pixelsPerMeter = Math.max(
      this.minPixelsPerMeter,
      Math.min(this.maxPixelsPerMeter, next),
    );
    const after = this.screenToWorld(anchorScreen);
    this.center.x += before.x - after.x;
    this.center.y += before.y - after.y;
  }

  /** 使指定范围填满视口 */
  fitBox(box: WorldBox, paddingPx = 48): void {
    const w = box.maxX - box.minX;
    const h = box.maxY - box.minY;
    this.center = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };

    if (w <= 0 || h <= 0) {
      this.pixelsPerMeter = 2;
      return;
    }

    const availW = Math.max(1, this.size.width - paddingPx * 2);
    const availH = Math.max(1, this.size.height - paddingPx * 2);
    const scale = Math.min(availW / w, availH / h);
    this.pixelsPerMeter = Math.max(
      this.minPixelsPerMeter,
      Math.min(this.maxPixelsPerMeter, scale),
    );
  }

  /** 判断工程坐标点是否在可视范围内 */
  isVisible(p: Vec2, paddingPx = 0): boolean {
    const b = this.visibleBox(paddingPx);
    return p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY;
  }

  /** 判断包围盒是否与可视范围相交 */
  intersectsBox(box: WorldBox, paddingPx = 0): boolean {
    const b = this.visibleBox(paddingPx);
    return !(box.maxX < b.minX || box.minX > b.maxX || box.maxY < b.minY || box.minY > b.maxY);
  }
}

/** 挑选合适的比例尺刻度值（1/2/5 序列） */
export function niceScaleValue(rawMeters: number): number {
  const exp = Math.floor(Math.log10(rawMeters));
  const base = 10 ** exp;
  const norm = rawMeters / base;
  const step = norm >= 5 ? 5 : norm >= 2 ? 2 : 1;
  return step * base;
}
