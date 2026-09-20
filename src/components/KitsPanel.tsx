import type { KitGroup, StockLot } from '../types';
import type { Allocation, StockSummary } from '../lib/inventory';
import { mixLabel } from '../lib/inventory';

interface KitsPanelProps {
  allocation: Allocation;
  summary: StockSummary;
  lots: StockLot[];
  onLock: (group: KitGroup) => void;
  onUnlock: (groupId: string) => void;
}

/** 成套批次：可装订数、短板、未配套余量与锁定/水填批次清单 */
export function KitsPanel({ allocation, summary, lots, onLock, onUnlock }: KitsPanelProps) {
  const lotById = new Map(lots.map((l) => [l.id, l]));

  return (
    <section className="kits-panel">
      <div className="kits-stats">
        <div className="kits-stat kits-stat--main">
          <span className="kits-stat__num">{allocation.bookCount}</span>
          <span className="kits-stat__label">现存可装订（本）</span>
        </div>
        <div className="kits-stat">
          <span className="kits-stat__num">{allocation.lockedBooks}</span>
          <span className="kits-stat__label">已锁定成套</span>
        </div>
        <div className="kits-stat">
          <span className="kits-stat__num">
            {allocation.bookCount - allocation.lockedBooks}
          </span>
          <span className="kits-stat__label">未锁定水填</span>
        </div>
        <div className="kits-stat">
          <span className="kits-stat__num">{summary.waste}</span>
          <span className="kits-stat__label">未配套余量（张）</span>
        </div>
      </div>

      {summary.missingSheets.length > 0 && (
        <p className="kits-constraint kits-constraint--bad">
          ✕ 断供折手：
          {summary.missingSheets.map((s) => `第 ${s.sheetIndex + 1} 帖`).join('、')}
          ，现存印张一本也装不成，必须补印或解除报废/复检。
        </p>
      )}
      {summary.missingSheets.length === 0 && summary.bottlenecks.length > 0 && (
        <p className="kits-constraint">
          ⚠ 短板折手：
          {summary.bottlenecks.map((s) => `第 ${s.sheetIndex + 1} 帖（${s.qty} 张）`).join('、')}
          ，可装订数被它卡住；其余折手的多出印张无法配套。
        </p>
      )}
      {summary.surplus.length > 0 && (
        <p className="kits-constraint kits-constraint--soft">
          未配套余量：
          {summary.surplus.map((s) => `第 ${s.sheetIndex + 1} 帖 +${s.qty}`).join('、')}（张）
        </p>
      )}

      <ul className="kit-list">
        {allocation.groups.length === 0 && (
          <li className="hint">没有可成套的折手组合：请先在库存矩阵登记合格到货。</li>
        )}
        {allocation.groups.map((g) => {
          const isLocked = allocation.locked.some((l) => l.id === g.id);
          return (
            <li key={g.id} className={`kit-row ${isLocked ? 'kit-row--locked' : ''}`}>
              <div className="kit-row__head">
                <span className={`kit-badge ${isLocked ? 'kit-badge--locked' : ''}`}>
                  {isLocked ? '🔒 已锁定' : '💧 水填'}
                </span>
                <strong>{mixLabel(g.mixKey)}</strong>
                <b className="kit-row__qty">× {g.qty} 本</b>
                {isLocked ? (
                  <button type="button" className="mini-btn" onClick={() => onUnlock(g.id)}>
                    解锁
                  </button>
                ) : (
                  <button type="button" className="mini-btn mini-btn--primary" onClick={() => onLock(g)}>
                    锁定此批次
                  </button>
                )}
              </div>
              <div className="kit-row__sheets">
                {g.lotIds.map((lotId, s) => {
                  const lot = lotId ? lotById.get(lotId) : undefined;
                  return (
                    <span key={s} className="kit-sheet-chip" title={lot?.id}>
                      第{s + 1}帖·{lot?.colorBatch ?? '?'}
                    </span>
                  );
                })}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="hint">
        分配按「先单色批各自配套、再全色批混用兜底」的固定顺序进行；锁定后该批印张即被占用，
        补印测算会原样保留。
      </p>
    </section>
  );
}
