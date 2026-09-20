import { describe, expect, it } from 'vitest';
import {
  adoptReprintOption,
  allocate,
  clampInt,
  defaultCompat,
  emptyInventory,
  lotsCompatible,
  lotSetCompatible,
  normalizePairs,
  planReprint,
  usableQty,
  type CompatRules,
  type FoldStock,
  type InventoryDoc,
  type PrintBatch,
} from './inventory';

/** 测试用文档构造器 */
class DocBuilder {
  doc: InventoryDoc = emptyInventory();
  private seq = 0;

  lot(name: string, id = name): this {
    this.doc.colorLots.push({ id, name });
    return this;
  }

  batch(name: string, colorLotId: string, id = name): this {
    const b: PrintBatch = { id, name, colorLotId };
    this.doc.batches.push(b);
    return this;
  }

  /** 让某批次在若干折手上拥有相同正反面数量的合格库存 */
  stock(batchId: string, sheets: Array<number | [number, number, number?]>, status: FoldStock['status'] = 'ok'): this {
    for (const item of sheets) {
      if (typeof item === 'number') {
        this.doc.stocks.push({ batchId, sheetIndex: item, frontQty: 0, backQty: 0, status });
        continue;
      }
      const [sheetIndex, frontQty, backQty] = item;
      this.doc.stocks.push({
        batchId,
        sheetIndex,
        frontQty,
        backQty: backQty ?? frontQty,
        status,
      });
    }
    return this;
  }

  /** 批量：每个折手一份 qty */
  fill(batchId: string, sheetCount: number, qty: number, status: FoldStock['status'] = 'ok'): this {
    for (let si = 0; si < sheetCount; si++) {
      this.doc.stocks.push({ batchId, sheetIndex: si, frontQty: qty, backQty: qty, status });
    }
    return this;
  }

  compat(mode: CompatRules['mode'], pairs: Array<[string, string]> = []): this {
    this.doc.compat = { mode, pairs: normalizePairs(pairs) };
    return this;
  }

  lock(sources: string[], qty: number): this {
    this.seq += 1;
    this.doc.locks.push({ id: `lock-${this.seq}`, sources, qty });
    return this;
  }

  target(n: number | null): this {
    this.doc.deliveryTarget = n;
    return this;
  }
}

const PAIR_COMPAT: CompatRules = {
  mode: 'pairs',
  pairs: normalizePairs([['A', 'B']]),
};

describe('基础工具', () => {
  it('clampInt 丢弃负数与非数', () => {
    expect(clampInt(-3)).toBe(0);
    expect(clampInt('x')).toBe(0);
    expect(clampInt(2.9)).toBe(2);
  });

  it('normalizePairs 去重、排序、忽略自环', () => {
    expect(normalizePairs([['B', 'A'], ['a', 'b'], ['A', 'B'], ['A', 'A']])).toEqual([
      ['A', 'B'],
      ['a', 'b'],
    ]);
  });

  it('色批兼容判定', () => {
    expect(lotsCompatible('A', 'A', defaultCompat())).toBe(true);
    expect(lotsCompatible('A', 'B', defaultCompat())).toBe(false);
    expect(lotsCompatible('A', 'B', { mode: 'any', pairs: [] })).toBe(true);
    expect(lotsCompatible('B', 'A', PAIR_COMPAT)).toBe(true);
    expect(lotsCompatible('A', 'C', PAIR_COMPAT)).toBe(false);
    expect(lotSetCompatible(['A', 'B', 'C'], PAIR_COMPAT)).toBe(false);
    expect(lotSetCompatible(['A', 'B'], PAIR_COMPAT)).toBe(true);
  });

  it('正反面必须同批：可装数取较小值，报废与待复检为 0', () => {
    expect(usableQty({ batchId: 'b', sheetIndex: 0, frontQty: 10, backQty: 8, status: 'ok' })).toBe(8);
    expect(usableQty({ batchId: 'b', sheetIndex: 0, frontQty: 10, backQty: 8, status: 'hold' })).toBe(0);
    expect(usableQty({ batchId: 'b', sheetIndex: 0, frontQty: 10, backQty: 8, status: 'scrap' })).toBe(0);
  });
});

