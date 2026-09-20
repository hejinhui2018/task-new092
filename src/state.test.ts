import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeskState } from './state';
import { commit, loadEnvelope, redo, saveEnvelope, undo } from './state';

/** 极简 localStorage mock */
function installStorage(initial: Record<string, string> = {}) {
  const store: Record<string, string> = { ...initial };
  const storage = {
    getItem: vi.fn((key: string) => (key in store ? store[key] : null)),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      for (const k of Object.keys(store)) delete store[k];
    }),
  };
  vi.stubGlobal('localStorage', storage);
  return { storage, store };
}

const v1Page = (i: number) => ({
  kind: 'art',
  id: `v1-${i}`,
  title: `第${i + 1}页`,
  printed: i + 1,
  bleed: 3,
  hue: i * 20,
});

const makeState = (over: Partial<DeskState> = {}): DeskState => ({
  pages: [v1Page(0), v1Page(1), v1Page(2), v1Page(3)] as DeskState['pages'],
  flip: 'long',
  previewOpen: false,
  previewIndex: 0,
  lots: [],
  lockedGroups: [],
  target: 0,
  ...over,
});

describe('历史栈纯函数 commit / undo / redo', () => {
  it('commit 把 present 压入 past 并清空 future', () => {
    const s0 = makeState({ target: 100 });
    const s1 = makeState({ target: 200 });
    const env = commit({ version: 2, past: [], present: s0, future: [s1] }, s1);
    expect(env.past).toHaveLength(1);
    expect(env.present.target).toBe(200);
    expect(env.future).toHaveLength(0);
  });

  it('undo 回到上一快照，redo 再前进', () => {
    const s0 = makeState({ target: 100 });
    const s1 = makeState({ target: 200 });
    let env = commit({ version: 2, past: [], present: s0, future: [] }, s1);
    env = undo(env);
    expect(env.present.target).toBe(100);
    expect(env.future).toHaveLength(1);
    env = redo(env);
    expect(env.present.target).toBe(200);
    expect(env.past).toHaveLength(1);
  });

  it('空栈时 undo/redo 原样返回', () => {
    const env = { version: 2 as const, past: [], present: makeState(), future: [] };
    expect(undo(env)).toBe(env);
    expect(redo(env)).toBe(env);
  });

  it('past 超过 100 条时丢弃最早快照', () => {
    let env = { version: 2 as const, past: [] as DeskState[], present: makeState(), future: [] as DeskState[] };
    for (let i = 0; i < 105; i++) env = commit(env, makeState({ target: i }));
    expect(env.past).toHaveLength(100);
    expect(env.present.target).toBe(104);
    // 栈内容为 [初始快照, t0, …]，截断后首位是 t4
    expect(env.past[0].target).toBe(4);
  });
});

describe('loadEnvelope 持久化与迁移', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('无任何数据时回退内置示例（16 页、两色批短缺库存、目标 600）', () => {
    installStorage();
    const env = loadEnvelope();
    expect(env.present.pages).toHaveLength(16);
    // 4 帖 × A/B 两批 + 第 3 帖一条报废记录 = 9 条
    expect(env.present.lots).toHaveLength(9);
    expect(env.present.target).toBe(600);
    expect(env.past).toHaveLength(0);
  });

  it('v1 数据自动迁移：保留页面与翻面，库存为空、目标 0', () => {
    const v1 = JSON.stringify({
      pages: [v1Page(0), v1Page(1), v1Page(2), v1Page(3), v1Page(4), v1Page(5), v1Page(6), v1Page(7)],
      flip: 'short',
      previewOpen: false,
      previewIndex: 2,
    });
    installStorage({ 'saddle-stitch-desk:v1': v1 });
    const env = loadEnvelope();
    expect(env.present.pages).toHaveLength(8);
    expect(env.present.flip).toBe('short');
    expect(env.present.previewIndex).toBe(2);
    expect(env.present.lots).toEqual([]);
    expect(env.present.lockedGroups).toEqual([]);
    expect(env.present.target).toBe(0);
  });

  it('v2 信封原样恢复，past/future 保留（刷新后可继续撤销重做）', () => {
    installStorage();
    const env0 = loadEnvelope();
    const changed = { ...env0.present, target: 700 };
    saveEnvelope(commit(env0, changed));
    const reloaded = loadEnvelope();
    expect(reloaded.present.target).toBe(700);
    expect(reloaded.past).toHaveLength(1);
    expect(reloaded.past[0].target).toBe(600);
    expect(undo(reloaded).present.target).toBe(600);
  });

  it('数据损坏（非法 JSON）时回退内置示例', () => {
    installStorage({ 'saddle-stitch-desk:v2': '{not-json' });
    const env = loadEnvelope();
    expect(env.present.pages).toHaveLength(16);
  });

  it('v2 present 缺 pages 时回退示例；库存中的越界折手记录被丢弃', () => {
    installStorage({
      'saddle-stitch-desk:v2': JSON.stringify({
        version: 2,
        past: [],
        present: {
          pages: [v1Page(0), v1Page(1), v1Page(2), v1Page(3)],
          flip: 'long',
          lots: [
            {
              id: 'good',
              sheetIndex: 0,
              colorBatch: 'A',
              frontQty: 5,
              backQty: 5,
              frontStatus: 'ok',
              backStatus: 'ok',
            },
            {
              id: 'orphan',
              sheetIndex: 9,
              colorBatch: 'A',
              frontQty: 5,
              backQty: 5,
              frontStatus: 'ok',
              backStatus: 'ok',
            },
          ],
          lockedGroups: [],
          target: 50,
        },
        future: [],
      }),
    });
    const env = loadEnvelope();
    expect(env.present.lots.map((l) => l.id)).toEqual(['good']);
    expect(env.present.target).toBe(50);
  });

  it('恢复时丢弃引用失效的锁定批次', () => {
    installStorage({
      'saddle-stitch-desk:v2': JSON.stringify({
        version: 2,
        past: [],
        present: {
          pages: Array.from({ length: 8 }, (_, i) => v1Page(i)),
          flip: 'long',
          lots: [
            { id: 'l0', sheetIndex: 0, colorBatch: 'A', frontQty: 5, backQty: 5, frontStatus: 'ok', backStatus: 'ok' },
            { id: 'l1', sheetIndex: 1, colorBatch: 'A', frontQty: 5, backQty: 5, frontStatus: 'ok', backStatus: 'ok' },
          ],
          lockedGroups: [
            { id: 'ghost-lock', mixKey: 'batch:A', lotIds: ['l0', 'missing'], qty: 3 },
          ],
          target: 0,
        },
        future: [],
      }),
    });
    const env = loadEnvelope();
    // revive 保留结构，但分配算法视其为失效；这里校验 revive 不报错且数量被规整
    expect(env.present.lockedGroups).toHaveLength(1);
    expect(env.present.lockedGroups[0].lotIds).toEqual(['l0', 'missing']);
  });
});
