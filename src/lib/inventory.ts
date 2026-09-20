/**
 * 折手库存与补印决策（纯函数核心）。
 *
 * 领域约定：
 * - 一本成品（骑马钉画册）需要拼版方案中的「每一折手」各一份；
 * - 每个印刷批次登记某折手的正反面合格数量、色批与质检状态；
 * - 正反面必须同批：一帖可装数 = min(正面合格, 背面合格)，报废批为 0，
 *   待复检批不参与自动成套；
 * - 不同色批能否混用由 compat 规则决定（默认仅同色批；可配置两两兼容）；
 * - 锁定的成套批次按锁定份数预留印张，优先于自动分配。
 */

/** 质检状态：ok 合格 / hold 待复检（暂不入册）/ scrap 报废（不可用） */
export type QcStatus = 'ok' | 'hold' | 'scrap';

/** 一条库存记录：某印刷批次下、某折手的正反面合格数量与状态 */
export interface FoldStock {
  /** 所属印刷批次 id */
  batchId: string;
  /** 折手序号（0 = 最外帖，对应 imposition Sheet.index） */
  sheetIndex: number;
  /** 正面（外开面）合格数量 */
  frontQty: number;
  /** 背面（内开面）合格数量 */
  backQty: number;
  /** 质检状态 */
  status: QcStatus;
}

/** 印刷批次：同一次上机产出，拥有统一色批 */
export interface PrintBatch {
  id: string;
  name: string;
  /** 色批 id */
  colorLotId: string;
}

/** 色批（墨色批次，不同色批可能存在色差） */
export interface ColorLot {
  id: string;
  name: string;
}

/**
 * 色批兼容规则：
 * - 'same'  只允许同色批混用（默认）；
 * - 'any'   任意色批可混用；
 * - 'pairs' 仅列出的色批对彼此兼容。
 */
export interface CompatRules {
  mode: 'same' | 'any' | 'pairs';
  /** mode='pairs' 时生效：无向色批 id 对，内部按字典序存储 */
  pairs: Array<[string, string]>;
}

/** 一个已锁定的成套批次：每个折手由哪个来源批贡献、锁定多少本 */
export interface KitLock {
  id: string;
  /** sources[折手序号] = 来源库存批次 id */
  sources: string[];
  qty: number;
}

/** 一整套库存文档（不含书页拼版数据） */
export interface InventoryDoc {
  colorLots: ColorLot[];
  batches: PrintBatch[];
  stocks: FoldStock[];
  compat: CompatRules;
  locks: KitLock[];
  /** 交付目标（本数）；null 表示未设定，仅看可装数量 */
  deliveryTarget: number | null;
}

/** 分配到一个成套批次中的单行：某库存批为某折手贡献的份数 */
export interface KitLine {
  batchId: string;
  sheetIndex: number;
  qty: number;
}

/** 一个成套批次：同一「折手→来源批」投影的确定性分组 */
export interface KitGroup {
  /** 稳定标识：折手来源批 id 的有序投影 */
  key: string;
  qty: number;
  /** 折手序号 → 来源库存批次 id */
  sourceBatchBySheet: string[];
  /** 该组涉及的色批 id（去重保序） */
  colorLotIds: string[];
  /** 是否为色批混用组 */
  mixed: boolean;
  /** 是否为锁定预留组 */
  locked: boolean;
  /** 锁定组与当前色批兼容规则冲突（规则改严后）时标记，但仍保留预留 */
  lotConflict?: boolean;
  lockId?: string;
  lines: KitLine[];
}

/** 单个折手的库存现状 */
export interface SheetStockRow {
  sheetIndex: number;
  /** 该折手全部合格份数（锁定前的总量） */
  available: number;
  /** 待复检折算份数 */
  hold: number;
  /** 报废份数（按正反面较大者计） */
  scrap: number;
  /** 正反面不同批数量差造成的富余单面数 */
  sideMismatch: number;
  /** 已被锁定预留的份数 */
  reserved: number;
  perBatch: Array<{
    batchId: string;
    colorLotId: string;
    usable: number;
    frontQty: number;
    backQty: number;
    status: QcStatus;
  }>;
}

/** 锁定无法完全满足时的缺口（库存被改少 / 状态变更后） */
export interface LockShortfall {
  lockId: string;
  requested: number;
  satisfied: number;
}

