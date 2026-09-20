import type {
  KitGroup,
  PlateStatus,
  ReprintCandidate,
  ReprintLine,
  ReprintLot,
  SheetQty,
  StockLot,
} from '../types';

/* ============================ 色批混用规则 ============================ */
/**
 * 成套规则（确定性的优先级）：
 * 1. 先按单色批各自配套（A 批只与 A 批成套，B 批只与 B 批成套）；
 * 2. 单色批成套后仍有散张，再按「现存色批全混用」兜底配套。
 *
 * 一条硬规则始终参与：同一折手的正反面必须来自同一批次且两面均合格，
 * 因此单条到货记录的可用数 = min(正面合格, 背面合格)，任一面待复检/
 * 报废则该批印张不能上机装订。
 */

export interface MixRule {
  id: string;
  /** KitGroup.mixKey */
  key: string;
  label: string;
  accepts: (batch: string) => boolean;
}

export const singleMix = (batch: string): MixRule => ({
  id: `single:${batch}`,
  key: `batch:${batch}`,
  label: `${batch} 批单色配套`,
  accepts: (b) => b === batch,
});

export const allMix = (batches: string[]): MixRule => {
  const sorted = [...new Set(batches)].sort();
  return {
    id: `mix:${sorted.join('+')}`,
    key: `mix:${sorted.join('+')}`,
    label:
      sorted.length > 1 ? `色批混用（${sorted.join('+')}）` : `${sorted[0] ?? 'A'} 批单色配套`,
    accepts: (b) => sorted.includes(b),
  };
};

/** 现存批次色批（含待复检/报废记录——报废过的批次仍可作为补印色批选择） */
export function lotBatches(lots: StockLot[]): string[] {
  return [...new Set(lots.map((l) => l.colorBatch).filter((b) => b.trim() !== ''))].sort();
}

/** 规则键转中文标签（batch:A → A 批单色；mix:A+B → 色批混用 A+B） */
export function mixLabel(key: string): string {
  if (key.startsWith('mix:')) return `色批混用 ${key.slice(4)}`;
  if (key.startsWith('batch:')) return `${key.slice(6)} 批单色`;
  return key;
}

/** 水填（未锁定）成套时依次尝试的混用规则 */
export function mixRulesFor(lots: StockLot[]): MixRule[] {
  const batches = lotBatches(lots);
  const base = batches.length > 0 ? batches : ['A'];
  return batches.length > 1 ? [...base.map(singleMix), allMix(batches)] : base.map(singleMix);
}

const STATUSES: PlateStatus[] = ['ok', 'hold', 'scrap'];

const clampInt = (v: unknown, min = 0, max = 1_000_000): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : min;
  return Math.max(min, Math.min(max, n));
};

const reviveStatus = (v: unknown): PlateStatus =>
  STATUSES.includes(v as PlateStatus) ? (v as PlateStatus) : 'ok';

/** 校验/规整库存记录，丢弃越界折手记录，并按 折手 → 色批 → id 确定性排序 */
export function normalizeLots(raw: unknown, sheetCount: number): StockLot[] {
  if (!Array.isArray(raw) || sheetCount <= 0) return [];
  const lots: StockLot[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    if (typeof o.id !== 'string') continue;
    const sheetIndex =
      typeof o.sheetIndex === 'number' && Number.isFinite(o.sheetIndex)
        ? Math.floor(o.sheetIndex)
        : NaN;
    // 引用已不存在折手的孤儿记录直接丢弃（页面减少后的清理依据）
    if (sheetIndex < 0 || sheetIndex >= sheetCount) continue;
    const colorBatch =
      typeof o.colorBatch === 'string' && o.colorBatch.trim() !== ''
        ? o.colorBatch.trim().slice(0, 12)
        : 'A';
    lots.push({
      id: o.id,
      sheetIndex,
      colorBatch,
      frontQty: clampInt(o.frontQty),
      backQty: clampInt(o.backQty),
      frontStatus: reviveStatus(o.frontStatus),
      backStatus: reviveStatus(o.backStatus),
    });
  }
  return lots.sort((a, b) =>
    a.sheetIndex !== b.sheetIndex
      ? a.sheetIndex - b.sheetIndex
      : a.colorBatch !== b.colorBatch
        ? a.colorBatch.localeCompare(b.colorBatch)
        : a.id.localeCompare(b.id),
  );
}

