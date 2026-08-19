/**
 * 工程文件（.odrproj.json）读写。
 *
 * 为什么需要它：.xodr 只保存拟合后的几何，不含用户点击的控制点与线形参数。
 * 只导出 xodr 的话，下次打开就只能拖动图元端点，无法再按"改半径/改缓和段长
 * 后整体重拟合"的方式作业。工程文件把这些作业上下文一并保存。
 */

import type { FitOptions } from '../core/geometry/alignment.ts';
import { DEFAULT_FIT } from '../core/geometry/alignment.ts';
import type { OdrDocument } from '../core/model/document.ts';
import { parseOpenDrive } from '../core/xml/parse.ts';
import { serializeOpenDrive } from '../core/xml/serialize.ts';
import { crsFromGeoReference, localTmerc, type CoordinateSystem } from '../geo/projection.ts';
import type { AlignmentRecord } from './store.ts';
import type { RoadTemplate } from './roadFactory.ts';
import { DEFAULT_TEMPLATE } from './roadFactory.ts';

const FORMAT_VERSION = 1;

interface SerializedAlignment {
  points: Array<{ x: number; y: number }>;
  fit: FitOptions;
}

interface ProjectFile {
  format: 'opendrive-editor-project';
  version: number;
  savedAt: string;
  crs: CoordinateSystem;
  template: RoadTemplate;
  tile?: {
    sourceId: string;
    opacity: number;
    zoomBias: number;
    /** 密钥不写入文件，避免随工程外传 */
  };
  alignments: Record<string, SerializedAlignment>;
  /** 完整的 xodr 内容 */
  xodr: string;
}

export interface ProjectSnapshot {
  document: OdrDocument;
  alignments: Map<string, AlignmentRecord>;
  crs: CoordinateSystem;
  template: RoadTemplate;
  tile?: { sourceId: string; opacity: number; zoomBias: number };
  warnings: string[];
}

export function serializeProject(
  doc: OdrDocument,
  alignments: ReadonlyMap<string, AlignmentRecord>,
  crs: CoordinateSystem,
  template: RoadTemplate,
  tile?: { sourceId: string; opacity: number; zoomBias: number },
): string {
  const record: Record<string, SerializedAlignment> = {};
  for (const [roadId, rec] of alignments) {
    record[roadId] = {
      points: rec.points.map((p) => ({ x: p.x, y: p.y })),
      fit: { ...rec.fit },
    };
  }

  const file: ProjectFile = {
    format: 'opendrive-editor-project',
    version: FORMAT_VERSION,
    savedAt: new Date().toISOString(),
    crs,
    template,
    ...(tile ? { tile } : {}),
    alignments: record,
    xodr: serializeOpenDrive(doc),
  };

  return JSON.stringify(file, null, 2);
}

export function parseProject(text: string): ProjectSnapshot {
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`工程文件不是有效 JSON：${(e as Error).message}`);
  }

  if (typeof raw !== 'object' || raw === null) {
    throw new Error('工程文件内容为空');
  }
  const file = raw as Partial<ProjectFile>;

  if (file.format !== 'opendrive-editor-project') {
    throw new Error('不是本编辑器的工程文件');
  }
  if (typeof file.version === 'number' && file.version > FORMAT_VERSION) {
    warnings.push(`工程文件版本 ${file.version} 高于当前支持的 ${FORMAT_VERSION}，可能有字段无法识别`);
  }
  if (typeof file.xodr !== 'string' || file.xodr.length === 0) {
    throw new Error('工程文件缺少路网数据');
  }

  const parsed = parseOpenDrive(file.xodr);
  warnings.push(...parsed.warnings);

  // 坐标系：优先用工程文件里的，缺失时从 geoReference 反推
  let crs: CoordinateSystem;
  if (file.crs && typeof file.crs.proj === 'string') {
    crs = file.crs;
  } else if (parsed.document.header.geoReference) {
    crs = crsFromGeoReference(parsed.document.header.geoReference);
    warnings.push('工程文件缺少坐标系定义，已从 geoReference 反推');
  } else {
    crs = localTmerc({ lon: 0, lat: 0 });
    warnings.push('工程文件与路网均未声明坐标系，已回退到经纬度原点的局部投影');
  }

  const alignments = new Map<string, AlignmentRecord>();
  if (file.alignments && typeof file.alignments === 'object') {
    for (const [roadId, rec] of Object.entries(file.alignments)) {
      if (!rec || !Array.isArray(rec.points)) continue;
      const points = rec.points
        .filter((p) => typeof p?.x === 'number' && typeof p?.y === 'number')
        .map((p) => ({ x: p.x, y: p.y }));
      if (points.length < 2) continue;
      alignments.set(roadId, {
        points,
        fit: { ...DEFAULT_FIT, ...(rec.fit ?? {}) },
      });
    }
  }

  return {
    document: parsed.document,
    alignments,
    crs,
    template: { ...DEFAULT_TEMPLATE, ...(file.template ?? {}) },
    ...(file.tile ? { tile: file.tile } : {}),
    warnings,
  };
}

/** 由文件名推断类型 */
export function isProjectFile(name: string): boolean {
  return /\.odrproj(\.json)?$/i.test(name) || /\.json$/i.test(name);
}
