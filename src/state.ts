import { useEffect, useState } from 'react';
import type { ArtPage, FlipMode } from './types';
import { createSampleInventory, createSamplePages } from './lib/sample';
import {
  clampInt,
  defaultCompat,
  emptyInventory,
  normalizePairs,
  type CompatRules,
  type FoldStock,
  type InventoryDoc,
  type KitLock,
  type PrintBatch,
  type ColorLot,
  type QcStatus,
} from './lib/inventory';

/** 进入撤销历史的文档部分 */
export interface DeskDoc {
  pages: ArtPage[];
  flip: FlipMode;
  inventory: InventoryDoc;
}

/** 完整历史快照（导出供测试与持久化使用） */
export interface HistoryState {
  present: DeskDoc;
  past: DeskDoc[];
  future: DeskDoc[];
  ephemeral: Ephemeral;
}

/** 弹窗等临时状态（不进撤销栈，但仍持久化） */
export interface Ephemeral {
  previewOpen: boolean;
  previewIndex: number;
}

export interface DeskState extends DeskDoc, Ephemeral {}

const STORAGE_KEY = 'saddle-stitch-desk:v2';
const LEGACY_KEY = 'saddle-stitch-desk:v1';
const HISTORY_LIMIT = 80;

// ---------------------------------------------------------------------------
// 初始示例
// ---------------------------------------------------------------------------

export function createInitialDoc(): DeskDoc {
  const pages = createSamplePages();
  // 示例 16 页 → 4 帖
  const sheetCount = Math.ceil(pages.length / 4);
  return {
    pages,
    flip: 'long',
    inventory: createSampleInventory(sheetCount),
  };
}

export function createInitialState(): DeskState {
  return { ...createInitialDoc(), previewOpen: false, previewIndex: 0 };
}

// ---------------------------------------------------------------------------
// 校验 / 复活
// ---------------------------------------------------------------------------

function reviveArt(raw: unknown): ArtPage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o.kind !== 'art' || typeof o.id !== 'string' || typeof o.title !== 'string') {
    return null;
  }
  return {
    kind: 'art',
    id: o.id,
    title: o.title,
    printed: typeof o.printed === 'number' ? o.printed : undefined,
    bleed: typeof o.bleed === 'number' && o.bleed >= 0 ? o.bleed : 3,
    inverted: Boolean(o.inverted),
    hue: typeof o.hue === 'number' ? o.hue : 200,
  };
}

function revivePages(raw: unknown): ArtPage[] | null {
  if (!Array.isArray(raw)) return null;
  const pages = raw.map(reviveArt).filter((p): p is ArtPage => p !== null);
  return pages.length === raw.length ? pages : null;
}

const isQc = (v: unknown): v is QcStatus => v === 'ok' || v === 'hold' || v === 'scrap';

function reviveStock(raw: unknown): FoldStock | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.batchId !== 'string' || typeof o.sheetIndex !== 'number') return null;
  return {
    batchId: o.batchId,
    sheetIndex: clampInt(o.sheetIndex),
    frontQty: clampInt(o.frontQty),
    backQty: clampInt(o.backQty),
    status: isQc(o.status) ? o.status : 'ok',
  };
}

function reviveCompat(raw: unknown): CompatRules {
  if (typeof raw !== 'object' || raw === null) return defaultCompat();
  const o = raw as Record<string, unknown>;
  const mode = o.mode === 'any' || o.mode === 'pairs' ? o.mode : 'same';
  const pairs: Array<[string, string]> = [];
  if (Array.isArray(o.pairs)) {
    for (const p of o.pairs) {
      if (Array.isArray(p) && typeof p[0] === 'string' && typeof p[1] === 'string') {
        pairs.push([p[0], p[1]]);
      }
    }
  }
  return { mode, pairs: normalizePairs(pairs) };
}

/** 从原始数据复活库存文档；结构损坏返回 null（调用方回退示例） */
export function reviveInventory(raw: unknown): InventoryDoc | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;

  const colorLots: ColorLot[] = [];
  if (Array.isArray(o.colorLots)) {
    for (const l of o.colorLots) {
      if (typeof l === 'object' && l !== null) {
        const lo = l as Record<string, unknown>;
        if (typeof lo.id === 'string' && typeof lo.name === 'string') {
          colorLots.push({ id: lo.id, name: lo.name });
        }
      }
    }
  }

  const batches: PrintBatch[] = [];
  if (Array.isArray(o.batches)) {
    for (const b of o.batches) {
      if (typeof b === 'object' && b !== null) {
        const bo = b as Record<string, unknown>;
        if (typeof bo.id === 'string' && typeof bo.name === 'string' && typeof bo.colorLotId === 'string') {
          batches.push({ id: bo.id, name: bo.name, colorLotId: bo.colorLotId });
        }
      }
    }
  }

  if (!Array.isArray(o.stocks)) return null;
  const stocks = o.stocks.map(reviveStock).filter((s): s is FoldStock => s !== null);

  const locks: KitLock[] = [];
  if (Array.isArray(o.locks)) {
    for (const lk of o.locks) {
      if (typeof lk !== 'object' || lk === null) continue;
      const lo = lk as Record<string, unknown>;
      if (
        typeof lo.id === 'string' &&
        Array.isArray(lo.sources) &&
        lo.sources.every((s) => typeof s === 'string') &&
        typeof lo.qty === 'number'
      ) {
        locks.push({ id: lo.id, sources: lo.sources as string[], qty: clampInt(lo.qty) });
      }
    }
  }

  return {
    colorLots,
    batches,
    stocks,
    compat: reviveCompat(o.compat),
    locks,
    deliveryTarget:
      typeof o.deliveryTarget === 'number' && o.deliveryTarget >= 0
        ? clampInt(o.deliveryTarget)
        : null,
  };
}

