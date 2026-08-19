/**
 * 坐标系与投影。
 *
 * 设计要点：OpenDRIVE 的 x/y 是**投影平面米制**坐标，而卫星瓦片是 Web Mercator。
 * 后者在纬度 φ 处的尺度因子为 1/cos φ——北京(39.9°)约 1.30，上海(31.2°)约 1.17。
 * 若把米直接当 Web Mercator 米使用，画出的路网会整体放大同等倍数。
 *
 * 因此本编辑器：
 *   - 工程坐标系 = 一个真实的等角投影（局部 TM / UTM / 高斯克吕格 / 自定义）
 *   - 全程在该坐标系下以真实米编辑，导出 x/y 直接可用
 *   - 卫星瓦片按角点经纬度反投影到工程坐标系后再绘制（见 tiles.ts）
 */

import proj4 from 'proj4';

/** WGS84 经纬度 */
export interface LonLat {
  lon: number;
  lat: number;
}

/** 投影平面坐标（米） */
export interface ProjXY {
  x: number;
  y: number;
}

export type CrsKind = 'local-tmerc' | 'utm' | 'gauss-kruger' | 'custom';

export interface CoordinateSystem {
  kind: CrsKind;
  /** 人类可读名称 */
  label: string;
  /** PROJ 字符串，写入 xodr 的 geoReference */
  proj: string;
  /** 工程原点（局部 TM 时为投影中心；其余仅作视图初始定位） */
  origin: LonLat;
}

const WGS84 = '+proj=longlat +datum=WGS84 +no_defs';

/**
 * 以指定经纬度为中心的局部横轴墨卡托。
 *
 * k=1 使原点处尺度精确为 1（真实米）。尺度误差随东向距离 x 增长约
 * x²/(2R²)，10 km 处约 1.2 ppm（即 1.2 cm/10 km），路网编辑完全够用。
 * 这也是 CARLA / esmini 等工具处理 OSM 导入时的惯用做法。
 */
export function localTmerc(origin: LonLat): CoordinateSystem {
  const lat = round(origin.lat, 9);
  const lon = round(origin.lon, 9);
  return {
    kind: 'local-tmerc',
    label: `局部横轴墨卡托 @ ${lat.toFixed(6)}, ${lon.toFixed(6)}`,
    proj: `+proj=tmerc +lat_0=${lat} +lon_0=${lon} +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs`,
    origin: { lon, lat },
  };
}

/** 由经度求 UTM 带号（1..60） */
export function utmZoneOf(lon: number): number {
  const z = Math.floor((normalizeLon(lon) + 180) / 6) + 1;
  return z < 1 ? 1 : z > 60 ? 60 : z;
}

/** UTM 投影。zone 缺省时按 origin 经度推算 */
export function utm(origin: LonLat, zone?: number): CoordinateSystem {
  const z = zone ?? utmZoneOf(origin.lon);
  const south = origin.lat < 0;
  return {
    kind: 'utm',
    label: `UTM ${z}${south ? 'S' : 'N'} (WGS84)`,
    proj: `+proj=utm +zone=${z}${south ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`,
    origin,
  };
}

/**
 * 高斯-克吕格（CGCS2000）。中国大比例尺测绘常用。
 * width=3 为 3° 分带（1:1万及更大比例尺），width=6 为 6° 分带。
 * withFalseEasting 为 true 时东向加上 带号×10⁶（国内成果的常见形式）。
 */
export function gaussKruger(
  origin: LonLat,
  width: 3 | 6 = 3,
  withFalseEasting = false,
): CoordinateSystem {
  const lon = normalizeLon(origin.lon);
  const zone = width === 3 ? Math.round(lon / 3) : Math.floor(lon / 6) + 1;
  const centralMeridian = width === 3 ? zone * 3 : zone * 6 - 3;
  const x0 = withFalseEasting ? zone * 1e6 : 500000;
  return {
    kind: 'gauss-kruger',
    label: `高斯克吕格 CGCS2000 ${width}°带 (中央经线 ${centralMeridian}°)`,
    proj: `+proj=tmerc +lat_0=0 +lon_0=${centralMeridian} +k=1 +x_0=${x0} +y_0=0 +ellps=GRS80 +units=m +no_defs`,
    origin,
  };
}

/** 自定义 PROJ 字符串 */
export function customCrs(proj: string, origin: LonLat, label = '自定义坐标系'): CoordinateSystem {
  return { kind: 'custom', label, proj, origin };
}

