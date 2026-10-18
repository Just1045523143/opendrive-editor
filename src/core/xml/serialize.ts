/**
 * 模型 → .xodr 文本。
 *
 * 数值格式化策略：JS 的默认 Number→String 已给出最短可逆表示，但对极小值会
 * 输出指数形式（如 1e-7）。虽然 xsd:double 允许指数记法，仍有解析器不接受，
 * 故统一转为定点表示；小于 1e-12 的量直接归零，避免写出 5.551115123125783e-17
 * 这类浮点噪声。
 */

import type { Geometry } from '../geometry/types.ts';
import type { PolyRecord } from '../math/poly.ts';
import type { OdrDocument } from '../model/document.ts';
import type { Junction } from '../model/junction.ts';
import type { Lane, LaneSection } from '../model/lane.ts';
import type { Road, RoadLinkEnd } from '../model/road.ts';
import { computeBounds } from '../model/bounds.ts';
import { encodeEntities } from './dom.ts';

/** 小于该量级的数值视为 0（滤除浮点噪声） */
const ZERO_EPS = 1e-12;

/**
 * 数值格式化。
 *
 * JS 的 Number→String 已给出**最短且可精确回读**的表示，故优先直接采用；
 * 仅当它落入指数记法（|v| ≥ 1e21 或 < 1e-6）时才转成定点，并逐级提升小数位
 * 直到能精确回读。这样既避免精度损失，也不会写出 1e-7 这类部分解析器不接受
 * 的形式。
 */
export function fmt(v: number): string {
  if (!Number.isFinite(v)) return '0';
  if (Math.abs(v) < ZERO_EPS) return '0';

  const direct = String(v);
  if (!direct.includes('e') && !direct.includes('E')) return direct;

  // 落入指数记法：转定点。曲率等小量在此分支，需较多小数位才能无损。
  for (let p = 7; p <= 100; p++) {
    const s = v.toFixed(p);
    if (Number(s) === v) return trimZeros(s);
  }
  return trimZeros(v.toFixed(100));
}

function trimZeros(s: string): string {
  if (!s.includes('.')) return s;
  let out = s.replace(/0+$/, '');
  if (out.endsWith('.')) out = out.slice(0, -1);
  return out === '-0' ? '0' : out;
}

/** 拼装属性串，跳过 undefined */
function attrs(pairs: Array<[string, string | number | undefined]>): string {
  let out = '';
  for (const [k, v] of pairs) {
    if (v === undefined) continue;
    const s = typeof v === 'number' ? fmt(v) : encodeEntities(v);
    out += ` ${k}="${s}"`;
  }
  return out;
}

function extraAttrs(extra: Record<string, string> | undefined): string {
  if (!extra) return '';
  return Object.entries(extra)
    .map(([k, v]) => ` ${k}="${encodeEntities(v)}"`)
    .join('');
}

function polyAttrs(p: PolyRecord): string {
  return attrs([
    ['s', p.s],
    ['a', p.a],
    ['b', p.b],
    ['c', p.c],
    ['d', p.d],
  ]);
}

function writeGeometry(g: Geometry, ind: string): string {
  const head = attrs([
    ['s', g.s],
    ['x', g.x],
    ['y', g.y],
    ['hdg', g.hdg],
    ['length', g.length],
  ]);
  let inner: string;
  switch (g.type) {
    case 'line':
      inner = `${ind}  <line/>\n`;
      break;
    case 'arc':
      inner = `${ind}  <arc${attrs([['curvature', g.curvature]])}/>\n`;
      break;
    case 'spiral':
      inner = `${ind}  <spiral${attrs([
        ['curvStart', g.curvStart],
        ['curvEnd', g.curvEnd],
      ])}/>\n`;
      break;
    case 'poly3':
      inner = `${ind}  <poly3${attrs([
        ['a', g.a],
        ['b', g.b],
        ['c', g.c],
        ['d', g.d],
      ])}/>\n`;
      break;
    case 'paramPoly3':
      inner = `${ind}  <paramPoly3${attrs([
        ['aU', g.aU],
        ['bU', g.bU],
        ['cU', g.cU],
        ['dU', g.dU],
        ['aV', g.aV],
        ['bV', g.bV],
        ['cV', g.cV],
        ['dV', g.dV],
        ['pRange', g.pRange],
      ])}/>\n`;
      break;
  }
  return `${ind}<geometry${head}>\n${inner}${ind}</geometry>\n`;
}

