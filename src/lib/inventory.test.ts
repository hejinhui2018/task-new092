import { describe, expect, it } from 'vitest';
import type { KitGroup, StockLot } from '../types';
import {
  adoptReprint,
  allocateKits,
  lockKitGroup,
  lotBlockReason,
  lotCapacity,
  lotFree,
  lockedUsageMap,
  mixLabel,
  normalizeLots,
  planReprints,
  reconcileInventory,
  stockSummary,
  unlockKitGroup,
} from './inventory';
import { createSampleLots } from './sample';

/** 构造一条合格到货记录 */
const lot = (
  id: string,
  sheetIndex: number,
  colorBatch: string,
  qty: number,
  extra: Partial<StockLot> = {},
): StockLot[] => [
  {
    id,
    sheetIndex,
    colorBatch,
    frontQty: qty,
    backQty: qty,
    frontStatus: 'ok',
    backStatus: 'ok',
    ...extra,
  },
];;

/** n 帖每帖一色批足量的快捷构造 */
const uniform = (n: number, batch: string, qty: number, prefix = batch): StockLot[] =>
  Array.from({ length: n }, (_, s) => lot(`${prefix}-s${s}`, s, batch, qty)[0]);

let idSeq = 0;
const genId = (p = 'id') => `${p}-${++idSeq}`;

describe('normalizeLots / 单批能力', () => {
  it('按 折手→色批→id 确定性排序', () => {
    const raw = [
      lot('z', 1, 'B', 10)[0],
      lot('a', 0, 'A', 10)[0],
      lot('m', 0, 'A', 10)[0],
    ];
    expect(normalizeLots(raw, 2).map((l) => l.id)).toEqual(['a', 'm', 'z']);
  });

  it('剔除超出折手范围的孤儿记录，负数与非数收敛为 0', () => {
    const raw = [
      { ...lot('ok', 1, 'A', 10)[0] },
      { ...lot('orphan', 5, 'A', 10)[0] },
      { ...lot('bad', 0, 'A', -5)[0], frontQty: Number.NaN },
    ];
    const out = normalizeLots(raw, 2);
    expect(out.map((l) => l.id)).toEqual(['bad', 'ok']);
    expect(out[0].frontQty).toBe(0);
  });

  it('正反面数量取最小值作为同批成套能力', () => {
    const l = lot('l', 0, 'A', 100, { backQty: 80 })[0];
    expect(lotCapacity(l)).toBe(80);
    expect(lotFree(l)).toBe(80);
  });

  it('任一面待复检或报废，能力为 0 且不参与成套', () => {
    const hold = lot('h', 0, 'A', 10, { backStatus: 'hold' })[0];
    const scrap = lot('x', 0, 'A', 10, { frontStatus: 'scrap' })[0];
    expect(lotCapacity(normalizeLots([hold], 1)[0])).toBe(0);
    expect(lotCapacity(scrap)).toBe(0);
    expect(lotBlockReason(hold)).toContain('待复检');
    expect(lotBlockReason(scrap)).toContain('报废');
  });

  it('正反面数量不一致时给出原因并仅按最小值配套', () => {
    const l = lot('l', 0, 'A', 100, { backQty: 90 })[0];
    expect(lotBlockReason(l)).toContain('90');
  });

  it('锁定占用从 lockedGroups 推导，超出能力的陈旧锁定按能力截断', () => {
    const lots = lot('l', 0, 'A', 5);
    const groups: KitGroup[] = [{ id: 'g', mixKey: 'batch:A', lotIds: ['l'], qty: 99 }];
    const usage = lockedUsageMap(lots, groups);
    expect(usage.get('l')).toBe(5);
    expect(lotFree(lots[0], usage.get('l'))).toBe(0);
  });
});

