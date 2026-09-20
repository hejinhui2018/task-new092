import type { Sheet } from '../lib/imposition';
import type { FlipMode } from '../types';
import { SlotView } from './SlotView';

interface SheetCardProps {
  sheet: Sheet;
  flip: FlipMode;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  /** 该折手正反面同批合格能力（无库存数据时为 null） */
  capacity: number | null;
  free: number;
  locked: number;
  focused: boolean;
  onFocus: (sheetIndex: number) => void;
}

/** 一张印张：正面与背面，按翻面方式左右并排或上下叠放，中缝为折线/装订口 */
export function SheetCard({
  sheet,
  flip,
  selectedKey,
  onSelect,
  capacity,
  free,
  locked,
  focused,
  onFocus,
}: SheetCardProps) {
  const keyOf = (side: 'front' | 'back', pos: number) =>
    `${sheet.index}:${side}:${pos}`;

  const stockClass =
    capacity === null
      ? ''
      : capacity === 0
        ? 'sheet-stock--missing'
        : free === 0 && capacity > 0
          ? 'sheet-stock--locked'
          : 'sheet-stock--ok';

  return (
    <section
      id={`sheet-card-${sheet.index}`}
      className={`sheet-card sheet-card--${flip} ${focused ? 'sheet-card--focus' : ''}`}
    >
      <header className="sheet-card__head">
        <h3>第 {sheet.index + 1} 帖印张</h3>
        <span className="muted">
          {sheet.index === 0 ? '最外帖（封面/封底）' : `由外向内第 ${sheet.index + 1} 层`}
        </span>
        {capacity !== null && (
          <button
            type="button"
            className={`sheet-stock ${stockClass}`}
            onClick={() => onFocus(sheet.index)}
            title="跳转到库存矩阵中该折手"
          >
            {capacity === 0
              ? '库存断供 ✕'
              : `库存 ${capacity}${locked > 0 ? ` · 锁 ${locked}` : ''} · 可配 ${free}`}
          </button>
        )}
      </header>

      <div className={`sheet-card__sides`}>
        {(['front', 'back'] as const).map((side) => (
          <div key={side} className={`side side--${flip}`}>
            <div className="side__label">
              <strong>{side === 'front' ? '正面' : '背面'}</strong>
              <span>{side === 'front' ? '外开面' : '内开面（翻面后所见）'}</span>
            </div>
            <div className={`side__plates side__plates--${flip}`}>
              <SlotView
                slot={sheet[side][0]}
                flip={flip}
                active={selectedKey === keyOf(side, 0)}
                onSelect={() => onSelect(keyOf(side, 0))}
              />
              <div className={`fold-gutter fold-gutter--${flip}`} aria-hidden>
                <span className="fold-gutter__line" />
                <span className="fold-gutter__text">折口 / 装订</span>
                <span className="fold-gutter__line" />
              </div>
              <SlotView
                slot={sheet[side][1]}
                flip={flip}
                active={selectedKey === keyOf(side, 1)}
                onSelect={() => onSelect(keyOf(side, 1))}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
