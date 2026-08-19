/**
 * 文档校验。
 *
 * 覆盖 ASAM OpenDRIVE 中最容易在编辑过程中被破坏、且下游消费方（仿真器、
 * 路径规划）确实依赖的约束：
 *   - planView 图元链的位置/航向连续性
 *   - road.length 与几何总长一致
 *   - laneSection 首段 s=0、按 s 升序、不越界
 *   - 同侧车道 id 由内向外连续（1,2,3… / −1,−2,−3…）
 *   - 车道宽度非负
 *   - link 指向的元素存在，且 elementType='road' 时必有 contactPoint
 *   - 相连道路在接续点处几何吻合
 *   - junction 内 connection 与 laneLink 引用有效
 */

import { evaluateGeometry } from '../geometry/evaluate.ts';
import { evalPoly3 } from '../math/poly.ts';
import { normalizeAngle } from '../math/vec.ts';
import type { OdrDocument } from './document.ts';
import { findLane } from './lane.ts';
import { laneSectionRange, type Road } from './road.ts';

export type IssueLevel = 'error' | 'warning';

export interface Issue {
  level: IssueLevel;
  /** 稳定的问题代码，便于界面分类与测试断言 */
  code: string;
  message: string;
  roadId?: string;
  geometryIndex?: number;
  sectionIndex?: number;
  laneId?: number;
  junctionId?: string;
}

/** 位置连续性容差（米）。1 mm 足以区分真实断裂与浮点噪声 */
const POS_TOL = 1e-3;
/** 航向连续性容差（弧度）≈ 0.006° */
const HDG_TOL = 1e-4;
/** 接续点几何吻合容差（米）。相连道路端点允许的间隙 */
const JOIN_TOL = 0.05;

export function validateDocument(doc: OdrDocument): Issue[] {
  const issues: Issue[] = [];
  const roadIds = new Set(doc.roads.map((r) => r.id));
  const junctionIds = new Set(doc.junctions.map((j) => j.id));

  const seen = new Set<string>();
  for (const road of doc.roads) {
    if (seen.has(road.id)) {
      issues.push({ level: 'error', code: 'duplicate-road-id', message: `道路 id "${road.id}" 重复`, roadId: road.id });
    }
    seen.add(road.id);
    validateRoad(road, issues);
    validateLinks(road, roadIds, junctionIds, issues);
  }

  validateJoins(doc, issues);
  validateJunctions(doc, roadIds, issues);
  return issues;
}

function validateRoad(road: Road, issues: Issue[]): void {
  const pv = road.planView;

  if (pv.length === 0) {
    issues.push({ level: 'error', code: 'empty-planview', message: `道路 ${road.id} 没有参考线几何`, roadId: road.id });
  }

  // 图元链连续性
  for (let i = 0; i < pv.length; i++) {
    const g = pv[i]!;

    if (g.length <= 0) {
      issues.push({
        level: 'error',
        code: 'nonpositive-geometry-length',
        message: `道路 ${road.id} 第 ${i} 个图元长度为 ${g.length}`,
        roadId: road.id,
        geometryIndex: i,
      });
    }

    if (i === 0 && Math.abs(g.s) > 1e-6) {
      issues.push({
        level: 'error',
        code: 'planview-not-start-at-zero',
        message: `道路 ${road.id} 首个图元 s=${g.s}，应为 0`,
        roadId: road.id,
        geometryIndex: 0,
      });
    }

    if (i + 1 < pv.length) {
      const next = pv[i + 1]!;

      if (Math.abs(g.s + g.length - next.s) > POS_TOL) {
        issues.push({
          level: 'error',
          code: 'planview-s-gap',
          message: `道路 ${road.id} 图元 ${i}→${i + 1} 的 s 不连续：${(g.s + g.length).toFixed(6)} vs ${next.s.toFixed(6)}`,
          roadId: road.id,
          geometryIndex: i,
        });
      }

      const end = evaluateGeometry(g, g.length);
      const gap = Math.hypot(end.x - next.x, end.y - next.y);
      if (gap > POS_TOL) {
        issues.push({
          level: 'error',
          code: 'planview-position-gap',
          message: `道路 ${road.id} 图元 ${i}→${i + 1} 位置断裂 ${gap.toFixed(4)} m`,
          roadId: road.id,
          geometryIndex: i,
        });
      }

      const dh = Math.abs(normalizeAngle(end.hdg - next.hdg));
      if (dh > HDG_TOL) {
        issues.push({
          level: 'warning',
          code: 'planview-heading-jump',
          message: `道路 ${road.id} 图元 ${i}→${i + 1} 航向突变 ${((dh * 180) / Math.PI).toFixed(4)}°`,
          roadId: road.id,
          geometryIndex: i,
        });
      }
    }
  }

  const geomLength = pv.length > 0 ? pv[pv.length - 1]!.s + pv[pv.length - 1]!.length : 0;
  if (pv.length > 0 && Math.abs(road.length - geomLength) > POS_TOL) {
    issues.push({
      level: 'error',
      code: 'road-length-mismatch',
      message: `道路 ${road.id} length=${road.length.toFixed(6)} 与几何总长 ${geomLength.toFixed(6)} 不符`,
      roadId: road.id,
    });
  }

  validateLaneSections(road, issues);
}

