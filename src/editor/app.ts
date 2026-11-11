/**
 * 应用装配：画布、事件、工具、面板、导入导出。
 */

import { DEFAULT_FIT, type FitOptions } from '../core/geometry/alignment.ts';
import { createEmptyDocument } from '../core/model/document.ts';
import { computeBounds } from '../core/model/bounds.ts';
import { referencePoint } from '../core/model/reference.ts';
import type { Issue } from '../core/model/validate.ts';
import { parseOpenDrive } from '../core/xml/parse.ts';
import { serializeOpenDrive } from '../core/xml/serialize.ts';
import {
  crsFromGeoReference,
  localTmerc,
  Projector,
  type CoordinateSystem,
  type LonLat,
} from '../geo/projection.ts';
import { reprojectDocument, snapshotEndpoints, measureReprojectionError } from '../geo/reproject.ts';
import { findTileSource, TILE_SOURCES } from '../geo/tiles.ts';
import { Inspector } from '../ui/inspector.ts';
import { rebuildSide, type PanelContext } from '../ui/panels.ts';
import { button, clear, downloadText, el, pickTextFile, selectRow } from '../ui/dom.ts';
import { FURNITURE, drawFurnitureIcon, groundPolygons } from './furniture.ts';
import { FurnitureTool } from './tools/furnitureTool.ts';
import { Preview3D } from './preview3d.ts';
import { isProjectFile, parseProject, serializeProject } from './project.ts';
import { buildRoadRenderData, type RoadRenderData } from './renderData.ts';
import { DEFAULT_RENDER_OPTIONS, Renderer, type RenderOptions } from './renderer.ts';
import { DEFAULT_TEMPLATE, type RoadTemplate } from './roadFactory.ts';
import { Store } from './store.ts';
import { TileLayer } from './tileLayer.ts';
import { DrawTool } from './tools/drawTool.ts';
import { JunctionTool } from './tools/junctionTool.ts';
import { LaneLinkTool } from './tools/laneLinkTool.ts';
import { SelectTool } from './tools/selectTool.ts';
import { DEFAULT_SNAP, type PointerInput, type SnapSettings, type Tool, type ToolContext, type ToolId } from './tools/types.ts';
import { MeasureTool, SplitTool } from './tools/utilTools.ts';
import { Viewport } from './viewport.ts';

/** 默认工作区中心：北京天安门附近。用户可在坐标系面板改到任意位置 */
const DEFAULT_ORIGIN: LonLat = { lon: 116.397428, lat: 39.90923 };

export class App {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx2d: CanvasRenderingContext2D;
  private readonly viewport = new Viewport();
  private readonly store = new Store();
  private readonly tileLayer: TileLayer;
  private readonly renderer: Renderer;
  private readonly inspector: Inspector;

  private crs: CoordinateSystem = localTmerc(DEFAULT_ORIGIN);
  private projector: Projector;

  private renderOptions: RenderOptions = { ...DEFAULT_RENDER_OPTIONS };
  private template: RoadTemplate = { ...DEFAULT_TEMPLATE };
  private fit: FitOptions = { ...DEFAULT_FIT };
  private snap: SnapSettings = { ...DEFAULT_SNAP };

  private tools: Record<ToolId, Tool>;
  private activeToolId: ToolId = 'select';
  private furniturePalette: HTMLElement | null = null;

  private dirty = true;
  private rafId = 0;

  private preview3d: Preview3D | null = null;
  private preview3dHost: HTMLElement | null = null;
  private preview3dButton: HTMLButtonElement | null = null;

  /** 渲染数据缓存，供拾取复用 */
  private renderDataCache: RoadRenderData[] = [];
  private renderDataDirty = true;

  private readonly dom: {
    toolbar: HTMLElement;
    rail: HTMLElement;
    side: HTMLElement;
    status: HTMLElement;
    stage: HTMLElement;
    attribution: HTMLElement;
    hint: HTMLElement;
    toast: HTMLElement;
  };

  private toastTimer = 0;

