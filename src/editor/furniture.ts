/** 交通设施预设。信号保留交通含义，路面对象保存可见轮廓。 */
import type { OdrDocument } from '../core/model/document.ts';
import type { Road, RoadObject, RoadSignal } from '../core/model/road.ts';
import { referencePoint } from '../core/model/reference.ts';

export const FURNITURE = [
  ['light', '三色交通灯'], ['speed', '限速牌'], ['stop', '停车让行'],
  ['yield', '减速让行'], ['noEntry', '禁止驶入'],
  ['arrowStraight', '地面直行箭头'], ['arrowLeft', '地面左转箭头'],
  ['arrowRight', '地面右转箭头'], ['arrowStraightLeft', '地面直行/左转'],
  ['arrowStraightRight', '地面直行/右转'], ['stopLine', '停止线'],
  ['crosswalk', '斑马线'],
] as const;
export type FurnitureKind = typeof FURNITURE[number][0];
export interface FurnitureItem {
  kind: FurnitureKind;
  source: RoadSignal | RoadObject;
  ground: boolean;
  value?: number;
  x: number; y: number; z: number;
  heading: number; pitch: number; roll: number;
  width: number; height: number; length: number;
}
const CODES: Record<string, FurnitureKind> = {
  '1000001': 'light', '274': 'speed', '206': 'stop', '205': 'yield', '267': 'noEntry',
};
function number(value: string | number | undefined, fallback = 0): number {
  const n = value === undefined ? NaN : Number(value);
  return Number.isFinite(n) ? n : fallback;
}
export function furnitureItems(road: Road): FurnitureItem[] {
  if (!road.planView.length) return [];
  const items: FurnitureItem[] = [];
  for (const source of [...road.signals, ...road.objects]) {
    const signal = road.signals.includes(source as RoadSignal);
    const a = source.extraAttrs ?? {};
    let kind: FurnitureKind | undefined;
    let value: number | undefined;
    if (signal) {
      const sg = source as RoadSignal;
      if (sg.country === 'DE' || sg.country === 'OpenDRIVE') kind = CODES[sg.type ?? ''];
      if (sg.type === 'trafficLight') kind = 'light';
      if (kind === 'speed') value = number(sg.value, number(sg.subtype, 50));
    } else {
      const match = /^Speed_(\d+(?:\.\d+)?)$/i.exec(source.name ?? '');
      if (match) { kind = 'speed'; value = Number(match[1]); }
      else if (source.type === 'crosswalk') kind = 'crosswalk';
      else if (source.type === 'roadMark') {
        kind = a.subtype === 'signalLines' ? 'stopLine'
          : FURNITURE.find(([k]) => k === a.subtype)?.[0];
      }
    }
    if (!kind || ![source.s, source.t, source.zOffset ?? 0].every(Number.isFinite)
      || source.s < 0 || source.s > road.length) continue;
    const ground = kind.startsWith('arrow') || kind === 'stopLine' || kind === 'crosswalk';
    const ref = referencePoint(road, source.s);
    // signal 的 zOffset 相对参考线高程，不能叠加横坡或 laneOffset。
    const orientation = signal ? (source as RoadSignal).orientation : a.orientation;
    const heading = ref.hdg + (signal
      ? (orientation === '+' ? Math.PI : 0) + number(a.hOffset)
      : number((source as RoadObject).hdg));
    items.push({ kind, source, ground, value,
      x: ref.x - Math.sin(ref.hdg) * source.t,
      y: ref.y + Math.cos(ref.hdg) * source.t,
      z: ref.z + (source.zOffset ?? 0), heading,
      pitch: number(a.pitch), roll: number(a.roll),
      width: source.width && source.width > 0 ? source.width : ground ? 3 : 0.7,
      height: source.height && source.height > 0 ? source.height : kind === 'light' ? 1.2 : 0.7,
      length: (source as RoadObject).length || 4,
    });
  }
  return items;
}

