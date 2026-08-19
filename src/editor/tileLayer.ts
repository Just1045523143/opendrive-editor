/**
 * 卫星影像图层：把 Web Mercator 瓦片绘制到工程坐标系画布上。
 *
 * 核心问题：瓦片是 EPSG:3857 的正方形，而工程坐标系是等角投影（局部 TM/UTM）。
 * 两者之间存在尺度差（Web Mercator 在纬度 φ 处放大 1/cos φ）与微小的经线收敛
 * 旋转。直接按经纬度线性映射会导致影像与几何错位。
 *
 * 做法：把每块瓦片的四个角反投影到工程坐标系，再求一个把瓦片像素空间
 * (0..256)² 映射到屏幕的仿射变换。单块瓦片跨度很小（z16 约 600 m），两种
 * 投影之间的非线性在该尺度下远小于 1 像素，故仿射近似足够；四角最小二乘拟合
 * 又能把残差进一步均摊。
 */

import { fromTileDatum, type TileDatum } from '../geo/gcj02.ts';
import type { Projector } from '../geo/projection.ts';
import {
  TILE_SIZE,
  tileCorners,
  tileKey,
  tileUrl,
  tilesInBounds,
  zoomForResolution,
  type LonLatBounds,
  type TileId,
  type TileSource,
} from '../geo/tiles.ts';
import type { Viewport } from './viewport.ts';

interface CacheEntry {
  image: HTMLImageElement;
  /** 最近一次使用的时间戳，用于 LRU 淘汰 */
  touched: number;
  state: 'loading' | 'ready' | 'error';
}

/** 相邻瓦片间的亚像素外扩，消除接缝白线 */
const SEAM_OVERLAP = 0.5;

export interface TileLayerOptions {
  source: TileSource;
  /** 需要密钥的源在此提供 */
  apiKey?: string;
  opacity: number;
  visible: boolean;
  /** 手动层级偏移，用于在影像模糊时强制取更高层级 */
  zoomBias: number;
}

export class TileLayer {
  private cache = new Map<string, CacheEntry>();
  private maxCacheSize = 600;
  private inFlight = 0;
  private maxConcurrent = 8;
  private queue: TileId[] = [];

  options: TileLayerOptions;
  /** 瓦片加载完成后触发重绘 */
  onNeedsRedraw: (() => void) | null = null;

  constructor(options: TileLayerOptions) {
    this.options = options;
  }

  setSource(source: TileSource, apiKey?: string): void {
    this.options.source = source;
    this.options.apiKey = apiKey;
    this.cache.clear();
    this.queue.length = 0;
  }

  /** 当前视口对应的经纬度包围盒。沿边界采样以覆盖投影带来的弯曲 */
  private viewBoundsLonLat(viewport: Viewport, projector: Projector): LonLatBounds {
    const box = viewport.visibleBox(TILE_SIZE / 2);
    let minLon = Infinity;
    let maxLon = -Infinity;
    let minLat = Infinity;
    let maxLat = -Infinity;

    // 3×3 网格采样，比仅取四角更稳健
    for (let i = 0; i <= 2; i++) {
      for (let j = 0; j <= 2; j++) {
        const x = box.minX + ((box.maxX - box.minX) * i) / 2;
        const y = box.minY + ((box.maxY - box.minY) * j) / 2;
        const ll = projector.unproject({ x, y });
        if (ll.lon < minLon) minLon = ll.lon;
        if (ll.lon > maxLon) maxLon = ll.lon;
        if (ll.lat < minLat) minLat = ll.lat;
        if (ll.lat > maxLat) maxLat = ll.lat;
      }
    }
    return { minLon, maxLon, minLat, maxLat };
  }

  /** 选择层级：使瓦片地面分辨率与屏幕分辨率相当 */
  private chooseZoom(viewport: Viewport, centerLat: number): number {
    const mpp = viewport.metersPerPixel / viewport.dpr;
    const z = zoomForResolution(mpp, centerLat, this.options.source.maxZoom);
    return Math.max(0, Math.min(this.options.source.maxZoom, z + this.options.zoomBias));
  }

  /**
   * 绘制图层。
   * ctx 的变换应为屏幕像素空间（调用方已处理 dpr 缩放）。
   */
  draw(ctx: CanvasRenderingContext2D, viewport: Viewport, projector: Projector): void {
    const { visible, opacity, source } = this.options;
    if (!visible || opacity <= 0 || !source.urlTemplate) return;
    if (source.requiresKey && !this.options.apiKey) return;

    const bounds = this.viewBoundsLonLat(viewport, projector);
    const centerLat = (bounds.minLat + bounds.maxLat) / 2;
    const z = this.chooseZoom(viewport, centerLat);
    const tiles = tilesInBounds(bounds, z);
    if (tiles.length === 0) return;

    ctx.save();
    ctx.globalAlpha = opacity;
    // 影像放大时保持平滑
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    for (const t of tiles) {
      const entry = this.acquire(t);
      if (!entry || entry.state !== 'ready') continue;
      this.drawTile(ctx, entry.image, t, viewport, projector, source.datum);
    }

    ctx.restore();
    this.pump();
  }

