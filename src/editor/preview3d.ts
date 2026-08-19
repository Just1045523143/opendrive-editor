/**
 * 3D 预览：把路网按高程与横坡生成三角网格。
 *
 * 坐标映射：工程系 (x 东, y 北, z 上) → Three.js (x, y 上, −z 北)。
 * 网格以路网范围中心为原点，避免大坐标（UTM 可达 10⁶ 量级）造成的
 * float32 精度损失——WebGL 顶点属性为 32 位浮点，10⁶ 量级下分辨率约 0.06 m，
 * 足以让路面出现可见抖动。
 */

import {
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  GridHelper,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { crossSectionAt } from '../core/model/lanes.ts';
import { referencePoint, sampleStations, stToXyz } from '../core/model/reference.ts';
import { laneSectionIndexAt, type Road } from '../core/model/road.ts';
import { findLane } from '../core/model/lane.ts';
import { boundsCenter, computeBounds } from '../core/model/bounds.ts';
import type { OdrDocument } from '../core/model/document.ts';
import { laneColor } from './renderData.ts';

interface MeshBuffers {
  positions: number[];
  colors: number[];
}

/** 把一条道路的车道面写入缓冲 */
function appendRoad(
  road: Road,
  origin: { x: number; y: number },
  buf: MeshBuffers,
  tolerance: number,
): void {
  if (road.planView.length === 0 || road.length <= 0) return;

  const stations = sampleStations(road, tolerance, 15);
  // 上一站的各车道边界点，用于生成三角带
  let prev: Map<number, { inner: Vector3; outer: Vector3; color: Color }> | null = null;
  let prevSection = -1;

  for (const s of stations) {
    const ref = referencePoint(road, s);
    const secIdx = laneSectionIndexAt(road, s);
    const section = road.laneSections[secIdx];
    if (!section) continue;

    const cs = crossSectionAt(road, s, ref);
    const current = new Map<number, { inner: Vector3; outer: Vector3; color: Color }>();

    for (const side of [cs.left, cs.right]) {
      for (const b of side) {
        const lane = findLane(section, b.laneId);
        if (!lane) continue;
        const pi = stToXyz(ref, b.tInner);
        const po = stToXyz(ref, b.tOuter);
        current.set(b.laneId, {
          inner: new Vector3(pi.x - origin.x, pi.z, -(pi.y - origin.y)),
          outer: new Vector3(po.x - origin.x, po.z, -(po.y - origin.y)),
          color: new Color(laneColor(lane.type)),
        });
      }
    }

    // 跨车道段时断开三角带，避免车道数变化处出现错乱三角
    if (prev && secIdx === prevSection) {
      for (const [laneId, cur] of current) {
        const p = prev.get(laneId);
        if (!p) continue;
        pushQuad(buf, p.inner, p.outer, cur.outer, cur.inner, cur.color);
      }
    }

    prev = current;
    prevSection = secIdx;
  }
}

function pushQuad(
  buf: MeshBuffers,
  a: Vector3,
  b: Vector3,
  c: Vector3,
  d: Vector3,
  color: Color,
): void {
  // 两个三角形 a-b-c 与 a-c-d
  for (const v of [a, b, c, a, c, d]) {
    buf.positions.push(v.x, v.y, v.z);
    buf.colors.push(color.r, color.g, color.b);
  }
}

export class Preview3D {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera: PerspectiveCamera;
  private roadMesh: Mesh | null = null;
  private refLines: Line[] = [];
  private grid: GridHelper | null = null;

  /** 轨道相机参数 */
  private target = new Vector3(0, 0, 0);
  private distance = 400;
  private azimuth = -Math.PI / 4;
  private elevationAngle = 0.6;

  private dragging: 'orbit' | 'pan' | null = null;
  private lastPointer = { x: 0, y: 0 };
  private disposed = false;

  constructor(readonly container: HTMLElement) {
    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.scene.background = new Color(0x0d0d12);

    this.camera = new PerspectiveCamera(55, 1, 0.5, 40000);

    this.scene.add(new AmbientLight(0xffffff, 0.75));
    const sun = new DirectionalLight(0xffffff, 1.5);
    sun.position.set(0.4, 1, 0.6).multiplyScalar(1000);
    this.scene.add(sun);

    container.append(this.renderer.domElement);
    this.bindEvents();
    this.resize();
  }

  private bindEvents(): void {
    const dom = this.renderer.domElement;

    dom.addEventListener('pointerdown', (e) => {
      dom.setPointerCapture(e.pointerId);
      this.dragging = e.button === 2 || e.shiftKey ? 'pan' : 'orbit';
      this.lastPointer = { x: e.clientX, y: e.clientY };
      e.preventDefault();
    });

    dom.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastPointer.x;
      const dy = e.clientY - this.lastPointer.y;
      this.lastPointer = { x: e.clientX, y: e.clientY };

      if (this.dragging === 'orbit') {
        this.azimuth -= dx * 0.005;
        this.elevationAngle = Math.max(
          0.03,
          Math.min(Math.PI / 2 - 0.02, this.elevationAngle + dy * 0.005),
        );
      } else {
        // 平移：沿相机右向与前向的水平投影移动
        const scale = this.distance * 0.0015;
        const right = new Vector3(Math.cos(this.azimuth), 0, -Math.sin(this.azimuth));
        const fwd = new Vector3(Math.sin(this.azimuth), 0, Math.cos(this.azimuth));
        this.target.addScaledVector(right, -dx * scale);
        this.target.addScaledVector(fwd, -dy * scale);
      }
      this.render();
    });

    dom.addEventListener('pointerup', (e) => {
      dom.releasePointerCapture(e.pointerId);
      this.dragging = null;
    });

    dom.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = Math.exp(e.deltaY * 0.001);
      this.distance = Math.max(5, Math.min(20000, this.distance * factor));
      this.render();
    }, { passive: false });

    dom.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  resize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  /** 由文档重建网格 */
  build(doc: OdrDocument, tolerance = 0.08): void {
    if (this.disposed) return;

    // 清理旧对象
    if (this.roadMesh) {
      this.scene.remove(this.roadMesh);
      this.roadMesh.geometry.dispose();
      (this.roadMesh.material as MeshStandardMaterial).dispose();
      this.roadMesh = null;
    }
    for (const l of this.refLines) {
      this.scene.remove(l);
      l.geometry.dispose();
      (l.material as LineBasicMaterial).dispose();
    }
    this.refLines = [];
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.dispose();
      this.grid = null;
    }

    const bounds = computeBounds(doc);
    const origin = bounds ? boundsCenter(bounds) : { x: 0, y: 0 };

    const buf: MeshBuffers = { positions: [], colors: [] };
    for (const road of doc.roads) appendRoad(road, origin, buf, tolerance);

    if (buf.positions.length > 0) {
      const geom = new BufferGeometry();
      geom.setAttribute('position', new BufferAttribute(new Float32Array(buf.positions), 3));
      geom.setAttribute('color', new BufferAttribute(new Float32Array(buf.colors), 3));
      geom.computeVertexNormals();

      const mat = new MeshStandardMaterial({
        vertexColors: true,
        side: DoubleSide,
        roughness: 0.92,
        metalness: 0.02,
      });
      this.roadMesh = new Mesh(geom, mat);
      this.scene.add(this.roadMesh);
    }

    // 地面网格作为高度参照
    const span = bounds
      ? Math.max(bounds.east - bounds.west, bounds.north - bounds.south, 100)
      : 200;
    const gridSize = Math.ceil((span * 1.6) / 50) * 50;
    this.grid = new GridHelper(gridSize, Math.max(4, Math.round(gridSize / 50)), 0x2a2a35, 0x1e1e26);
    this.grid.position.y = bounds ? bounds.minZ - 0.15 : -0.15;
    this.scene.add(this.grid);

    // 初始视角对准路网
    this.target.set(0, bounds ? (bounds.minZ + bounds.maxZ) / 2 : 0, 0);
    this.distance = Math.max(60, span * 1.1);
    this.render();
  }

  render(): void {
    if (this.disposed) return;
    const cosE = Math.cos(this.elevationAngle);
    this.camera.position.set(
      this.target.x + this.distance * cosE * Math.sin(this.azimuth),
      this.target.y + this.distance * Math.sin(this.elevationAngle),
      this.target.z + this.distance * cosE * Math.cos(this.azimuth),
    );
    this.camera.lookAt(this.target);
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.disposed = true;
    if (this.roadMesh) {
      this.roadMesh.geometry.dispose();
      (this.roadMesh.material as MeshStandardMaterial).dispose();
    }
    for (const l of this.refLines) {
      l.geometry.dispose();
      (l.material as LineBasicMaterial).dispose();
    }
    this.grid?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  /** 顶点数，供状态栏显示 */
  get triangleCount(): number {
    const attr = this.roadMesh?.geometry.getAttribute('position');
    return attr ? attr.count / 3 : 0;
  }
}
