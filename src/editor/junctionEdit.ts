/**
 * 交叉口的删除操作。
 *
 * 交叉口工具按「路臂两两配对」全量生成转向，包含实际渠化未必允许的转向和掉头。
 * 与其在生成前让用户逐项勾选（选中路臂时还不知道会生成哪些转向），不如先全量
 * 生成、再让用户在交叉口面板上逐条删掉多余的——生成结果画在图上，看着删比对着
 * 复选框猜要准。
 *
 * 删除的难点全在引用清理。OpenDRIVE 的路口关系分散在三处：
 *
 *   1. `<junction><connection>`      转向记录本身
 *   2. 连接道路的 `road@junction`    标记归属
 *   3. 入口道路的 `<link>`           指向 junction
 *
 * 漏掉任何一处都会留下悬空引用，校验会报 dangling-*。特别是第 3 条：入口道路的
 * link 指向的是**整个路口**而非某条转向，所以只有当该入口道路的最后一条转向也被
 * 删除时才能清掉；提前清掉会让剩下的转向失去入口侧的连接声明。
 */

import type { OdrDocument } from '../core/model/document.ts';

export interface DeleteResult {
  ok: boolean;
  /** 被移除的连接道路 id */
  removedRoads: string[];
  /** 入口道路的 link 是否因此被还原 */
  restoredIncoming: boolean;
  /** 路口是否因已无连接而整体删除 */
  junctionRemoved: boolean;
}

const EMPTY: DeleteResult = {
  ok: false,
  removedRoads: [],
  restoredIncoming: false,
  junctionRemoved: false,
};

/**
 * 删除整个交叉口及其全部连接道路。
 *
 * 入口道路指向本路口的 link、以及指向已删除连接道路的 link 都要清空。
 */
export function deleteJunction(doc: OdrDocument, junctionId: string): DeleteResult {
  if (!doc.junctions.some((x) => x.id === junctionId)) return EMPTY;

  const connectingIds = new Set(
    doc.roads.filter((r) => r.junction === junctionId).map((r) => r.id),
  );

  doc.roads = doc.roads.filter((r) => !connectingIds.has(r.id));
  doc.junctions = doc.junctions.filter((x) => x.id !== junctionId);

  for (const road of doc.roads) {
    for (const which of ['predecessor', 'successor'] as const) {
      const link = road.link[which];
      if (!link) continue;
      // 指向本路口，或指向已被删除的连接道路
      const stale =
        (link.elementType === 'junction' && link.elementId === junctionId) ||
        (link.elementType === 'road' && connectingIds.has(link.elementId));
      if (stale) delete road.link[which];
    }
  }

  return {
    ok: true,
    removedRoads: [...connectingIds],
    restoredIncoming: true,
    junctionRemoved: true,
  };
}

/**
 * 删除单条转向连接。
 *
 * 三处引用按依赖顺序清理：先摘掉 connection 记录，再删连接道路，最后判断入口
 * 道路是否还剩别的转向——剩着就保留它的 link，一条不剩才还原。
 *
 * 路口被删空时一并移除整个 `<junction>`：空 junction 会被校验报 empty-junction，
 * 留在文档里没有意义。
 */
export function deleteConnection(
  doc: OdrDocument,
  junctionId: string,
  connectionId: string,
): DeleteResult {
  const j = doc.junctions.find((x) => x.id === junctionId);
  if (!j) return EMPTY;

  const conn = j.connections.find((c) => c.id === connectionId);
  if (!conn) return EMPTY;

  const { connectingRoad, incomingRoad } = conn;

  j.connections = j.connections.filter((c) => c.id !== connectionId);
  doc.roads = doc.roads.filter((r) => r.id !== connectingRoad);

  // 入口道路的 link 指向整个路口，只有它最后一条转向也被删掉时才能还原
  let restoredIncoming = false;
  const stillUsed = j.connections.some((c) => c.incomingRoad === incomingRoad);
  if (!stillUsed) {
    const incoming = doc.roads.find((r) => r.id === incomingRoad);
    if (incoming) {
      for (const which of ['predecessor', 'successor'] as const) {
        const link = incoming.link[which];
        if (link?.elementType === 'junction' && link.elementId === junctionId) {
          delete incoming.link[which];
          restoredIncoming = true;
        }
      }
    }
  }

  // 空 junction 会被校验报 empty-junction，直接连壳一起删
  let junctionRemoved = false;
  if (j.connections.length === 0) {
    doc.junctions = doc.junctions.filter((x) => x.id !== junctionId);
    junctionRemoved = true;
    // 路口整体消失后，其余入口道路指向它的 link 也成了悬空引用
    for (const road of doc.roads) {
      for (const which of ['predecessor', 'successor'] as const) {
        const link = road.link[which];
        if (link?.elementType === 'junction' && link.elementId === junctionId) {
          delete road.link[which];
        }
      }
    }
  }

  return { ok: true, removedRoads: [connectingRoad], restoredIncoming, junctionRemoved };
}
