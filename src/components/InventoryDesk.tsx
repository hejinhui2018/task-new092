import type { KitGroup, ReprintCandidate, StockLot } from '../types';
import type { Allocation, StockSummary } from '../lib/inventory';
import { StockMatrix } from './StockMatrix';
import { KitsPanel } from './KitsPanel';
import { ReprintPanel } from './ReprintPanel';

interface InventoryDeskProps {
  lots: StockLot[];
  sheetCount: number;
  focusSheet: number | null;
  lockedGroups: KitGroup[];
  target: number;
  allocation: Allocation;
  summary: StockSummary;
  lockedUsage: Map<string, number>;
  onAddLot: (sheetIndex: number) => void;
  onChangeLot: (id: string, patch: Partial<Omit<StockLot, 'id'>>) => void;
  onRemoveLot: (id: string) => void;
  onLock: (group: KitGroup) => void;
  onUnlock: (groupId: string) => void;
  onTargetChange: (target: number) => void;
  onAdopt: (candidate: ReprintCandidate) => void;
}

/** 折手库存工作台：库存矩阵 + 成套批次 + 补印清单（首屏与印张预览联动） */
export function InventoryDesk(props: InventoryDeskProps) {
  return (
    <section className="inventory" id="inventory-desk">
      <header className="panel-head inventory__head">
        <h2>折手库存与补印决策</h2>
        <span className="muted">
          按「正反面同批合格」登记到货，系统先单色批成套、再色批混用兜底
        </span>
      </header>
      <div className="inventory__grid">
        <div className="inventory__col inventory__col--matrix" id="stock-matrix-scroll">
          <h3 className="inventory__subhead">库存矩阵</h3>
          <StockMatrix
            lots={props.lots}
            sheetCount={props.sheetCount}
            lockedUsage={props.lockedUsage}
            focusSheet={props.focusSheet}
            onAdd={props.onAddLot}
            onChange={props.onChangeLot}
            onRemove={props.onRemoveLot}
          />
        </div>
        <div className="inventory__col inventory__col--side">
          <h3 className="inventory__subhead">成套批次</h3>
          <KitsPanel
            allocation={props.allocation}
            summary={props.summary}
            lots={props.lots}
            onLock={props.onLock}
            onUnlock={props.onUnlock}
          />
          <ReprintPanel
            lots={props.lots}
            sheetCount={props.sheetCount}
            lockedGroups={props.lockedGroups}
            target={props.target}
            onTargetChange={props.onTargetChange}
            onAdopt={props.onAdopt}
          />
        </div>
      </div>
    </section>
  );
}
