/**
 * Web Mercator 瓦片数学与影像源定义。
 *
 * 瓦片按 XYZ（slippy map）方案编号，EPSG:3857。本模块只做索引与经纬度换算，
 * 实际的"反投影到工程坐标系再绘制"在 editor/tileLayer.ts 完成。
 */

import { type TileDatum } from './gcj02.ts';
import type { LonLat } from './projection.ts';

/** 瓦片边长（像素） */
export const TILE_SIZE = 256;

/** Web Mercator 纬度上下限（±85.051129°），超出即投影发散 */
export const MAX_LATITUDE = 85.0511287798066;

export interface TileId {
  x: number;
  y: number;
  z: number;
}

/** 经纬度 → 分数瓦片坐标（同一层级内连续） */
export function lonLatToTileXY(ll: LonLat, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const lat = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, ll.lat));
  const latRad = (lat * Math.PI) / 180;
  return {
    x: ((ll.lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  };
}

/** 分数瓦片坐标 → 经纬度 */
export function tileXYToLonLat(x: number, y: number, z: number): LonLat {
  const n = 2 ** z;
  const lonDeg = (x / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  return { lon: lonDeg, lat: (latRad * 180) / Math.PI };
}

/** 瓦片四角经纬度，顺序：左上、右上、右下、左下 */
export function tileCorners(t: TileId): [LonLat, LonLat, LonLat, LonLat] {
  return [
    tileXYToLonLat(t.x, t.y, t.z),
    tileXYToLonLat(t.x + 1, t.y, t.z),
    tileXYToLonLat(t.x + 1, t.y + 1, t.z),
    tileXYToLonLat(t.x, t.y + 1, t.z),
  ];
}

/** 某层级在指定纬度处的地面分辨率（米/像素） */
export function groundResolution(lat: number, z: number): number {
  const EARTH_CIRCUMFERENCE = 40075016.685578488;
  return (EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180)) / (TILE_SIZE * 2 ** z);
}

/**
 * 由目标分辨率反求层级。
 * metersPerPixel 为当前视图每屏幕像素代表的真实米数。
 */
export function zoomForResolution(metersPerPixel: number, lat: number, maxZoom = 21): number {
  const EARTH_CIRCUMFERENCE = 40075016.685578488;
  const z = Math.log2(
    (EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180)) / (TILE_SIZE * metersPerPixel),
  );
  return Math.max(0, Math.min(maxZoom, Math.round(z)));
}

/** 经纬度包围盒 */
export interface LonLatBounds {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

/** 列出覆盖给定经纬度范围的瓦片；limit 用于防止层级选择失误导致请求爆量 */
export function tilesInBounds(b: LonLatBounds, z: number, limit = 400): TileId[] {
  const n = 2 ** z;
  const tl = lonLatToTileXY({ lon: b.minLon, lat: b.maxLat }, z);
  const br = lonLatToTileXY({ lon: b.maxLon, lat: b.minLat }, z);

  const x0 = Math.max(0, Math.floor(tl.x));
  const x1 = Math.min(n - 1, Math.floor(br.x));
  const y0 = Math.max(0, Math.floor(tl.y));
  const y1 = Math.min(n - 1, Math.floor(br.y));

  const out: TileId[] = [];
  const total = (x1 - x0 + 1) * (y1 - y0 + 1);
  if (total > limit || total <= 0) return out;

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      out.push({ x, y, z });
    }
  }
  return out;
}

/** 影像源定义 */
export interface TileSource {
  id: string;
  label: string;
  /** URL 模板，支持 {x} {y} {z} {s}（子域轮询）{key}（密钥） */
  urlTemplate: string;
  /** 瓦片所处大地基准。国内影像多为 gcj02，需纠偏后才能与 WGS84 几何对齐 */
  datum: TileDatum;
  maxZoom: number;
  /** 子域列表，配合 {s} 使用 */
  subdomains?: string[];
  /** 版权声明，界面必须展示 */
  attribution: string;
  /** true 表示必须由用户提供 key 才能使用 */
  requiresKey?: boolean;
  /** 使用条款提示 */
  terms?: string;
}

/**
 * 内置影像源。
 *
 * 使用第三方瓦片须遵守各自服务条款——尤其商业用途通常需要授权或自备密钥。
 * 默认仅启用 Esri World Imagery（允许署名前提下的非商业使用），其余需用户
 * 显式选择或填入密钥。
 */
export const TILE_SOURCES: TileSource[] = [
  {
    id: 'esri-imagery',
    label: 'Esri 世界影像',
    urlTemplate:
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    datum: 'wgs84',
    maxZoom: 19,
    attribution: 'Esri, Maxar, Earthstar Geographics',
    terms: '非商业用途需署名；商业用途请查阅 Esri 服务条款',
  },
  {
    id: 'osm',
    label: 'OpenStreetMap 街道图',
    urlTemplate: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    subdomains: ['a', 'b', 'c'],
    datum: 'wgs84',
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors',
    terms: 'ODbL；请遵守 OSM 瓦片使用政策，避免大批量抓取',
  },
  {
    id: 'tianditu-img',
    label: '天地图影像（需密钥）',
    urlTemplate:
      'https://t{s}.tianditu.gov.cn/img_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=img&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk={key}',
    subdomains: ['0', '1', '2', '3', '4', '5', '6', '7'],
    datum: 'wgs84',
    maxZoom: 18,
    requiresKey: true,
    attribution: '天地图 · 国家地理信息公共服务平台',
    terms: '需在天地图官网申请 tk 密钥',
  },
  {
    id: 'amap-satellite',
    label: '高德卫星（GCJ-02，需授权）',
    urlTemplate: 'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
    subdomains: ['1', '2', '3', '4'],
    datum: 'gcj02',
    maxZoom: 18,
    attribution: '© 高德地图',
    terms: '生产环境须取得高德开放平台授权；本编辑器已内置 GCJ-02 纠偏',
  },
  {
    id: 'custom',
    label: '自定义 URL 模板',
    urlTemplate: '',
    datum: 'wgs84',
    maxZoom: 22,
    attribution: '自定义源',
    terms: '由使用者自行确保合规',
  },
];

export function findTileSource(id: string): TileSource | undefined {
  return TILE_SOURCES.find((s) => s.id === id);
}

/** 展开 URL 模板 */
export function tileUrl(source: TileSource, t: TileId, key?: string): string {
  let url = source.urlTemplate;
  if (source.subdomains && source.subdomains.length > 0) {
    const idx = (t.x + t.y) % source.subdomains.length;
    url = url.replace('{s}', source.subdomains[idx]!);
  }
  return url
    .replace('{z}', String(t.z))
    .replace('{x}', String(t.x))
    .replace('{y}', String(t.y))
    .replace('{key}', key ?? '');
}

export function tileKey(sourceId: string, t: TileId): string {
  return `${sourceId}/${t.z}/${t.x}/${t.y}`;
}
