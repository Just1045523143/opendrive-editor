/**
 * 侧栏面板：图层与影像源、工程坐标系、校验结果、消息日志。
 */

import { summarizeIssues, validateDocument, type Issue } from '../core/model/validate.ts';
import { computeBounds } from '../core/model/bounds.ts';
import {
  gaussKruger,
  localTmerc,
  utm,
  utmZoneOf,
  type CoordinateSystem,
  type CrsKind,
  type LonLat,
} from '../geo/projection.ts';
import { TILE_SOURCES } from '../geo/tiles.ts';
import type { RoadTemplate } from '../editor/roadFactory.ts';
import type { SnapSettings } from '../editor/tools/types.ts';
import type { FitOptions } from '../core/geometry/alignment.ts';
import type { RenderOptions } from '../editor/renderer.ts';
import type { Store } from '../editor/store.ts';
import type { TileLayer } from '../editor/tileLayer.ts';
import { button, checkRow, clear, el, kv, numberRow, panel, selectRow, textRow } from './dom.ts';

export interface PanelContext {
  store: Store;
  tileLayer: TileLayer;
  renderOptions: RenderOptions;
  template: RoadTemplate;
  fit: FitOptions;
  snap: SnapSettings;
  crs: CoordinateSystem;
  requestRedraw: () => void;
  invalidate: (roadId?: string) => void;
  rebuildPanels: () => void;
  setCrs: (crs: CoordinateSystem) => void;
  goToLonLat: (ll: LonLat) => void;
  fitAll: () => void;
  selectIssue: (issue: Issue) => void;
}

/* ---------- 影像与图层 ---------- */

export function buildLayerPanel(ctx: PanelContext): HTMLElement {
  const body = el('div');
  const opts = ctx.tileLayer.options;

  body.append(
    selectRow(
      '影像源',
      opts.source.id,
      TILE_SOURCES.map((s) => ({ value: s.id, label: s.label })),
      (id) => {
        const src = TILE_SOURCES.find((s) => s.id === id);
        if (!src) return;
        ctx.tileLayer.setSource(src, opts.apiKey);
        ctx.rebuildPanels();
        ctx.requestRedraw();
      },
    ),
  );

  if (opts.source.id === 'custom') {
    body.append(
      textRow('URL 模板', opts.source.urlTemplate, (v) => {
        opts.source.urlTemplate = v.trim();
        ctx.tileLayer.setSource(opts.source, opts.apiKey);
        ctx.requestRedraw();
      }, '支持占位符 {x} {y} {z} {s} {key}'),
      selectRow(
        '坐标基准',
        opts.source.datum,
        [
          { value: 'wgs84' as const, label: 'WGS84（无偏移）' },
          { value: 'gcj02' as const, label: 'GCJ-02（国内偏移）' },
          { value: 'bd09' as const, label: 'BD-09（百度）' },
        ],
        (v) => {
          opts.source.datum = v;
          ctx.tileLayer.setSource(opts.source, opts.apiKey);
          ctx.requestRedraw();
        },
      ),
    );
  }

  if (opts.source.requiresKey) {
    body.append(
      textRow('密钥', opts.apiKey ?? '', (v) => {
        ctx.tileLayer.setSource(opts.source, v.trim());
        ctx.requestRedraw();
      }),
    );
  }

  body.append(
    numberRow('不透明度', Math.round(opts.opacity * 100), (v) => {
      opts.opacity = Math.max(0, Math.min(1, v / 100));
      ctx.requestRedraw();
    }, { min: 0, max: 100, step: 5 }),
    numberRow('层级偏移', opts.zoomBias, (v) => {
      opts.zoomBias = Math.max(-3, Math.min(3, Math.round(v)));
      ctx.requestRedraw();
    }, { min: -3, max: 3, step: 1, title: '影像偏模糊时 +1 取更高层级；加载慢时 −1' }),
  );

  if (opts.source.terms) {
    body.append(el('p', { class: 'note', text: `使用条款：${opts.source.terms}` }));
  }

  body.append(el('div', { class: 'sep-h' }));

  const r = ctx.renderOptions;
  const toggle = (label: string, key: keyof RenderOptions, title?: string): HTMLElement =>
    checkRow(label, r[key] as boolean, (v) => {
      (r[key] as boolean) = v;
      ctx.requestRedraw();
    }, title);

  body.append(
    el('p', { class: 'note', text: '显示图层' }),
    toggle('卫星影像', 'showTiles'),
    toggle('网格', 'showGrid'),
    toggle('车道面', 'showLaneFill'),
    toggle('车道标线', 'showRoadMarks'),
    toggle('参考线', 'showReferenceLine'),
    toggle('控制点', 'showControlPoints'),
    toggle('道路编号', 'showRoadIds'),
    toggle('车道编号', 'showLaneIds', '需放大到一定比例才显示'),
    toggle('交叉口范围', 'showJunctions', '虚框为该路口全部连接道路的包围盒'),
  );

  body.append(
    numberRow('曲线精度 (m)', r.tolerance, (v) => {
      r.tolerance = Math.max(0.005, Math.min(1, v));
      ctx.invalidate();
      ctx.requestRedraw();
    }, { min: 0.005, max: 1, step: 0.01, title: '采样弦高容差，越小越平滑越慢' }),
  );

  return panel('影像与图层', body);
}