function validateLaneSections(road: Road, issues: Issue[]): void {
  const sections = road.laneSections;

  if (sections.length === 0) {
    issues.push({ level: 'error', code: 'no-lane-section', message: `道路 ${road.id} 没有车道段`, roadId: road.id });
    return;
  }

  if (Math.abs(sections[0]!.s) > 1e-6) {
    issues.push({
      level: 'error',
      code: 'lane-section-not-start-at-zero',
      message: `道路 ${road.id} 首个车道段 s=${sections[0]!.s}，应为 0`,
      roadId: road.id,
      sectionIndex: 0,
    });
  }

  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i]!;

    if (i > 0 && sec.s <= sections[i - 1]!.s) {
      issues.push({
        level: 'error',
        code: 'lane-section-order',
        message: `道路 ${road.id} 车道段 ${i} 的 s=${sec.s} 未大于前一段`,
        roadId: road.id,
        sectionIndex: i,
      });
    }

    if (sec.s > road.length + 1e-6) {
      issues.push({
        level: 'error',
        code: 'lane-section-out-of-range',
        message: `道路 ${road.id} 车道段 ${i} 的 s=${sec.s} 超出道路长度 ${road.length}`,
        roadId: road.id,
        sectionIndex: i,
      });
    }

    // 同侧 id 连续性
    checkLaneIdSequence(road, i, sec.left.map((l) => l.id), 1, issues);
    checkLaneIdSequence(road, i, sec.right.map((l) => l.id), -1, issues);

    if (sec.center.id !== 0) {
      issues.push({
        level: 'error',
        code: 'center-lane-id',
        message: `道路 ${road.id} 车道段 ${i} 的中心车道 id=${sec.center.id}，应为 0`,
        roadId: road.id,
        sectionIndex: i,
      });
    }

    // 宽度非负
    const { start, end } = laneSectionRange(road, i);
    const span = end - start;
    for (const lane of [...sec.left, ...sec.right]) {
      if (lane.borders && lane.borders.length > 0) continue;
      if (lane.widths.length === 0) {
        issues.push({
          level: 'error',
          code: 'lane-missing-width',
          message: `道路 ${road.id} 车道段 ${i} 车道 ${lane.id} 缺少 width 记录`,
          roadId: road.id,
          sectionIndex: i,
          laneId: lane.id,
        });
        continue;
      }
      for (const w of lane.widths) {
        // 在该宽度记录的作用区间内采样，检查是否出现负宽
        const wEnd = span - w.sOffset;
        if (wEnd <= 0) continue;
        for (let k = 0; k <= 8; k++) {
          const v = evalPoly3(w, (wEnd * k) / 8);
          if (v < -1e-6) {
            issues.push({
              level: 'error',
              code: 'negative-lane-width',
              message: `道路 ${road.id} 车道段 ${i} 车道 ${lane.id} 在 sOffset≈${(w.sOffset + (wEnd * k) / 8).toFixed(2)} 处宽度为负 (${v.toFixed(4)})`,
              roadId: road.id,
              sectionIndex: i,
              laneId: lane.id,
            });
            break;
          }
        }
      }
    }
  }
}