/** 该批印张中同批正反面均合格的成套能力 */
export function lotCapacity(lot: StockLot): number {
  return lot.frontStatus === 'ok' && lot.backStatus === 'ok'
    ? Math.min(lot.frontQty, lot.backQty)
    : 0;
}

/** 按有效锁定批次汇总每条到货记录的占用数量 */
export function lockedUsageMap(
  lots: StockLot[],
  lockedGroups: KitGroup[],
): Map<string, number> {
  const lotById = new Map(lots.map((l) => [l.id, l]));
  const usage = new Map<string, number>();
  for (const group of lockedGroups) {
    for (const lotId of group.lotIds) {
      if (lotId && lotById.has(lotId)) usage.set(lotId, (usage.get(lotId) ?? 0) + group.qty);
    }
  }
  // 占用不得超过能力（数量被改小后的陈旧锁定按能力截断）
  for (const [id, q] of usage) {
    const cap = lotCapacity(lotById.get(id)!);
    if (q > cap) usage.set(id, cap);
  }
  return usage;
}

/** 尚未被锁定成套占用的合格印张 */
export function lotFree(lot: StockLot, lockedUsage = 0): number {
  return Math.max(0, lotCapacity(lot) - lockedUsage);
}

/** 不能参与装订的记录及原因（供矩阵告警） */
export function lotBlockReason(lot: StockLot): string | null {
  if (lot.frontStatus === 'scrap' || lot.backStatus === 'scrap') {
    const sides = [
      lot.frontStatus === 'scrap' ? '正面' : null,
      lot.backStatus === 'scrap' ? '背面' : null,
    ]
      .filter(Boolean)
      .join('、');
    return `${sides}已报废`;
  }
  if (lot.frontStatus === 'hold' || lot.backStatus === 'hold') {
    const sides = [
      lot.frontStatus === 'hold' ? '正面' : null,
      lot.backStatus === 'hold' ? '背面' : null,
    ]
      .filter(Boolean)
      .join('、');
    return `${sides}待复检，暂不配套`;
  }
  if (lot.frontQty !== lot.backQty) {
    return `正反面合格数不一致（正 ${lot.frontQty} / 背 ${lot.backQty}），仅 ${lotCapacity(
      lot,
    )} 张可同批配套`;
  }
  return null;
}

/* ============================ 成套分配 ============================ */

export interface Allocation {
  /** 通过校验的已锁定批次 */
  locked: KitGroup[];
  /** 系统水填的未锁定批次 */
  water: KitGroup[];
  groups: KitGroup[];
  /** 总可装订本数 */
  bookCount: number;
  /** 已锁定本数 */
  lockedBooks: number;
}

/**
 * 确定性成套分配：
 * 1. 先保留合法的已锁定批次（数量、批次、折手引用逐一核对，失效批次自动放弃）；
 * 2. 再按色批规则链做水填，每轮取整条链上的最小余量，绝不只取各折手最小值
 *    （最小值相同但批次不兼容时不能跨批凑套）。
 */