/* ---------- 工程坐标系 ---------- */

export function buildCrsPanel(ctx: PanelContext): HTMLElement {
  const body = el('div');
  const crs = ctx.crs;
  const hasRoads = ctx.store.document.roads.length > 0;

  body.append(
    kv([
      ['坐标系', crs.label],
      ['原点纬度', crs.origin.lat.toFixed(7)],
      ['原点经度', crs.origin.lon.toFixed(7)],
    ]),
  );

  const kindOptions: Array<{ value: CrsKind; label: string }> = [
    { value: 'local-tmerc', label: '局部横轴墨卡托（推荐）' },
    { value: 'utm', label: `UTM ${utmZoneOf(crs.origin.lon)}N` },
    { value: 'gauss-kruger', label: '高斯克吕格 3° 带（CGCS2000）' },
    { value: 'custom', label: '自定义 PROJ 串' },
  ];

  body.append(
    selectRow('投影类型', crs.kind, kindOptions, (kind) => {
      if (hasRoads && !confirm('切换坐标系会重新投影既有路网。基于控制点绘制的道路将精确重拟合，导入的几何按图元起点近似变换。是否继续？')) {
        ctx.rebuildPanels();
        return;
      }
      const next =
        kind === 'utm'
          ? utm(crs.origin)
          : kind === 'gauss-kruger'
            ? gaussKruger(crs.origin, 3)
            : kind === 'custom'
              ? { ...crs, kind: 'custom' as const, label: '自定义坐标系' }
              : localTmerc(crs.origin);
      ctx.setCrs(next);
    }),
  );

  if (crs.kind === 'custom') {
    body.append(
      el('div', { class: 'row wide' },
        el('label', { text: 'PROJ 字符串' }),
      ),
      el('div', { class: 'row wide' },
        el('input', {
          type: 'text',
          value: crs.proj,
          onchange: (e: Event) => {
            const v = (e.target as HTMLInputElement).value.trim();
            if (!v) return;
            ctx.setCrs({ ...crs, proj: v });
          },
        }),
      ),
    );
  } else {
    body.append(el('p', { class: 'note', text: crs.proj }));
  }

  // 定位到经纬度
  let latInput = crs.origin.lat;
  let lonInput = crs.origin.lon;
  body.append(
    el('p', { class: 'note', text: '定位（WGS84）' }),
    numberRow('纬度', latInput, (v) => {
      latInput = v;
    }, { step: 0.0001, min: -85, max: 85 }),
    numberRow('经度', lonInput, (v) => {
      lonInput = v;
    }, { step: 0.0001, min: -180, max: 180 }),
    el('div', { class: 'btn-row' },
      button('跳转', () => ctx.goToLonLat({ lat: latInput, lon: lonInput })),
      button('以此为原点重建坐标系', () => {
        if (hasRoads && !confirm('重建坐标系会重新投影既有路网，是否继续？')) return;
        ctx.setCrs(localTmerc({ lat: latInput, lon: lonInput }));
      }),
      button('全览路网', () => ctx.fitAll()),
    ),
  );

  const bounds = computeBounds(ctx.store.document);
  if (bounds) {
    body.append(
      kv([
        ['范围东西', `${(bounds.east - bounds.west).toFixed(1)} m`],
        ['范围南北', `${(bounds.north - bounds.south).toFixed(1)} m`],
      ]),
    );
  }

  return panel('工程坐标系', body);
}

