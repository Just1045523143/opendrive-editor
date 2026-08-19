/**
 * GCJ-02 / BD-09 与 WGS84 的相互转换。
 *
 * 国内地图服务（高德、腾讯、天地图影像等）发布的瓦片使用 GCJ-02（"火星坐标"），
 * 百度再叠加一层 BD-09。若直接用 WGS84 经纬度去索引这些瓦片，影像会相对
 * 真实位置偏移数百米——在高精路网场景下完全不可接受。
 *
 * GCJ-02 的官方算法未公开，业界通用的是一组公开的经验逼近式，精度约 1~2 m，
 * 优于瓦片自身在常用层级下的地面分辨率（z19 约 0.3 m/px，z18 约 0.6 m/px），
 * 对描绘车道级几何而言残差主要来自影像自身正射校正而非此转换。
 *
 * 反向（GCJ-02→WGS84）无闭式解，采用不动点迭代，3 次即收敛到 1e-9 度以下。
 */

import type { LonLat } from './projection.ts';

/** 克拉索夫斯基椭球长半轴（经验式沿用此参数，不可替换为 WGS84 的值） */
const A = 6378245.0;
/** 第一偏心率平方 */
const EE = 0.00669342162296594323;

const PI = Math.PI;
const X_PI = (PI * 3000.0) / 180.0;

/** 中国大陆粗略包围盒。框外不做偏移（港澳台及境外使用真实 WGS84） */
export function outOfChina(lon: number, lat: number): boolean {
  return lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x: number, y: number): number {
  let ret =
    -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLon(x: number, y: number): number {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0;
  return ret;
}

/** 计算 WGS84 点处的 GCJ-02 偏移量（度） */
function offset(lon: number, lat: number): { dLon: number; dLat: number } {
  let dLat = transformLat(lon - 105.0, lat - 35.0);
  let dLon = transformLon(lon - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
  dLon = (dLon * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI);
  return { dLon, dLat };
}

/** WGS84 → GCJ-02 */
export function wgs84ToGcj02(p: LonLat): LonLat {
  if (outOfChina(p.lon, p.lat)) return { ...p };
  const { dLon, dLat } = offset(p.lon, p.lat);
  return { lon: p.lon + dLon, lat: p.lat + dLat };
}

/**
 * GCJ-02 → WGS84（不动点迭代）。
 *
 * 求解 f(w) = w + offset(w) = g 中的 w。由于 offset 随位置变化极缓，
 * 迭代 w ← g − offset(w) 的收缩因子约 1e-4，3 次迭代残差已 < 1e-11 度（约 1 μm）。
 */
export function gcj02ToWgs84(p: LonLat): LonLat {
  if (outOfChina(p.lon, p.lat)) return { ...p };
  let lon = p.lon;
  let lat = p.lat;
  for (let i = 0; i < 4; i++) {
    const { dLon, dLat } = offset(lon, lat);
    const nextLon = p.lon - dLon;
    const nextLat = p.lat - dLat;
    if (Math.abs(nextLon - lon) < 1e-12 && Math.abs(nextLat - lat) < 1e-12) {
      lon = nextLon;
      lat = nextLat;
      break;
    }
    lon = nextLon;
    lat = nextLat;
  }
  return { lon, lat };
}

/** GCJ-02 → BD-09（百度） */
export function gcj02ToBd09(p: LonLat): LonLat {
  const z = Math.sqrt(p.lon * p.lon + p.lat * p.lat) + 0.00002 * Math.sin(p.lat * X_PI);
  const theta = Math.atan2(p.lat, p.lon) + 0.000003 * Math.cos(p.lon * X_PI);
  return {
    lon: z * Math.cos(theta) + 0.0065,
    lat: z * Math.sin(theta) + 0.006,
  };
}

/**
 * BD-09 → GCJ-02。
 *
 * 常见的"减 0.0065/0.006 后反算"写法与正变换并非严格互逆，残差约 7 cm。
 * 对车道级作业而言这属于可消除的系统误差，故先用该式取初值，再用不动点
 * 迭代收敛到正变换的真实逆——3 次迭代后残差降到 1e-9 度（亚毫米）以下。
 */
export function bd09ToGcj02(p: LonLat): LonLat {
  // 闭式近似作初值
  const x = p.lon - 0.0065;
  const y = p.lat - 0.006;
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * X_PI);
  const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * X_PI);
  let lon = z * Math.cos(theta);
  let lat = z * Math.sin(theta);

  // 迭代精化：求 g 使 gcj02ToBd09(g) == p
  for (let i = 0; i < 4; i++) {
    const forward = gcj02ToBd09({ lon, lat });
    const dLon = forward.lon - p.lon;
    const dLat = forward.lat - p.lat;
    if (Math.abs(dLon) < 1e-12 && Math.abs(dLat) < 1e-12) break;
    lon -= dLon;
    lat -= dLat;
  }

  return { lon, lat };
}

export function wgs84ToBd09(p: LonLat): LonLat {
  return gcj02ToBd09(wgs84ToGcj02(p));
}

export function bd09ToWgs84(p: LonLat): LonLat {
  return gcj02ToWgs84(bd09ToGcj02(p));
}

/** 瓦片源使用的大地基准 */
export type TileDatum = 'wgs84' | 'gcj02' | 'bd09';

/** 把 WGS84 坐标转到指定瓦片基准下 */
export function toTileDatum(p: LonLat, datum: TileDatum): LonLat {
  switch (datum) {
    case 'wgs84':
      return { ...p };
    case 'gcj02':
      return wgs84ToGcj02(p);
    case 'bd09':
      return wgs84ToBd09(p);
  }
}

/** 把瓦片基准下的坐标转回 WGS84 */
export function fromTileDatum(p: LonLat, datum: TileDatum): LonLat {
  switch (datum) {
    case 'wgs84':
      return { ...p };
    case 'gcj02':
      return gcj02ToWgs84(p);
    case 'bd09':
      return bd09ToWgs84(p);
  }
}