function checkLaneIdSequence(
  road: Road,
  sectionIndex: number,
  ids: readonly number[],
  sign: 1 | -1,
  issues: Issue[],
): void {
  for (let k = 0; k < ids.length; k++) {
    const expected = sign * (k + 1);
    if (ids[k] !== expected) {
      issues.push({
        level: 'error',
        code: 'lane-id-not-sequential',
        message: `道路 ${road.id} 车道段 ${sectionIndex} ${sign > 0 ? '左' : '右'}侧车道 id 应由内向外连续（期望 ${expected}，实际 ${ids[k]}）`,
        roadId: road.id,
        sectionIndex,
        laneId: ids[k],
      });
      return;
    }
  }
}

function validateLinks(
  road: Road,
  roadIds: ReadonlySet<string>,
  junctionIds: ReadonlySet<string>,
  issues: Issue[],
): void {
  for (const which of ['predecessor', 'successor'] as const) {
    const link = road.link[which];
    if (!link) continue;

    const pool = link.elementType === 'junction' ? junctionIds : roadIds;
    if (!pool.has(link.elementId)) {
      issues.push({
        level: 'error',
        code: 'dangling-link',
        message: `道路 ${road.id} 的 ${which} 指向不存在的${link.elementType === 'junction' ? '交叉口' : '道路'} "${link.elementId}"`,
        roadId: road.id,
      });
      continue;
    }

    if (link.elementType === 'road' && !link.contactPoint) {
      issues.push({
        level: 'error',
        code: 'link-missing-contact-point',
        message: `道路 ${road.id} 的 ${which} 指向道路但缺少 contactPoint`,
        roadId: road.id,
      });
    }
  }

  if (road.junction !== '-1' && !junctionIds.has(road.junction)) {
    issues.push({
      level: 'error',
      code: 'dangling-junction-ref',
      message: `道路 ${road.id} 的 junction="${road.junction}" 不存在`,
      roadId: road.id,
    });
  }
}

/** 检查相连道路在接续点处的几何吻合度 */
function validateJoins(doc: OdrDocument, issues: Issue[]): void {
  const byId = new Map(doc.roads.map((r) => [r.id, r] as const));

  for (const road of doc.roads) {
    const pv = road.planView;
    if (pv.length === 0) continue;

    for (const which of ['predecessor', 'successor'] as const) {
      const link = road.link[which];
      if (!link || link.elementType !== 'road' || !link.contactPoint) continue;
      const other = byId.get(link.elementId);
      if (!other || other.planView.length === 0) continue;

      // 本端点
      const mine =
        which === 'predecessor'
          ? evaluateGeometry(pv[0]!, 0)
          : evaluateGeometry(pv[pv.length - 1]!, pv[pv.length - 1]!.length);

      // 对方端点
      const otherPv = other.planView;
      const theirs =
        link.contactPoint === 'start'
          ? evaluateGeometry(otherPv[0]!, 0)
          : evaluateGeometry(otherPv[otherPv.length - 1]!, otherPv[otherPv.length - 1]!.length);

      const gap = Math.hypot(mine.x - theirs.x, mine.y - theirs.y);
      if (gap > JOIN_TOL) {
        issues.push({
          level: 'warning',
          code: 'join-gap',
          message: `道路 ${road.id} 与 ${other.id} 在接续点存在 ${gap.toFixed(3)} m 间隙`,
          roadId: road.id,
        });
      }
    }
  }
}