function reviveDoc(raw: unknown): DeskDoc | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const pages = revivePages(o.pages);
  if (!pages) return null;
  const inventory = reviveInventory(o.inventory) ?? emptyInventory();
  return {
    pages,
    flip: o.flip === 'short' ? 'short' : 'long',
    inventory,
  };
}

// ---------------------------------------------------------------------------
// v1 → v2 迁移
// ---------------------------------------------------------------------------

/** 旧版（只有拼版数据）记录迁移为 v2：保留页面/翻面，库存取内置示例 */
export function migrateV1(raw: string | null): HistoryState | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Partial<DeskState> & { version?: unknown };
    // 已带版本标记的不是 v1
    if (data.version === 2) return null;
    const pages = revivePages(data.pages);
    if (!pages) return null;
    const doc: DeskDoc = {
      pages,
      flip: data.flip === 'short' ? 'short' : 'long',
      // 老用户没有任何库存数据：给出空库存而非示例，避免虚构车间库存
      inventory: emptyInventory(),
    };
    return {
      present: doc,
      past: [],
      future: [],
      ephemeral: {
        previewOpen: Boolean(data.previewOpen),
        previewIndex:
          typeof data.previewIndex === 'number' && data.previewIndex >= 0
            ? Math.floor(data.previewIndex)
            : 0,
      },
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 载入 / 保存
// ---------------------------------------------------------------------------

function loadHistory(): HistoryState {
  const fallback: HistoryState = {
    present: createInitialDoc(),
    past: [],
    future: [],
    ephemeral: { previewOpen: false, previewIndex: 0 },
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw) as Record<string, unknown>;
      const present = reviveDoc(data.present);
      if (present) {
        const past = Array.isArray(data.past)
          ? data.past.map(reviveDoc).filter((d): d is DeskDoc => d !== null)
          : [];
        const future = Array.isArray(data.future)
          ? data.future.map(reviveDoc).filter((d): d is DeskDoc => d !== null)
          : [];
        return {
          present,
          past: past.slice(-HISTORY_LIMIT),
          future,
          ephemeral: {
            previewOpen: Boolean(
              (data.ephemeral as Record<string, unknown> | undefined)?.previewOpen,
            ),
            previewIndex: clampInt(
              (data.ephemeral as Record<string, unknown> | undefined)?.previewIndex,
            ),
          },
        };
      }
    }
    // v1 迁移
    const migrated = migrateV1(localStorage.getItem(LEGACY_KEY));
    if (migrated) return migrated;
  } catch {
    // 落到示例
  }
  return fallback;
}

function saveHistory(h: HistoryState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, ...h }));
  } catch {
    // 隐私模式或配额受限时静默失败，不影响当前会话
  }
}

// ---------------------------------------------------------------------------
// 历史变迁（纯函数，便于测试）
// ---------------------------------------------------------------------------

export function applyCommit(prev: HistoryState, next: DeskDoc): HistoryState {
  if (next === prev.present) return prev;
  return {
    present: next,
    past: [...prev.past, prev.present].slice(-HISTORY_LIMIT),
    future: [],
    ephemeral: prev.ephemeral,
  };
}

export function applyUndo(prev: HistoryState): HistoryState {
  if (prev.past.length === 0) return prev;
  const previous = prev.past[prev.past.length - 1];
  return {
    present: previous,
    past: prev.past.slice(0, -1),
    future: [prev.present, ...prev.future].slice(0, HISTORY_LIMIT),
    ephemeral: prev.ephemeral,
  };
}

export function applyRedo(prev: HistoryState): HistoryState {
  if (prev.future.length === 0) return prev;
  const [next, ...rest] = prev.future;
  return {
    present: next,
    past: [...prev.past, prev.present].slice(-HISTORY_LIMIT),
    future: rest,
    ephemeral: prev.ephemeral,
  };
}

// ---------------------------------------------------------------------------
// Hook：文档历史 + 临时状态
// ---------------------------------------------------------------------------

export interface DeskApi {
  state: DeskState;
  canUndo: boolean;
  canRedo: boolean;
  /** 修改文档并记录撤销点 */
  commit: (updater: (doc: DeskDoc) => DeskDoc) => void;
  /** 直接替换文档（记录撤销点） */
  commitDoc: (next: DeskDoc) => void;
  /** 修改临时状态（预演弹窗），不入历史 */
  setEphemeral: (patch: Partial<Ephemeral>) => void;
  undo: () => void;
  redo: () => void;
  reset: () => void;
}

export function useDeskState(): DeskApi {
  const [h, setH] = useState<HistoryState>(loadHistory);

  useEffect(() => {
    saveHistory(h);
  }, [h]);

  const commit: DeskApi['commit'] = (updater) => {
    setH((prev) => applyCommit(prev, updater(prev.present)));
  };

  return {
    state: { ...h.present, ...h.ephemeral },
    canUndo: h.past.length > 0,
    canRedo: h.future.length > 0,
    commit,
    commitDoc: (next) => commit(() => next),
    setEphemeral: (patch) =>
      setH((prev) => ({ ...prev, ephemeral: { ...prev.ephemeral, ...patch } })),
    undo: () => setH(applyUndo),
    redo: () => setH(applyRedo),
    reset: () =>
      setH({
        present: createInitialDoc(),
        past: [],
        future: [],
        ephemeral: { previewOpen: false, previewIndex: 0 },
      }),
  };
}