  /**
   * 把单块瓦片按四角对应关系仿射绘制。
   *
   * 瓦片像素空间取 (0,0)-(256,256)，四角对应工程坐标经投影得到的屏幕点。
   * 由于瓦片像素空间是规则正方形，最小二乘仿射解可直接由四角均值给出：
   *   a = ((P1−P0)+(P2−P3)) / 2 / TILE   （u 方向）
   *   b = ((P3−P0)+(P2−P1)) / 2 / TILE   （v 方向）
   *   平移由四角重心与变换后中心相等确定。
   */
  private drawTile(
    ctx: CanvasRenderingContext2D,
    img: HTMLImageElement,
    t: TileId,
    viewport: Viewport,
    projector: Projector,
    datum: TileDatum,
  ): void {
    const corners = tileCorners(t);
    // 瓦片经纬度在其自身基准下，需先转回 WGS84 再投影
    const screen = corners.map((ll) => {
      const wgs = fromTileDatum(ll, datum);
      return viewport.worldToScreen(projector.project(wgs));
    });

    const p0 = screen[0]!; // 左上 (u=0, v=0)
    const p1 = screen[1]!; // 右上 (u=T, v=0)
    const p2 = screen[2]!; // 右下 (u=T, v=T)
    const p3 = screen[3]!; // 左下 (u=0, v=T)

    const ax = ((p1.x - p0.x) + (p2.x - p3.x)) / 2 / TILE_SIZE;
    const ay = ((p1.y - p0.y) + (p2.y - p3.y)) / 2 / TILE_SIZE;
    const bx = ((p3.x - p0.x) + (p2.x - p1.x)) / 2 / TILE_SIZE;
    const by = ((p3.y - p0.y) + (p2.y - p1.y)) / 2 / TILE_SIZE;

    // 亚像素外扩消接缝：以瓦片中心为不动点略微放大
    const grow = 1 + (2 * SEAM_OVERLAP) / TILE_SIZE;
    const half = TILE_SIZE / 2;
    // 平移量：令变换后瓦片中心与四角重心重合
    const cx = (p0.x + p1.x + p2.x + p3.x) / 4;
    const cy = (p0.y + p1.y + p2.y + p3.y) / 4;
    const tx = cx - (ax * half + bx * half) * grow;
    const ty = cy - (ay * half + by * half) * grow;

    ctx.save();
    // 用 transform 复合而非 setTransform 覆盖，使调用方已施加的 dpr 缩放得以保留
    ctx.transform(ax * grow, ay * grow, bx * grow, by * grow, tx, ty);
    try {
      ctx.drawImage(img, 0, 0, TILE_SIZE, TILE_SIZE);
    } catch {
      // 跨域瓦片在部分源上可能失败，忽略单块错误
    }
    ctx.restore();
  }

  /** 取缓存，未命中则入队加载 */
  private acquire(t: TileId): CacheEntry | undefined {
    const key = tileKey(this.options.source.id, t);
    const hit = this.cache.get(key);
    if (hit) {
      hit.touched = performance.now();
      return hit;
    }
    if (!this.queue.some((q) => q.x === t.x && q.y === t.y && q.z === t.z)) {
      this.queue.push(t);
    }
    return undefined;
  }

  /** 按并发上限发起请求 */
  private pump(): void {
    while (this.inFlight < this.maxConcurrent && this.queue.length > 0) {
      const t = this.queue.shift()!;
      this.load(t);
    }
  }

  private load(t: TileId): void {
    const key = tileKey(this.options.source.id, t);
    if (this.cache.has(key)) return;

    const img = new Image();
    // 允许把瓦片画进 canvas；源需返回 CORS 头，否则退化为不可读但仍可绘制
    img.crossOrigin = 'anonymous';
    const entry: CacheEntry = { image: img, touched: performance.now(), state: 'loading' };
    this.cache.set(key, entry);
    this.inFlight++;

    const finish = (state: 'ready' | 'error') => {
      entry.state = state;
      this.inFlight--;
      if (state === 'ready') this.onNeedsRedraw?.();
      this.pump();
      this.evict();
    };

    img.onload = () => finish('ready');
    img.onerror = () => finish('error');
    img.src = tileUrl(this.options.source, t, this.options.apiKey);
  }

  /** LRU 淘汰 */
  private evict(): void {
    if (this.cache.size <= this.maxCacheSize) return;
    const entries = [...this.cache.entries()]
      .filter(([, e]) => e.state !== 'loading')
      .sort((a, b) => a[1].touched - b[1].touched);
    const drop = this.cache.size - this.maxCacheSize;
    for (let i = 0; i < drop && i < entries.length; i++) {
      this.cache.delete(entries[i]![0]);
    }
  }

  /** 供界面显示的加载状态 */
  get stats(): { cached: number; loading: number; queued: number } {
    let loading = 0;
    for (const e of this.cache.values()) if (e.state === 'loading') loading++;
    return { cached: this.cache.size, loading, queued: this.queue.length };
  }
}
