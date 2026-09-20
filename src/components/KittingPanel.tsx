import { useState } from 'react';
import type { AllocationResult } from '../lib/inventory';
import type { InventoryDoc, KitGroup } from '../lib/inventory';
import { uid } from '../lib/uid';

interface Props {
  alloc: AllocationResult;
  inventory: InventoryDoc;
  batchName: (id: string) => string;
  lotName: (id: string) => string;
  lotColor: (id: string) => string;
  commitInventory: (updater: (inv: InventoryDoc) => InventoryDoc) => void;
}

/** 成套批次与锁定面板：可装数量、短板、余量、锁定操作 */
export function KittingPanel({
  alloc,
  inventory,
  batchName,
  lotName,
  lotColor,
  commitInventory,
}: Props) {
  const [lockQty, setLockQty] = useState<Record<string, string>>({});

  const lockGroup = (g: KitGroup) => {
    const raw = lockQty[g.key];
    const qty = raw === undefined || raw === '' ? g.qty : Math.max(1, Math.min(g.qty, Math.floor(Number(raw)) || 0));
    if (qty <= 0) return;
    commitInventory((inv) => ({
      ...inv,
      locks: [...inv.locks, { id: uid('lock'), sources: [...g.sourceBatchBySheet], qty }],
    }));
    setLockQty((m) => ({ ...m, [g.key]: '' }));
  };

  const unlock = (lockId: string) =>
    commitInventory((inv) => ({ ...inv, locks: inv.locks.filter((l) => l.id !== lockId) }));

  const freeGroups = alloc.groups.filter((g) => !g.locked);
  const lockedGroups = alloc.groups.filter((g) => g.locked);
  const target = inventory.deliveryTarget;
  const reached = target != null && alloc.bookCount >= target;

  return (
    <section className="kitting-panel">
      <div className="panel-head">
        <h2>成套批次</h2>
        <span className="muted">按色批规则确定性分配，锁定后优先预留</span>
      </div>

      <div className="kit-stats">
        <div className={`kit-stat ${reached ? 'kit-stat--ok' : ''}`}>
          <b>{alloc.bookCount}</b>
          <span>可装订（本）</span>
        </div>
        <div className="kit-stat">
          <b>{alloc.lockedBooks}</b>
          <span>已锁定（本）</span>
        </div>
        <div className="kit-stat">
          <b>{alloc.bookCount - alloc.lockedBooks}</b>
          <span>未锁定（本）</span>
        </div>
        {target != null && (
          <div className={`kit-stat ${reached ? 'kit-stat--ok' : 'kit-stat--bad'}`}>
            <b>{Math.max(0, target - alloc.bookCount)}</b>
            <span>距目标 {target} 本</span>
          </div>
        )}
      </div>

      <ul className="kit-notes">
        {alloc.bottlenecks.map((si) => (
          <li key={`b-${si}`} className="kit-note kit-note--bad">
            短板折手：第 {si + 1} 帖合格 {alloc.rows[si].available} 份
            {alloc.rows[si].reserved > 0 && `（含锁定预留 ${alloc.rows[si].reserved}）`}
          </li>
        ))}
        {alloc.surplus.map((s) => (
          <li key={`s-${s.sheetIndex}`} className="kit-note">
            第 {s.sheetIndex + 1} 帖未配套余量 <b>{s.qty}</b> 份
          </li>
        ))}
        {alloc.stranded
          .filter((s) => s.reason === 'hold' || s.reason === 'scrap' || s.reason === 'side-mismatch')
          .map((s, i) => (
            <li key={`st-${i}`} className="kit-note kit-note--warn">
              {batchName(s.batchId)} · 第 {s.sheetIndex + 1} 帖：
              {s.reason === 'hold' && ` ${s.usable} 份待复检，暂不入册`}
              {s.reason === 'scrap' && ` ${s.usable} 份报废`}
              {s.reason === 'side-mismatch' && ` 正反面差 ${s.usable} 张单面，无法同批配套`}
            </li>
          ))}
        {alloc.lockShortfalls.map((sf) => (
          <li key={sf.lockId} className="kit-note kit-note--bad">
            锁定 {sf.lockId} 需 {sf.requested} 本，库存仅能满足 {sf.satisfied} 本
          </li>
        ))}
      </ul>

      <h3 className="kit-subhead">已锁定成套批次</h3>
      {lockedGroups.length === 0 ? (
        <p className="hint">尚未锁定。在下方成套批次上锁定后，印张在分配与补印规划中视为已消耗。</p>
      ) : (
        <ul className="kit-groups">
          {lockedGroups.map((g) => (
            <li key={g.key} className={`kit-group kit-group--locked ${g.lotConflict ? 'is-conflict' : ''}`}>
              <header>
                <span className="kit-group__qty">{g.qty} 本</span>
                <span className="kit-lots">
                  {g.colorLotIds.map((id) => (
                    <span key={id} className="lot-chip">
                      <i className="lot-dot" style={{ background: lotColor(id) }} />
                      {lotName(id)}
                    </span>
                  ))}
                </span>
                {g.mixed && <span className="tag tag--warn">色批混用</span>}
                {g.lotConflict && <span className="tag tag--bad">与现行混用规则冲突</span>}
                <button type="button" className="mini-btn mini-btn--danger" onClick={() => unlock(g.lockId!)}>
                  解锁
                </button>
              </header>
              <GroupSources g={g} sheetCount={g.sourceBatchBySheet.length} batchName={batchName} />
            </li>
          ))}
        </ul>
      )}

      <h3 className="kit-subhead">可锁定的成套批次（自动分配）</h3>
      {freeGroups.length === 0 ? (
        <p className="hint">没有可成套的完整折手集合：补齐短板折手或调整色批混用规则后再看。</p>
      ) : (
        <ul className="kit-groups">
          {freeGroups.map((g) => (
            <li key={g.key} className="kit-group">
              <header>
                <span className="kit-group__qty">{g.qty} 本</span>
                <span className="kit-lots">
                  {g.colorLotIds.map((id) => (
                    <span key={id} className="lot-chip">
                      <i className="lot-dot" style={{ background: lotColor(id) }} />
                      {lotName(id)}
                    </span>
                  ))}
                </span>
                {g.mixed && <span className="tag tag--warn">色批混用</span>}
              </header>
              <GroupSources
                g={g}
                sheetCount={g.sourceBatchBySheet.length}
                batchName={batchName}
              />
              <footer className="kit-group__actions">
                <label className="inline-qty">
                  锁定本数
                  <input
                    type="number"
                    min={1}
                    max={g.qty}
                    placeholder={String(g.qty)}
                    value={lockQty[g.key] ?? ''}
                    onChange={(e) => setLockQty((m) => ({ ...m, [g.key]: e.target.value }))}
                  />
                </label>
                <button type="button" className="btn btn--small" onClick={() => lockGroup(g)}>
                  🔒 锁定 {Math.min(g.qty, Math.floor(Number(lockQty[g.key]) || g.qty))} 本
                </button>
              </footer>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function GroupSources({
  g,
  sheetCount,
  batchName,
}: {
  g: KitGroup;
  sheetCount: number;
  batchName: (id: string) => string;
}) {
  return (
    <ol className="kit-sources">
      {Array.from({ length: sheetCount }, (_, si) => (
        <li key={si}>
          <span className="muted">第 {si + 1} 帖</span>
          <b>{batchName(g.sourceBatchBySheet[si])}</b>
        </li>
      ))}
    </ol>
  );
}