/**
 * 投影器：缓存 proj4 转换对象，提供双向转换。
 */
export class Projector {
  readonly crs: CoordinateSystem;
  private readonly forward: proj4.Converter;

  constructor(crs: CoordinateSystem) {
    this.crs = crs;
    this.forward = proj4(WGS84, crs.proj);
  }

  /** WGS84 经纬度 → 工程平面米 */
  project(ll: LonLat): ProjXY {
    const [x, y] = this.forward.forward([ll.lon, ll.lat]) as [number, number];
    return { x, y };
  }

  /** 工程平面米 → WGS84 经纬度 */
  unproject(p: ProjXY): LonLat {
    const [lon, lat] = this.forward.inverse([p.x, p.y]) as [number, number];
    return { lon, lat };
  }

  /**
   * 指定位置的局部尺度因子：投影距离 / 椭球面真实距离。
   * 1 表示无变形；界面据此提示用户当前坐标系在作业区的变形量。
   *
   * 真实距离取子午线方向的椭球弧长 M·dφ，其中 M 为子午圈曲率半径
   *   M = a(1−e²) / (1 − e²sin²φ)^{3/2}
   * 用常数「每度 111132.95 m」会在中纬度引入约 1e-3 的系统偏差，
   * 足以掩盖真实的投影变形，故必须按纬度严格计算。
   */
  scaleFactorAt(ll: LonLat): number {
    const dLat = 1e-5; // 约 1.1 m，足够小以线性化
    const a = this.project(ll);
    const b = this.project({ lon: ll.lon, lat: ll.lat + dLat });
    const projected = Math.hypot(b.x - a.x, b.y - a.y);

    const real = meridianArc(ll.lat, dLat);
    return real > 0 ? projected / real : 1;
  }
}

/** WGS84 长半轴（米） */
const WGS84_A = 6378137;
/** WGS84 第一偏心率平方 */
const WGS84_E2 = 0.00669437999014;

/** 纬度 lat 处、跨度 dLatDeg 度的子午线椭球弧长（米） */
function meridianArc(lat: number, dLatDeg: number): number {
  const phi = (lat * Math.PI) / 180;
  const sinPhi = Math.sin(phi);
  const w = 1 - WGS84_E2 * sinPhi * sinPhi;
  const M = (WGS84_A * (1 - WGS84_E2)) / Math.pow(w, 1.5);
  return M * ((dLatDeg * Math.PI) / 180);
}

function normalizeLon(lon: number): number {
  let l = lon;
  while (l > 180) l -= 360;
  while (l < -180) l += 360;
  return l;
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/**
 * 从 xodr 的 geoReference 字符串重建坐标系。
 * 无法识别时退回 custom，仍可正常转换（proj4 支持大多数 PROJ 串）。
 */
export function crsFromGeoReference(geoRef: string, fallbackOrigin?: LonLat): CoordinateSystem {
  const trimmed = geoRef.trim();

  // 从 PROJ 串里取投影中心作为 origin
  const lat0 = matchNum(trimmed, /\+lat_0=(-?[\d.]+)/);
  const lon0 = matchNum(trimmed, /\+lon_0=(-?[\d.]+)/);
  const origin: LonLat = {
    lon: lon0 ?? fallbackOrigin?.lon ?? 0,
    lat: lat0 ?? fallbackOrigin?.lat ?? 0,
  };

  if (/\+proj=utm/.test(trimmed)) {
    const zone = matchNum(trimmed, /\+zone=(\d+)/) ?? 1;
    const south = /\+south/.test(trimmed);
    return {
      kind: 'utm',
      label: `UTM ${zone}${south ? 'S' : 'N'}`,
      proj: trimmed,
      origin,
    };
  }

  if (/\+proj=tmerc/.test(trimmed)) {
    const isLocal = lat0 !== undefined && Math.abs(lat0) > 1e-9;
    return {
      kind: isLocal ? 'local-tmerc' : 'gauss-kruger',
      label: isLocal
        ? `局部横轴墨卡托 @ ${origin.lat.toFixed(6)}, ${origin.lon.toFixed(6)}`
        : `横轴墨卡托 (中央经线 ${origin.lon}°)`,
      proj: trimmed,
      origin,
    };
  }

  return { kind: 'custom', label: '自定义坐标系', proj: trimmed, origin };
}

function matchNum(s: string, re: RegExp): number | undefined {
  const m = re.exec(s);
  if (!m || m[1] === undefined) return undefined;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : undefined;
}