/** 归一化轮廓，u 沿箭头前进方向，v 向左。显示和导出使用同一份几何。 */
export function groundPolygons(kind: FurnitureKind): number[][][] {
  if (kind === 'crosswalk') return Array.from({ length: 6 }, (_, i) => {
    const u = -0.5 + i / 6;
    return [[u, -0.5], [u + 0.08, -0.5], [u + 0.08, 0.5], [u, 0.5]];
  });
  if (kind === 'stopLine') return [[[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]];
  const straight = [[-0.5, -0.09], [0.18, -0.09], [0.18, -0.25], [0.5, 0], [0.18, 0.25], [0.18, 0.09], [-0.5, 0.09]];
  const left = [[-0.5, -0.09], [0.09, -0.09], [0.09, 0.24], [0.25, 0.24], [0, 0.5], [-0.25, 0.24], [-0.09, 0.24], [-0.09, 0.09], [-0.5, 0.09]];
  const turn = kind.includes('Right') ? left.map(([u, v]) => [u!, -v!]) : left;
  return kind === 'arrowStraight' ? [straight]
    : kind.startsWith('arrowStraight') ? [straight, turn] : [turn];
}

export function addFurniture(
  doc: OdrDocument, road: Road, kind: FurnitureKind,
  placement?: { s: number; t: number; orientation?: '+' | '-' },
): RoadSignal | RoadObject {
  if (placement && (!Number.isFinite(placement.s) || !Number.isFinite(placement.t)
    || placement.s < 0 || placement.s > road.length)) throw new Error('设施位置超出道路范围');
  const existing = new Set(doc.roads.flatMap(r => [...r.signals, ...r.objects].map(o => o.id)));
  let n = 1;
  while (existing.has(String(n))) n++;
  const s = placement?.s ?? road.length / 2;
  const ref = referencePoint(road, s);
  const ground = kind.startsWith('arrow') || kind === 'stopLine' || kind === 'crosswalk';
  const t = placement?.t ?? (ground ? -1.75 : -5);
  const orientation = placement?.orientation ?? ((t > ref.laneOffset) !== (road.rule === 'LHT') ? '-' : '+');
  if (!ground) {
    const type = Object.entries(CODES).find(([, k]) => k === kind)![0];
    const signal: RoadSignal = { id: String(n), name: FURNITURE.find(([k]) => k === kind)![1],
      s, t, zOffset: kind === 'light' ? 3 : 2, orientation,
      dynamic: kind === 'light' ? 'yes' : 'no', country: kind === 'light' ? 'OpenDRIVE' : 'DE',
      type, subtype: kind === 'speed' ? '50' : '-1',
      ...(kind === 'speed' ? { value: 50 } : {}),
      height: kind === 'light' ? 1.2 : 0.7, width: kind === 'light' ? 0.45 : 0.7,
      extraAttrs: { hOffset: '0', pitch: '0', roll: '0', ...(kind === 'speed' ? { unit: 'km/h' } : {}) },
    };
    road.signals.push(signal);
    return signal;
  }
  doc.header.revMinor = Math.max(doc.header.revMinor, 8);
  const object: RoadObject = { id: String(n), name: FURNITURE.find(([k]) => k === kind)![1],
    type: kind === 'crosswalk' ? 'crosswalk' : 'roadMark',
    s, t, zOffset: -t * Math.sin(ref.superelevation), hdg: orientation === '-' ? Math.PI : 0, height: 0,
    length: kind === 'stopLine' ? 0.4 : 4, width: kind === 'crosswalk' ? 7 : 3,
    extraAttrs: { subtype: kind === 'crosswalk' ? 'zebra' : kind === 'stopLine' ? 'signalLines' : kind,
      orientation: 'none', dynamic: 'no', pitch: String((orientation === '-' ? 1 : -1) * Math.atan(ref.grade)),
      roll: String((orientation === '-' ? 1 : -1) * ref.superelevation) },
  };
  refreshGroundOutline(object, kind);
  road.objects.push(object);
  return object;
}

export function refreshGroundOutline(object: RoadObject, kind: FurnitureKind): void {
  object.rawChildren = '      <outlines>\n' + groundPolygons(kind).map((poly, i) =>
    `        <outline id="${i}" outer="true" closed="true">\n` + poly.map(([u, v], j) =>
      `          <cornerLocal id="${j}" u="${u! * object.length!}" v="${v! * object.width!}" z="0" height="0"/>\n`).join('')
    + '        </outline>\n').join('') + '      </outlines>\n      <material roadMarkColor="white"/>\n      <userData code="opendrive-editor" value="preset"/>\n';
}

/** 删除设施时同步清理信号控制引用。 */
export function removeFurniture(doc: OdrDocument, road: Road, source: RoadSignal | RoadObject): void {
  const isSignal = road.signals.includes(source);
  road.signals = road.signals.filter(s => s !== source);
  road.objects = road.objects.filter(o => o !== source);
  if (!isSignal) return;
  for (const controller of doc.controllers) controller.controls = controller.controls.filter(c => c.signalId !== source.id);
  const empty = new Set(doc.controllers.filter(c => !c.controls.length).map(c => c.id));
  doc.controllers = doc.controllers.filter(c => !empty.has(c.id));
  for (const junction of doc.junctions) junction.controllers = junction.controllers.filter(c => !empty.has(c.id));
}

/** 用于俯视图和 3D 牌面纹理的同一套矢量图标。 */
export function drawFurnitureIcon(ctx: CanvasRenderingContext2D, kind: FurnitureKind, value?: number): void {
  ctx.save();
  ctx.lineWidth = 0.1;
  ctx.fillStyle = 'white'; ctx.strokeStyle = '#d51e2b';
  ctx.font = 'bold 0.48px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if (kind === 'light') {
    ctx.fillStyle = '#181820'; ctx.fillRect(-0.26, -0.5, 0.52, 1);
    ['#f34a4a', '#eac34b', '#46bb78'].forEach((color, i) => {
      ctx.beginPath(); ctx.arc(0, -0.32 + i * 0.32, 0.12, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
    });
  } else if (kind === 'yield' || kind === 'stop') {
    const sides = kind === 'stop' ? 8 : 3;
    ctx.beginPath();
    for (let i = 0; i < sides; i++) {
      const a = Math.PI / 2 + i * 2 * Math.PI / sides;
      const x = Math.cos(a) * 0.48, y = Math.sin(a) * 0.48;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath(); ctx.fillStyle = kind === 'stop' ? '#d51e2b' : 'white'; ctx.fill(); ctx.stroke();
    if (kind === 'stop') { ctx.fillStyle = 'white'; ctx.font = 'bold 0.25px sans-serif'; ctx.fillText('STOP', 0, 0); }
  } else {
    ctx.beginPath(); ctx.arc(0, 0, 0.44, 0, Math.PI * 2);
    if (kind === 'noEntry') ctx.fillStyle = '#d51e2b';
    ctx.fill(); ctx.stroke();
    if (kind === 'noEntry') { ctx.fillStyle = 'white'; ctx.fillRect(-0.3, -0.08, 0.6, 0.16); }
    else { ctx.fillStyle = '#15151a'; ctx.fillText(String(value ?? 50), 0, 0.015); }
  }
  ctx.restore();
}