describe('allocateKits - 成套分配', () => {
  it('单色批：可装订数为各折手能力最小值，而非简单求和', () => {
    const lots4 = [
      ...uniform(3, 'A', 100, 'a'),
      lot('weak', 3, 'A', 70)[0],
    ];
    const a = allocateKits(4, lots4, []);
    expect(a.bookCount).toBe(70);
    expect(a.groups).toHaveLength(1);
    expect(a.groups[0].qty).toBe(70);
    expect(a.groups[0].mixKey).toBe('batch:A');
  });

  it('两色批：先各批单色配套，缺额再走全色批混用兜底（示例 470/500 + 120 → 590）', () => {
    const a = allocateKits(4, createSampleLots(), []);
    expect(a.bookCount).toBe(590);
    const byKey = new Map<string, number>();
    for (const g of a.groups) byKey.set(g.mixKey, (byKey.get(g.mixKey) ?? 0) + g.qty);
    expect(byKey.get('batch:A')).toBe(470);
    expect(byKey.get('batch:B')).toBe(120);
  });

  it('色批不兼容时不能跨批凑套：无混用规则应为 0，启用混用兜底后才成套', () => {
    // 第 1 帖只有 A 100、第 2 帖只有 B 100：每帖合计最小值是 100，
    // 但单色批各自都凑不齐；只有混用规则允许 (A,B) 组合
    const lots = [...lot('a0', 0, 'A', 100), ...lot('b1', 1, 'B', 100)];
    const a = allocateKits(2, lots, []);
    expect(a.bookCount).toBe(100);
    expect(a.water[0].mixKey).toBe('mix:A+B');
    expect(a.water[0].lotIds).toEqual(['a0', 'b1']);
  });

  it('混用只吃单色配套后的散张：A 帖1=100 帖2=50，B 帖2=50 → A 单色 50 + 混用 50', () => {
    const lots = [
      ...lot('a0', 0, 'A', 100),
      ...lot('a1', 1, 'A', 50),
      ...lot('b1', 1, 'B', 50),
    ];
    const a = allocateKits(2, lots, []);
    expect(a.bookCount).toBe(100);
    const byKey = new Map<string, number>();
    for (const g of a.groups) byKey.set(g.mixKey, (byKey.get(g.mixKey) ?? 0) + g.qty);
    expect(byKey.get('batch:A')).toBe(50);
    expect(byKey.get('mix:A+B')).toBe(50);
  });

  it('待复检/报废印张不参与成套', () => {
    const lots = [
      ...lot('a0', 0, 'A', 100),
      ...lot('a1', 1, 'A', 100, { frontStatus: 'hold' }),
    ];
    expect(allocateKits(2, lots, []).bookCount).toBe(0);
  });

  it('结果对相同输入确定（反复计算一致）', () => {
    const r1 = allocateKits(4, createSampleLots(), []);
    const r2 = allocateKits(4, createSampleLots(), []);
    expect(JSON.stringify(r1.groups)).toBe(JSON.stringify(r2.groups));
  });

  it('已锁定批次优先保留并计入锁定数', () => {
    const lots = uniform(2, 'A', 100, 'a');
    const lock: KitGroup = {
      id: 'lock-1',
      mixKey: 'batch:A',
      lotIds: ['a-s0', 'a-s1'],
      qty: 30,
    };
    const a = allocateKits(2, lots, [lock]);
    expect(a.lockedBooks).toBe(30);
    expect(a.locked[0].id).toBe('lock-1');
    expect(a.bookCount).toBe(100);
  });

  it('失效锁定自动放弃：引用已删除批次、数量超限、折手指错都不承认', () => {
    const lots = uniform(2, 'A', 10, 'a');
    const bad1: KitGroup = { id: 'g1', mixKey: 'batch:A', lotIds: ['ghost', 'a-s1'], qty: 1 };
    const bad2: KitGroup = { id: 'g2', mixKey: 'batch:A', lotIds: ['a-s0', 'a-s1'], qty: 99 };
    const bad3: KitGroup = { id: 'g3', mixKey: 'batch:A', lotIds: ['a-s1', 'a-s0'], qty: 1 };
    const a = allocateKits(2, lots, [bad1, bad2, bad3]);
    expect(a.locked).toHaveLength(0);
    expect(a.bookCount).toBe(10);
  });
});

describe('stockSummary - 总览', () => {
  it('指出短板、未配套余量与浪费', () => {
    const lots = [
      ...uniform(3, 'A', 100, 'a'),
      ...lot('weak', 3, 'A', 60),
    ];
    const a = allocateKits(4, lots, []);
    const s = stockSummary(4, lots, a);
    expect(s.bindable).toBe(60);
    expect(s.bottlenecks.map((x) => x.sheetIndex)).toEqual([3]);
    expect(s.surplus.map((x) => x.sheetIndex)).toEqual([0, 1, 2]);
    expect(s.waste).toBe(120);
  });

  it('断供折手被明确标出且可装订 0', () => {
    const lots = [...lot('a0', 0, 'A', 10), ...lot('a2', 2, 'A', 10)];
    const a = allocateKits(3, lots, []);
    const s = stockSummary(3, lots, a);
    expect(s.bindable).toBe(0);
    expect(s.missingSheets.map((x) => x.sheetIndex)).toEqual([1]);
  });
});