export function allocateKits(
  sheetCount: number,
  lots: StockLot[],
  lockedGroups: KitGroup[],
): Allocation {
  const safeLots = normalizeLots(lots, sheetCount);
  const freeById = new Map<string, number>();
  for (const lot of safeLots) freeById.set(lot.id, lotCapacity(lot));
  const lotById = new Map(safeLots.map((l) => [l.id, l]));

  // ---------- 1. 校验并保留锁定批次 ----------
  const locked: KitGroup[] = [];
  const committed = new Map<string, number>();
  const lockedCandidates = lockedGroups
    .filter((g) => Array.isArray(g.lotIds) && g.lotIds.length === sheetCount)
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const g of lockedCandidates) {
    const qty = clampInt(g.qty, 1);
    const chosen: StockLot[] = [];
    let ok = true;
    g.lotIds.forEach((lotId, s) => {
      const lot = lotId ? lotById.get(lotId) : undefined;
      if (!lot || lot.sheetIndex !== s || lotCapacity(lot) <= 0) ok = false;
      else chosen.push(lot);
    });
    if (!ok || chosen.length !== sheetCount) continue;
    // 锁定数量不得超过该批次尚未被其他锁定占用的能力
    for (const lot of chosen) {
      const used = committed.get(lot.id) ?? 0;
      if (lotCapacity(lot) - used < qty) ok = false;
    }
    if (!ok) continue;
    for (const lot of chosen) committed.set(lot.id, (committed.get(lot.id) ?? 0) + qty);
    locked.push({ ...g, lotIds: chosen.map((l) => l.id), qty });
  }

  for (const [id, used] of committed) {
    freeById.set(id, (freeById.get(id) ?? 0) - used);
  }

  // ---------- 2. 规则链水填 ----------
  const phases = mixRulesFor(safeLots);
  const water: KitGroup[] = [];
  let serial = 0;

  for (const mix of phases) {
    for (;;) {
      const chosenLotIds: string[] = [];
      let qty = Infinity;
      for (let s = 0; s < sheetCount; s++) {
        const candidates = safeLots
          .filter(
            (l) =>
              l.sheetIndex === s &&
              mix.accepts(l.colorBatch) &&
              (freeById.get(l.id) ?? 0) > 0,
          )
          .sort((a, b) => a.id.localeCompare(b.id));
        const pick = candidates[0];
        if (!pick) {
          qty = 0;
          break;
        }
        chosenLotIds.push(pick.id);
        qty = Math.min(qty, freeById.get(pick.id) ?? 0);
      }
      if (!Number.isFinite(qty) || qty <= 0 || chosenLotIds.length !== sheetCount) break;
      for (const id of chosenLotIds) freeById.set(id, (freeById.get(id) ?? 0) - qty);
      water.push({
        id: `w:${mix.id}#${serial++}`,
        mixKey: mix.key,
        lotIds: chosenLotIds,
        qty,
      });
    }
  }

  const groups = [...locked, ...water];
  return {
    locked,
    water,
    groups,
    bookCount: groups.reduce((sum, g) => sum + g.qty, 0),
    lockedBooks: locked.reduce((sum, g) => sum + g.qty, 0),
  };
}

/* ============================ 库存总览 ============================ */

export interface StockSummary {
  /** 每帖正反面同批合格的成套能力（含锁定） */
  capacityBySheet: number[];
  /** 每帖尚未锁定的合格余量 */
  freeBySheet: number[];
  /** 总可装订本数 */
  bindable: number;
  /** 已锁定本数 */
  lockedBooks: number;
  /** 完全断供的折手（合格数为 0） */
  missingSheets: SheetQty[];
  /** 卡住装订上限的短板折手（合格能力 == 可装订数） */
  bottlenecks: SheetQty[];
  /** 各折手无法进入书册的未配套余量 */
  surplus: SheetQty[];
  /** 无法配套的合格印张总数（剩余浪费） */
  waste: number;
}

export function stockSummary(
  sheetCount: number,
  lots: StockLot[],
  allocation: Allocation,
): StockSummary {
  const safeLots = normalizeLots(lots, sheetCount);
  const usage = lockedUsageMap(safeLots, allocation.locked);
  const capacityBySheet = new Array(sheetCount).fill(0);
  const freeBySheet = new Array(sheetCount).fill(0);
  for (const lot of safeLots) {
    capacityBySheet[lot.sheetIndex] += lotCapacity(lot);
    freeBySheet[lot.sheetIndex] += lotFree(lot, usage.get(lot.id) ?? 0);
  }
  const bindable = allocation.bookCount;
  const ofSheet = (pred: (s: number) => boolean, value: (s: number) => number): SheetQty[] =>
    Array.from({ length: sheetCount }, (_, s) => s)
      .filter(pred)
      .map((s) => ({ sheetIndex: s, qty: value(s) }));

  const missingSheets = ofSheet((s) => capacityBySheet[s] === 0, (s) => capacityBySheet[s]);
  const bottlenecks =
    bindable > 0 ? ofSheet((s) => capacityBySheet[s] === bindable, (s) => capacityBySheet[s]) : [];
  const surplus = ofSheet(
    (s) => capacityBySheet[s] - bindable > 0,
    (s) => capacityBySheet[s] - bindable,
  );
  const waste =
    capacityBySheet.reduce((a, b) => a + b, 0) - (sheetCount > 0 ? bindable * sheetCount : 0);

  return {
    capacityBySheet,
    freeBySheet,
    bindable,
    lockedBooks: allocation.lockedBooks,
    missingSheets,
    bottlenecks,
    surplus,
    waste: Math.max(0, waste),
  };
}

/* ============================ 补印决策 ============================ */

