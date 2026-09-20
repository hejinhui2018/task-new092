import { useState } from 'react';
import type { Sheet } from '../lib/imposition';
import {
  clampInt,
  normalizePairs,
  type CompatRules,
  type FoldStock,
  type InventoryDoc,
  type QcStatus,
} from '../lib/inventory';
import { uid } from '../lib/uid';

interface Props {
  sheets: Sheet[];
  inventory: InventoryDoc;
  /** 折手行高亮（与印张预览联动） */
  focusSheet: number | null;
  onFocusSheet: (i: number | null) => void;
  commitInventory: (updater: (inv: InventoryDoc) => InventoryDoc) => void;
}

const STATUS_LABEL: Record<QcStatus, string> = {
  ok: '合格',
  hold: '待复检',
  scrap: '报废',
};

/** 失焦才提交的数量输入，避免每个按键产生一个撤销点 */
function QtyInput({ value, onCommit }: { value: number; onCommit: (n: number) => void }) {
  return (
    <input
      key={value}
      type="number"
      min={0}
      defaultValue={value}
      className="qty-input"
      onBlur={(e) => {
        const n = clampInt(e.target.value);
        if (n !== value) onCommit(n);
        else e.target.value = String(value);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
    />
  );
}

/** 库存矩阵：折手 × 印刷批次 的正反面合格数与质检状态 */
export function InventoryPanel({ sheets, inventory, focusSheet, onFocusSheet, commitInventory }: Props) {
  const [addingLot, setAddingLot] = useState(false);
  const [newLotName, setNewLotName] = useState('');
  const [addingBatch, setAddingBatch] = useState(false);
  const [newBatchName, setNewBatchName] = useState('');
  const [newBatchLot, setNewBatchLot] = useState('');
  const [showCompat, setShowCompat] = useState(false);

  const lotColor = (id: string): string => {
    const idx = inventory.colorLots.findIndex((l) => l.id === id);
    const n = Math.max(1, inventory.colorLots.length);
    return `hsl(${Math.round(((idx < 0 ? 0 : idx) * 360) / n)}, 62%, 55%)`;
  };

  const findStock = (batchId: string, sheetIndex: number): FoldStock | undefined =>
    inventory.stocks.find((s) => s.batchId === batchId && s.sheetIndex === sheetIndex);

  const upsertStock = (batchId: string, sheetIndex: number, patch: Partial<FoldStock>) =>
    commitInventory((inv) => {
      const existing = inv.stocks.find((s) => s.batchId === batchId && s.sheetIndex === sheetIndex);
      if (existing) {
        return {
          ...inv,
          stocks: inv.stocks.map((s) => (s === existing ? { ...s, ...patch } : s)),
        };
      }
      return {
        ...inv,
        stocks: [
          ...inv.stocks,
          { batchId, sheetIndex, frontQty: 0, backQty: 0, status: 'ok', ...patch },
        ],
      };
    });

  const addColorLot = () => {
    const name = newLotName.trim();
    if (!name) return;
    commitInventory((inv) => ({
      ...inv,
      colorLots: [...inv.colorLots, { id: uid('lot'), name }],
    }));
    setNewLotName('');
    setAddingLot(false);
  };

  const addBatch = () => {
    const name = newBatchName.trim();
    const lotId = newBatchLot || inventory.colorLots[0]?.id;
    if (!name || !lotId) return;
    commitInventory((inv) => ({
      ...inv,
      batches: [...inv.batches, { id: uid('batch'), name, colorLotId: lotId }],
    }));
    setNewBatchName('');
    setAddingBatch(false);
  };

  const removeBatch = (batchId: string) => {
    commitInventory((inv) => ({
      ...inv,
      // 删除批次连带清理库存与引用它的锁定来源
      stocks: inv.stocks.filter((s) => s.batchId !== batchId),
      locks: inv.locks
        .map((l) => ({ ...l, sources: l.sources.filter((s) => s !== batchId) }))
        .filter((l) => l.sources.length === sheets.length),
    }));
  };

  const setCompat = (patch: Partial<CompatRules>) =>
    commitInventory((inv) => ({ ...inv, compat: { ...inv.compat, ...patch } }));

  const togglePair = (a: string, b: string) =>
    commitInventory((inv) => {
      if (inv.compat.mode !== 'pairs') return inv;
      const exists = inv.compat.pairs.some(
        ([x, y]) => (x === a && y === b) || (x === b && y === a),
      );
      const pairs = exists
        ? inv.compat.pairs.filter(([x, y]) => !((x === a && y === b) || (x === b && y === a)))
        : normalizePairs([...inv.compat.pairs, [a, b]]);
      return { ...inv, compat: { ...inv.compat, pairs } };
    });

  return (
    <section className="inventory-panel">
      <div className="panel-head">
        <h2>折手库存矩阵</h2>
        <span className="muted">正反面须同批合格才能入册 · 点击折手行联动印张</span>
      </div>

      {/* 色批与批次 */}
      <div className="inv-toolbar">
        <div className="inv-lots">
          {inventory.colorLots.map((lot) => (
            <span key={lot.id} className="lot-chip">
              <i className="lot-dot" style={{ background: lotColor(lot.id) }} />
              {lot.name}
            </span>
          ))}
          {addingLot ? (
            <span className="inline-form">
              <input
                autoFocus
                value={newLotName}
                placeholder="新色批名"
                onChange={(e) => setNewLotName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addColorLot()}
              />
              <button type="button" className="mini-btn" onClick={addColorLot}>
                加
              </button>
              <button type="button" className="mini-btn" onClick={() => setAddingLot(false)}>
                消
              </button>
            </span>
          ) : (
            <button type="button" className="mini-btn" onClick={() => setAddingLot(true)}>
              + 色批
            </button>
          )}
        </div>
        <button
          type="button"
          className={`mini-btn ${showCompat ? 'mini-btn--on' : ''}`}
          onClick={() => setShowCompat((v) => !v)}
        >
          色批混用规则
        </button>
      </div>

      {showCompat && (
        <div className="compat-box">
          <div className="compat-modes" role="group" aria-label="色批兼容规则">
            {(
              [
                ['same', '仅同色批'],
                ['pairs', '指定色批对可混'],
                ['any', '任意混用'],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                className={`mini-btn ${inventory.compat.mode === mode ? 'mini-btn--on' : ''}`}
                onClick={() => setCompat({ mode })}
              >
                {label}
              </button>
            ))}
          </div>
          {inventory.compat.mode === 'pairs' && inventory.colorLots.length >= 2 && (
            <div className="compat-pairs">
              {inventory.colorLots.map((a, i) =>
                inventory.colorLots.slice(i + 1).map((b) => {
                  const on = inventory.compat.pairs.some(
                    ([x, y]) => (x === a.id && y === b.id) || (x === b.id && y === a.id),
                  );
                  return (
                    <label key={`${a.id}-${b.id}`} className="pair-check">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => togglePair(a.id, b.id)}
                      />
                      <i className="lot-dot" style={{ background: lotColor(a.id) }} />
                      {a.name}
                      <span className="muted">⇄</span>
                      <i className="lot-dot" style={{ background: lotColor(b.id) }} />
                      {b.name}
                    </label>
                  );
                }),
              )}
            </div>
          )}
        </div>
      )}

      {/* 批次管理 */}
      <div className="inv-batches">
        {inventory.batches.map((b) => (
          <span key={b.id} className="batch-chip">
            <i className="lot-dot" style={{ background: lotColor(b.colorLotId) }} />
            {b.name}
            <button
              type="button"
              className="mini-btn mini-btn--danger"
              title="删除该批次及其全部库存"
              onClick={() => removeBatch(b.id)}
            >
              ✕
            </button>
          </span>
        ))}
        {addingBatch ? (
          <span className="inline-form">
            <input
              autoFocus
              value={newBatchName}
              placeholder="批次名（如 7/20 追印）"
              onChange={(e) => setNewBatchName(e.target.value)}
            />
            <select value={newBatchLot} onChange={(e) => setNewBatchLot(e.target.value)}>
              <option value="">选色批</option>
              {inventory.colorLots.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
            <button type="button" className="mini-btn" onClick={addBatch}>
              加
            </button>
            <button type="button" className="mini-btn" onClick={() => setAddingBatch(false)}>
              消
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="mini-btn"
            disabled={inventory.colorLots.length === 0}
            onClick={() => {
              setNewBatchLot(inventory.colorLots[0]?.id ?? '');
              setAddingBatch(true);
            }}
          >
            + 印刷批次
          </button>
        )}
      </div>

      {/* 矩阵 */}
      <div className="inv-matrix">
        {sheets.map((sheet) => {
          const focused = focusSheet === sheet.index;
          return (
            <div
              key={sheet.index}
              className={`inv-row ${focused ? 'is-focused' : ''}`}
              onMouseEnter={() => onFocusSheet(sheet.index)}
            >
              <div className="inv-row__head">
                <button
                  type="button"
                  className="inv-row__title"
                  onClick={() => onFocusSheet(focused ? null : sheet.index)}
                >
                  第 {sheet.index + 1} 帖
                </button>
                <span className="muted">
                  {sheet.index === 0 ? '最外帖' : `内第 ${sheet.index + 1} 层`}
                </span>
              </div>
              {inventory.batches.length === 0 && (
                <p className="hint">尚无印刷批次，先添加批次再登记正反面合格数。</p>
              )}
              {inventory.batches.map((batch) => {
                const st = findStock(batch.id, sheet.index);
                const status: QcStatus = st?.status ?? 'ok';
                const rowCls =
                  status === 'scrap'
                    ? 'inv-cell inv-cell--scrap'
                    : status === 'hold'
                      ? 'inv-cell inv-cell--hold'
                      : 'inv-cell';
                return (
                  <div key={batch.id} className={rowCls}>
                    <span className="inv-cell__batch">
                      <i className="lot-dot" style={{ background: lotColor(batch.colorLotId) }} />
                      {batch.name}
                      {!st && <em className="muted">未登记</em>}
                    </span>
                    <label className="inv-qty">
                      正
                      <QtyInput
                        value={st?.frontQty ?? 0}
                        onCommit={(n) => upsertStock(batch.id, sheet.index, { frontQty: n })}
                      />
                    </label>
                    <label className="inv-qty">
                      背
                      <QtyInput
                        value={st?.backQty ?? 0}
                        onCommit={(n) => upsertStock(batch.id, sheet.index, { backQty: n })}
                      />
                    </label>
                    <div className="inv-status" role="group" aria-label="质检状态">
                      {(Object.keys(STATUS_LABEL) as QcStatus[]).map((s) => (
                        <button
                          key={s}
                          type="button"
                          className={`mini-btn ${status === s ? `mini-btn--status-${s}` : ''}`}
                          aria-pressed={status === s}
                          onClick={() => upsertStock(batch.id, sheet.index, { status: s })}
                        >
                          {STATUS_LABEL[s]}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      {focusSheet !== null && (
        <p className="hint">已联动到第 {focusSheet + 1} 帖印张（中间栏高亮）。</p>
      )}
    </section>
  );
}
