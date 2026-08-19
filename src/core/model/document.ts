/** 顶层文档模型（`<OpenDRIVE>`）。 */

import type { Controller, Junction, JunctionConnection } from './junction.ts';
import type { Road } from './road.ts';

/**
 * 文件头（`<header>`）。
 *
 * geoReference 是整份文件的坐标基准：一段 PROJ 字符串，声明 x/y 所处的
 * 投影坐标系。缺失时 OpenDRIVE 规定坐标系原点未定义，此时无法与卫星影像
 * 对齐——本编辑器始终写出该字段。
 */
export interface Header {
  revMajor: number;
  revMinor: number;
  name?: string;
  version?: string;
  date?: string;
  /** 路网范围（米），由几何计算得出 */
  north?: number;
  south?: number;
  east?: number;
  west?: number;
  vendor?: string;
  /** PROJ.4 / PROJ 字符串，如 '+proj=tmerc +lat_0=39.9 +lon_0=116.4 ...' */
  geoReference?: string;
  /** 相对于 geoReference 的附加平移（`<offset>`） */
  offset?: {
    x: number;
    y: number;
    z: number;
    hdg: number;
  };
}

/** 一份 OpenDRIVE 路网 */
export interface OdrDocument {
  header: Header;
  roads: Road[];
  junctions: Junction[];
  controllers: Controller[];
}

export function createEmptyDocument(geoReference?: string): OdrDocument {
  return {
    header: {
      revMajor: 1,
      revMinor: 7,
      name: 'Untitled',
      version: '1.00',
      date: new Date().toISOString(),
      vendor: 'opendrive-editor',
      geoReference,
    },
    roads: [],
    junctions: [],
    controllers: [],
  };
}

export function findRoad(doc: OdrDocument, id: string): Road | undefined {
  return doc.roads.find((r) => r.id === id);
}

export function findJunction(doc: OdrDocument, id: string): Junction | undefined {
  return doc.junctions.find((j) => j.id === id);
}

/**
 * 该转向连接是否牵涉到指定道路。
 *
 * 三种牵涉方式：作为入口道路、作为连接道路本身、或作为连接道路另一端所接的
 * 出口道路。出口那一侧容易漏——它不出现在 `<connection>` 的任何字段里，只体现
 * 在连接道路的 `link` 上，漏判会让删掉出口臂之后留下一条通向虚无的连接道路。
 */
export function connectionTouchesRoad(
  doc: OdrDocument,
  conn: JunctionConnection,
  roadId: string,
): boolean {
  if (conn.incomingRoad === roadId || conn.connectingRoad === roadId) return true;

  const connecting = findRoad(doc, conn.connectingRoad);
  if (!connecting) return false;
  return (
    (connecting.link.predecessor?.elementType === 'road' &&
      connecting.link.predecessor.elementId === roadId) ||
    (connecting.link.successor?.elementType === 'road' &&
      connecting.link.successor.elementId === roadId)
  );
}

/** 指定路口是否还在使用该道路（作为入口、连接道路或出口） */
export function junctionUsesRoad(doc: OdrDocument, junction: Junction, roadId: string): boolean {
  return junction.connections.some((c) => connectionTouchesRoad(doc, c, roadId));
}

/**
 * 该道路的指定端点是否真的已被占用。
 *
 * 不能只看 `link` 存不存在。历史上画布删除道路时清理不全，会留下指向已空路口的
 * link；这种悬空 link 让端点被永判为「已占用」，用户在界面上删掉了全部连接却
 * 再也生成不了新路口，且没有任何可操作的出路。所以要求 link 指向的目标确实存在
 * 且确实还在用这条路——指向不存在的元素等于没接，允许直接覆盖。
 */
export function isEndOccupied(doc: OdrDocument, road: Road, end: 'start' | 'end'): boolean {
  const link = road.link[end === 'start' ? 'predecessor' : 'successor'];
  if (!link) return false;

  if (link.elementType === 'road') return doc.roads.some((r) => r.id === link.elementId);

  const junction = findJunction(doc, link.elementId);
  return junction !== undefined && junctionUsesRoad(doc, junction, road.id);
}

/** 生成未被占用的数字 id（以字符串形式），用于新建道路/交叉口 */
export function nextNumericId(existing: readonly { id: string }[]): string {
  let max = 0;
  for (const item of existing) {
    const n = Number.parseInt(item.id, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return String(max + 1);
}
