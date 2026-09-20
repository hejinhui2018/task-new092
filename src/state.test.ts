import { describe, expect, it } from 'vitest';
import {
  applyCommit,
  applyRedo,
  applyUndo,
  createInitialDoc,
  migrateV1,
  reviveInventory,
  type DeskDoc,
  type HistoryState,
} from './state';
import { emptyInventory } from './lib/inventory';

const docA: DeskDoc = {
  pages: [
    { kind: 'art', id: 'p1', title: '封面', printed: 1, bleed: 3, hue: 0 },
  ],
  flip: 'long',
  inventory: emptyInventory(),
};

const docB: DeskDoc = { ...docA, flip: 'short' };

const fresh = (doc: DeskDoc): HistoryState => ({
  present: doc,
  past: [],
  future: [],
  ephemeral: { previewOpen: false, previewIndex: 0 },
});

describe('撤销 / 重做变迁', () => {
  it('commit 入栈并清空 future', () => {
    let h = fresh(docA);
    h = applyCommit(h, docB);
    expect(h.past).toEqual([docA]);
    expect(h.present).toBe(docB);
    expect(h.future).toEqual([]);
    // 先撤销再改 → 旧 future 被丢弃
    h = applyUndo(h);
    expect(h.present).toBe(docA);
    h = applyCommit(h, docB);
    expect(h.future).toEqual([]);
    expect(h.past).toEqual([docA]);
  });

  it('undo / redo 往返', () => {
    let h = applyCommit(fresh(docA), docB);
    h = applyUndo(h);
    expect(h.present).toBe(docA);
    h = applyRedo(h);
    expect(h.present).toBe(docB);
    // 到底后为空操作
    const end = applyRedo(h);
    expect(end).toBe(h);
  });

  it('同一引用 commit 为空操作', () => {
    const h = fresh(docA);
    expect(applyCommit(h, docA)).toBe(h);
  });

  it('历史长度有上限（80）', () => {
    let h = fresh(docA);
    const versions: DeskDoc[] = [];
    for (let i = 0; i < 90; i++) {
      const d: DeskDoc = {
        ...docA,
        inventory: { ...emptyInventory(), deliveryTarget: i },
      };
      versions.push(d);
      h = applyCommit(h, d);
    }
    expect(h.past).toHaveLength(80);
    expect(h.past[h.past.length - 1]).toBe(versions[89 - 1]);
    // 90 次提交后栈底为 docA 之后第 10 个版本（docA 本身也占一位）
    expect(h.past[0]).toBe(versions[9]);
  });
});

describe('v1 → v2 迁移', () => {
  it('旧版 localStorage 记录迁移：保留页面与翻面，库存为空', () => {
    const v1 = JSON.stringify({
      pages: [
        { kind: 'art', id: 'x', title: '旧页', printed: 1, bleed: 3, hue: 10 },
      ],
      flip: 'short',
      previewOpen: true,
      previewIndex: 2,
    });
    const h = migrateV1(v1)!;
    expect(h.present.pages).toHaveLength(1);
    expect(h.present.flip).toBe('short');
    expect(h.present.inventory.stocks).toEqual([]);
    expect(h.ephemeral.previewOpen).toBe(true);
    expect(h.ephemeral.previewIndex).toBe(2);
  });

  it('空串 / 损坏 JSON / 已为 v2 时返回 null', () => {
    expect(migrateV1(null)).toBeNull();
    expect(migrateV1('{not json')).toBeNull();
    expect(migrateV1(JSON.stringify({ version: 2, pages: [] }))).toBeNull();
    expect(migrateV1(JSON.stringify({ pages: 'bad' }))).toBeNull();
  });
});

describe('库存文档复活', () => {
  it('完整文档按字段复活，数量被收敛为非负整数', () => {
    const inv = reviveInventory({
      colorLots: [{ id: 'A', name: '蓝' }],
      batches: [{ id: 'b1', name: '首批', colorLotId: 'A' }],
      stocks: [
        { batchId: 'b1', sheetIndex: 1, frontQty: -5, backQty: 8.9, status: 'hold' },
        { batchId: 'b1', sheetIndex: 2, frontQty: 3, backQty: 3, status: 'weird' },
      ],
      compat: { mode: 'pairs', pairs: [['B', 'A'], ['A', 'B']] },
      locks: [{ id: 'l1', sources: ['b1', 'b1'], qty: 2 }],
      deliveryTarget: 12.6,
    })!;
    expect(inv.stocks[0].frontQty).toBe(0);
    expect(inv.stocks[0].backQty).toBe(8);
    expect(inv.stocks[0].status).toBe('hold');
    expect(inv.stocks[1].status).toBe('ok');
    expect(inv.compat.mode).toBe('pairs');
    expect(inv.compat.pairs).toEqual([['A', 'B']]);
    expect(inv.locks[0].qty).toBe(2);
    expect(inv.deliveryTarget).toBe(12);
  });

  it('stocks 缺失或非对象时返回 null；字段不全时宽容回退', () => {
    expect(reviveInventory(null)).toBeNull();
    expect(reviveInventory('x')).toBeNull();
    expect(reviveInventory({ batches: [] })).toBeNull();
    const inv = reviveInventory({ stocks: [] })!;
    expect(inv.batches).toEqual([]);
    expect(inv.compat.mode).toBe('same');
    expect(inv.deliveryTarget).toBeNull();
  });

  it('无效锁定记录被丢弃，有效记录保留', () => {
    const inv = reviveInventory({
      stocks: [],
      locks: [
        { id: 'bad', sources: ['b1', 123], qty: 2 },
        { id: 'ok', sources: ['b1', 'b2'], qty: 4 },
        'junk',
      ],
    })!;
    expect(inv.locks.map((l) => l.id)).toEqual(['ok']);
  });
});

describe('内置示例', () => {
  it('示例为两色批且第 3 帖暖沙金批短缺，目标 150 本', () => {
    const doc = createInitialDoc();
    expect(doc.inventory.colorLots).toHaveLength(2);
    const sandSheet3 = doc.inventory.stocks.find(
      (s) => s.batchId === 'batch-sand' && s.sheetIndex === 2,
    )!;
    expect(Math.min(sandSheet3.frontQty, sandSheet3.backQty)).toBe(30);
    expect(doc.inventory.deliveryTarget).toBe(150);
  });
});
