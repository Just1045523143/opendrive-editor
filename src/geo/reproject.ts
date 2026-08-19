/**
 * 坐标系切换时的路网重投影。
 *
 * 两类处理：
 *   1. 有控制点记录的道路——把控制点经 WGS84 中转到新坐标系后重新拟合。
 *      结果精确，几何类型与线形参数完全保留。
 *   2. 导入的道路（无控制点）——对每个图元的起点做投影变换，航向按两投影
 *      之间的局部旋转量修正，长度与曲率按局部尺度比缩放。
 *
 *      这是近似：等角投影之间的差异在图元跨度内不是严格的刚体变换。但常用
 *      投影（局部 TM / UTM / 高斯克吕格）在同一作业区内尺度比与旋转量的变化
 *      都极小，单个图元（通常 < 300 m）内的残差在毫米级。若要求严格无误差，
 *      应先用「提取控制点」再重拟合。
 */

import { evaluateGeometry } from '../core/geometry/evaluate.ts';
import type { Geometry } from '../core/geometry/types.ts';
import { normalizeAngle, type Vec2 } from '../core/math/vec.ts';
import type { OdrDocument } from '../core/model/document.ts';
import { refitRoad } from '../editor/roadFactory.ts';
import type { AlignmentRecord } from '../editor/store.ts';
import { Projector, type CoordinateSystem } from './projection.ts';

/** 局部线性化：返回 from→to 在指定点附近的旋转角与尺度比 */
function localTransform(
  from: Projector,
  to: Projector,
  at: Vec2,
): { rotation: number; scale: number } {
  const probe = 10; // 10 m 探测基线，足够小以线性化、足够大以避免舍入噪声
  const ll0 = from.unproject(at);
  const ll1 = from.unproject({ x: at.x + probe, y: at.y });

  const a = to.project(ll0);
  const b = to.project(ll1);

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);

  return {
    rotation: Math.atan2(dy, dx), // 原方向为 +x（角度 0），故差值即旋转量
    scale: len / probe,
  };
}

export interface ReprojectResult {
  refittedRoads: number;
  transformedRoads: number;
  /** 变换过程中观察到的最大尺度偏差（相对 1） */
  maxScaleDeviation: number;
}

/**
 * 把文档从 fromCrs 重投影到 toCrs（原地修改）。
 */
export function reprojectDocument(
  doc: OdrDocument,
  alignments: Map<string, AlignmentRecord>,
  fromCrs: CoordinateSystem,
  toCrs: CoordinateSystem,
): ReprojectResult {
  const from = new Projector(fromCrs);
  const to = new Projector(toCrs);

  let refitted = 0;
  let transformed = 0;
  let maxScaleDev = 0;

  for (const road of doc.roads) {
    const rec = alignments.get(road.id);

    if (rec && rec.points.length >= 2) {
      // 控制点路线：经纬度中转后重新拟合，无累积误差
      rec.points = rec.points.map((p) => {
        const ll = from.unproject(p);
        const q = to.project(ll);
        return { x: q.x, y: q.y };
      });
      if (refitRoad(road, rec.points, rec.fit)) {
        refitted++;
        continue;
      }
      // 拟合失败则退回逐图元变换
    }

    for (const g of road.planView) {
      const { rotation, scale } = localTransform(from, to, { x: g.x, y: g.y });
      maxScaleDev = Math.max(maxScaleDev, Math.abs(scale - 1));

      const ll = from.unproject({ x: g.x, y: g.y });
      const q = to.project(ll);
      g.x = q.x;
      g.y = q.y;
      g.hdg = normalizeAngle(g.hdg + rotation);
      g.length *= scale;
      scaleCurvature(g, scale);
    }

    const oldLength = road.length;

    // s 需按新长度重新累积，否则 s 与 length 不自洽
    let s = 0;
    for (const g of road.planView) {
      g.s = s;
      s += g.length;
    }
    road.length = s;

    // 车道段与各分段记录的 s 随总长同比缩放，保持相对位置不变
    if (oldLength > 1e-9) {
      const k = s / oldLength;
      if (Math.abs(k - 1) > 1e-12) {
        for (const sec of road.laneSections) sec.s *= k;
        for (const list of [road.elevations, road.superelevations, road.laneOffsets]) {
          for (const rec of list) rec.s *= k;
        }
        for (const o of road.objects) o.s *= k;
        for (const sg of road.signals) sg.s *= k;
      }
    }

    transformed++;
  }

  // 物体/信号的横向位置不随投影改变（t 为道路坐标），仅 s 已随长度缩放
  return { refittedRoads: refitted, transformedRoads: transformed, maxScaleDeviation: maxScaleDev };
}

/** 曲率量纲为 1/长度，尺度放大 k 时曲率除以 k */
function scaleCurvature(g: Geometry, scale: number): void {
  if (scale === 1) return;
  if (g.type === 'arc') {
    g.curvature /= scale;
  } else if (g.type === 'spiral') {
    g.curvStart /= scale;
    g.curvEnd /= scale;
  } else if (g.type === 'poly3') {
    // v = a + bu + cu² + du³；u,v 同比放大 k 时 a→ka, b→b, c→c/k, d→d/k²
    g.a *= scale;
    g.c /= scale;
    g.d /= scale * scale;
  } else if (g.type === 'paramPoly3') {
    for (const key of ['aU', 'bU', 'cU', 'dU', 'aV', 'bV', 'cV', 'dV'] as const) {
      g[key] *= scale;
    }
  }
}

/**
 * 校验重投影质量：比较变换前后各道路端点在 WGS84 下的位置差。
 * 返回最大偏差（米），用于向用户报告。
 */
export function measureReprojectionError(
  before: ReadonlyArray<{ id: string; start: Vec2; end: Vec2 }>,
  doc: OdrDocument,
  fromCrs: CoordinateSystem,
  toCrs: CoordinateSystem,
): number {
  const from = new Projector(fromCrs);
  const to = new Projector(toCrs);
  let worst = 0;

  for (const snap of before) {
    const road = doc.roads.find((r) => r.id === snap.id);
    if (!road || road.planView.length === 0) continue;

    const first = road.planView[0]!;
    const last = road.planView[road.planView.length - 1]!;
    const nowStart = evaluateGeometry(first, 0);
    const nowEnd = evaluateGeometry(last, last.length);

    // 把旧坐标与新坐标都归到 WGS84 再比较，单位换算为米（用新投影度量）
    for (const [old, now] of [
      [snap.start, { x: nowStart.x, y: nowStart.y }],
      [snap.end, { x: nowEnd.x, y: nowEnd.y }],
    ] as const) {
      const oldInNew = to.project(from.unproject(old));
      worst = Math.max(worst, Math.hypot(oldInNew.x - now.x, oldInNew.y - now.y));
    }
  }

  return worst;
}

/** 采集重投影前的端点快照，供事后核验 */
export function snapshotEndpoints(doc: OdrDocument): Array<{ id: string; start: Vec2; end: Vec2 }> {
  const out: Array<{ id: string; start: Vec2; end: Vec2 }> = [];
  for (const road of doc.roads) {
    if (road.planView.length === 0) continue;
    const first = road.planView[0]!;
    const last = road.planView[road.planView.length - 1]!;
    const s = evaluateGeometry(first, 0);
    const e = evaluateGeometry(last, last.length);
    out.push({ id: road.id, start: { x: s.x, y: s.y }, end: { x: e.x, y: e.y } });
  }
  return out;
}
