import type { PlateStatus, StockLot } from '../types';
import { lotBlockReason, lotCapacity } from '../lib/inventory';

interface StockMatrixProps {
  lots: StockLot[];
  sheetCount: number;
  /** 每条到货记录被有效锁定批次占用的数量 */
  lockedUsage: Map<string, number>;
  /** 需要高亮聚焦的折手（点击印张卡片联动） */
  focusSheet: number | null;
  onAdd: (sheetIndex: number) => void;
  onChange: (id: string, patch: Partial<Omit<StockLot, 'id'>>) => void;
  onRemove: (id: string) => void;
}

const STATUS_LABEL: Record<PlateStatus, string> = {
  ok: '合格',
  hold: '待检',
  scrap: '报废',
};

const STATUS_ORDER: PlateStatus[] = ['ok', 'hold', 'scrap'];

const cycleStatus = (s: PlateStatus): PlateStatus =>
  STATUS_ORDER[(STATUS_ORDER.indexOf(s) + 1) % STATUS_ORDER.length];

const StatusButton = ({
  status,
  onCycle,
}: {
  status: PlateStatus;
  onCycle: () => void;
}) => (
  <button
    type="button"
    className={`stock-status stock-status--${status}`}
    title="点击切换：合格 → 待复检 → 报废"
    onClick={onCycle}
  >
    {STATUS_LABEL[status]}
  </button>
);

const QtyInput = ({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) => (
  <input
    type="number"
    min={0}
    step={10}
    value={value}
    onChange={(e) => onChange(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
  />
);

/** 折手库存矩阵：按折手分组登记各印刷批次的正反面合格数量、色批与检验状态 */
export function StockMatrix({
  lots,
  sheetCount,
  lockedUsage,
  focusSheet,
  onAdd,
  onChange,
  onRemove,
}: StockMatrixProps) {
  if (sheetCount <= 0) {
    return <p className="hint">暂无印张，无法登记折手库存。</p>;
  }

  return (
    <div className="stock-matrix">
      <div className="stock-matrix__head">
        <span>色批</span>
        <span>正面（数量/状态）</span>
        <span>背面（数量/状态）</span>
        <span>成套能力</span>
        <span />
      </div>

      {Array.from({ length: sheetCount }, (_, s) => s).map((s) => {
        const rows = lots.filter((l) => l.sheetIndex === s);
        const cap = rows.reduce((sum, l) => sum + lotCapacity(l), 0);
        const used = rows.reduce((sum, l) => sum + (lockedUsage.get(l.id) ?? 0), 0);
        const free = cap - used;
        return (
          <div
            key={s}
            className={`stock-group ${focusSheet === s ? 'stock-group--focus' : ''} ${
              cap === 0 ? 'stock-group--missing' : ''
            }`}
          >
            <div className="stock-group__title">
              第 {s + 1} 帖
              <small>
                合格 {cap} · 可配 {free}
                {cap === 0 && ' · 断供'}
              </small>
            </div>

            {rows.length === 0 && <div className="stock-group__empty">尚无到货记录</div>}

            {rows.map((lot) => {
              const reason = lotBlockReason(lot);
              return (
                <div key={lot.id} className={`stock-row ${reason ? 'stock-row--blocked' : ''}`}>
                  <label className="stock-batch">
                    <input
                      type="text"
                      maxLength={6}
                      value={lot.colorBatch}
                      onChange={(e) => onChange(lot.id, { colorBatch: e.target.value || 'A' })}
                    />
                  </label>
                  <div className="stock-cell">
                    <QtyInput
                      value={lot.frontQty}
                      onChange={(v) => onChange(lot.id, { frontQty: v })}
                    />
                    <StatusButton
                      status={lot.frontStatus}
                      onCycle={() => onChange(lot.id, { frontStatus: cycleStatus(lot.frontStatus) })}
                    />
                  </div>
                  <div className="stock-cell">
                    <QtyInput
                      value={lot.backQty}
                      onChange={(v) => onChange(lot.id, { backQty: v })}
                    />
                    <StatusButton
                      status={lot.backStatus}
                      onCycle={() => onChange(lot.id, { backStatus: cycleStatus(lot.backStatus) })}
                    />
                  </div>
                  <div className="stock-cap">
                    <b>{lotCapacity(lot)}</b>
                    {(lockedUsage.get(lot.id) ?? 0) > 0 && (
                      <small>锁 {lockedUsage.get(lot.id)}</small>
                    )}
                  </div>
                  <button
                    type="button"
                    className="mini-btn mini-btn--danger"
                    title="删除该到货记录"
                    onClick={() => onRemove(lot.id)}
                  >
                    ✕
                  </button>
                  {reason && <div className="stock-row__warn">⚠ {reason}</div>}
                </div>
              );
            })}

            <button type="button" className="mini-btn stock-group__add" onClick={() => onAdd(s)}>
              ＋ 登记批次
            </button>
          </div>
        );
      })}
      <p className="hint">
        正反面必须同批且两面均合格才能装订；点击状态钮可在 合格 / 待复检 / 报废 间循环。
      </p>
    </div>
  );
}