/* ---------- 新建道路模板 ---------- */

export function buildTemplatePanel(ctx: PanelContext): HTMLElement {
  const body = el('div');
  const t = ctx.template;

  body.append(
    numberRow('左侧车道数', t.leftLanes, (v) => {
      t.leftLanes = Math.max(0, Math.round(v));
      ctx.requestRedraw();
    }, { min: 0, max: 8, step: 1 }),
    numberRow('右侧车道数', t.rightLanes, (v) => {
      t.rightLanes = Math.max(0, Math.round(v));
      ctx.requestRedraw();
    }, { min: 0, max: 8, step: 1 }),
    numberRow('车道宽 (m)', t.laneWidth, (v) => {
      t.laneWidth = Math.max(1, v);
      ctx.requestRedraw();
    }, { min: 1, max: 8, step: 0.25 }),
    checkRow('含人行道', t.sidewalk, (v) => {
      t.sidewalk = v;
      ctx.rebuildPanels();
      ctx.requestRedraw();
    }),
  );

  if (t.sidewalk) {
    body.append(
      numberRow('人行道宽 (m)', t.sidewalkWidth, (v) => {
        t.sidewalkWidth = Math.max(0.5, v);
      }, { min: 0.5, step: 0.25 }),
    );
  }

  body.append(
    numberRow('限速 (km/h)', t.speedLimit, (v) => {
      t.speedLimit = Math.max(0, Math.round(v));
    }, { min: 0, step: 10, title: '0 表示不写入限速' }),
    selectRow('道路类型', t.roadType, [
      { value: 'town', label: 'town 城市道路' },
      { value: 'motorway', label: 'motorway 高速' },
      { value: 'rural', label: 'rural 乡村' },
      { value: 'lowSpeed', label: 'lowSpeed 低速' },
      { value: 'pedestrian', label: 'pedestrian 步行' },
    ], (v) => {
      t.roadType = v;
    }),
  );

  body.append(el('p', { class: 'note', text: '线形参数' }));
  body.append(
    selectRow('拟合方式', ctx.fit.mode, [
      { value: 'spiral' as const, label: '缓和曲线（曲率连续）' },
      { value: 'arc' as const, label: '切线圆弧' },
    ], (v) => {
      ctx.fit.mode = v;
      ctx.rebuildPanels();
    }),
    numberRow('半径 (m)', ctx.fit.radius, (v) => {
      ctx.fit.radius = Math.max(1, v);
      ctx.requestRedraw();
    }, { min: 1, step: 5 }),
  );
  if (ctx.fit.mode === 'spiral') {
    body.append(
      numberRow('缓和段长 (m)', ctx.fit.spiralLength, (v) => {
        ctx.fit.spiralLength = Math.max(0, v);
        ctx.requestRedraw();
      }, { min: 0, step: 5 }),
    );
  }

  body.append(el('p', { class: 'note', text: '吸附' }));
  body.append(
    checkRow('吸附到道路端点', ctx.snap.toRoadEnds, (v) => {
      ctx.snap.toRoadEnds = v;
    }),
    checkRow('吸附到网格', ctx.snap.toGrid, (v) => {
      ctx.snap.toGrid = v;
      ctx.rebuildPanels();
    }),
  );
  if (ctx.snap.toGrid) {
    body.append(
      numberRow('网格间距 (m)', ctx.snap.gridSpacing, (v) => {
        ctx.snap.gridSpacing = Math.max(0.01, v);
      }, { min: 0.01, step: 0.5 }),
    );
  }

  return panel('新建道路', body);
}

/* ---------- 路网列表 ---------- */

