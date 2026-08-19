/**
 * .xodr → 模型。
 *
 * 解析策略偏向宽容：缺失的可选属性取规范默认值，无法识别的元素/属性尽量
 * 保留（extraAttrs / rawChildren）以便导出时不丢信息。遇到结构性错误
 * （如 road 缺少 planView）记入 warnings 而非抛错，让用户仍能看到部分路网。
 */

import type { Geometry } from '../geometry/types.ts';
import type { PolyRecord } from '../math/poly.ts';
import type { OdrDocument, Header } from '../model/document.ts';
import type {
  Controller,
  Junction,
  JunctionConnection,
  JunctionLaneLink,
} from '../model/junction.ts';
import type { Lane, LaneSection, RoadMark } from '../model/lane.ts';
import type {
  ContactPoint,
  Elevation,
  LinkElementType,
  Road,
  RoadLink,
  RoadLinkEnd,
  RoadObject,
  RoadSignal,
  RoadTypeRecord,
} from '../model/road.ts';
import {
  attr,
  child,
  children,
  num,
  numOpt,
  parseXml,
  serializeRaw,
  type XmlNode,
} from './dom.ts';

export interface ParseResult {
  document: OdrDocument;
  warnings: string[];
}

/** 已建模的属性名集合，用于筛出 extraAttrs */
function collectExtra(node: XmlNode, known: readonly string[]): Record<string, string> | undefined {
  let out: Record<string, string> | undefined;
  for (const [k, v] of Object.entries(node.attrs)) {
    if (known.includes(k)) continue;
    (out ??= {})[k] = v;
  }
  return out;
}

function parseHeader(node: XmlNode | undefined): Header {
  if (!node) return { revMajor: 1, revMinor: 7 };

  const geoNode = child(node, 'geoReference');
  const offsetNode = child(node, 'offset');

  const header: Header = {
    revMajor: num(node, 'revMajor', 1),
    revMinor: num(node, 'revMinor', 7),
    name: attr(node, 'name'),
    version: attr(node, 'version'),
    date: attr(node, 'date'),
    north: numOpt(node, 'north'),
    south: numOpt(node, 'south'),
    east: numOpt(node, 'east'),
    west: numOpt(node, 'west'),
    vendor: attr(node, 'vendor'),
  };

  const geo = geoNode?.text?.trim();
  if (geo) header.geoReference = geo;

  if (offsetNode) {
    header.offset = {
      x: num(offsetNode, 'x'),
      y: num(offsetNode, 'y'),
      z: num(offsetNode, 'z'),
      hdg: num(offsetNode, 'hdg'),
    };
  }

  return header;
}

/** 解析 planView 下的几何图元链 */
function parsePlanView(node: XmlNode | undefined, warnings: string[], roadId: string): Geometry[] {
  if (!node) return [];
  const out: Geometry[] = [];

  for (const g of children(node, 'geometry')) {
    const base = {
      s: num(g, 's'),
      x: num(g, 'x'),
      y: num(g, 'y'),
      hdg: num(g, 'hdg'),
      length: num(g, 'length'),
    };

    if (base.length <= 0) {
      warnings.push(`道路 ${roadId}: s=${base.s} 处几何长度为 ${base.length}，已跳过`);
      continue;
    }

    const spiral = child(g, 'spiral');
    const arc = child(g, 'arc');
    const poly3 = child(g, 'poly3');
    const param = child(g, 'paramPoly3');

    if (spiral) {
      out.push({
        ...base,
        type: 'spiral',
        curvStart: num(spiral, 'curvStart'),
        curvEnd: num(spiral, 'curvEnd'),
      });
    } else if (arc) {
      out.push({ ...base, type: 'arc', curvature: num(arc, 'curvature') });
    } else if (poly3) {
      out.push({
        ...base,
        type: 'poly3',
        a: num(poly3, 'a'),
        b: num(poly3, 'b'),
        c: num(poly3, 'c'),
        d: num(poly3, 'd'),
      });
    } else if (param) {
      const range = attr(param, 'pRange');
      out.push({
        ...base,
        type: 'paramPoly3',
        aU: num(param, 'aU'),
        bU: num(param, 'bU'),
        cU: num(param, 'cU'),
        dU: num(param, 'dU'),
        aV: num(param, 'aV'),
        bV: num(param, 'bV'),
        cV: num(param, 'cV'),
        dV: num(param, 'dV'),
        pRange: range === 'arcLength' ? 'arcLength' : 'normalized',
      });
    } else {
      // 无子元素时按 <line> 处理（规范要求必有其一，此处容错）
      out.push({ ...base, type: 'line' });
    }
  }

  out.sort((a, b) => a.s - b.s);
  return out;
}

