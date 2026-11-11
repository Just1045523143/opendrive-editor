/**
 * 编辑器状态：文档、选择、历史、线形控制点侧车数据。
 *
 * 撤销重做采用快照式（structuredClone 整份文档）而非命令式。理由：路网文档
 * 在典型规模（数百条道路）下不过数 MB，快照成本可接受；而命令式需为每种
 * 编辑操作写正反向逻辑，出错面大得多。拖拽等高频操作用事务合并成单条历史。
 *
 * 侧车数据（alignments）保存用户点击的控制点。OpenDRIVE 只存拟合后的几何，
 * 不含原始控制点；若不额外记录，二次编辑时就无法还原用户意图。该数据随
 * 工程文件（.odrproj.json）一起保存，导出 .xodr 时不写入。
 */

import type { FitOptions } from '../core/geometry/alignment.ts';
import type { Vec2 } from '../core/math/vec.ts';
import { createEmptyDocument, type OdrDocument } from '../core/model/document.ts';

/** 一条道路的线形控制点记录 */
export interface AlignmentRecord {
  points: Vec2[];
  fit: FitOptions;
}

export type Selection =
  | { kind: 'none' }
  | { kind: 'road'; roadId: string }
  | { kind: 'lane'; roadId: string; sectionIndex: number; laneId: number }
  | { kind: 'geometry'; roadId: string; geometryIndex: number }
  | { kind: 'controlPoint'; roadId: string; pointIndex: number }
  | { kind: 'furniture'; roadId: string; furnitureId: string; sourceType: 'signal' | 'object' }
  | { kind: 'junction'; junctionId: string };

export interface Message {
  level: 'info' | 'warn' | 'error';
  text: string;
  at: number;
}

const MAX_HISTORY = 60;

export class Store {
  private doc: OdrDocument;
  private alignments = new Map<string, AlignmentRecord>();

  private undoStack: Array<{ doc: OdrDocument; alignments: Map<string, AlignmentRecord> }> = [];
  private redoStack: Array<{ doc: OdrDocument; alignments: Map<string, AlignmentRecord> }> = [];
  private txDepth = 0;
  private txDirty = false;

  selection: Selection = { kind: 'none' };
  messages: Message[] = [];

  private changeListeners = new Set<() => void>();
  private selectionListeners = new Set<() => void>();
  private messageListeners = new Set<() => void>();

  constructor(doc?: OdrDocument) {
    this.doc = doc ?? createEmptyDocument();
  }

  get document(): OdrDocument {
    return this.doc;
  }

  /** 替换整份文档（导入 / 新建），清空历史 */
  replaceDocument(doc: OdrDocument, alignments?: Map<string, AlignmentRecord>): void {
    this.doc = doc;
    this.alignments = alignments ?? new Map();
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.selection = { kind: 'none' };
    this.emitChange();
    this.emitSelection();
  }

  /* ---------- 事务与历史 ---------- */

  /**
   * 开启事务。事务内的多次 mutate 只产生一条历史记录。
   * 用于拖拽这类连续操作。
   */
  begin(): void {
    if (this.txDepth === 0) {
      this.snapshot();
      this.txDirty = false;
    }
    this.txDepth++;
  }

  commit(): void {
    if (this.txDepth === 0) return;
    this.txDepth--;
    if (this.txDepth === 0 && !this.txDirty) {
      // 事务内无实际改动，撤掉刚压入的快照
      this.undoStack.pop();
    }
  }

  /** 在事务外调用会自行开一条历史；在事务内则合并 */
  mutate(fn: () => void): void {
    if (this.txDepth === 0) {
      this.snapshot();
      fn();
      this.txDirty = true;
      this.emitChange();
      return;
    }
    fn();
    this.txDirty = true;
    this.emitChange();
  }

  private snapshot(): void {
    this.undoStack.push({
      doc: structuredClone(this.doc),
      alignments: new Map(
        [...this.alignments].map(([k, v]) => [k, structuredClone(v)] as const),
      ),
    });
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push({
      doc: structuredClone(this.doc),
      alignments: new Map([...this.alignments].map(([k, v]) => [k, structuredClone(v)] as const)),
    });
    this.doc = prev.doc;
    this.alignments = prev.alignments;
    this.validateSelection();
    this.emitChange();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push({
      doc: structuredClone(this.doc),
      alignments: new Map([...this.alignments].map(([k, v]) => [k, structuredClone(v)] as const)),
    });
    this.doc = next.doc;
    this.alignments = next.alignments;
    this.validateSelection();
    this.emitChange();
  }

  /** 撤销后选中对象可能已不存在，需清理 */
  private validateSelection(): void {
    const sel = this.selection;
    if (sel.kind === 'none') return;
    if (sel.kind === 'junction') {
      if (!this.doc.junctions.some((j) => j.id === sel.junctionId)) this.select({ kind: 'none' });
      return;
    }
    const road = this.doc.roads.find((r) => r.id === sel.roadId);
    if (!road) {
      this.select({ kind: 'none' });
      return;
    }
    if (sel.kind === 'geometry' && sel.geometryIndex >= road.planView.length) {
      this.select({ kind: 'road', roadId: sel.roadId });
    }
    if (sel.kind === 'furniture' && !(sel.sourceType === 'signal' ? road.signals : road.objects).some(o => o.id === sel.furnitureId)) {
      this.select({ kind: 'road', roadId: sel.roadId });
    }
    if (sel.kind === 'controlPoint') {
      const rec = this.alignments.get(sel.roadId);
      if (!rec || sel.pointIndex >= rec.points.length) {
        this.select({ kind: 'road', roadId: sel.roadId });
      }
    }
  }

  /* ---------- 选择 ---------- */

  select(sel: Selection): void {
    const same = JSON.stringify(sel) === JSON.stringify(this.selection);
    if (same) return;
    this.selection = sel;
    this.emitSelection();
  }

  get selectedRoadId(): string | null {
    const s = this.selection;
    return s.kind === 'road' || s.kind === 'lane' || s.kind === 'geometry' || s.kind === 'controlPoint' || s.kind === 'furniture'
      ? s.roadId
      : null;
  }

  /* ---------- 线形侧车数据 ---------- */

  getAlignment(roadId: string): AlignmentRecord | undefined {
    return this.alignments.get(roadId);
  }

  setAlignment(roadId: string, record: AlignmentRecord): void {
    this.alignments.set(roadId, record);
  }

  deleteAlignment(roadId: string): void {
    this.alignments.delete(roadId);
  }

  get allAlignments(): ReadonlyMap<string, AlignmentRecord> {
    return this.alignments;
  }

  /* ---------- 消息 ---------- */

  notify(level: Message['level'], text: string): void {
    this.messages.push({ level, text, at: Date.now() });
    if (this.messages.length > 200) this.messages.shift();
    this.messageListeners.forEach((l) => l());
  }

  clearMessages(): void {
    this.messages.length = 0;
    this.messageListeners.forEach((l) => l());
  }

  /* ---------- 订阅 ---------- */

  onChange(l: () => void): () => void {
    this.changeListeners.add(l);
    return () => this.changeListeners.delete(l);
  }

  onSelectionChange(l: () => void): () => void {
    this.selectionListeners.add(l);
    return () => this.selectionListeners.delete(l);
  }

  onMessage(l: () => void): () => void {
    this.messageListeners.add(l);
    return () => this.messageListeners.delete(l);
  }

  private emitChange(): void {
    this.changeListeners.forEach((l) => l());
  }

  private emitSelection(): void {
    this.selectionListeners.forEach((l) => l());
  }
}
