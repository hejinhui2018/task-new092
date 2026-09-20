import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ArtPage, FlipMode, KitGroup, StockLot } from './types';
import { createSampleLots, createSamplePages } from './lib/sample';
import { normalizeLots } from './lib/inventory';

/** 当前工作台数据（历史中的一个快照） */
export interface DeskState {
  pages: ArtPage[];
  flip: FlipMode;
  previewOpen: boolean;
  previewIndex: number;
  /** 各印刷批次登记的折手到货记录 */
  lots: StockLot[];
  /** 已锁定的成套批次 */
  lockedGroups: KitGroup[];
  /** 交付目标（本）；0 表示未设定 */
  target: number;
}

/** 持久化信封：present + 过去/未来栈，刷新后可继续撤销重做 */
interface HistoryEnvelope {
  version: 2;
  past: DeskState[];
  present: DeskState;
  future: DeskState[];
}

const STORAGE_KEY = 'saddle-stitch-desk:v2';
const LEGACY_KEY = 'saddle-stitch-desk:v1';
const HISTORY_LIMIT = 100;

export function createInitialState(): DeskState {
  return {
    pages: createSamplePages(),
    flip: 'long',
    previewOpen: false,
    previewIndex: 0,
    lots: createSampleLots(),
    lockedGroups: [],
    target: 600,
  };
}

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

function reviveState(raw: unknown, sheetCount: number): DeskState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const pages = Array.isArray(o.pages)
    ? (o.pages.map(reviveArt).filter(Boolean) as ArtPage[])
    : null;
  if (!pages) return null;
  return {
    pages,
    flip: o.flip === 'short' ? 'short' : 'long',
    previewOpen: Boolean(o.previewOpen),
    previewIndex:
      typeof o.previewIndex === 'number' && o.previewIndex >= 0 ? Math.floor(o.previewIndex) : 0,
    lots: normalizeLots(o.lots, sheetCount),
    lockedGroups: reviveLockedGroups(o.lockedGroups, sheetCount),
    target:
      typeof o.target === 'number' && Number.isFinite(o.target) && o.target >= 0
        ? Math.floor(o.target)
        : 0,
  };
}

function reviveLockedGroups(raw: unknown, sheetCount: number): KitGroup[] {
  if (!Array.isArray(raw) || sheetCount <= 0) return [];
  const groups: KitGroup[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    if (typeof o.id !== 'string' || typeof o.mixKey !== 'string') continue;
    if (!Array.isArray(o.lotIds) || o.lotIds.length !== sheetCount) continue;
    if (!o.lotIds.every((x) => x === null || typeof x === 'string')) continue;
    const qty = typeof o.qty === 'number' && o.qty > 0 ? Math.floor(o.qty) : 0;
    if (qty <= 0) continue;
    groups.push({ id: o.id, mixKey: o.mixKey, lotIds: o.lotIds as (string | null)[], qty });
  }
  return groups;
}

/** v1（无库存）→ v2：沿用页面/翻面设置，库存与锁定置为空，目标 0 */
function migrateV1(raw: string): HistoryEnvelope | null {
  try {
    const v1 = JSON.parse(raw) as Partial<DeskState>;
    const pages = Array.isArray(v1.pages)
      ? (v1.pages.map(reviveArt).filter(Boolean) as ArtPage[])
      : null;
    if (!pages) return null;
    const sheetCount = Math.ceil(pages.length / 4);
    const state: DeskState = {
      pages,
      flip: v1.flip === 'short' ? 'short' : 'long',
      previewOpen: false,
      previewIndex:
        typeof v1.previewIndex === 'number' && v1.previewIndex >= 0
          ? Math.floor(v1.previewIndex)
          : 0,
      lots: normalizeLots([], sheetCount),
      lockedGroups: [],
      target: 0,
    };
    return { version: 2, past: [], present: state, future: [] };
  } catch {
    return null;
  }
}