/** 解析形如 <elevation s a b c d> 的分段多项式序列 */
function parsePolyRecords(parent: XmlNode | undefined, tag: string): PolyRecord[] {
  if (!parent) return [];
  return children(parent, tag)
    .map((n) => ({
      s: num(n, 's'),
      a: num(n, 'a'),
      b: num(n, 'b'),
      c: num(n, 'c'),
      d: num(n, 'd'),
    }))
    .sort((x, y) => x.s - y.s);
}

function parseRoadMarks(laneNode: XmlNode): RoadMark[] {
  return children(laneNode, 'roadMark')
    .map((m) => {
      const mark: RoadMark = {
        sOffset: num(m, 'sOffset'),
        type: attr(m, 'type') ?? 'none',
        color: attr(m, 'color') ?? 'standard',
      };
      const weight = attr(m, 'weight');
      if (weight === 'bold' || weight === 'standard') mark.weight = weight;
      const w = numOpt(m, 'width');
      if (w !== undefined) mark.width = w;
      const lc = attr(m, 'laneChange');
      if (lc === 'increase' || lc === 'decrease' || lc === 'both' || lc === 'none') {
        mark.laneChange = lc;
      }
      const to = numOpt(m, 'tOffset');
      if (to !== undefined) mark.tOffset = to;
      const material = attr(m, 'material');
      if (material) mark.material = material;
      const h = numOpt(m, 'height');
      if (h !== undefined) mark.height = h;
      return mark;
    })
    .sort((a, b) => a.sOffset - b.sOffset);
}

const LANE_KNOWN_ATTRS = ['id', 'type', 'level'] as const;

function parseLane(node: XmlNode): Lane {
  const linkNode = child(node, 'link');
  const widthNodes = children(node, 'width');
  const borderNodes = children(node, 'border');

  const lane: Lane = {
    id: num(node, 'id'),
    type: attr(node, 'type') ?? 'none',
    link: {
      predecessorIds: linkNode
        ? children(linkNode, 'predecessor').map((p) => num(p, 'id'))
        : [],
      successorIds: linkNode ? children(linkNode, 'successor').map((p) => num(p, 'id')) : [],
    },
    widths: widthNodes
      .map((w) => ({
        sOffset: num(w, 'sOffset'),
        a: num(w, 'a'),
        b: num(w, 'b'),
        c: num(w, 'c'),
        d: num(w, 'd'),
      }))
      .sort((a, b) => a.sOffset - b.sOffset),
    roadMarks: parseRoadMarks(node),
  };

  const level = attr(node, 'level');
  if (level === 'true' || level === '1') lane.level = true;

  if (borderNodes.length > 0) {
    lane.borders = borderNodes
      .map((b) => ({
        sOffset: num(b, 'sOffset'),
        a: num(b, 'a'),
        b: num(b, 'b'),
        c: num(b, 'c'),
        d: num(b, 'd'),
      }))
      .sort((a, b) => a.sOffset - b.sOffset);
  }

  const speedNodes = children(node, 'speed');
  if (speedNodes.length > 0) {
    lane.speeds = speedNodes.map((s) => {
      const unit = attr(s, 'unit');
      return {
        sOffset: num(s, 'sOffset'),
        max: num(s, 'max'),
        ...(unit === 'm/s' || unit === 'mph' || unit === 'km/h' ? { unit } : {}),
      };
    });
  }

  const material = child(node, 'material');
  if (material) lane.material = attr(material, 'surface');

  const extra = collectExtra(node, LANE_KNOWN_ATTRS);
  if (extra) lane.extraAttrs = extra;

  return lane;
}

function parseLaneSections(lanesNode: XmlNode | undefined): LaneSection[] {
  if (!lanesNode) return [];
  const out: LaneSection[] = [];

  for (const sec of children(lanesNode, 'laneSection')) {
    const leftNode = child(sec, 'left');
    const centerNode = child(sec, 'center');
    const rightNode = child(sec, 'right');

    const left = leftNode ? children(leftNode, 'lane').map(parseLane) : [];
    const right = rightNode ? children(rightNode, 'lane').map(parseLane) : [];
    const centerLanes = centerNode ? children(centerNode, 'lane').map(parseLane) : [];

    // 左侧由内向外 = id 升序；右侧由内向外 = id 降序
    left.sort((a, b) => a.id - b.id);
    right.sort((a, b) => b.id - a.id);

    const section: LaneSection = {
      s: num(sec, 's'),
      left,
      center: centerLanes[0] ?? {
        id: 0,
        type: 'none',
        link: { predecessorIds: [], successorIds: [] },
        widths: [],
        roadMarks: [],
      },
      right,
    };

    const single = attr(sec, 'singleSide');
    if (single === 'true' || single === '1') section.singleSide = true;

    out.push(section);
  }

  out.sort((a, b) => a.s - b.s);
  return out;
}