export interface ReprintPlan {
  /** 现存可装订数 */
  base: number;
  /** 已锁定本数 */
  lockedBooks: number;
  candidates: ReprintCandidate[];
  /** 无解时的约束说明 */
  infeasible?: string;
}

/** 各折手上某色批的合格能力 */
function capacityByBatch(lots: StockLot[], sheetCount: number): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const lot of lots) {
    const col = map.get(lot.colorBatch) ?? new Array(sheetCount).fill(0);
    col[lot.sheetIndex] += lotCapacity(lot);
    map.set(lot.colorBatch, col);
  }
  return map;
}

/** 已锁定成套对各色批/折手的占用 */
function lockUsageByBatch(
  lockedGroups: KitGroup[],
  lots: StockLot[],
  sheetCount: number,
): Map<string, number[]> {
  const lotById = new Map(lots.map((l) => [l.id, l]));
  const map = new Map<string, number[]>();
  for (const group of lockedGroups) {
    group.lotIds.forEach((lotId, s) => {
      const lot = lotId ? lotById.get(lotId) : undefined;
      if (!lot) return;
      const col = map.get(lot.colorBatch) ?? new Array(sheetCount).fill(0);
      col[s] += group.qty;
      map.set(lot.colorBatch, col);
    });
  }
  return map;
}

/** 加入补印合成批次后的库存（不做分配，分配统一走完整规则链以贴合采用后实况） */
function withReprintLots(sheetCount: number, lots: StockLot[], mix: MixRule, lines: ReprintLine[]): StockLot[] {
  const synth: StockLot[] = lines.map((line) => ({
    id: `rp:${mix.id}:s${line.sheetIndex}`,
    sheetIndex: line.sheetIndex,
    colorBatch: line.colorBatch,
    frontQty: line.qty,
    backQty: line.qty,
    frontStatus: 'ok',
    backStatus: 'ok',
  }));
  return normalizeLots([...lots, ...synth], sheetCount);
}

/** 该帖现存合格能力最强的色批（决定混用候选把缺口交谁上机） */
const dominantBatch = (caps: Map<string, number[]>, sheetIndex: number, fallback: string): string => {
  let best = '';
  let bestQty = -1;
  for (const [batch, col] of caps) {
    const q = col[sheetIndex] ?? 0;
    if (q > bestQty || (q === bestQty && (best === '' || batch < best))) {
      best = batch;
      bestQty = q;
    }
  }
  return bestQty > 0 ? best : fallback;
};

/**
 * 比较补印候选并按 开机版组数 → 补印印张数 → 剩余浪费 确定性排序。
 *
 * 规则链为 单色批 A、单色批 B、…、全色批混用。补印不会影响其他色批的
 * 现存贡献，故某单色批通道只需承担
 *   D = 目标 - 现存总数 + 该色批现存水填数
 * （现存总数中扣掉别人的，剩下的缺口归自己），每帖补到该批自由余量 ≥ D；
 * 全混用候选：完整链总数恒为各折手总合格能力的最小值（锁定在每帖占用
 * 相同，不改变最小值），故每帖补到总能力 ≥ 目标即可，缺口交该帖现存
 * 能力最强的色批上机。
 * 正反面同批硬规则使得「补一张」= 该帖正反面两块版同批一次上机。
 */
