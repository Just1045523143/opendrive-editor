/**
 * 删除道路及其连带引用。
 *
 * 删一条路从来不只是从 `doc.roads` 里摘掉它。这条路可能是某个路口的入口臂、
 * 出口臂，或者本身就是一条连接道路，三种身份下要清理的东西各不相同：
 *
 *   入口臂      它发起的全部转向随之失效，那些连接道路要一起删
 *   出口臂      通向它的连接道路成了断头路，同样要删
 *   连接道路    对应的 `<connection>` 记录要摘掉
 *
 * 清理不干净的代价不是校验报个错就完了。此前画布 Delete 只摘 `<connection>`
 * 记录，留下空 junction 和入口道路指向它的 link；那条 link 让交叉口工具永久
 * 判定该端点「已有连接，请先删除后重试」，而用户在界面上确实已经删光了，
 * 于是陷入死局。所以删除一律走这里，与面板上的删除共用同一套清理逻辑。
 */

import { connectionTouchesRoad } from '../core/model/document.ts';
import type { OdrDocument } from '../core/model/document.ts';
import { deleteConnection } from './junctionEdit.ts';

export interface DeleteRoadResult {
  ok: boolean;
  /** 全部被移除的道路 id，含目标道路自身与连带删除的连接道路 */
  removedRoads: string[];
  /** 因删空而一并移除的路口 id */
  removedJunctions: string[];
}

/**
 * 删除一条道路，连带清理它牵涉的全部转向连接。
 *
 * 转向连接逐条走 `deleteConnection`，不在这里另写一套：那个函数已经处理了
 * 「入口道路的 link 只有在最后一条转向也删掉时才还原」以及「路口删空后整体
 * 移除」，重复实现必然漂移。
 */
export function deleteRoad(doc: OdrDocument, roadId: string): DeleteRoadResult {
  if (!doc.roads.some((r) => r.id === roadId)) {
    return { ok: false, removedRoads: [], removedJunctions: [] };
  }

  const removedRoads: string[] = [];
  const removedJunctions: string[] = [];

  // 快照一份路口列表：deleteConnection 可能把路口整个删掉，不能边删边遍历
  for (const junction of [...doc.junctions]) {
    const doomed = junction.connections
      .filter((c) => connectionTouchesRoad(doc, c, roadId))
      .map((c) => c.id);

    for (const connectionId of doomed) {
      const res = deleteConnection(doc, junction.id, connectionId);
      if (!res.ok) continue;
      removedRoads.push(...res.removedRoads);
      if (res.junctionRemoved) removedJunctions.push(junction.id);
    }
  }

  // 目标道路自身可能已作为连接道路被上面删掉了
  if (doc.roads.some((r) => r.id === roadId)) {
    doc.roads = doc.roads.filter((r) => r.id !== roadId);
    removedRoads.push(roadId);
  }

  // 其余道路指向它的 link 全部清空
  for (const road of doc.roads) {
    for (const which of ['predecessor', 'successor'] as const) {
      const link = road.link[which];
      if (link?.elementType === 'road' && link.elementId === roadId) delete road.link[which];
    }
  }

  return { ok: true, removedRoads, removedJunctions };
}