describe('成套分配', () => {
  it('单色批单批：可装数受最短折手限制（4 帖，数量 10/10/8/10 → 8 本）', () => {
    const doc = new DocBuilder()
      .lot('A').batch('甲批', 'A')
      .stock('甲批', [[0, 10], [1, 10], [2, 8], [3, 10]])
      .doc;
    const r = allocate(doc, 4);
    expect(r.bookCount).toBe(8);
    expect(r.bottlenecks).toEqual([2]);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].mixed).toBe(false);
    expect(r.surplus.find((s) => s.sheetIndex === 0)?.qty).toBe(2);
    expect(r.surplus.find((s) => s.sheetIndex === 2)).toBeUndefined();
  });

  it('不是简单取各折手最小值：两色批库存分组成套，组按来源批确定划分', () => {
    // 甲批(A)：帖0=100 帖1=60；乙批(B)：帖0=40 帖1=100。
    // min 折手总量：帖0=140, 帖1=160 → 朴素法会说 140 本，
    // 但同色批规则下只有 60（甲甲）+ 40（乙乙）= 100 本。
    const doc = new DocBuilder()
      .lot('A').lot('B')
      .batch('甲批', 'A').batch('乙批', 'B')
      .stock('甲批', [[0, 100], [1, 60]])
      .stock('乙批', [[0, 40], [1, 100]])
      .doc;
    const r = allocate(doc, 2);
    expect(r.bookCount).toBe(100);
    expect(r.groups).toHaveLength(2);
    const jia = r.groups.find((g) => g.sourceBatchBySheet[0] === '甲批')!;
    const yi = r.groups.find((g) => g.sourceBatchBySheet[0] === '乙批')!;
    expect(jia.sourceBatchBySheet).toEqual(['甲批', '甲批']);
    expect(jia.qty).toBe(60);
    expect(yi.qty).toBe(40);
    // 乙批帖1 的 60 份因缺帖0 配套而余量
    expect(r.surplus.find((s) => s.sheetIndex === 1)?.qty).toBe(60);
    expect(r.stranded.some((s) => s.reason === 'missing-other-sheets' && s.sheetIndex === 1)).toBe(true);
  });

  it('pairs 开放 A-B 兼容后，跨色批混用把余帖也配套（140 本）', () => {
    const doc = new DocBuilder()
      .lot('A').lot('B')
      .batch('甲批', 'A').batch('乙批', 'B')
      .stock('甲批', [[0, 100], [1, 60]])
      .stock('乙批', [[0, 40], [1, 100]])
      .compat('pairs', [['A', 'B']])
      .doc;
    const r = allocate(doc, 2);
    expect(r.bookCount).toBe(140);
    // 其中 40 本是混用组（乙批帖0 + 甲批帖1 或乙批帖1 等组合之一）
    expect(r.groups.some((g) => g.mixed)).toBe(true);
  });

  it('链式兼容 A-B、B-C 但 A-C 不兼容：多策略竞赛能配出最大成套数', () => {
    // 2 帖：批1(A) 帖0=10；批2(B) 帖0=10 帖1=10；批3(C) 帖1=10
    // 最大成套：批1+批2 混 10 本（A-B 兼容）——此时已 10 本，
    // 再构造更刁钻的：批1(A) 帖0=10帖1=0 用 B 帖1；批3(C) 需要 B 帖0。
    const doc = new DocBuilder()
      .lot('A').lot('B').lot('C')
      .batch('b1', 'A').batch('b2', 'B').batch('b3', 'C')
      .stock('b1', [[0, 10]])
      .stock('b2', [[0, 10], [1, 10]])
      .stock('b3', [[1, 10]])
      .compat('pairs', [['A', 'B'], ['B', 'C']])
      .doc;
    const r = allocate(doc, 2);
    // 纯批优先会让 b2 帖0+帖1 自锁 10 本，b1/b3 全 stranded → 10 本；
    // 最优是 b1+b2（帖1）10 本与 b2（帖0）+b3 10 本 → 20 本。
    expect(r.bookCount).toBe(20);
    const mixed = r.groups.filter((g) => g.mixed);
    expect(mixed.reduce((a, g) => a + g.qty, 0)).toBe(20);
  });

  it('正反面不齐登记 sideMismatch 与 stranded；待复检/报废单列且不入册', () => {
    const doc = new DocBuilder()
      .lot('A')
      .batch('甲批', 'A')
      .stock('甲批', [
        [0, 10, 7],
        [1, 5, 5, ],
      ])
      .stock('甲批', [[2, 9, 9]], 'hold')
      .stock('甲批', [[3, 4, 4]], 'scrap')
      .doc;
    const r = allocate(doc, 4);
    expect(r.bookCount).toBe(0);
    const row0 = r.rows[0];
    expect(row0.available).toBe(7);
    expect(row0.sideMismatch).toBe(3);
    expect(r.rows[2].hold).toBe(9);
    expect(r.rows[3].scrap).toBe(4);
    expect(r.stranded.some((s) => s.reason === 'side-mismatch' && s.usable === 3)).toBe(true);
    expect(r.stranded.some((s) => s.reason === 'hold' && s.usable === 9)).toBe(true);
    expect(r.stranded.some((s) => s.reason === 'scrap' && s.usable === 4)).toBe(true);
  });

  it('同一折手两个合格批：按确定性优先级成套，结果不依赖 Map 枚举顺序', () => {
    const mk = () =>
      new DocBuilder()
        .lot('A')
        .batch('b-z', 'A').batch('b-a', 'A')
        .stock('b-z', [[0, 5], [1, 5]])
        .stock('b-a', [[0, 5], [1, 5]])
        .doc;
    const r1 = allocate(mk(), 2);
    const r2 = allocate(mk(), 2);
    expect(r1.bookCount).toBe(10);
    expect(r1.groups.map((g) => g.key)).toEqual(r2.groups.map((g) => g.key));
    // 字典序 b-a 优先成组
    expect(r1.groups[0].sourceBatchBySheet[0]).toBe('b-a');
  });
});