describe('planReprints - 补印决策（内置两色批短缺示例）', () => {
  const lots = createSampleLots();

  it('现存可装订 590 本，目标 ≤590 时不给补印候选', () => {
    const plan = planReprints(4, lots, [], 590);
    expect(plan.base).toBe(590);
    expect(plan.candidates).toHaveLength(0);
    expect(plan.infeasible).toBeUndefined();
  });

  it('目标 600：候选按 版组数→印张数→浪费 排序，A 批补第 3 帖 10 张为最优', () => {
    const plan = planReprints(4, lots, [], 600);
    expect(plan.infeasible).toBeUndefined();
    expect(plan.candidates.length).toBeGreaterThanOrEqual(2);
    const best = plan.candidates[0];
    expect(best.plateGroups).toBe(1);
    expect(best.sheets).toBe(10);
    expect(best.lines).toEqual([{ sheetIndex: 2, colorBatch: 'A', qty: 10 }]);
    // 采用后实测：A 480 + B 120 = 600，三帖各余 20 张 = 60 张浪费
    expect(best.totalBooks).toBe(600);
    expect(best.waste).toBe(60);
  });

  it('A 批单色候选：B 批 120 本照旧，A 批只需在第 3 帖补 10 张', () => {
    const plan = planReprints(4, lots, [], 600);
    const aOnly = plan.candidates.find((c) => c.id === 'cand:single:A');
    expect(aOnly).toBeDefined();
    expect(aOnly!.lines).toEqual([{ sheetIndex: 2, colorBatch: 'A', qty: 10 }]);
    expect(aOnly!.plateGroups).toBe(1);
    expect(aOnly!.totalBooks).toBe(600);
  });

  it('B 批单色候选需要 4 组版（B 批每帖现存 120 均不足 130），排序在最后', () => {
    const plan = planReprints(4, lots, [], 600);
    const bOnly = plan.candidates.find((c) => c.id === 'cand:single:B');
    expect(bOnly).toBeDefined();
    expect(bOnly!.plateGroups).toBe(4);
    // B 批承担 130 本（A 批 470 本照旧），每帖补 10 张，共 40 张
    expect(bOnly!.sheets).toBe(40);
    expect(bOnly!.lines.every((l) => l.qty === 10)).toBe(true);
    expect(plan.candidates.indexOf(bOnly!)).toBe(plan.candidates.length - 1);
  });

  it('说明逐帖解释补齐的书册区间（第 591–600 本）', () => {
    const plan = planReprints(4, lots, [], 600);
    const text = plan.candidates[0].explanation.join('\n');
    expect(text).toContain('第 591–600 本');
    expect(text).toContain('第 3 帖');
  });

  it('无解情形：目标低于已锁定数时明确指出约束', () => {
    const lock: KitGroup = {
      id: 'L',
      mixKey: 'batch:A',
      lotIds: lots.filter((l) => l.colorBatch === 'A' && l.frontStatus === 'ok').sort(
        (a, b) => a.sheetIndex - b.sheetIndex,
      ).map((l) => l.id),
      qty: 400,
    };
    // 第 3 帖 A 只有 470，锁 400 可行
    const plan = planReprints(4, lots, [lock], 100);
    expect(plan.infeasible).toContain('已锁定成套 400');
  });

  it('目标非正数 / 无折手时给出无解说明', () => {
    expect(planReprints(4, lots, [], 0).infeasible).toContain('交付目标');
    expect(planReprints(0, [], [], 10).infeasible).toContain('折手');
  });
});

describe('锁定 / 解锁 / 采用补印 / 规整', () => {
  it('锁定水填批次后占用库存，解锁后释放', () => {
    const lots = uniform(2, 'A', 10, 'a');
    const a0 = allocateKits(2, lots, []);
    const locked = lockKitGroup(a0.water[0], () => genId('kit'));
    const groups = [locked];

    const usage = lockedUsageMap(lots, groups);
    expect(usage.get('a-s0')).toBe(10);
    expect(usage.get('a-s1')).toBe(10);

    const a1 = allocateKits(2, lots, groups);
    expect(a1.lockedBooks).toBe(10);
    expect(a1.bookCount).toBe(10);
    // 全部锁定后没有可再水填的自由余量
    expect(a1.water).toHaveLength(0);

    const rest = unlockKitGroup(groups, locked.id);
    expect(rest).toHaveLength(0);
    expect(allocateKits(2, lots, rest).bookCount).toBe(10);
  });

  it('采用补印候选：合成批次不入库存，换发正式批次且数量正确', () => {
    const plan = planReprints(4, createSampleLots(), [], 600);
    const best = plan.candidates[0];
    const { lots: next, added } = adoptReprint(best, createSampleLots(), () => genId('lot'));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ sheetIndex: 2, colorBatch: 'A', qty: 10 });
    expect(next.some((l) => l.id.startsWith('rp:'))).toBe(false);
    const final = allocateKits(4, next, []);
    expect(final.bookCount).toBe(600);
  });

  it('页面减少后规整：剔除孤儿库存并丢弃失效锁定', () => {
    const lots = [...uniform(3, 'A', 10, 'a'), lot('orphan', 3, 'A', 10)[0]];
    const locks: KitGroup[] = [
      { id: 'g1', mixKey: 'batch:A', lotIds: ['a-s0', 'a-s1', 'a-s2', 'orphan'], qty: 5 },
    ];
    const r = reconcileInventory(3, lots, locks);
    expect(r.lots.map((l) => l.sheetIndex).sort()).toEqual([0, 1, 2]);
    expect(r.lockedGroups).toHaveLength(0);
  });

  it('mixLabel 转中文', () => {
    expect(mixLabel('batch:A')).toBe('A 批单色');
    expect(mixLabel('mix:A+B')).toBe('色批混用 A+B');
  });
});