function writeLinkEnd(tag: string, end: RoadLinkEnd | undefined, ind: string): string {
  if (!end) return '';
  return `${ind}<${tag}${attrs([
    ['elementType', end.elementType],
    ['elementId', end.elementId],
    ['contactPoint', end.contactPoint],
    ['elementS', end.elementS],
    ['elementDir', end.elementDir],
  ])}/>\n`;
}

function writeLane(lane: Lane, ind: string): string {
  let out = `${ind}<lane${attrs([
    ['id', lane.id],
    ['type', lane.type],
    ['level', lane.level === undefined ? undefined : lane.level ? 'true' : 'false'],
  ])}${extraAttrs(lane.extraAttrs)}>\n`;

  const { predecessorIds, successorIds } = lane.link;
  if (predecessorIds.length > 0 || successorIds.length > 0) {
    out += `${ind}  <link>\n`;
    for (const id of predecessorIds) out += `${ind}    <predecessor id="${id}"/>\n`;
    for (const id of successorIds) out += `${ind}    <successor id="${id}"/>\n`;
    out += `${ind}  </link>\n`;
  }

  if (lane.borders && lane.borders.length > 0) {
    for (const b of lane.borders) {
      out += `${ind}  <border${attrs([
        ['sOffset', b.sOffset],
        ['a', b.a],
        ['b', b.b],
        ['c', b.c],
        ['d', b.d],
      ])}/>\n`;
    }
  } else if (lane.id !== 0) {
    for (const w of lane.widths) {
      out += `${ind}  <width${attrs([
        ['sOffset', w.sOffset],
        ['a', w.a],
        ['b', w.b],
        ['c', w.c],
        ['d', w.d],
      ])}/>\n`;
    }
  }

  for (const m of lane.roadMarks) {
    // The editor treats OpenDRIVE's "standard" road-mark color as white.
    // Emit that color explicitly because Apollo's imap converter otherwise
    // maps the boundary to UNKNOWN and routing cannot create lane-change edges.
    const color = m.color === 'standard' ? 'white' : m.color;
    out += `${ind}  <roadMark${attrs([
      ['sOffset', m.sOffset],
      ['type', m.type],
      ['weight', m.weight],
      ['color', color],
      ['material', m.material],
      ['width', m.width],
      ['laneChange', m.laneChange],
      ['height', m.height],
    ])}/>\n`;
  }

  if (lane.speeds) {
    for (const sp of lane.speeds) {
      out += `${ind}  <speed${attrs([
        ['sOffset', sp.sOffset],
        ['max', sp.max],
        ['unit', sp.unit],
      ])}/>\n`;
    }
  }

  if (lane.material) {
    out += `${ind}  <material${attrs([['surface', lane.material]])}/>\n`;
  }

  out += `${ind}</lane>\n`;
  return out;
}

function writeLaneSection(sec: LaneSection, ind: string): string {
  let out = `${ind}<laneSection${attrs([
    ['s', sec.s],
    ['singleSide', sec.singleSide ? 'true' : undefined],
  ])}>\n`;

  if (sec.left.length > 0) {
    out += `${ind}  <left>\n`;
    // 写出顺序按 id 降序（由外向内），符合常见工具惯例
    for (const lane of [...sec.left].sort((a, b) => b.id - a.id)) {
      out += writeLane(lane, ind + '    ');
    }
    out += `${ind}  </left>\n`;
  }

  out += `${ind}  <center>\n${writeLane(sec.center, ind + '    ')}${ind}  </center>\n`;

  if (sec.right.length > 0) {
    out += `${ind}  <right>\n`;
    for (const lane of [...sec.right].sort((a, b) => b.id - a.id)) {
      out += writeLane(lane, ind + '    ');
    }
    out += `${ind}  </right>\n`;
  }

  out += `${ind}</laneSection>\n`;
  return out;
}