/** 成套分配结果 */
export interface AllocationResult {
  /** 可装订本数（含锁定） */
  bookCount: number;
  /** 其中已锁定的本数 */
  lockedBooks: number;
  groups: KitGroup[];
  rows: SheetStockRow[];
  /** 短板折手（合格总量最小的折手；并列时全部列出） */
  bottlenecks: number[];
  /** 成套后未配套的合格印张余量（按折手汇总份数） */
  surplus: Array<{ sheetIndex: number; qty: number }>;
  /** 未能入册的库存（待复检 / 报废 / 正反面不齐 / 缺配套折手） */
  stranded: Array<{
    batchId: string;
    sheetIndex: number;
    usable: number;
    reason: 'hold' | 'scrap' | 'side-mismatch' | 'missing-other-sheets';
  }>;
  lockShortfalls: LockShortfall[];
}

/** 补印候选中的一块版：重印某折手 qty 份（一份 = 正反面各一张印张） */
export interface ReprintPlate {
  sheetIndex: number;
  qty: number;
}

/** 补印候选方案 */
export interface ReprintOption {
  /** 稳定标识：折手→份数 的有序投影 */
  key: string;
  plates: ReprintPlate[];
  /** 补印品统一使用的色批 id */
  colorLotId: string;
  /** 开机版组数（需重新上机的折手版种数） */
  plateGroups: number;
  /** 补印印张数（正反面合计） */
  pressSheets: number;
  /** 补印品中最终未配套、纯浪费的印张数（正反面合计） */
  wasteSheets: number;
  /** 采用后可装订总本数（含已锁定） */
  resultingBooks: number;
  /** 该候选能补齐哪些书册（人类可读解释行） */
  explanations: string[];
}

/** 补印规划结果 */
export interface ReprintPlan {
  lockedBooks: number;
  currentBooks: number;
  /** 缺口本数；未设目标为 null */
  gap: number | null;
  options: ReprintOption[];
  /** 无解时的约束说明 */
  infeasible: string[];
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

export const clampInt = (n: unknown, min = 0): number => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v >= min ? v : min;
};

const sortPair = (a: string, b: string): [string, string] => (a <= b ? [a, b] : [b, a]);

export const normalizePairs = (pairs: Array<[string, string]>): Array<[string, string]> => {
  const seen = new Set<string>();
  const out: Array<[string, string]> = [];
  for (const [a, b] of pairs) {
    if (!a || !b || a === b) continue;
    const p = sortPair(a, b);
    const k = p.join(' ');
    if (!seen.has(k)) {
      seen.add(k);
      out.push(p);
    }
  }
  return out.sort((x, y) => (x[0] === y[0] ? (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0) : x[0] < y[0] ? -1 : 1));
};

/** 两个色批是否可在同一本书中混用 */
export function lotsCompatible(a: string, b: string, compat: CompatRules): boolean {
  if (a === b) return true;
  if (compat.mode === 'any') return true;
  if (compat.mode === 'same') return false;
  const [x, y] = sortPair(a, b);
  return compat.pairs.some(([p, q]) => p === x && q === y);
}

/** 一批色批集合是否两两兼容 */
export function lotSetCompatible(lotIds: string[], compat: CompatRules): boolean {
  for (let i = 0; i < lotIds.length; i++) {
    for (let j = i + 1; j < lotIds.length; j++) {
      if (!lotsCompatible(lotIds[i], lotIds[j], compat)) return false;
    }
  }
  return true;
}

/** 一条库存记录可装份数：正反面必须同批且合格，取较小值 */
export const usableQty = (s: FoldStock): number =>
  s.status === 'ok' ? Math.min(clampInt(s.frontQty), clampInt(s.backQty)) : 0;

interface StockCell {
  batchId: string;
  colorLotId: string;
  qty: number;
  frontQty: number;
  backQty: number;
  status: QcStatus;
}

interface Prepared {
  sheetCount: number;
  /** cells[sheetIndex]，按 batchId 升序 */
  cells: StockCell[][];
  batchById: Map<string, PrintBatch>;
}