function parseLinkEnd(node: XmlNode | undefined): RoadLinkEnd | undefined {
  if (!node) return undefined;
  const rawType = attr(node, 'elementType');
  const elementType: LinkElementType = rawType === 'junction' ? 'junction' : 'road';
  const cp = attr(node, 'contactPoint');
  const end: RoadLinkEnd = {
    elementType,
    elementId: attr(node, 'elementId') ?? '',
  };
  if (cp === 'start' || cp === 'end') end.contactPoint = cp as ContactPoint;
  const es = numOpt(node, 'elementS');
  if (es !== undefined) end.elementS = es;
  const dir = attr(node, 'elementDir');
  if (dir === '+' || dir === '-') end.elementDir = dir;
  return end;
}

function parseRoadLink(node: XmlNode | undefined): RoadLink {
  if (!node) return {};
  const link: RoadLink = {};
  const pre = parseLinkEnd(child(node, 'predecessor'));
  const suc = parseLinkEnd(child(node, 'successor'));
  if (pre) link.predecessor = pre;
  if (suc) link.successor = suc;
  return link;
}

function parseRoadTypes(node: XmlNode): RoadTypeRecord[] {
  return children(node, 'type')
    .map((t) => {
      const speed = child(t, 'speed');
      const rec: RoadTypeRecord = { s: num(t, 's'), type: attr(t, 'type') ?? 'town' };
      if (speed) {
        const max = attr(speed, 'max');
        if (max !== undefined && max !== 'no limit' && max !== 'undefined') {
          const v = Number(max);
          if (Number.isFinite(v)) rec.speedMax = v;
        }
        const unit = attr(speed, 'unit');
        if (unit) rec.speedUnit = unit;
      }
      return rec;
    })
    .sort((a, b) => a.s - b.s);
}

const OBJECT_KNOWN = [
  'id', 'type', 'name', 's', 't', 'zOffset', 'hdg', 'length', 'width', 'radius', 'height',
] as const;

function parseObjects(node: XmlNode | undefined): RoadObject[] {
  if (!node) return [];
  return children(node, 'object').map((o) => {
    const obj: RoadObject = {
      id: attr(o, 'id') ?? '',
      s: num(o, 's'),
      t: num(o, 't'),
    };
    const type = attr(o, 'type');
    if (type) obj.type = type;
    const name = attr(o, 'name');
    if (name) obj.name = name;
    for (const key of ['zOffset', 'hdg', 'length', 'width', 'radius', 'height'] as const) {
      const v = numOpt(o, key);
      if (v !== undefined) obj[key] = v;
    }
    const extra = collectExtra(o, OBJECT_KNOWN);
    if (extra) obj.extraAttrs = extra;
    if (o.children.length > 0) {
      obj.rawChildren = o.children.map((c) => serializeRaw(c, '      ')).join('');
    }
    return obj;
  });
}

const SIGNAL_KNOWN = [
  'id', 's', 't', 'name', 'dynamic', 'orientation', 'zOffset', 'country',
  'type', 'subtype', 'value', 'height', 'width', 'text',
] as const;

function parseSignals(node: XmlNode | undefined): RoadSignal[] {
  if (!node) return [];
  return children(node, 'signal').map((sg) => {
    const sig: RoadSignal = {
      id: attr(sg, 'id') ?? '',
      s: num(sg, 's'),
      t: num(sg, 't'),
    };
    for (const key of ['name', 'country', 'type', 'subtype', 'text'] as const) {
      const v = attr(sg, key);
      if (v !== undefined) sig[key] = v;
    }
    const dyn = attr(sg, 'dynamic');
    if (dyn === 'yes' || dyn === 'no') sig.dynamic = dyn;
    const ori = attr(sg, 'orientation');
    if (ori === '+' || ori === '-' || ori === 'none') sig.orientation = ori;
    for (const key of ['zOffset', 'value', 'height', 'width'] as const) {
      const v = numOpt(sg, key);
      if (v !== undefined) sig[key] = v;
    }
    const extra = collectExtra(sg, SIGNAL_KNOWN);
    if (extra) sig.extraAttrs = extra;
    if (sg.children.length > 0) {
      sig.rawChildren = sg.children.map((c) => serializeRaw(c, '      ')).join('');
    }
    return sig;
  });
}

const ROAD_KNOWN = ['id', 'name', 'length', 'junction', 'rule'] as const;