function writeRoad(road: Road, ind: string): string {
  let out = `${ind}<road${attrs([
    ['name', road.name ?? ''],
    ['length', road.length],
    ['id', road.id],
    ['junction', road.junction],
    ['rule', road.rule],
  ])}${extraAttrs(road.extraAttrs)}>\n`;

  const inner = ind + '  ';

  if (road.link.predecessor || road.link.successor) {
    out += `${inner}<link>\n`;
    out += writeLinkEnd('predecessor', road.link.predecessor, inner + '  ');
    out += writeLinkEnd('successor', road.link.successor, inner + '  ');
    out += `${inner}</link>\n`;
  }

  // <type> 必须在 planView 之前
  for (const t of road.types) {
    const hasSpeed = t.speedMax !== undefined;
    out += `${inner}<type${attrs([
      ['s', t.s],
      ['type', t.type],
    ])}${hasSpeed ? '' : '/'}>\n`;
    if (hasSpeed) {
      out += `${inner}  <speed${attrs([
        ['max', t.speedMax],
        ['unit', t.speedUnit ?? 'm/s'],
      ])}/>\n${inner}</type>\n`;
    }
  }

  out += `${inner}<planView>\n`;
  for (const g of road.planView) out += writeGeometry(g, inner + '  ');
  out += `${inner}</planView>\n`;

  if (road.elevations.length > 0) {
    out += `${inner}<elevationProfile>\n`;
    for (const e of road.elevations) out += `${inner}  <elevation${polyAttrs(e)}/>\n`;
    out += `${inner}</elevationProfile>\n`;
  }

  if (road.superelevations.length > 0 || (road.shapes && road.shapes.length > 0)) {
    out += `${inner}<lateralProfile>\n`;
    for (const s of road.superelevations) {
      out += `${inner}  <superelevation${polyAttrs(s)}/>\n`;
    }
    if (road.shapes) {
      for (const sh of road.shapes) {
        out += `${inner}  <shape${attrs([
          ['s', sh.s],
          ['t', sh.t],
          ['a', sh.a],
          ['b', sh.b],
          ['c', sh.c],
          ['d', sh.d],
        ])}/>\n`;
      }
    }
    out += `${inner}</lateralProfile>\n`;
  }

  out += `${inner}<lanes>\n`;
  for (const lo of road.laneOffsets) out += `${inner}  <laneOffset${polyAttrs(lo)}/>\n`;
  for (const sec of road.laneSections) out += writeLaneSection(sec, inner + '  ');
  out += `${inner}</lanes>\n`;

  if (road.objects.length > 0) {
    out += `${inner}<objects>\n`;
    for (const o of road.objects) {
      const head = `${inner}  <object${attrs([
        ['id', o.id],
        ['type', o.type],
        ['name', o.name],
        ['s', o.s],
        ['t', o.t],
        ['zOffset', o.zOffset],
        ['hdg', o.hdg],
        ['length', o.length],
        ['width', o.width],
        ['radius', o.radius],
        ['height', o.height],
      ])}${extraAttrs(o.extraAttrs)}`;
      out += o.rawChildren
        ? `${head}>\n${o.rawChildren}${inner}  </object>\n`
        : `${head}/>\n`;
    }
    out += `${inner}</objects>\n`;
  }

  if (road.signals.length > 0) {
    out += `${inner}<signals>\n`;
    for (const sg of road.signals) {
      const head = `${inner}  <signal${attrs([
        ['id', sg.id],
        ['s', sg.s],
        ['t', sg.t],
        ['name', sg.name],
        ['dynamic', sg.dynamic],
        ['orientation', sg.orientation],
        ['zOffset', sg.zOffset],
        ['country', sg.country],
        ['type', sg.type],
        ['subtype', sg.subtype],
        ['value', sg.value],
        ['height', sg.height],
        ['width', sg.width],
        ['text', sg.text],
      ])}${extraAttrs(sg.extraAttrs)}`;
      out += sg.rawChildren
        ? `${head}>\n${sg.rawChildren}${inner}  </signal>\n`
        : `${head}/>\n`;
    }
    out += `${inner}</signals>\n`;
  }

  out += `${ind}</road>\n`;
  return out;
}

