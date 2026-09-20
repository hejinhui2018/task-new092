import { useEffect, useMemo, useState } from 'react';
import type { KitGroup, ReprintCandidate, StockLot } from '../types';
import { planReprints } from '../lib/inventory';

interface ReprintPanelProps {
  lots: StockLot[];
  sheetCount: number;
  lockedGroups: KitGroup[];
  target: number;
  onTargetChange: (target: number) => void;
  onAdopt: (candidate: ReprintCandidate) => void;
}

/** 补印决策：设定交付目标、比较候选并解释每案能补齐的书册区间 */
export function ReprintPanel({
  lots,
  sheetCount,
  lockedGroups,
  target,
  onTargetChange,
  onAdopt,
}: ReprintPanelProps) {
  const [draft, setDraft] = useState(String(target || ''));

  useEffect(() => {
    setDraft(target ? String(target) : '');
  }, [target]);

  const goal = Number(draft);
  const plan = useMemo(
    () =>
      sheetCount > 0 && draft !== '' && Number.isFinite(goal) && goal > 0
        ? planReprints(sheetCount, lots, lockedGroups, Math.floor(goal))
        : null,
    [sheetCount, lots, lockedGroups, draft, goal],
  );

  const met = plan && plan.candidates.length === 0 && !plan.infeasible;

  return (
    <section className="reprint-panel">
      <header className="panel-head">
        <h2>补印决策</h2>
      </header>

      <label className="reprint-target">
        交付目标
        <input
          type="number"
          min={1}
          step={50}
          value={draft}
          placeholder="例如 600"
          onChange={(e) => {
            setDraft(e.target.value);
            onTargetChange(Math.max(0, Math.floor(Number(e.target.value) || 0)));
          }}
        />
        <span>本</span>
      </label>

      {plan === null && <p className="hint">输入交付目标后比较各候选方案。</p>}

      {plan && plan.infeasible && (
        <div className="reprint-infeasible">
          <strong>无解：</strong>
          {plan.infeasible}
        </div>
      )}

      {plan && met && (
        <p className="reprint-met">
          ✓ 现存 {plan.base} 本已满足目标，无需补印
          {plan.lockedBooks > 0 && `（含已锁定 ${plan.lockedBooks} 本）`}。
        </p>
      )}

      {plan && !plan.infeasible && !met && (
        <>
          <p className="hint reprint-summary-hint">
            现存可装订 <b>{plan.base}</b> 本（含锁定 {plan.lockedBooks} 本），
            候选按 <b>开机版组数 → 补印印张数 → 剩余浪费</b> 排序。
          </p>
          <ul className="cand-list">
            {plan.candidates.map((c, i) => (
              <li key={c.id} className={`cand-row ${i === 0 ? 'cand-row--best' : ''}`}>
                <header className="cand-row__head">
                  {i === 0 && <span className="cand-badge">推荐</span>}
                  <strong>{c.lines[0] ? candTitle(c) : '—'}</strong>
                  <span className="cand-metrics">
                    <span>{c.plateGroups} 组版</span>
                    <span>{c.sheets} 张</span>
                    <span>浪费 {c.waste}</span>
                    <span>共 {c.totalBooks} 本</span>
                  </span>
                  <button type="button" className="mini-btn mini-btn--primary" onClick={() => onAdopt(c)}>
                    采用
                  </button>
                </header>
                <ul className="cand-explain">
                  {c.explanation.map((line, k) => (
                    <li key={k}>{line}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

const candTitle = (c: ReprintCandidate): string => {
  const batches = [...new Set(c.lines.map((l) => l.colorBatch))].sort();
  return batches.length > 1 ? `色批混用（${batches.join('+')}）` : `${batches[0]} 批补印`;
};
