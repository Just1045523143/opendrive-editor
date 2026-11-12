/** 停止线保留为可见路面 object，灯通过标准 signal/reference 指向它。 */
import type { OdrDocument } from '../core/model/document.ts';
import type { Road, RoadObject, RoadSignal } from '../core/model/road.ts';
import { parseXml, serializeRaw, type XmlNode } from '../core/xml/dom.ts';

function children(signal: RoadSignal): XmlNode[] {
  return parseXml(`<signal>${signal.rawChildren ?? ''}</signal>`).children;
}

function pointsTo(node: XmlNode, id: string, elementType: 'object' | 'signal'): boolean {
  return node.tag === 'reference' && node.attrs.elementId === id && node.attrs.elementType === elementType;
}

function write(signal: RoadSignal, nodes: XmlNode[]): void {
  signal.rawChildren = nodes.map(node => serializeRaw(node, '      ')).join('') || undefined;
}

export function trafficLights(road: Road): RoadSignal[] {
  return road.signals.filter(isTrafficLight);
}

export function isTrafficLight(signal: RoadSignal): boolean {
  return signal.type === 'trafficLight' || signal.type === '1000001'
    && (signal.country === 'OpenDRIVE' || signal.country === 'DE');
}

export function stopLineLights(road: Road, stopLine: RoadObject): RoadSignal[] {
  return trafficLights(road).filter(light => children(light).some(node => pointsTo(node, stopLine.id, 'object')));
}

/** 只修改当前灯线关系；保留适用车道、其他停止线及未知 XML 子元素。 */
export function setStopLineLight(road: Road, stopLine: RoadObject, light: RoadSignal, bound: boolean): void {
  if (!road.objects.includes(stopLine) || !trafficLights(road).includes(light)) {
    throw new Error('停止线和交通灯必须属于同一道路');
  }
  const nodes = children(light).filter(node => !pointsTo(node, stopLine.id, 'object'));
  if (bound) {
    const reference: XmlNode = { tag: 'reference', attrs: {
      elementId: stopLine.id, elementType: 'object', type: 'stopline',
    }, children: [] };
    // signal 的 reference 位于可选的世界位置和附加数据之前。
    const extra = nodes.findIndex(node => ['positionRoad', 'positionInertial', 'userData', 'include', 'dataQuality'].includes(node.tag));
    nodes.splice(extra < 0 ? nodes.length : extra, 0, reference);
  }
  write(light, nodes);
}

/** 删除设施后清理它的引用，区分 object/signal 两个 ID 命名空间。 */
export function removeFacilityReferences(doc: OdrDocument, id: string, elementType: 'object' | 'signal'): void {
  for (const road of doc.roads) for (const signal of road.signals) {
    const nodes = children(signal);
    const kept = nodes.filter(node => !pointsTo(node, id, elementType)
      && !(elementType === 'signal' && node.tag === 'dependency' && node.attrs.id === id));
    if (kept.length !== nodes.length) write(signal, kept);
  }
}