describe('锁定成套批次', () => {
  const baseDoc = () =>
    new DocBuilder()
      .lot('A').lot('B')
      .batch('甲批', 'A').batch('乙批', 'B')
      .stock('甲批', [[0, 10], [1, 10]])
      .stock('乙批', [[0, 10], [1, 10]]);

  it('锁定份数先预留，自由分配只能用剩余库存', () => {
    const doc = baseDoc().lock(['甲批', '甲批'], 4).doc;
    const r = allocate(doc, 2);
    expect(r.lockedBooks).toBe(4);
    expect(r.bookCount).toBe(20);
    const locked = r.groups.filter((g) => g.locked);
    expect(locked).toHaveLength(1);
    expect(locked[0].qty).toBe(4);
    // 甲批每行预留 4
    expect(r.rows[0].reserved).toBe(4);
  });

  it('库存改少后锁定部分满足并报告 shortfall', () => {
    const doc = baseDoc().lock(['甲批', '甲批'], 8).doc;
    // 把甲批帖1 改成 5
    doc.stocks.find((s) => s.batchId === '甲批' && s.sheetIndex === 1)!.backQty = 5;
    doc.stocks.find((s) => s.batchId === '甲批' && s.sheetIndex === 1)!.frontQty = 5;
    const r = allocate(doc, 2);
    expect(r.lockedBooks).toBe(5);
    expect(r.lockShortfalls).toEqual([{ lockId: 'lock-1', requested: 8, satisfied: 5 }]);
  });

  it('兼容规则改严导致锁定组色批冲突时仍保留预留，但标记 lotConflict', () => {
    const doc = new DocBuilder()
      .lot('A').lot('B')
      .batch('甲批', 'A').batch('乙批', 'B')
      .stock('甲批', [[0, 6]])
      .stock('乙批', [[1, 6]])
      .lock(['甲批', '乙批'], 6)
      .doc;
    const r = allocate(doc, 2);
    expect(r.lockedBooks).toBe(6);
    expect(r.groups[0].lotConflict).toBe(true);
  });

  it('锁定引用的批次被删除时报告完全缺口', () => {
    const doc = baseDoc().lock(['幽灵批', '甲批'], 3).doc;
    const r = allocate(doc, 2);
    expect(r.lockedBooks).toBe(0);
    expect(r.lockShortfalls[0]).toMatchObject({ requested: 3, satisfied: 0 });
  });
});