  constructor() {
    const canvas = document.getElementById('canvas');
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('未找到画布元素');
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法获取 2D 绘图上下文');
    this.ctx2d = ctx;

    this.dom = {
      toolbar: requireEl('toolbar'),
      rail: requireEl('rail'),
      side: requireEl('side'),
      status: requireEl('status'),
      stage: canvas.parentElement as HTMLElement,
      attribution: requireEl('attribution'),
      hint: requireEl('hint'),
      toast: requireEl('toast'),
    };

    this.projector = new Projector(this.crs);

    const source = TILE_SOURCES[0]!;
    this.tileLayer = new TileLayer({
      source,
      opacity: 1,
      visible: true,
      zoomBias: 0,
    });
    this.tileLayer.onNeedsRedraw = () => this.requestRedraw();

    this.renderer = new Renderer(this.store, this.viewport, this.tileLayer);
    this.renderer.options = this.renderOptions;

    this.inspector = new Inspector(this.store, {
      invalidate: (id) => this.invalidate(id),
      requestRedraw: () => this.requestRedraw(),
      focusRoad: (id) => this.focusRoad(id),
      template: () => this.template,
    });

    this.tools = {
      select: new SelectTool(),
      draw: new DrawTool(),
      junction: new JunctionTool(),
      laneLink: new LaneLinkTool(),
      split: new SplitTool(),
      measure: new MeasureTool(),
      furniture: new FurnitureTool(),
      lane: new SelectTool(), // 车道编辑走检查器,此处复用选择工具
    };

    this.store.replaceDocument(createEmptyDocument(this.crs.proj));

    this.bindStore();
    this.bindCanvas();
    this.bindKeyboard();
    this.buildToolbar();
    this.buildRail();
    this.rebuildPanels();
    this.resize();

    window.addEventListener('resize', () => this.resize());
    this.viewport.center = { x: 0, y: 0 };
    this.viewport.pixelsPerMeter = 1.2;

    this.loop();
    this.store.notify('info', '就绪。切换到「绘制道路」工具，在影像上点击即可开始描绘。');
  }

  /* ---------- 绑定 ---------- */

  private bindStore(): void {
    this.store.onChange(() => {
      this.renderDataDirty = true;
      this.requestRedraw();
      this.rebuildPanels();
      this.preview3d?.build(this.store.document, Math.max(0.05, this.renderOptions.tolerance));
    });
    this.store.onSelectionChange(() => {
      this.inspector.render();
      this.rebuildPanels();
      this.requestRedraw();
    });
    this.store.onMessage(() => {
      this.updateStatus();
      this.showToast();
    });
  }

  /**
   * 把最新一条消息就地显示在画布上。
   *
   * 消息面板默认收起，`notify` 发出的拒绝理由此前完全不可见——工具明明说明了
   * 原因，用户看到的却是「按了没反应」。error/warn 停留更久，info 一扫而过。
   */
  private showToast(): void {
    const msg = this.store.messages[this.store.messages.length - 1];
    if (!msg) return;

    const node = this.dom.toast;
    node.textContent = msg.text;
    node.className = `toast show ${msg.level}`;

    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(
      () => {
        node.className = 'toast';
      },
      msg.level === 'info' ? 2600 : 6000,
    );
  }

  private get toolContext(): ToolContext {
    return {
      store: this.store,
      viewport: this.viewport,
      projector: this.projector,
      renderData: () => this.getRenderData(),
      requestRedraw: () => this.requestRedraw(),
      invalidate: (id) => this.invalidate(id),
      template: this.template,
      fit: this.fit,
      snap: this.snap,
      showFurniture: this.renderOptions.showFurniture,
    };
  }

  private get activeTool(): Tool {
    return this.tools[this.activeToolId];
  }

  private toPointerInput(e: PointerEvent): PointerInput {
    const rect = this.canvas.getBoundingClientRect();
    const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    return {
      screen,
      world: this.viewport.screenToWorld(screen),
      button: e.button,
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      raw: e,
    };
  }