function writeJunction(j: Junction, ind: string): string {
  let out = `${ind}<junction${attrs([
    ['id', j.id],
    ['name', j.name],
    ['type', j.type === 'default' ? undefined : j.type],
  ])}${extraAttrs(j.extraAttrs)}>\n`;

  for (const c of j.connections) {
    out += `${ind}  <connection${attrs([
      ['id', c.id],
      ['type', c.type === 'default' ? undefined : c.type],
      ['incomingRoad', c.incomingRoad],
      ['connectingRoad', c.connectingRoad],
      ['contactPoint', c.contactPoint],
      ['linkedRoad', c.linkedRoad],
    ])}>\n`;
    for (const l of c.laneLinks) {
      out += `${ind}    <laneLink from="${l.from}" to="${l.to}"/>\n`;
    }
    out += `${ind}  </connection>\n`;
  }

  for (const p of j.priorities) {
    out += `${ind}  <priority${attrs([
      ['high', p.high],
      ['low', p.low],
    ])}/>\n`;
  }

  for (const c of j.controllers) {
    out += `${ind}  <controller${attrs([
      ['id', c.id],
      ['type', c.type],
      ['sequence', c.sequence],
    ])}/>\n`;
  }

  out += `${ind}</junction>\n`;
  return out;
}

/**
 * 把文档序列化为 .xodr 文本。
 * bounds 会依据当前几何重新计算并写入 header。
 */
export function serializeOpenDrive(doc: OdrDocument): string {
  const bounds = computeBounds(doc);
  const h = doc.header;

  let out = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<OpenDRIVE>\n';

  out += `  <header${attrs([
    ['revMajor', h.revMajor],
    ['revMinor', h.revMinor],
    ['name', h.name ?? ''],
    ['version', h.version ?? '1.00'],
    ['date', h.date ?? new Date().toISOString()],
    ['north', bounds ? bounds.north : h.north],
    ['south', bounds ? bounds.south : h.south],
    ['east', bounds ? bounds.east : h.east],
    ['west', bounds ? bounds.west : h.west],
    ['vendor', h.vendor ?? 'opendrive-editor'],
  ])}>\n`;

  if (h.geoReference) {
    out += `    <geoReference><![CDATA[${h.geoReference}]]></geoReference>\n`;
  }
  if (h.offset) {
    out += `    <offset${attrs([
      ['x', h.offset.x],
      ['y', h.offset.y],
      ['z', h.offset.z],
      ['hdg', h.offset.hdg],
    ])}/>\n`;
  }
  out += '  </header>\n';

  for (const road of doc.roads) out += writeRoad(road, '  ');
  for (const c of doc.controllers) {
    out += `  <controller${attrs([
      ['id', c.id],
      ['name', c.name],
      ['sequence', c.sequence],
    ])}>\n`;
    for (const ctl of c.controls) {
      out += `    <control${attrs([
        ['signalId', ctl.signalId],
        ['type', ctl.type],
      ])}/>\n`;
    }
    out += '  </controller>\n';
  }
  for (const j of doc.junctions) out += writeJunction(j, '  ');

  out += '</OpenDRIVE>\n';
  return out;
}