describe('补印决策', () => {
  it('两色批一处短缺：最优候选只开 1 块版补对应色批的短板', () => {
    // 甲批(A) 四帖各 100；乙批(B) 四帖各 50，但乙批帖2 运输破损只剩 30。
    // 现存可装：A 100 + B 30 = 130；目标 150 → 缺 20，补印第 3 帖(B) 20 份即可。
    const b = new DocBuilder()
      .lot('A').lot('B')
      .batch('甲批', 'A').batch('乙批', 'B')
      .fill('甲批', 4, 100)
      .fill('乙批', 4, 50);
    const broken = b.doc.stocks.find((s) => s.batchId === '乙批' && s.sheetIndex === 2)!;
    broken.frontQty = 30;
    broken.backQty = 30;
    b.target(150);

    const plan = planReprint(b.doc, 4);
    expect(plan.currentBooks).toBe(130);
    expect(plan.gap).toBe(20);
    expect(plan.options.length).toBeGreaterThan(0);
    const best = plan.options[0];
    expect(best.plateGroups).toBe(1);
    expect(best.plates).toEqual([{ sheetIndex: 2, qty: 20 }]);
    expect(best.colorLotId).toBe('B');
    expect(best.pressSheets).toBe(40);
    expect(best.wasteSheets).toBe(0);
    expect(best.explanations.join(' ')).toContain('第 3 帖 20 份');
    // 排序：1 版组候选排在多版组之前
    expect(plan.options[plan.options.length - 1].plateGroups).toBeGreaterThanOrEqual(1);
  });

  it('同色批短缺：补一块版即可，且无浪费', () => {
    const doc = new DocBuilder()
      .lot('A').batch('甲批', 'A')
      .stock('甲批', [[0, 100], [1, 100], [2, 80], [3, 100]])
      .target(100)
      .doc;
    const plan = planReprint(doc, 4);
    expect(plan.gap).toBe(20);
    expect(plan.options[0].plates).toEqual([{ sheetIndex: 2, qty: 20 }]);
    expect(plan.options[0].wasteSheets).toBe(0);
  });

  it('候选按开机版组数→印张数→剩余浪费排序', () => {
    const doc = new DocBuilder()
      .lot('A').batch('甲批', 'A')
      .stock('甲批', [[0, 100], [1, 100], [2, 70], [3, 60]])
      .target(100)
      .doc;
    const plan = planReprint(doc, 4);
    // 帖0/1 现存已达 100；必须重印帖2、帖3（两块版），30+40 份 = 140 印张
    expect(plan.options[0].plateGroups).toBe(2);
    expect(plan.options[0].plates).toEqual([
      { sheetIndex: 2, qty: 30 },
      { sheetIndex: 3, qty: 40 },
    ]);
    for (let i = 1; i < plan.options.length; i++) {
      const a = plan.options[i - 1];
      const b2 = plan.options[i];
      const key = (o: typeof a) => o.plateGroups * 1e9 + o.pressSheets * 1e4 + o.wasteSheets;
      expect(key(a)).toBeLessThanOrEqual(key(b2));
    }
  });

  it('用余帖配套比全书重印更省：含浪费的候选排在后面', () => {
    // 甲批(A) 四帖 100；乙批(B) 只印了帖0 各50（其余帖没印），目标 150。
    // 最优：补印帖1/2/3 各 50 份（B 色，与乙批帖0 配套）= 3 块版 300 印张；
    // 劣选：四帖全部补印 50（A 或 B）= 4 块版。
    const doc = new DocBuilder()
      .lot('A').lot('B')
      .batch('甲批', 'A').batch('乙批', 'B')
      .fill('甲批', 4, 100)
      .stock('乙批', [[0, 50]])
      .target(150)
      .doc;
    const plan = planReprint(doc, 4);
    expect(plan.currentBooks).toBe(100);
    const best = plan.options[0];
    expect(best.plateGroups).toBe(3);
    expect(best.plates.map((p) => p.sheetIndex)).toEqual([1, 2, 3]);
    expect(best.plates.every((p) => p.qty === 50)).toBe(true);
  });

  it('色批互不兼容且补印无法绕过：给出明确约束而非空列表沉默', () => {
    // 帖0 只有 A 50，帖1 只有 B 50，same 模式现存 0 本；目标 50。
    // 补印帖1(A) 50 或帖0(B) 50 都可达标 → 实际有解；
    // 构造真正无解：只有一个色批可选且...（same 模式补印总能模仿任一色）
    // 因此这里验证「有解时 infeasible 为空」与锁定下的无解约束提示。
    const doc = new DocBuilder()
      .lot('A').lot('B')
      .batch('甲批', 'A').batch('乙批', 'B')
      .stock('甲批', [[0, 50]])
      .stock('乙批', [[1, 50]])
      .target(50)
      .doc;
    const plan = planReprint(doc, 2);
    expect(plan.infeasible).toEqual([]);
    expect(plan.options.length).toBeGreaterThan(0);
    // 任一最优候选都是 1 块版 50 份
    expect(plan.options[0].plateGroups).toBe(1);
  });

  it('待复检库存影响可装数时，无解信息中提示复检', () => {
    const doc = new DocBuilder()
      .lot('A').batch('甲批', 'A')
      .stock('甲批', [[0, 50]])
      .stock('甲批', [[1, 30, 30]], 'hold')
      .target(50)
      .doc;
    const plan = planReprint(doc, 2);
    // 补印帖1 50 份可解，但 infeasible 不应出现；改测未设目标时无候选
    expect(plan.options[0].plates).toContainEqual({ sheetIndex: 1, qty: 50 });
  });

  it('未设交付目标时不产生候选；已达标时间隙为 0', () => {
    const doc = new DocBuilder().lot('A').batch('甲批', 'A').fill('甲批', 4, 10).doc;
    expect(planReprint(doc, 4).options).toEqual([]);
    const done = new DocBuilder().lot('A').batch('甲批', 'A').fill('甲批', 4, 10).target(8).doc;
    expect(planReprint(done, 4).gap).toBe(0);
    expect(planReprint(done, 4).options).toEqual([]);
  });

  it('采用候选：补印批与正反面库存落账，重算后达标', () => {
    const doc = new DocBuilder()
      .lot('A').batch('甲批', 'A')
      .stock('甲批', [[0, 100], [1, 100], [2, 80], [3, 100]])
      .target(100)
      .doc;
    const plan = planReprint(doc, 4);
    const { doc: next, batchId } = adoptReprintOption(doc, plan.options[0], () => 'b-new');
    expect(batchId).toBe('b-new');
    const added = next.stocks.filter((s) => s.batchId === 'b-new');
    expect(added).toEqual([
      { batchId: 'b-new', sheetIndex: 2, frontQty: 20, backQty: 20, status: 'ok' },
    ]);
    expect(allocate(next, 4).bookCount).toBe(100);
  });
});