  private bindCanvas(): void {
    const c = this.canvas;

    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.activeTool.onPointerDown?.(this.toolContext, this.toPointerInput(e));
      this.updateCursor();
    });

    c.addEventListener('pointermove', (e) => {
      const input = this.toPointerInput(e);
      this.activeTool.onPointerMove?.(this.toolContext, input);
      this.updateCoordReadout(input);
    });

    c.addEventListener('pointerup', (e) => {
      if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
      this.activeTool.onPointerUp?.(this.toolContext, this.toPointerInput(e));
      this.updateCursor();
    });

    c.addEventListener('pointercancel', () => {
      this.activeTool.onKeyDown?.(this.toolContext, { key: 'Escape' } as KeyboardEvent);
      this.updateCursor();
    });

    c.addEventListener('dblclick', (e) => {
      const rect = c.getBoundingClientRect();
      const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      this.activeTool.onDoubleClick?.(this.toolContext, {
        screen,
        world: this.viewport.screenToWorld(screen),
        button: 0,
        shiftKey: e.shiftKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        raw: e as unknown as PointerEvent,
      });
    });

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      // 每档 1.15 倍，触控板的小增量也能平滑缩放
      const factor = Math.exp(-e.deltaY * 0.0016);
      this.viewport.zoomAt(anchor, factor);
      this.requestRedraw();
    }, { passive: false });

    c.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private bindKeyboard(): void {
    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null;
      // 输入框内不劫持按键
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;

      // 空格先给工具（交叉口工具用它提交），未消费才作为「按住平移」修饰键
      if (e.code === 'Space') {
        if (this.activeTool.onKeyDown?.(this.toolContext, e)) {
          e.preventDefault();
          return;
        }
        const sel = this.tools.select;
        if (sel instanceof SelectTool) sel.spacePressed = true;
        this.updateCursor();
        e.preventDefault();
        return;
      }

      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        this.store.undo();
        this.invalidate();
        e.preventDefault();
        return;
      }
      if (ctrl && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        this.store.redo();
        this.invalidate();
        e.preventDefault();
        return;
      }
      if (ctrl && e.key.toLowerCase() === 's') {
        this.saveProject();
        e.preventDefault();
        return;
      }
      if (ctrl && e.key.toLowerCase() === 'e') {
        this.exportXodr();
        e.preventDefault();
        return;
      }

      if (this.activeTool.onKeyDown?.(this.toolContext, e)) {
        e.preventDefault();
        return;
      }

      if (e.key === 'Escape' && this.activeToolId === 'furniture') {
        this.setTool('select'); e.preventDefault(); return;
      }
      const shortcuts: Record<string, ToolId> = {
        v: 'select',
        d: 'draw',
        j: 'junction',
        l: 'laneLink',
        c: 'split',
        m: 'measure',
        f: 'furniture',
      };
      const tool = shortcuts[e.key.toLowerCase()];
      if (tool && !ctrl) {
        this.setTool(tool);
        e.preventDefault();
      }
    });

    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        const sel = this.tools.select;
        if (sel instanceof SelectTool) sel.spacePressed = false;
        this.updateCursor();
      }
    });
  }

  /* ---------- 渲染循环 ---------- */

  private requestRedraw(): void {
    this.dirty = true;
  }

  private invalidate(roadId?: string): void {
    this.renderer.invalidate(roadId);
    this.renderDataDirty = true;
    this.requestRedraw();
  }

  private getRenderData(): RoadRenderData[] {
    if (!this.renderDataDirty) return this.renderDataCache;
    this.renderDataCache = this.store.document.roads.map((r) =>
      buildRoadRenderData(r, this.renderOptions.tolerance),
    );
    this.renderDataDirty = false;
    return this.renderDataCache;
  }

  private loop(): void {
    const step = (): void => {
      if (this.dirty) {
        this.dirty = false;
        this.draw();
      }
      this.rafId = requestAnimationFrame(step);
    };
    this.rafId = requestAnimationFrame(step);
  }

  private draw(): void {
    this.renderer.draw(this.ctx2d, this.projector);
    // 工具自身的临时图形绘制在最上层
    this.ctx2d.save();
    this.ctx2d.setTransform(this.viewport.dpr, 0, 0, this.viewport.dpr, 0, 0);
    this.activeTool.draw?.(this.toolContext, this.ctx2d);
    this.ctx2d.restore();
    this.updateStatus();
  }

  private resize(): void {
    const rect = this.dom.stage.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.viewport.size = { width: rect.width, height: rect.height };
    this.viewport.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.preview3d?.resize();
    this.requestRedraw();
  }

  private updateCursor(): void {
    this.canvas.style.cursor = this.activeTool.cursor?.(this.toolContext) ?? 'default';
  }

  /* ---------- 工具栏与工具切换 ---------- */

  private setTool(id: ToolId): void {
    if (id === this.activeToolId) return;
    if (id === 'furniture') {
      if (this.preview3d) this.togglePreview3D();
      this.renderOptions.showFurniture = true;
    }
    this.activeTool.onDeactivate?.(this.toolContext);
    this.activeToolId = id;
    this.furniturePalette?.remove();
    this.furniturePalette = null;
    if (id === 'furniture') this.buildFurniturePalette();
    this.activeTool.onActivate?.(this.toolContext);
    this.buildRail();
    this.updateCursor();
    this.dom.hint.textContent = this.activeTool.hint;
    this.requestRedraw();
  }

  private buildRail(): void {
    clear(this.dom.rail);
    const entries: Array<{ id: ToolId; glyph: string }> = [
      { id: 'select', glyph: '⬚' },
      { id: 'draw', glyph: '✎' },
      { id: 'junction', glyph: '✚' },
      { id: 'laneLink', glyph: '⤳' },
      { id: 'split', glyph: '⊣' },
      { id: 'measure', glyph: '⟺' },
      { id: 'furniture', glyph: '🚦' },
    ];

    for (const entry of entries) {
      const tool = this.tools[entry.id];
      const btn = el('button', {
        class: `tool-btn${entry.id === this.activeToolId ? ' active' : ''}`,
        title: `${tool.label} — ${tool.hint}`,
        onclick: () => this.setTool(entry.id === 'furniture' && this.activeToolId === 'furniture' ? 'select' : entry.id),
      },
        el('span', { class: 'glyph', text: entry.glyph }),
        el('span', { text: tool.label }),
      );
      this.dom.rail.append(btn);
    }
  }

  private buildFurniturePalette(): void {
    const tool = this.tools.furniture as FurnitureTool;
    const palette = el('div', { class: 'furniture-palette', role: 'region', 'aria-label': '交通设施放置' });
    palette.append(el('strong', { text: '交通设施 · 点击地图放置' }),
      button('关闭 (Esc)', () => this.setTool('select')));
    const choices = el('div', { class: 'furniture-choices' });
    for (const [kind, label] of FURNITURE) {
      const choice = button(label, () => {
        tool.kind = kind;
        this.furniturePalette?.remove(); this.buildFurniturePalette(); this.requestRedraw();
      });
      choice.classList.toggle('active', tool.kind === kind);
      choice.setAttribute('aria-pressed', String(tool.kind === kind));
      const icon = el('canvas', { width: 28, height: 28, 'aria-hidden': 'true' });
      const c = icon.getContext('2d');
      if (c) {
        c.translate(14,14); c.scale(25,25);
        if (kind.startsWith('arrow') || kind === 'crosswalk' || kind === 'stopLine') {
          c.fillStyle = 'white';
          for (const poly of groundPolygons(kind)) {
            c.beginPath(); poly.forEach(([u,v], i) => { if (i === 0) c.moveTo(u!, -v!); else c.lineTo(u!, -v!); }); c.closePath(); c.fill();
          }
        } else drawFurnitureIcon(c, kind);
      }
      choice.prepend(icon); choices.append(choice);
    }
    palette.append(choices, selectRow('朝向', tool.orientation,
      [{ value: 'auto' as const, label: '按所在道路侧自动判断' }, { value: '+' as const, label: '沿 +s 行驶方向' }, { value: '-' as const, label: '沿 −s 行驶方向' }],
      v => { tool.orientation = v; this.requestRedraw(); }),
      el('p', { class: 'note', text: '悬停查看所属道路，单击连续放置。添加后在右侧调整高度、限速等属性。' }));
    this.dom.stage.append(palette); this.furniturePalette = palette;
  }

  private buildToolbar(): void {
    const t = this.dom.toolbar;
    clear(t);
    this.preview3dButton = button('3D 预览', () => this.togglePreview3D());
    this.updatePreviewModeButton();

    t.append(
      el('strong', { text: '高精路网编辑器' }),
      el('span', { class: 'sep' }),
      button('新建', () => this.newDocument()),
      button('打开', () => this.openFile(), { title: '支持 .xodr 与 .odrproj.json' }),
      button('保存工程', () => this.saveProject(), { title: 'Ctrl+S，含控制点，可续编' }),
      button('导出 xodr', () => this.exportXodr(), { primary: true, title: 'Ctrl+E' }),
      el('span', { class: 'sep' }),
      button('撤销', () => {
        this.store.undo();
        this.invalidate();
      }, { title: 'Ctrl+Z' }),
      button('重做', () => {
        this.store.redo();
        this.invalidate();
      }, { title: 'Ctrl+Y' }),
      el('span', { class: 'sep' }),
      button('全览', () => this.fitAll()),
      this.preview3dButton,
      el('span', { class: 'spacer' }),
      button('说明', () => this.showHelp()),
    );

    this.dom.hint.textContent = this.activeTool.hint;
    this.dom.attribution.textContent = this.tileLayer.options.source.attribution;
  }

  /* ---------- 面板 ---------- */

  private get panelContext(): PanelContext {
    return {
      store: this.store,
      tileLayer: this.tileLayer,
      renderOptions: this.renderOptions,
      template: this.template,
      fit: this.fit,
      snap: this.snap,
      crs: this.crs,
      requestRedraw: () => this.requestRedraw(),
      invalidate: (id) => this.invalidate(id),
      rebuildPanels: () => this.rebuildPanels(),
      setCrs: (crs) => this.changeCrs(crs),
      goToLonLat: (ll) => this.goToLonLat(ll),
      fitAll: () => this.fitAll(),
      selectIssue: (issue) => this.selectIssue(issue),
    };
  }

  private rebuildPanels(): void {
    this.inspector.render();
    rebuildSide(this.dom.side, this.panelContext, this.inspector.root);
    this.dom.attribution.textContent = this.tileLayer.options.source.attribution;
  }

  private updateStatus(): void {
    const doc = this.store.document;
    const stats = this.tileLayer.stats;
    const mpp = this.viewport.metersPerPixel;
    const scale = this.projector.scaleFactorAt(this.crs.origin);

    clear(this.dom.status);
    this.dom.status.append(
      el('span', { text: `道路 ${doc.roads.length}` }),
      el('span', { text: `交叉口 ${doc.junctions.length}` }),
      el('span', { id: 'coord-readout', text: '—' }),
      el('span', { text: `${mpp < 1 ? `${(mpp * 100).toFixed(1)} cm/px` : `${mpp.toFixed(2)} m/px`}` }),
      el('span', { text: `瓦片 ${stats.cached}（加载中 ${stats.loading}）` }),
      el('span', {
        class: Math.abs(scale - 1) < 1e-4 ? 'stat-ok' : 'stat-warn',
        text: `投影尺度 ${scale.toFixed(6)}`,
        title: '原点处每米真实距离对应的投影距离；偏离 1 越多，变形越大',
      }),
      el('span', { text: this.crs.label }),
    );
  }

  private updateCoordReadout(input: PointerInput): void {
    const node = document.getElementById('coord-readout');
    if (!node) return;
    const ll = this.projector.unproject(input.world);
    node.textContent = `x ${input.world.x.toFixed(2)}  y ${input.world.y.toFixed(2)}  |  ${ll.lat.toFixed(7)}, ${ll.lon.toFixed(7)}`;
  }

  /* ---------- 视图 ---------- */

  private fitAll(): void {
    const bounds = computeBounds(this.store.document);
    if (!bounds) {
      this.store.notify('info', '路网为空，无法全览');
      return;
    }
    this.viewport.fitBox({
      minX: bounds.west,
      maxX: bounds.east,
      minY: bounds.south,
      maxY: bounds.north,
    });
    this.requestRedraw();
  }

  private focusRoad(roadId: string): void {
    const road = this.store.document.roads.find((r) => r.id === roadId);
    if (!road || road.length <= 0) return;
    const mid = referencePoint(road, road.length / 2);
    this.viewport.center = { x: mid.x, y: mid.y };
    this.store.select({ kind: 'road', roadId });
    this.requestRedraw();
  }

  private goToLonLat(ll: LonLat): void {
    const p = this.projector.project(ll);
    this.viewport.center = { x: p.x, y: p.y };
    if (this.viewport.pixelsPerMeter < 1) this.viewport.pixelsPerMeter = 2;
    this.requestRedraw();
    this.store.notify('info', `已定位到 ${ll.lat.toFixed(6)}, ${ll.lon.toFixed(6)}`);
  }

  private selectIssue(issue: Issue): void {
    if (issue.roadId) {
      if (issue.laneId !== undefined && issue.sectionIndex !== undefined) {
        this.store.select({
          kind: 'lane',
          roadId: issue.roadId,
          sectionIndex: issue.sectionIndex,
          laneId: issue.laneId,
        });
      } else if (issue.geometryIndex !== undefined) {
        this.store.select({
          kind: 'geometry',
          roadId: issue.roadId,
          geometryIndex: issue.geometryIndex,
        });
      } else {
        this.store.select({ kind: 'road', roadId: issue.roadId });
      }
      this.focusRoad(issue.roadId);
    } else if (issue.junctionId) {
      this.store.select({ kind: 'junction', junctionId: issue.junctionId });
    }
  }

  /* ---------- 坐标系 ---------- */

  private changeCrs(next: CoordinateSystem): void {
    const doc = this.store.document;

    if (doc.roads.length === 0) {
      this.crs = next;
      this.projector = new Projector(next);
      doc.header.geoReference = next.proj;
      this.tileLayer.setSource(this.tileLayer.options.source, this.tileLayer.options.apiKey);
      this.invalidate();
      this.rebuildPanels();
      this.store.notify('info', `坐标系已设为 ${next.label}`);
      return;
    }

    const from = this.crs;
    const before = snapshotEndpoints(doc);

    this.store.mutate(() => {
      const alignments = new Map(this.store.allAlignments);
      const result = reprojectDocument(doc, alignments, from, next);
      for (const [id, rec] of alignments) this.store.setAlignment(id, rec);
      doc.header.geoReference = next.proj;

      const err = measureReprojectionError(before, doc, from, next);
      this.store.notify(
        err > 0.05 ? 'warn' : 'info',
        `重投影完成：${result.refittedRoads} 条精确重拟合，${result.transformedRoads} 条近似变换，最大偏差 ${(err * 1000).toFixed(1)} mm`,
      );
    });

    this.crs = next;
    this.projector = new Projector(next);
    this.invalidate();
    this.rebuildPanels();
  }

  /* ---------- 文件 ---------- */

  private newDocument(): void {
    if (this.store.document.roads.length > 0 && !confirm('新建将丢弃当前未保存的内容，是否继续？')) {
      return;
    }
    this.store.replaceDocument(createEmptyDocument(this.crs.proj));
    this.invalidate();
    this.rebuildPanels();
    this.store.notify('info', '已新建空白路网');
  }

  private async openFile(): Promise<void> {
    const picked = await pickTextFile('.xodr,.xml,.json,.odrproj');
    if (!picked) return;

    try {
      if (isProjectFile(picked.name) && picked.text.trimStart().startsWith('{')) {
        const snap = parseProject(picked.text);
        this.crs = snap.crs;
        this.projector = new Projector(snap.crs);
        this.template = snap.template;
        this.store.replaceDocument(snap.document, snap.alignments);

        if (snap.tile) {
          const src = findTileSource(snap.tile.sourceId);
          if (src) this.tileLayer.setSource(src, this.tileLayer.options.apiKey);
          this.tileLayer.options.opacity = snap.tile.opacity;
          this.tileLayer.options.zoomBias = snap.tile.zoomBias;
        }

        for (const w of snap.warnings) this.store.notify('warn', w);
        this.store.notify('info', `已打开工程 ${picked.name}，${snap.document.roads.length} 条道路`);
      } else {
        const parsed = parseOpenDrive(picked.text);
        const geoRef = parsed.document.header.geoReference;
        this.crs = geoRef ? crsFromGeoReference(geoRef, this.crs.origin) : this.crs;
        this.projector = new Projector(this.crs);
        this.store.replaceDocument(parsed.document);

        for (const w of parsed.warnings.slice(0, 30)) this.store.notify('warn', w);
        if (parsed.warnings.length > 30) {
          this.store.notify('warn', `另有 ${parsed.warnings.length - 30} 条解析警告未显示`);
        }
        this.store.notify(
          'info',
          `已导入 ${picked.name}，${parsed.document.roads.length} 条道路、${parsed.document.junctions.length} 个交叉口`,
        );
      }

      this.invalidate();
      this.rebuildPanels();
      this.fitAll();
    } catch (e) {
      this.store.notify('error', `打开失败：${(e as Error).message}`);
      this.rebuildPanels();
    }
  }

  private saveProject(): void {
    const text = serializeProject(
      this.store.document,
      this.store.allAlignments,
      this.crs,
      this.template,
      {
        sourceId: this.tileLayer.options.source.id,
        opacity: this.tileLayer.options.opacity,
        zoomBias: this.tileLayer.options.zoomBias,
      },
    );
    const name = (this.store.document.header.name ?? 'roadnetwork').replace(/[^\w.-]+/g, '_');
    downloadText(`${name}.odrproj.json`, text, 'application/json');
    this.store.notify('info', '工程已保存（含控制点，可续编）');
  }

  private exportXodr(): void {
    const doc = this.store.document;
    if (doc.roads.length === 0) {
      this.store.notify('warn', '路网为空，无内容可导出');
      return;
    }
    // 导出前把当前坐标系写入 geoReference，确保下游能正确定位
    doc.header.geoReference = this.crs.proj;
    const text = serializeOpenDrive(doc);
    const name = (doc.header.name ?? 'roadnetwork').replace(/[^\w.-]+/g, '_');
    downloadText(`${name}.xodr`, text);
    this.store.notify('info', `已导出 ${(text.length / 1024).toFixed(1)} KB，坐标系 ${this.crs.label}`);
  }

  /* ---------- 3D 预览 ---------- */

  private togglePreview3D(): void {
    if (this.preview3d) {
      this.preview3d.dispose();
      this.preview3d = null;
      this.preview3dHost?.remove();
      this.preview3dHost = null;
      this.updatePreviewModeButton();
      this.requestRedraw();
      return;
    }

    // 结束 2D 放置模式，避免高层级面板继续遮住 3D 画布。
    if (this.activeToolId === 'furniture') this.setTool('select');
    const host = el('div', { class: 'preview-3d' });
    this.dom.stage.append(host);
    this.preview3dHost = host;
    try {
      this.preview3d = new Preview3D(host);
      this.preview3d.build(this.store.document, Math.max(0.05, this.renderOptions.tolerance));
    } catch (error) {
      this.preview3d?.dispose();
      this.preview3d = null;
      host.remove();
      this.preview3dHost = null;
      this.updatePreviewModeButton();
      this.requestRedraw();
      this.store.notify('error', `3D 预览开启失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.updatePreviewModeButton();
    this.store.notify(
      'info',
      `3D 预览已开启（${this.preview3d.triangleCount} 三角面）。设施图标标示位置，不代表实时灯态。左键旋转、右键或 Shift 平移、滚轮缩放。`,
    );
  }

  private updatePreviewModeButton(): void {
    const active = this.preview3d !== null;
    this.preview3dButton?.classList.toggle('active', active);
    this.preview3dButton?.setAttribute('aria-pressed', String(active));
    if (this.preview3dButton) this.preview3dButton.title = active ? '当前为 3D 模式，点击返回俯视编辑' : '切换到 3D 预览';
  }

  /* ---------- 帮助 ---------- */

  private showHelp(): void {
    const backdrop = requireEl('modal-backdrop');
    const modal = requireEl('modal');
    clear(modal);

    modal.append(
      el('h2', { text: '使用说明' }),
      el('p', { class: 'note', text: '工作流程' }),
      el('ol', {},
        el('li', {}, '在「工程坐标系」面板输入作业区经纬度，点「以此为原点重建坐标系」，再点「跳转」。'),
        el('li', {}, '在「影像与图层」面板选择卫星影像源；国内影像（高德）会自动做 GCJ-02 纠偏。'),
        el('li', {}, '在「新建道路」面板设定车道数、车道宽、半径与缓和段长。'),
        el('li', {}, '切到「绘制道路」工具（快捷键 D），沿影像上的道路中心线逐点点击，双击或回车结束。'),
        el('li', {}, '切回「选择」工具（V），拖动方形控制点微调线形；在右侧检查器改车道类型、宽度、标线。'),
        el('li', {}, '路口处：各进口道的端点应止于路缘石（不要交汇于一点），再切到「交叉口」工具（J），依次点击各进口道端点，回车自动生成全部转向。'),
        el('li', {}, '看「校验」面板确认无错误，再「导出 xodr」。'),
      ),
      el('p', { class: 'note', text: '交叉口生成规则' }),
      el('p', { class: 'note', text:
        '按实际交规配对车道：右转取最外侧一条、直行由内向外逐条对齐、左转取最内侧一条。' +
        '转向由两臂航向夹角判定（±30° 内为直行）。连接道路用 Hermite 曲线（导出为 paramPoly3），' +
        '两端位姿严格吻合，路口进出处无航向突变。车道数不等时按车道多者为主路自动生成让行关系；' +
        '相同时留空，由你手工指定。' },
      ),
      el('p', { class: 'note', text: '快捷键' }),
      el('div', { class: 'kv' },
        ...[
          ['V', '选择工具'], ['D', '绘制道路'], ['J', '交叉口'], ['C', '切分车道段'], ['M', '量测'],
          ['空格 + 拖动', '平移视图'], ['滚轮', '缩放'],
          ['Ctrl+Z / Ctrl+Y', '撤销 / 重做'], ['Ctrl+S', '保存工程'], ['Ctrl+E', '导出 xodr'],
          ['Delete', '删除选中道路'], ['Insert', '加密控制点'],
          ['Backspace（绘制中）', '退回上一点'], ['右键 / Esc（绘制中）', '取消'],
        ].flatMap(([k, v]) => [el('span', { text: k! }), el('span', { text: v! })]),
      ),
      el('p', { class: 'note', text: '关于坐标与精度' }),
      el('p', { class: 'note', text:
        'OpenDRIVE 的 x/y 是投影平面米制坐标，卫星瓦片是 Web Mercator。后者在纬度 40° 处有约 1.3 倍的尺度膨胀，' +
        '本编辑器把瓦片按角点反投影到工程坐标系后再绘制，因此屏幕上量到的距离即真实距离。' +
        '导出文件的 geoReference 记录了所用投影，下游工具据此可还原到经纬度。' },
      ),
      el('p', { class: 'note', text:
        '回旋线（缓和曲线）采用 Fresnel 积分闭式解，位置精度约 1e-12 m；' +
        '圆角与缓和曲线的切点由解析式给出，几何链首尾严格连续。' },
      ),
      el('div', { class: 'btn-row' },
        button('关闭', () => {
          backdrop.hidden = true;
        }, { primary: true }),
      ),
    );

    backdrop.hidden = false;
    backdrop.onclick = (e) => {
      if (e.target === backdrop) backdrop.hidden = true;
    };
  }
}

function requireEl(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少 DOM 元素 #${id}`);
  return node;
}