function parseRoad(node: XmlNode, warnings: string[]): Road {
  const id = attr(node, 'id') ?? '';
  const lanesNode = child(node, 'lanes');
  const laneSections = parseLaneSections(lanesNode);

  if (laneSections.length === 0) {
    warnings.push(`道路 ${id}: 缺少 laneSection，已补入空车道段`);
    laneSections.push({
      s: 0,
      left: [],
      center: { id: 0, type: 'none', link: { predecessorIds: [], successorIds: [] }, widths: [], roadMarks: [] },
      right: [],
    });
  }

  const planView = parsePlanView(child(node, 'planView'), warnings, id);
  if (planView.length === 0) warnings.push(`道路 ${id}: planView 为空`);

  const declaredLength = num(node, 'length');
  const last = planView[planView.length - 1];
  const geomLength = last ? last.s + last.length : 0;
  if (planView.length > 0 && Math.abs(declaredLength - geomLength) > 1e-3) {
    warnings.push(
      `道路 ${id}: length 属性 ${declaredLength.toFixed(4)} 与几何总长 ${geomLength.toFixed(4)} 不一致，采用几何总长`,
    );
  }

  const rule = attr(node, 'rule');
  const elevationProfile = child(node, 'elevationProfile');
  const lateralProfile = child(node, 'lateralProfile');

  const road: Road = {
    id,
    name: attr(node, 'name'),
    length: planView.length > 0 ? geomLength : declaredLength,
    junction: attr(node, 'junction') ?? '-1',
    link: parseRoadLink(child(node, 'link')),
    types: parseRoadTypes(node),
    planView,
    elevations: parsePolyRecords(elevationProfile, 'elevation') as Elevation[],
    superelevations: parsePolyRecords(lateralProfile, 'superelevation'),
    laneOffsets: parsePolyRecords(lanesNode, 'laneOffset'),
    laneSections,
    objects: parseObjects(child(node, 'objects')),
    signals: parseSignals(child(node, 'signals')),
  };

  if (rule === 'LHT' || rule === 'RHT') road.rule = rule;

  const extra = collectExtra(node, ROAD_KNOWN);
  if (extra) road.extraAttrs = extra;

  return road;
}

const JUNCTION_KNOWN = ['id', 'name', 'type'] as const;

function parseJunction(node: XmlNode): Junction {
  const connections: JunctionConnection[] = children(node, 'connection').map((c) => {
    const laneLinks: JunctionLaneLink[] = children(c, 'laneLink').map((l) => ({
      from: num(l, 'from'),
      to: num(l, 'to'),
    }));
    const cp = attr(c, 'contactPoint');
    const conn: JunctionConnection = {
      id: attr(c, 'id') ?? '',
      incomingRoad: attr(c, 'incomingRoad') ?? '',
      connectingRoad: attr(c, 'connectingRoad') ?? '',
      contactPoint: cp === 'end' ? 'end' : 'start',
      laneLinks,
    };
    const type = attr(c, 'type');
    if (type === 'virtual' || type === 'default') conn.type = type;
    const linked = attr(c, 'linkedRoad');
    if (linked) conn.linkedRoad = linked;
    return conn;
  });

  const type = attr(node, 'type');
  const junction: Junction = {
    id: attr(node, 'id') ?? '',
    name: attr(node, 'name'),
    connections,
    priorities: children(node, 'priority').map((p) => ({
      high: attr(p, 'high') ?? '',
      low: attr(p, 'low') ?? '',
    })),
    controllers: children(node, 'controller').map((c) => ({
      id: attr(c, 'id') ?? '',
      type: attr(c, 'type'),
      sequence: numOpt(c, 'sequence'),
    })),
  };
  if (type === 'default' || type === 'direct' || type === 'virtual') junction.type = type;

  const extra = collectExtra(node, JUNCTION_KNOWN);
  if (extra) junction.extraAttrs = extra;

  return junction;
}

function parseController(node: XmlNode): Controller {
  return {
    id: attr(node, 'id') ?? '',
    name: attr(node, 'name'),
    sequence: numOpt(node, 'sequence'),
    controls: children(node, 'control').map((c) => ({
      signalId: attr(c, 'signalId') ?? '',
      type: attr(c, 'type'),
    })),
  };
}

/**
 * 解析 .xodr 文本。
 */
export function parseOpenDrive(src: string): ParseResult {
  const warnings: string[] = [];
  const root = parseXml(src);

  if (root.tag !== 'OpenDRIVE') {
    warnings.push(`根元素为 <${root.tag}>，预期 <OpenDRIVE>`);
  }

  const header = parseHeader(child(root, 'header'));
  const roads = children(root, 'road').map((r) => parseRoad(r, warnings));
  const junctions = children(root, 'junction').map(parseJunction);
  const controllers = children(root, 'controller').map(parseController);

  if (!header.geoReference) {
    warnings.push('文件未声明 geoReference，无法确定坐标系；已按局部平面坐标处理');
  }

  return { document: { header, roads, junctions, controllers }, warnings };
}