/** 从 localStorage 恢复信封；数据损坏或首次访问时回退到内置示例 */
export function loadEnvelope(): HistoryEnvelope {
  const fallback = (): HistoryEnvelope => ({
    version: 2,
    past: [],
    present: createInitialState(),
    future: [],
  });
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw) as Partial<HistoryEnvelope>;
      const presentPages = (data.present as DeskState | undefined)?.pages;
      const sheetCount = Array.isArray(presentPages)
        ? Math.ceil(presentPages.length / 4)
        : 0;
      const present = reviveState(data.present, sheetCount);
      if (!present) return fallback();
      // 每个历史快照按自身页数推算折手数，避免撤销到页数更多的旧快照时误丢库存
      const sheetsOf = (raw: unknown): number => {
        const p = (raw as Partial<DeskState> | null)?.pages;
        return Array.isArray(p) ? Math.ceil(p.length / 4) : 0;
      };
      const past = Array.isArray(data.past)
        ? (data.past.map((s) => reviveState(s, sheetsOf(s))).filter(Boolean) as DeskState[])
        : [];
      const future = Array.isArray(data.future)
        ? (data.future.map((s) => reviveState(s, sheetsOf(s))).filter(Boolean) as DeskState[])
        : [];
      return { version: 2, past: past.slice(-HISTORY_LIMIT), present, future: future.slice(0, HISTORY_LIMIT) };
    }
    // 首次升级：迁移旧 v1 数据
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const migrated = migrateV1(legacy);
      if (migrated) return migrated;
    }
    return fallback();
  } catch {
    return fallback();
  }
}

export function saveEnvelope(envelope: HistoryEnvelope): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    // 隐私模式或配额受限时静默失败，不影响当前会话
  }
}

/** 压入一个新快照：present 进 past、清空 future */
export function commit(envelope: HistoryEnvelope, next: DeskState): HistoryEnvelope {
  return {
    version: 2,
    past: [...envelope.past, envelope.present].slice(-HISTORY_LIMIT),
    present: next,
    future: [],
  };
}

export function undo(envelope: HistoryEnvelope): HistoryEnvelope {
  const prev = envelope.past[envelope.past.length - 1];
  if (!prev) return envelope;
  return {
    version: 2,
    past: envelope.past.slice(0, -1),
    present: prev,
    future: [envelope.present, ...envelope.future].slice(0, HISTORY_LIMIT),
  };
}

export function redo(envelope: HistoryEnvelope): HistoryEnvelope {
  const next = envelope.future[0];
  if (!next) return envelope;
  return {
    version: 2,
    past: [...envelope.past, envelope.present].slice(-HISTORY_LIMIT),
    present: next,
    future: envelope.future.slice(1),
  };
}

/**
 * 带撤销/重做与自动持久化的状态 hook。
 * commit 入历史栈；replace 静默替换（用于折叠预演位置等瞬态变化）。
 */
export function useDeskHistory(): {
  state: DeskState;
  canUndo: boolean;
  canRedo: boolean;
  commit: (updater: DeskState | ((s: DeskState) => DeskState)) => void;
  replace: (updater: DeskState | ((s: DeskState) => DeskState)) => void;
  undo: () => void;
  redo: () => void;
} {
  const [envelope, setEnvelope] = useState<HistoryEnvelope>(loadEnvelope);

  useEffect(() => {
    saveEnvelope(envelope);
  }, [envelope]);

  const commitState = useCallback(
    (updater: DeskState | ((s: DeskState) => DeskState)) =>
      setEnvelope((env) => commit(env, resolveUpdater(env, updater))),
    [],
  );
  const replaceState = useCallback(
    (updater: DeskState | ((s: DeskState) => DeskState)) =>
      setEnvelope((env) => ({ ...env, present: resolveUpdater(env, updater) })),
    [],
  );
  const undoState = useCallback(() => setEnvelope((env) => undo(env)), []);
  const redoState = useCallback(() => setEnvelope((env) => redo(env)), []);

  return useMemo(
    () => ({
      state: envelope.present,
      canUndo: envelope.past.length > 0,
      canRedo: envelope.future.length > 0,
      commit: commitState,
      replace: replaceState,
      undo: undoState,
      redo: redoState,
    }),
    [envelope, commitState, replaceState, undoState, redoState],
  );
}

function resolveUpdater(
  env: HistoryEnvelope,
  updater: DeskState | ((s: DeskState) => DeskState),
): DeskState {
  return typeof updater === 'function' ? updater(env.present) : updater;
}