function validateJunctions(doc: OdrDocument, roadIds: ReadonlySet<string>, issues: Issue[]): void {
  const byId = new Map(doc.roads.map((r) => [r.id, r] as const));

  for (const j of doc.junctions) {
    if (j.connections.length === 0) {
      issues.push({
        level: 'warning',
        code: 'empty-junction',
        message: `交叉口 ${j.id} 没有任何连接`,
        junctionId: j.id,
      });
    }

    for (const c of j.connections) {
      for (const [field, id] of [
        ['incomingRoad', c.incomingRoad],
        ['connectingRoad', c.connectingRoad],
      ] as const) {
        if (!roadIds.has(id)) {
          issues.push({
            level: 'error',
            code: 'junction-dangling-road',
            message: `交叉口 ${j.id} 连接 ${c.id} 的 ${field}="${id}" 不存在`,
            junctionId: j.id,
          });
        }
      }

      const incoming = byId.get(c.incomingRoad);
      const connecting = byId.get(c.connectingRoad);
      if (!incoming || !connecting) continue;

      // 连接道路必须声明归属于本 junction
      if (connecting.junction !== j.id) {
        issues.push({
          level: 'error',
          code: 'connecting-road-junction-mismatch',
          message: `连接道路 ${connecting.id} 的 junction="${connecting.junction}"，应为 "${j.id}"`,
          junctionId: j.id,
          roadId: connecting.id,
        });
      }

      // 入口道路不应标记为某个 junction 的连接道路
      if (incoming.junction === j.id) {
        issues.push({
          level: 'warning',
          code: 'incoming-road-marked-as-connecting',
          message: `入口道路 ${incoming.id} 的 junction 属性指向 ${j.id}，入口道路应保持 -1`,
          junctionId: j.id,
          roadId: incoming.id,
        });
      }

      /*
       * laneLink 的两侧含义不同：
       *   from —— 入口道路的车道；取哪个车道段由「入口道路的哪一端接入本路口」
       *           决定，即该路 link 中指向本 junction 的那一端
       *   to   —— 连接道路自身的车道；由 contactPoint 指明其哪一端与入口相接
       */
      const incomingEnd =
        incoming.link.predecessor?.elementId === j.id
          ? 'start'
          : incoming.link.successor?.elementId === j.id
            ? 'end'
            : null;

      if (incomingEnd === null) {
        issues.push({
          level: 'error',
          code: 'incoming-road-not-linked',
          message: `入口道路 ${incoming.id} 未通过 link 指向交叉口 ${j.id}`,
          junctionId: j.id,
          roadId: incoming.id,
        });
      }

      const incomingSection =
        incomingEnd === 'start'
          ? incoming.laneSections[0]
          : incoming.laneSections[incoming.laneSections.length - 1];
      const connectingSection =
        c.contactPoint === 'start'
          ? connecting.laneSections[0]
          : connecting.laneSections[connecting.laneSections.length - 1];

      const seen = new Set<string>();
      for (const l of c.laneLinks) {
        if (incomingSection && !findLane(incomingSection, l.from)) {
          issues.push({
            level: 'error',
            code: 'junction-dangling-lane',
            message: `交叉口 ${j.id} 连接 ${c.id}: 入口道路 ${c.incomingRoad} 无车道 ${l.from}`,
            junctionId: j.id,
          });
        }
        if (connectingSection && !findLane(connectingSection, l.to)) {
          issues.push({
            level: 'error',
            code: 'junction-dangling-lane',
            message: `交叉口 ${j.id} 连接 ${c.id}: 连接道路 ${c.connectingRoad} 无车道 ${l.to}`,
            junctionId: j.id,
          });
        }
        // 同一入口车道在一条 connection 内重复出现会造成歧义
        const key = `${l.from}`;
        if (seen.has(key)) {
          issues.push({
            level: 'warning',
            code: 'duplicate-lane-link',
            message: `交叉口 ${j.id} 连接 ${c.id}: 入口车道 ${l.from} 被重复映射`,
            junctionId: j.id,
          });
        }
        seen.add(key);
      }
    }
  }
}

/** 按级别汇总 */
export function summarizeIssues(issues: readonly Issue[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const i of issues) {
    if (i.level === 'error') errors++;
    else warnings++;
  }
  return { errors, warnings };
}