export function buildRoadListPanel(ctx: PanelContext): HTMLElement {
  const body = el('div');
  const doc = ctx.store.document;
  const selectedId = ctx.store.selectedRoadId;

  if (doc.roads.length === 0) {
    body.append(el('p', { class: 'note', text: '尚无道路。切换到「绘制道路」工具开始描绘。' }));
    return panel('路网', body);
  }

  const list = el('div', { class: 'list' });
  for (const road of doc.roads) {
    const lanes = road.laneSections[0];
    const count = lanes ? lanes.left.length + lanes.right.length : 0;
    list.append(
      el('div', {
        class: `list-item${road.id === selectedId ? ' selected' : ''}`,
        onclick: () => ctx.store.select({ kind: 'road', roadId: road.id }),
        ondblclick: () => {
          ctx.store.select({ kind: 'road', roadId: road.id });
          ctx.fitAll();
        },
      },
        el('span', { text: `R${road.id}` }),
        el('span', { class: 'spacer' }),
        el('span', { text: `${road.length.toFixed(0)}m` }),
        el('span', { class: 'badge', text: `${count} 道` }),
      ),
    );
  }
  body.append(list);

  if (doc.junctions.length > 0) {
    const jlist = el('div', { class: 'list' });
    for (const j of doc.junctions) {
      jlist.append(
        el('div', {
          class: 'list-item',
          onclick: () => ctx.store.select({ kind: 'junction', junctionId: j.id }),
        },
          el('span', { text: `J${j.id}` }),
          el('span', { class: 'spacer' }),
          el('span', { class: 'badge', text: `${j.connections.length} 连接` }),
        ),
      );
    }
    body.append(el('p', { class: 'note', text: '交叉口' }), jlist);
  }

  return panel(`路网（${doc.roads.length} 条道路）`, body);
}

/* ---------- 校验 ---------- */

export function buildValidationPanel(ctx: PanelContext): HTMLElement {
  const body = el('div');
  const issues = validateDocument(ctx.store.document);
  const { errors, warnings } = summarizeIssues(issues);

  body.append(
    kv([
      ['错误', String(errors)],
      ['警告', String(warnings)],
    ]),
  );

  if (issues.length === 0) {
    body.append(el('p', { class: 'note', text: '未发现问题，可安全导出。' }));
    return panel('校验', body, { collapsed: true });
  }

  const list = el('div', { class: 'list' });
  for (const issue of issues.slice(0, 120)) {
    list.append(
      el('div', {
        class: `issue ${issue.level}`,
        onclick: () => ctx.selectIssue(issue),
      },
        el('div', { text: issue.message }),
        el('div', { class: 'code', text: issue.code }),
      ),
    );
  }
  body.append(list);
  if (issues.length > 120) {
    body.append(el('p', { class: 'note', text: `另有 ${issues.length - 120} 条未列出。` }));
  }

  return panel('校验', body, { collapsed: errors === 0 });
}

/* ---------- 消息 ---------- */

export function buildMessagePanel(ctx: PanelContext): HTMLElement {
  const body = el('div');
  const msgs = ctx.store.messages.slice(-40).reverse();

  if (msgs.length === 0) {
    body.append(el('p', { class: 'note', text: '暂无消息。' }));
  } else {
    const list = el('div', { class: 'list' });
    for (const m of msgs) {
      const time = new Date(m.at).toLocaleTimeString('zh-CN', { hour12: false });
      list.append(el('div', { class: `msg ${m.level}`, text: `${time}  ${m.text}` }));
    }
    body.append(list);
    body.append(
      el('div', { class: 'btn-row' },
        button('清空', () => {
          ctx.store.clearMessages();
          ctx.rebuildPanels();
        }),
      ),
    );
  }

  return panel('消息', body, { collapsed: true });
}

/** 重建整个侧栏 */
export function rebuildSide(container: HTMLElement, ctx: PanelContext, inspector: HTMLElement): void {
  clear(container);
  container.append(
    inspector,
    buildRoadListPanel(ctx),
    buildTemplatePanel(ctx),
    buildLayerPanel(ctx),
    buildCrsPanel(ctx),
    buildValidationPanel(ctx),
    buildMessagePanel(ctx),
  );
}
