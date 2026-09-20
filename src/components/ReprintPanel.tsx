import { useEffect, useState } from 'react';
import {
  adoptReprintOption,
  clampInt,
  type InventoryDoc,
  type ReprintOption,
  type ReprintPlan,
} from '../lib/inventory';
import { uid } from '../lib/uid';

interface Props {
  plan: ReprintPlan;
  inventory: InventoryDoc;
  lotColor: (id: string) => string;
  lotName: (id: string) => string;
  commitInventory: (updater: (inv: InventoryDoc) => InventoryDoc) => void;
}

/** 交付目标 + 补印候选清单（开机版组数 / 印张数 / 浪费排序，含解释与采用） */
export function ReprintPanel({ plan, inventory, lotColor, lotName, commitInventory }: Props) {
  const [targetText, setTargetText] = useState(
    inventory.deliveryTarget == null ? '' : String(inventory.deliveryTarget),
  );

  // 外部状态变化（撤销/重做/采用后）同步输入框
  useEffect(() => {
    setTargetText(inventory.deliveryTarget == null ? '' : String(inventory.deliveryTarget));
  }, [inventory.deliveryTarget]);

  const applyTarget = () => {
    const trimmed = targetText.trim();
    const value = trimmed === '' ? null : clampInt(trimmed);
    if (value === inventory.deliveryTarget) return;
    commitInventory((inv) => ({ ...inv, deliveryTarget: value }));
  };

  const adopt = (option: ReprintOption) => {
    commitInventory((inv) => adoptReprintOption(inv, option, () => uid('batch')).doc);
  };

  const hasTarget = inventory.deliveryTarget != null;
  const met = hasTarget && plan.gap === 0;

  return (
    <section className="reprint-panel">
      <div className="panel-head">
        <h2>补印决策</h2>
        <span className="muted">按 开机版组数 → 印张数 → 剩余浪费 排序</span>
      </div>

      <div className="reprint-target">
        <label>
          交付目标（本）
          <input
            type="number"
            min={0}
            placeholder="如 150"
            value={targetText}
            onChange={(e) => setTargetText(e.target.value)}
            onBlur={applyTarget}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
        </label>
        <div className="reprint-target__status">
          {!hasTarget && <span className="muted">输入目标后开始比较补印候选</span>}
          {hasTarget && met && (
            <span className="status-pill status-pill--ok">现存 {plan.currentBooks} 本已达标</span>
          )}
          {hasTarget && !met && (
            <span className="status-pill status-pill--bad">
              现存 {plan.currentBooks} 本 · 缺 {plan.gap} 本 · 已锁 {plan.lockedBooks}
            </span>
          )}
        </div>
      </div>

      {hasTarget && !met && plan.options.length > 0 && (
        <ol className="reprint-options">
          {plan.options.map((opt, i) => (
            <li key={opt.key} className={`reprint-option ${i === 0 ? 'is-best' : ''}`}>
              <header>
                {i === 0 && <span className="tag tag--best">最省开机</span>}
                <span className="reprint-option__lots">
                  <i className="lot-dot" style={{ background: lotColor(opt.colorLotId) }} />
                  补印色批：{lotName(opt.colorLotId)}
                </span>
              </header>
              <div className="reprint-metrics">
                <div>
                  <b>{opt.plateGroups}</b>
                  <span>开机版组</span>
                </div>
                <div>
                  <b>{opt.pressSheets}</b>
                  <span>补印印张</span>
                </div>
                <div>
                  <b className={opt.wasteSheets > 0 ? 'metric--warn' : ''}>
                    {opt.wasteSheets}
                  </b>
                  <span>剩余浪费</span>
                </div>
                <div>
                  <b>{opt.resultingBooks}</b>
                  <span>采用后可装</span>
                </div>
              </div>
              <ul className="reprint-plates">
                {opt.plates.map((p) => (
                  <li key={p.sheetIndex}>
                    第 {p.sheetIndex + 1} 帖 × {p.qty} 份（正反面各 {p.qty} 张）
                  </li>
                ))}
              </ul>
              <ul className="reprint-why">
                {opt.explanations.map((line, j) => (
                  <li key={j}>{line}</li>
                ))}
              </ul>
              <button type="button" className="btn btn--small btn--block" onClick={() => adopt(opt)}>
                采用此方案（登记补印批次）
              </button>
            </li>
          ))}
        </ol>
      )}

      {hasTarget && !met && plan.options.length === 0 && (
        <div className="reprint-infeasible">
          <h4>当前约束下无解</h4>
          <ul>
            {plan.infeasible.map((line, i) => (
              <li key={i}>⛔ {line}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