export function planReprints(
  sheetCount: number,
  rawLots: StockLot[],
  lockedGroups: KitGroup[],
  target: number,
): ReprintPlan {
  const lots = normalizeLots(rawLots, sheetCount);
  const current = allocateKits(sheetCount, lots, lockedGroups);
  const base = current.bookCount;

  const fail = (infeasible: string): ReprintPlan => ({
    base,
    lockedBooks: current.lockedBooks,
    candidates: [],
    infeasible,
  });

  if (sheetCount <= 0) return fail('当前没有任何折手：请先在左侧编排页面并生成印张。');
  if (!Number.isFinite(target) || target <= 0) {
    return fail('请输入大于 0 的交付目标本数。');
  }
  if (target < current.lockedBooks) {
    return fail(
      `已锁定成套 ${current.lockedBooks} 本，交付目标 ${target} 本低于锁定数量；不能拆解锁批来减量，请提高目标或先解锁批次。`,
    );
  }
  if (target <= base) {
    return { base, lockedBooks: current.lockedBooks, candidates: [] };
  }

  const caps = capacityByBatch(lots, sheetCount);
  // 锁定占用只承认通过成套校验的批次（数量被改小后陈旧锁批自动失效）
  const lockUse = lockUsageByBatch(current.locked, lots, sheetCount);
  const totalCap = new Array(sheetCount).fill(0);
  for (const col of caps.values()) col.forEach((q, s) => (totalCap[s] += q));
  const fallbackBatch = lotBatches(lots)[0] ?? 'A';
  const mixedKey = allMix(lotBatches(lots)).key;

  // 现存库存下，每个单色批阶段可独立水填的数量 = 该批各帖自由余量的最小值
  // （各单色批批次互不相交，阶段先后不改变这个值）
  const phaseQty = new Map<string, number>();
  for (const g of current.water) {
    if (g.mixKey.startsWith('batch:')) {
      phaseQty.set(g.mixKey, (phaseQty.get(g.mixKey) ?? 0) + g.qty);
    }
  }

  const candidates: ReprintCandidate[] = [];

  for (const mix of mixRulesFor(lots)) {
    const isMixed = mix.key === mixedKey;
    let lines: ReprintLine[] = [];
    let othersSingles = 0;
    let deficit = 0;

    if (isMixed) {
      for (let s = 0; s < sheetCount; s++) {
        const need = target - totalCap[s];
        if (need > 0) {
          lines.push({ sheetIndex: s, colorBatch: dominantBatch(caps, s, fallbackBatch), qty: need });
        }
      }
    } else {
      const batch = mix.key.slice('batch:'.length);
      // 单色批策略：其他色批现存单色书册照旧产出，新增书册全部由本批承担，
      // 不依赖混用兜底
      othersSingles = [...phaseQty.entries()]
        .filter(([key]) => key !== mix.key)
        .reduce((sum, [, q]) => sum + q, 0);
      deficit = target - current.lockedBooks - othersSingles;
      const capCol = caps.get(batch) ?? new Array(sheetCount).fill(0);
      const useCol = lockUse.get(batch) ?? new Array(sheetCount).fill(0);
      for (let s = 0; s < sheetCount; s++) {
        const need = deficit - (capCol[s] - useCol[s]);
        if (need > 0) lines.push({ sheetIndex: s, colorBatch: batch, qty: need });
      }
    }

    const combined = withReprintLots(sheetCount, lots, mix, lines);
    // 采用后实况：锁定批次照旧、水填走完整规则链
    const allocation = allocateKits(sheetCount, combined, lockedGroups);
    if (allocation.bookCount >= target) {
      const summary = stockSummary(sheetCount, combined, allocation);
      const lineList = [...lines].sort((a, b) => a.sheetIndex - b.sheetIndex);
      const plateGroups = lineList.length;
      const sheets = lineList.reduce((sum, l) => sum + l.qty, 0);

      const explanation: string[] = [];
      explanation.push(
        `${mix.label}：补印 ${sheets} 张、${plateGroups} 组版（每组含正反面两块版）后可装订 ${
          allocation.bookCount
        } 本，补齐现存 ${base} 本之后的第 ${base + 1}–${target} 本（新增 ${target - base} 本）。`,
      );
      if (current.lockedBooks > 0) {
        explanation.push(`已锁定 ${current.lockedBooks} 本成套批次，方案优先保留、不拆锁。`);
      }
      if (!isMixed && othersSingles > 0) {
        explanation.push(
          `其他色批现存可单色配套 ${othersSingles} 本，本批通道承担剩余 ${deficit} 本，不依赖色批混用。`,
        );
      }
      for (const line of lineList) {
        const have = isMixed
          ? totalCap[line.sheetIndex]
          : (caps.get(line.colorBatch)?.[line.sheetIndex] ?? 0);
        explanation.push(
          `第 ${line.sheetIndex + 1} 帖交 ${line.colorBatch} 批补印 ${line.qty} 张、正反面同批一次上机：` +
            `该帖${isMixed ? '现存总' : `${line.colorBatch} 批现存`}合格能力 ${have} 张，不足目标。`,
        );
      }
      if (summary.waste > 0) {
        const detail = summary.surplus
          .map((s) => `第 ${s.sheetIndex + 1} 帖余 ${s.qty} 张`)
          .join('、');
        explanation.push(
          `补印后仍有 ${summary.waste} 张合格印张无法配套（${detail}），计入剩余浪费。`,
        );
      } else {
        explanation.push('补印后合格印张全部配套，无剩余浪费。');
      }

      candidates.push({
        id: `cand:${mix.id}`,
        lines: lineList,
        plateGroups,
        sheets,
        waste: summary.waste,
        totalBooks: allocation.bookCount,
        lockedBooks: allocation.lockedBooks,
        lots: combined,
        groups: allocation.groups,
        surplus: summary.surplus,
        explanation,
      });
    }
  }

  const isMixedId = (id: string) => id.startsWith('cand:mix');
  candidates.sort(
    (a, b) =>
      a.plateGroups - b.plateGroups ||
      a.sheets - b.sheets ||
      a.waste - b.waste ||
      // 补印行完全等价时，单色批方案比混用方案语义更明确，优先保留
      Number(isMixedId(a.id)) - Number(isMixedId(b.id)) ||
      a.id.localeCompare(b.id),
  );

  // 不同规则可能给出完全相同的补印行（如短板帖正好由主力色批补印），合并去重
  const signature = (c: ReprintCandidate) =>
    c.lines.map((l) => `${l.sheetIndex}:${l.colorBatch}:${l.qty}`).join('|');
  const seenSigs = new Set<string>();
  const unique = candidates.filter((c) => {
    const sig = signature(c);
    if (seenSigs.has(sig)) return false;
    seenSigs.add(sig);
    return true;
  });

  if (unique.length === 0) {
    return fail(
      `现有色批规则下无法补印到 ${target} 本：请检查折手正反面是否同批合格、待复检/报废状态及锁定批次是否互相冲突。`,
    );
  }
  return { base, lockedBooks: current.lockedBooks, candidates: unique };
}