function prepare(doc: InventoryDoc, sheetCount: number): Prepared {
  const batchById = new Map(doc.batches.map((b) => [b.id, b]));
  const cells: StockCell[][] = Array.from({ length: sheetCount }, () => []);
  for (const s of doc.stocks) {
    if (s.sheetIndex < 0 || s.sheetIndex >= sheetCount) continue;
    const batch = batchById.get(s.batchId);
    if (!batch) continue;
    cells[s.sheetIndex].push({
      batchId: s.batchId,
      colorLotId: batch.colorLotId,
      qty: usableQty(s),
      frontQty: clampInt(s.frontQty),
      backQty: clampInt(s.backQty),
      status: s.status,
    });
  }
  for (const list of cells) {
    list.sort((a, b) => cmpString(a.batchId, b.batchId));
  }
  return { sheetCount, cells, batchById };
}

// ---------------------------------------------------------------------------
// 库存现状行（矩阵 / 短板 / 未配套）
// ---------------------------------------------------------------------------

function buildRows(
  prep: Prepared,
  reserved: number[][],
): SheetStockRow[] {
  return prep.cells.map((list, sheetIndex) => {
    let available = 0;
    let hold = 0;
    let scrap = 0;
    let sideMismatch = 0;
    let reservedTotal = 0;
    for (let ci = 0; ci < list.length; ci++) {
      const c = list[ci];
      reservedTotal += reserved[sheetIndex][ci] ?? 0;
      if (c.status === 'hold') {
        hold += Math.min(c.frontQty, c.backQty);
        sideMismatch += Math.abs(c.frontQty - c.backQty);
      } else if (c.status === 'scrap') {
        scrap += Math.max(c.frontQty, c.backQty);
      } else {
        available += c.qty;
        sideMismatch += Math.abs(c.frontQty - c.backQty);
      }
    }
    return {
      sheetIndex,
      available,
      hold,
      scrap,
      sideMismatch,
      reserved: reservedTotal,
      perBatch: list.map((c) => ({
        batchId: c.batchId,
        colorLotId: c.colorLotId,
        usable: c.qty,
        frontQty: c.frontQty,
        backQty: c.backQty,
        status: c.status,
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// 确定性成套分配
// ---------------------------------------------------------------------------

interface AllocState {
  /** remain[折手][该折手单元格下标] = 剩余合格份数 */
  remain: number[][];
  groups: KitGroup[];
  indexByKey: Map<string, number>;
}

const groupKeyOf = (batchIds: string[]): string => batchIds.join('|');

function pushGroup(
  st: AllocState,
  prep: Prepared,
  batchIds: string[],
  qty: number,
  opts: { locked: boolean; lockId?: string; lotConflict?: boolean },
): void {
  if (qty <= 0) return;
  const key = opts.lockId ? `lock:${opts.lockId}` : groupKeyOf(batchIds);
  const lotIds: string[] = [];
  const seenLots = new Set<string>();
  batchIds.forEach((bid, si) => {
    const ci = prep.cells[si].findIndex((c) => c.batchId === bid);
    const cell = prep.cells[si][ci];
    st.remain[si][ci] -= qty;
    if (!seenLots.has(cell.colorLotId)) {
      seenLots.add(cell.colorLotId);
      lotIds.push(cell.colorLotId);
    }
  });
  const existing = st.indexByKey.get(key);
  if (existing !== undefined) {
    const g = st.groups[existing];
    g.qty += qty;
    g.lines.forEach((line) => {
      line.qty += qty;
    });
    return;
  }
  st.indexByKey.set(key, st.groups.length);
  st.groups.push({
    key,
    qty,
    sourceBatchBySheet: [...batchIds],
    colorLotIds: lotIds,
    mixed: lotIds.length > 1,
    locked: opts.locked,
    lotConflict: opts.lotConflict,
    lockId: opts.lockId,
    lines: batchIds.map((bid, si) => ({ batchId: bid, sheetIndex: si, qty })),
  });
}

/**
 * 候选组合的优先级（数组字典序，越小越优先）。
 * policy 决定策略：
 * - 'pure'：不混色批优先 → 色批种数少 → 色批名 → 批次名；
 * - 'mixed'：允许混用时反而优先混用（用于链式兼容下救回更多成套数）；
 * - anchor 某色批：优先用到该色批的组合，其后按 pure 规则。
 * 多策略各跑一遍取成套数最多者，避免单一贪心在 A-B、B-C 兼容而
 * A-C 不兼容等结构下少配套。
 */
type RankPolicy = { kind: 'pure' | 'mixed' } | { kind: 'anchor'; lot: string };

function rankCombo(
  batchIds: string[],
  prep: Prepared,
  compat: CompatRules,
  policy: RankPolicy,
): { ok: boolean; rank: (number | string)[] } {
  const lots: string[] = [];
  batchIds.forEach((bid, si) => {
    const cell = prep.cells[si].find((c) => c.batchId === bid)!;
    lots.push(cell.colorLotId);
  });
  const distinctLots = [...new Set(lots)].sort();
  if (!lotSetCompatible(distinctLots, compat)) return { ok: false, rank: [] };
  const isMixed = distinctLots.length > 1 ? 1 : 0;
  if (policy.kind === 'mixed') {
    return {
      ok: true,
      rank: [isMixed === 0 ? 1 : 0, distinctLots.length, distinctLots.join(','), batchIds.join(',')],
    };
  }
  if (policy.kind === 'anchor') {
    return {
      ok: true,
      rank: [
        distinctLots.includes(policy.lot) ? 0 : 1,
        isMixed,
        distinctLots.length,
        distinctLots.join(','),
        batchIds.join(','),
      ],
    };
  }
  return {
    ok: true,
    rank: [isMixed, distinctLots.length, distinctLots.join(','), batchIds.join(',')],
  };
}

const cmpString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const compareRank = (a: (number | string)[], b: (number | string)[]): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    if (typeof a[i] === 'number' && typeof b[i] === 'number')
      return (a[i] as number) - (b[i] as number);
    return cmpString(String(a[i] ?? ''), String(b[i] ?? ''));
  }
  return 0;
};

/**
 * 成套分配：
 * 1. 锁定组先按当前库存扣减（库存不足时部分满足并登记 shortfall）；
 * 2. 其余库存每轮在「折手 × 现存批次」笛卡尔积中选等级最高的色批兼容
 *    组合，按该组合瓶颈份数成套并扣减，直到任一轮无可行组合。
 */
export function allocate(doc: InventoryDoc, sheetCount: number): AllocationResult {
  const prep = prepare(doc, sheetCount);
  const remain: number[][] = prep.cells.map((list) => list.map((c) => c.qty));
  const reserved: number[][] = prep.cells.map((list) => list.map(() => 0));
  const st: AllocState = { remain, groups: [], indexByKey: new Map() };
  const lockShortfalls: LockShortfall[] = [];

  const cellIndexOf = (si: number, batchId: string): number =>
    prep.cells[si].findIndex((c) => c.batchId === batchId);

  // --- 1) 锁定预留（按 locks 顺序，确定性） ---
  for (const lock of doc.locks) {
    const want = clampInt(lock.qty);
    if (lock.sources.length !== sheetCount) {
      // 拼版结构变化（增减页面导致折手数改变），旧锁定无法套用
      if (want > 0) lockShortfalls.push({ lockId: lock.id, requested: want, satisfied: 0 });
      continue;
    }
    const indices = lock.sources.map((bid, si) => cellIndexOf(si, bid));
    let valid = true;
    for (let si = 0; si < sheetCount; si++) {
      const ci = indices[si];
      if (ci < 0 || remain[si][ci] <= 0) {
        valid = false;
        break;
      }
    }
    if (!valid || want <= 0) {
      if (want > 0) lockShortfalls.push({ lockId: lock.id, requested: want, satisfied: 0 });
      continue;
    }
    const cap = Math.min(want, ...indices.map((ci, si) => remain[si][ci]));
    const lotIds = indices.map((ci, si) => prep.cells[si][ci].colorLotId);
    const lotConflict = !lotSetCompatible([...new Set(lotIds)], doc.compat);
    // 预留计数（现状行展示用）；库存扣减统一由 pushGroup 完成，避免重复
    for (let si = 0; si < sheetCount; si++) {
      reserved[si][indices[si]] += cap;
    }
    pushGroup(st, prep, lock.sources, cap, { locked: true, lockId: lock.id, lotConflict });
    if (cap < want) lockShortfalls.push({ lockId: lock.id, requested: want, satisfied: cap });
  }

  // --- 2) 自由分配（多策略竞赛，取成套数最多者） ---
  const presentLots = new Set<string>();
  remain.forEach((col, si) => {
    col.forEach((q, ci) => {
      if (q > 0) presentLots.add(prep.cells[si][ci].colorLotId);
    });
  });
  const policies: RankPolicy[] = [
    { kind: 'pure' },
    ...[...presentLots].sort().map((lot): RankPolicy => ({ kind: 'anchor', lot })),
    { kind: 'mixed' },
  ];

  interface PolicyRun {
    policy: RankPolicy;
    groups: Array<{ batchIds: string[]; qty: number }>;
    count: number;
  }

  const runPolicy = (policy: RankPolicy): PolicyRun => {
    const rem = remain.map((col) => [...col]);
    const groups: Array<{ batchIds: string[]; qty: number }> = [];

    const findBest = (): string[] | null => {
      const active: string[][] = prep.cells.map((list, si) =>
        list.filter((_, ci) => rem[si][ci] > 0).map((c) => c.batchId),
      );
      if (active.some((a) => a.length === 0)) return null;

      let best: string[] | null = null;
      let bestRank: (number | string)[] | null = null;
      const pick = new Array<string>(sheetCount);

      const visit = (si: number): void => {
        if (si === sheetCount) {
          const { ok, rank } = rankCombo(pick, prep, doc.compat, policy);
          if (ok && (!bestRank || compareRank(rank, bestRank) < 0)) {
            bestRank = rank;
            best = [...pick];
          }
          return;
        }
        for (const bid of active[si]) {
          pick[si] = bid;
          visit(si + 1);
        }
      };
      visit(0);
      return best;
    };

    for (;;) {
      const chosen = findBest();
      if (!chosen) break;

      const take = Math.min(
        ...chosen.map((bid, si) => rem[si][cellIndexOf(si, bid)]),
      );
      const same = groups.find((g) => g.batchIds.join('|') === chosen.join('|'));
      chosen.forEach((bid, si) => {
        rem[si][cellIndexOf(si, bid)] -= take;
      });
      if (same) same.qty += take;
      else groups.push({ batchIds: [...chosen], qty: take });
    }
    return {
      policy,
      groups,
      count: groups.reduce((a, g) => a + g.qty, 0),
    };
  };

  const runs = policies.map(runPolicy);
  const policyIndex = (p: RankPolicy): string =>
    p.kind === 'pure' ? '0' : p.kind === 'mixed' ? '2' : `1:${p.kind === 'anchor' ? p.lot : ''}`;
  runs.sort((a, b) =>
    a.count === b.count
      ? cmpString(policyIndex(a.policy), policyIndex(b.policy))
      : b.count - a.count,
  );
  const winner = runs[0];
  let freeBooks = 0;
  for (const g of winner.groups) {
    pushGroup(st, prep, g.batchIds, g.qty, { locked: false });
    freeBooks += g.qty;
  }

  const lockedBooks = st.groups.filter((g) => g.locked).reduce((a, g) => a + g.qty, 0);
  const rows = buildRows(prep, reserved);

  // 未配套余量：成套后仍有合格库存的折手（含被锁定扣剩的部分）
  const surplus = remain
    .map((col, si) => ({ sheetIndex: si, qty: col.reduce((a, b) => a + b, 0) }))
    .filter((r) => r.qty > 0);

  const minAvail = rows.length === 0 ? 0 : Math.min(...rows.map((r) => r.available));
  const bottlenecks =
    rows.length === 0 ? [] : rows.filter((r) => r.available === minAvail).map((r) => r.sheetIndex);

  // 未能入册明细
  const stranded: AllocationResult['stranded'] = [];
  prep.cells.forEach((list, si) => {
    list.forEach((c, ci) => {
      if (c.status === 'hold') {
        stranded.push({
          batchId: c.batchId,
          sheetIndex: si,
          usable: Math.min(c.frontQty, c.backQty),
          reason: 'hold',
        });
      } else if (c.status === 'scrap') {
        stranded.push({
          batchId: c.batchId,
          sheetIndex: si,
          usable: Math.max(c.frontQty, c.backQty),
          reason: 'scrap',
        });
      } else {
        const diff = Math.abs(c.frontQty - c.backQty);
        if (diff > 0) {
          stranded.push({ batchId: c.batchId, sheetIndex: si, usable: diff, reason: 'side-mismatch' });
        }
        const left = remain[si][ci];
        if (left > 0) {
          stranded.push({ batchId: c.batchId, sheetIndex: si, usable: left, reason: 'missing-other-sheets' });
        }
      }
    });
  });

  st.groups.sort((a, b) => {
    if (a.locked !== b.locked) return a.locked ? -1 : 1;
    return cmpString(a.key, b.key);
  });

  return {
    bookCount: lockedBooks + freeBooks,
    lockedBooks,
    groups: st.groups,
    rows,
    bottlenecks,
    surplus,
    stranded,
    lockShortfalls,
  };
}

// ---------------------------------------------------------------------------
// 补印候选
// ---------------------------------------------------------------------------

const VIRTUAL_REPRINT_BATCH = '__reprint__';

/**
 * 补印品可使用的色批候选。
 * 同色批模式下，补 A 批缺的折手必须用 A 色，补 B 批缺的必须用 B 色，
 * 因此所有现存色批都要枚举；pairs 模式同理；any 模式任取其一即可。
 */
function candidateReprintLots(doc: InventoryDoc): string[] {
  const existingLots = [...new Set(doc.batches.map((b) => b.colorLotId))].sort();
  const pool = doc.colorLots.length > 0 ? doc.colorLots.map((l) => l.id).sort() : existingLots;
  if (pool.length === 0) return [];
  if (doc.compat.mode === 'any') return [pool[0]];
  // 现存色批全部候选（补印可指定任一色批去补对应色批的短板），
  // 若色批表里还有现存批次未使用的色批，也允许尝试（可能恰好与某色批成对兼容）
  return [...new Set([...existingLots, ...pool])];
}

function withVirtualReprint(
  doc: InventoryDoc,
  reprinted: number[],
  vec: number[],
  lotId: string,
): InventoryDoc {
  const stocks = [
    ...doc.stocks.filter((s) => s.batchId !== VIRTUAL_REPRINT_BATCH),
  ];
  reprinted.forEach((si, i) => {
    if (vec[i] > 0) {
      stocks.push({
        batchId: VIRTUAL_REPRINT_BATCH,
        sheetIndex: si,
        frontQty: vec[i],
        backQty: vec[i],
        status: 'ok',
      });
    }
  });
  return {
    ...doc,
    stocks,
    batches: [
      ...doc.batches.filter((b) => b.id !== VIRTUAL_REPRINT_BATCH),
      { id: VIRTUAL_REPRINT_BATCH, name: '补印', colorLotId: lotId },
    ],
  };
}

interface MinimalResult {
  plates: ReprintPlate[];
  lotId: string;
  resultingBooks: number;
  /** 补印批各折手最终被用掉的份数（键为折手序号） */
  usedByReprint: Map<number, number>;
}

/**
 * 给定重印折手集合，求最小补印量向量：
 * 从 max(0, target-现存合格) 起步，模拟分配；不足时只给「补印批已耗尽」
 * 的瓶颈折手加量；若瓶颈在不重印折手（色批不兼容），该子集不可行。
 * 达标后再逐块逐份回减，消除任何可去掉的过印。
 */
function minimalReprintQty(
  doc: InventoryDoc,
  sheetCount: number,
  reprinted: number[],
  target: number,
  lotId: string,
): MinimalResult | null {
  const base = allocate(doc, sheetCount);
  const vec = reprinted.map((si) => Math.max(0, target - base.rows[si].available));

  const sim = (v: number[]) => allocate(withVirtualReprint(doc, reprinted, v, lotId), sheetCount);

  let result = sim(vec);
  let guard = 0;
  const guardMax = sheetCount * (target + 1) + sheetCount;
  while (result.bookCount < target) {
    // 找补印批已耗尽的重印折手（还能加量的瓶颈）
    const exhausted: number[] = [];
    reprinted.forEach((si, i) => {
      const left = vec[i] - usedOfReprintAt(result, si);
      if (left <= 0 && vec[i] < target) exhausted.push(i);
    });
    if (exhausted.length === 0) return null; // 堵在不重印的折手，加量无意义
    const deficit = target - result.bookCount;
    for (const i of exhausted) vec[i] += deficit;
    result = sim(vec);
    guard += 1;
    if (guard > guardMax) return null;
  }

  // 逐份回减，保持 bookCount >= target
  for (let i = 0; i < vec.length; i++) {
    while (vec[i] > 0) {
      const trial = vec.slice();
      trial[i] -= 1;
      const r = sim(trial);
      if (r.bookCount >= target) {
        vec[i] -= 1;
        result = r;
      } else break;
    }
  }

  const usedByReprint = new Map<number, number>();
  reprinted.forEach((si, i) => {
    if (vec[i] > 0) usedByReprint.set(si, usedOfReprintAt(result, si));
  });

  return {
    plates: reprinted
      .map((si, i) => ({ sheetIndex: si, qty: vec[i] }))
      .filter((p) => p.qty > 0)
      .sort((a, b) => a.sheetIndex - b.sheetIndex),
    lotId,
    resultingBooks: result.bookCount,
    usedByReprint,
  };
}

/** 模拟分配结果中，补印批在某折手上被消耗的份数 */
function usedOfReprintAt(alloc: AllocationResult, sheetIndex: number): number {
  let used = 0;
  for (const g of alloc.groups) {
    const line = g.lines.find((l) => l.sheetIndex === sheetIndex && l.batchId === VIRTUAL_REPRINT_BATCH);
    if (line) used += line.qty;
  }
  return used;
}

/**
 * 补印规划：枚举非空重印折手子集（2^m - 1，m = 折手数，通常 ≤ 十余），
 * 求每个可行子集的最小补印量，按开机版组数 → 补印印张数 → 剩余浪费排序。
 */
export function planReprint(doc: InventoryDoc, sheetCount: number): ReprintPlan {
  const target = doc.deliveryTarget == null ? null : clampInt(doc.deliveryTarget);
  const base = allocate(doc, sheetCount);
  const lockedBooks = base.lockedBooks;
  const currentBooks = base.bookCount;

  const infeasible: string[] = [];
  if (target == null) {
    return { lockedBooks, currentBooks, gap: null, options: [], infeasible };
  }
  if (currentBooks >= target) {
    return { lockedBooks, currentBooks, gap: 0, options: [], infeasible };
  }
  const gap = target - currentBooks;
  const options: ReprintOption[] = [];
  const seen = new Set<string>();
  const m = sheetCount;
  const lotName = (id: string) => doc.colorLots.find((l) => l.id === id)?.name ?? id;
  const batchName = (id: string) => doc.batches.find((b) => b.id === id)?.name ?? id;

  // 现存合格不足 target 的折手「必须补印」；其余折手是否需要重印取决于
  // 色批兼容，作为可枚举项。枚举上限保护超厚书册（2^12 个可选子集）。
  const mandatory = base.rows.filter((r) => r.available < target).map((r) => r.sheetIndex);
  const optional = base.rows.filter((r) => r.available >= target).map((r) => r.sheetIndex);
  const MAX_OPTIONAL_ENUM = 12;
  const optLimit = Math.min(optional.length, MAX_OPTIONAL_ENUM);
  const optEnumerated = optional.slice(0, optLimit);

  for (let omask = 0; omask < 1 << optEnumerated.length; omask++) {
    const extra = optEnumerated.filter((_, i) => (omask & (1 << i)) !== 0);
    const reprinted = [...mandatory, ...extra].sort((a, b) => a - b);
    for (const lotId of candidateReprintLots(doc)) {
      const minimal = minimalReprintQty(doc, m, reprinted, target, lotId);
      if (!minimal || minimal.plates.length === 0) continue;

      const { plates, resultingBooks, usedByReprint } = minimal;
      const key = `${plates.map((p) => `${p.sheetIndex}:${p.qty}`).join('|')}@${lotId}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const pressSheets = plates.reduce((a, p) => a + p.qty * 2, 0);
      const wasteSheets = plates.reduce(
        (a, p) => a + (p.qty - (usedByReprint.get(p.sheetIndex) ?? p.qty)) * 2,
        0,
      );

      options.push({
        key,
        plates,
        colorLotId: lotId,
        plateGroups: plates.length,
        pressSheets,
        wasteSheets,
        resultingBooks,
        explanations: explainReprint(
          doc,
          m,
          plates,
          lotId,
          currentBooks,
          resultingBooks,
          lotName,
          batchName,
        ),
      });
    }
  }

  options.sort((a, b) => {
    if (a.plateGroups !== b.plateGroups) return a.plateGroups - b.plateGroups;
    if (a.pressSheets !== b.pressSheets) return a.pressSheets - b.pressSheets;
    if (a.wasteSheets !== b.wasteSheets) return a.wasteSheets - b.wasteSheets;
    return cmpString(a.key, b.key);
  });

  if (options.length === 0) {
    for (const row of base.rows) {
      if (row.available < target) {
        infeasible.push(
          `第 ${row.sheetIndex + 1} 帖现存合格仅 ${row.available} 份，距目标 ${target} 本缺 ${
            target - row.available
          } 份，该帖必须列入补印`,
        );
      }
    }
    const lotsInUse = new Set<string>();
    for (const g of base.groups) g.colorLotIds.forEach((l) => lotsInUse.add(l));
    if (lotsInUse.size > 1 && doc.compat.mode === 'same') {
      infeasible.push(
        `现存库存分属 ${lotsInUse.size} 个色批（${[...lotsInUse].map(lotName).join('、')}），
        兼容规则为「仅同色批」：补印印张只能与其中一个色批配套，若另一色批的折手不交印则永远凑不齐；
        可考虑开放该两色批兼容或把对应折手一并补印`.replace(/\s+/g, ''),
      );
    }
    const holdTotal = base.stranded
      .filter((s) => s.reason === 'hold')
      .reduce((a, s) => a + s.usable, 0);
    if (holdTotal > 0) {
      infeasible.push(`另有 ${holdTotal} 份折手待复检，复检合格后可能缩小补印范围`);
    }
    if (infeasible.length === 0) {
      infeasible.push(`当前色批兼容规则下，任何补印组合都无法达到 ${target} 本`);
    }
  }

  return { lockedBooks, currentBooks, gap, options: options.slice(0, 8), infeasible };
}

function explainReprint(
  doc: InventoryDoc,
  sheetCount: number,
  plates: ReprintPlate[],
  lotId: string,
  currentBooks: number,
  resultingBooks: number,
  lotName: (id: string) => string,
  batchName: (id: string) => string,
): string[] {
  const sim = withVirtualReprint(
    doc,
    plates.map((p) => p.sheetIndex),
    plates.map((p) => p.qty),
    lotId,
  );
  const alloc = allocate(sim, sheetCount);
  const added = resultingBooks - currentBooks;
  const lines: string[] = [];
  lines.push(
    `重开 ${plates.length} 块版（${plates
      .map((p) => `第 ${p.sheetIndex + 1} 帖 ${p.qty} 份`)
      .join('、')}），补印色批「${lotName(lotId)}」，在现有 ${currentBooks} 本之外再配出 ${added} 本，共 ${resultingBooks} 本`,
  );
  const partners = new Set<string>();
  let reprintOnly = 0;
  for (const g of alloc.groups) {
    const hasReprint = g.lines.some((l) => l.batchId === VIRTUAL_REPRINT_BATCH);
    if (!hasReprint) continue;
    const onlyReprint = g.lines.every((l) => l.batchId === VIRTUAL_REPRINT_BATCH);
    if (onlyReprint) reprintOnly += g.qty;
    for (const l of g.lines) {
      if (l.batchId !== VIRTUAL_REPRINT_BATCH) partners.add(l.batchId);
    }
  }
  if (partners.size > 0) {
    lines.push(`补印折手与现存批次（${[...partners].map(batchName).join('、')}）的余帖配套成书`);
  }
  if (reprintOnly > 0) {
    lines.push(`${reprintOnly} 本由补印折手自行成套（${plates.length === sheetCount ? '全书重印' : '不与旧帖混配'}）`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// 采用补印方案：把虚拟补印批落为真实的新批次与库存
// ---------------------------------------------------------------------------

let adoptSeq = 0;

export function adoptReprintOption(
  doc: InventoryDoc,
  option: ReprintOption,
  idFactory: () => string,
): { doc: InventoryDoc; batchId: string } {
  const batchId = idFactory();
  adoptSeq += 1;
  const stocks: FoldStock[] = [
    ...doc.stocks,
    ...option.plates.map((p) => ({
      batchId,
      sheetIndex: p.sheetIndex,
      frontQty: p.qty,
      backQty: p.qty,
      status: 'ok' as const,
    })),
  ];
  const batches = [
    ...doc.batches,
    {
      id: batchId,
      name: `补印批次 ${new Date().toISOString().slice(0, 10)}-${adoptSeq}`,
      colorLotId: option.colorLotId,
    },
  ];
  return { doc: { ...doc, stocks, batches }, batchId };
}

// ---------------------------------------------------------------------------
// 文档构造辅助
// ---------------------------------------------------------------------------

export const defaultCompat = (): CompatRules => ({ mode: 'same', pairs: [] });

export function emptyInventory(): InventoryDoc {
  return {
    colorLots: [],
    batches: [],
    stocks: [],
    compat: defaultCompat(),
    locks: [],
    deliveryTarget: null,
  };
}
