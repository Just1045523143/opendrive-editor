import { BoxGeometry, CanvasTexture, CylinderGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry, Shape, ShapeGeometry, Sprite, SpriteMaterial, SRGBColorSpace } from 'three';
import type { OdrDocument } from '../core/model/document.ts';
import { furnitureItems, groundPolygons, drawFurnitureIcon } from './furniture.ts';

/** 无外部模型依赖的示意模型；不推断相位、控制关系或仿真状态。 */
export function buildFurniture3D(doc: OdrDocument, origin: { x: number; y: number }): Group {
  const all = new Group();
  for (const road of doc.roads) for (const item of furnitureItems(road)) {
    const anchor = new Group();
    anchor.position.set(item.x - origin.x, item.z, -(item.y - origin.y));
    anchor.rotation.x = -Math.PI / 2;
    const model = new Group();
    model.rotation.set(item.roll, item.pitch, item.heading, 'ZYX');
    anchor.add(model); all.add(anchor);
    anchor.userData = { roadId: road.id, id: item.source.id, kind: item.kind };
    if (item.ground) {
      for (const poly of groundPolygons(item.kind)) {
        const shape = new Shape();
        poly.forEach(([u, v], i) => {
          if (i === 0) shape.moveTo(u! * item.length, v! * item.width);
          else shape.lineTo(u! * item.length, v! * item.width);
        });
        shape.closePath();
        const mesh = new Mesh(new ShapeGeometry(shape), new MeshBasicMaterial({ color: 'white', side: DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
        mesh.position.z = 0.015;
        model.add(mesh);
      }
    } else {
      const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256;
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;
      ctx.translate(128, 128); ctx.scale(256, 256);
      drawFurnitureIcon(ctx, item.kind, item.value);
      const texture = new CanvasTexture(canvas); texture.colorSpace = SRGBColorSpace;
      // 固定屏幕尺寸的定位图标：大范围全览或从灯背面观察时仍能找到设施。
      const badge = new Sprite(new SpriteMaterial({ map: texture, sizeAttenuation: false, depthTest: false, depthWrite: false }));
      badge.position.z = item.height + 0.4;
      badge.renderOrder = 10;
      badge.userData.furnitureBadge = true;
      anchor.add(badge);
      const height = item.height, width = item.kind === 'light' ? Math.max(item.width, height * 0.52) : item.width;
      const face = new Mesh(new PlaneGeometry(width, height), new MeshBasicMaterial({ map: texture, transparent: true, side: DoubleSide }));
      // 牌面 normal=+u，局部竖直方向为 +z。
      face.rotation.set(Math.PI / 2, 0, Math.PI / 2, 'ZYX');
      face.position.set(0.065, 0, height / 2);
      model.add(face);
      if (item.kind === 'light') {
        const housing = new Mesh(new BoxGeometry(0.12, width, height), new MeshBasicMaterial({ color: 0x222228 }));
        housing.position.z = height / 2; model.add(housing);
      }
      const poleHeight = Math.max(0, item.source.zOffset ?? 0);
      if (poleHeight > 0) {
        const pole = new Mesh(new CylinderGeometry(0.035, 0.045, poleHeight, 8), new MeshBasicMaterial({ color: 0x92929b }));
        pole.rotation.x = Math.PI / 2;
        pole.position.z = -poleHeight / 2;
        anchor.add(pole);
      }
    }
  }
  return all;
}

/** perspective 投影下保持图标高度为 28 CSS 像素，不受视距或设备像素比影响。 */
export function updateFurnitureBadges(group: Group, camera: PerspectiveCamera, viewportHeight: number): void {
  const scale = 28 * 2 / (Math.max(1, viewportHeight) * camera.projectionMatrix.elements[5]!);
  group.traverse(object => {
    if (object instanceof Sprite && object.userData.furnitureBadge) object.scale.set(scale, scale, 1);
  });
}

export function disposeFurniture3D(group: Group): void {
  const textures = new Set<CanvasTexture>();
  group.traverse(object => {
    if (!(object instanceof Mesh) && !(object instanceof Sprite)) return;
    if (object instanceof Mesh) object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if ((material instanceof MeshBasicMaterial || material instanceof SpriteMaterial) && material.map) textures.add(material.map as CanvasTexture);
      material.dispose();
    }
  });
  for (const texture of textures) texture.dispose();
}