/* ============================ 采用方案 / 锁定 / 编辑 ============================ */

/** 采用补印候选：剔除合成批次、换成正式批次入库，锁定批次保持不变 */
export function adoptReprint(
  candidate: ReprintCandidate,
  existingLots: StockLot[],
  genId: () => string,
): { lots: StockLot[]; added: ReprintLot[] } {
  const synthIds = new Set(
    candidate.lines.map((l) => `rp:${candidate.id.replace('cand:', '')}:s${l.sheetIndex}`),
  );
  const added: ReprintLot[] = candidate.lines.map((line) => ({
    id: genId(),
    sheetIndex: line.sheetIndex,
    colorBatch: line.colorBatch,
    qty: line.qty,
    frontQty: line.qty,
    backQty: line.qty,
    frontStatus: 'ok',
    backStatus: 'ok',
  }));
  const kept = existingLots.filter((l) => !synthIds.has(l.id));
  return { lots: [...kept, ...added], added };
}

/** 把一个水填批次锁定为成套批次（锁定占用由 lockedGroups 单一数据源推导） */
export function lockKitGroup(group: KitGroup, genId: () => string): KitGroup {
  return { ...group, id: genId() };
}

/** 解锁成套批次 */
export function unlockKitGroup(lockedGroups: KitGroup[], groupId: string): KitGroup[] {
  return lockedGroups.filter((g) => g.id !== groupId);
}

export function addLot(lots: StockLot[], sheetCount: number, genId: () => string): StockLot[] {
  if (sheetCount <= 0) return lots;
  const lot: StockLot = {
    id: genId(),
    sheetIndex: 0,
    colorBatch: lotBatches(lots)[0] ?? 'A',
    frontQty: 0,
    backQty: 0,
    frontStatus: 'ok',
    backStatus: 'ok',
  };
  return [...lots, lot];
}

export function updateLot(
  lots: StockLot[],
  id: string,
  patch: Partial<Omit<StockLot, 'id'>>,
): StockLot[] {
  return lots.map((l) => (l.id === id ? { ...l, ...patch } : l));
}

export function removeLot(lots: StockLot[], id: string): StockLot[] {
  return lots.filter((l) => l.id !== id);
}

/**
 * 页面增删或数量变化后规整库存：
 * - 剔除引用已不存在折手的孤儿记录；
 * - 丢弃引用失效/容量不足的锁定批次（锁定占用全部从 lockedGroups 推导）。
 */
export function reconcileInventory(
  sheetCount: number,
  rawLots: StockLot[],
  lockedGroups: KitGroup[],
): { lots: StockLot[]; lockedGroups: KitGroup[] } {
  const lots = normalizeLots(rawLots, sheetCount);
  const valid = allocateKits(sheetCount, lots, lockedGroups).locked;
  return { lots, lockedGroups: valid };
}
