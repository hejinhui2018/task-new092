import { useEffect, useMemo, useState } from 'react';
import type { ArtPage } from './types';
import { useDeskState } from './state';
import { buildImposition } from './lib/imposition';
import { diagnose } from './lib/diagnostics';
import { allocate, planReprint, type InventoryDoc } from './lib/inventory';
import { PageList } from './components/PageList';
import { SheetCard } from './components/SheetCard';
import { IssuesPanel } from './components/IssuesPanel';
import { PreviewModal } from './components/PreviewModal';
import { InventoryPanel } from './components/InventoryPanel';
import { KittingPanel } from './components/KittingPanel';
import { ReprintPanel } from './components/ReprintPanel';

export default function App() {
  const desk = useDeskState();
  const { state } = desk;
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  /** 库存矩阵与印张预览的联动折手（hover 行 / 点击标题） */
  const [focusSheet, setFocusSheet] = useState<number | null>(null);

  const imp = useMemo(() => buildImposition(state.pages, state.flip), [state.pages, state.flip]);
  const issues = useMemo(() => diagnose(imp.pages), [imp.pages]);

  // 折手数变化（增减页面）后把联动位置收敛到合法范围
  useEffect(() => {
    if (focusSheet !== null && focusSheet > imp.sheets.length - 1) {
      setFocusSheet(imp.sheets.length > 0 ? imp.sheets.length - 1 : null);
    }
  }, [imp.sheets.length, focusSheet]);

  // 页面减少后，把预演位置收敛到合法范围
  useEffect(() => {
    if (state.previewIndex > imp.paddedCount - 1) {
      desk.setEphemeral({ previewIndex: Math.max(0, imp.paddedCount - 1) });
    }
  }, [imp.paddedCount, state.previewIndex, desk]);

  // 键盘撤销 / 重做（输入框中不拦截）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const el = e.target as HTMLElement | null;
      if (el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return;
      if (e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        desk.undo();
      } else if (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)) {
        e.preventDefault();
        desk.redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // desk 的方法内部均为函数式 setState，闭包旧引用依然安全
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commit = desk.commit;
  const patch = (p: Partial<{ pages: ArtPage[]; flip: typeof state.flip }>) =>
    commit((doc) => ({ ...doc, ...p }));

  const commitInventory = (updater: (inv: InventoryDoc) => InventoryDoc) =>
    commit((doc) => ({ ...doc, inventory: updater(doc.inventory) }));

  const handleReorder = (pages: ArtPage[]) => patch({ pages });
  const handleAdd = (page: ArtPage) => commit((doc) => ({ ...doc, pages: [...doc.pages, page] }));
  const handleDelete = (id: string) =>
    commit((doc) => ({ ...doc, pages: doc.pages.filter((p) => p.id !== id) }));
  const handleChange = (id: string, p: Partial<ArtPage>) =>
    commit((doc) => ({
      ...doc,
      pages: doc.pages.map((pg) => (pg.id === id ? { ...pg, ...p } : pg)),
    }));

  const alloc = useMemo(
    () => allocate(state.inventory, imp.sheets.length),
    [state.inventory, imp.sheets.length],
  );
  const plan = useMemo(
    () => planReprint(state.inventory, imp.sheets.length),
    [state.inventory, imp.sheets.length],
  );

  const lotName = (id: string) =>
    state.inventory.colorLots.find((l) => l.id === id)?.name ?? id;
  const lotColor = (id: string): string => {
    const idx = state.inventory.colorLots.findIndex((l) => l.id === id);
    const n = Math.max(1, state.inventory.colorLots.length);
    return `hsl(${Math.round(((idx < 0 ? 0 : idx) * 360) / n)}, 62%, 55%)`;
  };
  const batchName = (id: string) =>
    state.inventory.batches.find((b) => b.id === id)?.name ?? id;

  const errorCount = issues.filter((i) => i.level === 'error').length;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__brand">
          <h1>骑马钉拼版台 · 装订配套</h1>
          <span className="muted">看清每张印张，也看清现存印张能装成多少本</span>
        </div>

        <div className="topbar__tools">
          <div className="history-buttons" role="group" aria-label="撤销重做">
            <button
              type="button"
              className="btn"
              onClick={desk.undo}
              disabled={!desk.canUndo}
              title="撤销（Ctrl+Z）"
            >
              ↶ 撤销
            </button>
            <button
              type="button"
              className="btn"
              onClick={desk.redo}
              disabled={!desk.canRedo}
              title="重做（Ctrl+Y）"
            >
              ↷ 重做
            </button>
          </div>

          <div className="flip-switch" role="group" aria-label="翻面方式">
            <button
              type="button"
              className={state.flip === 'long' ? 'is-active' : ''}
              onClick={() => patch({ flip: 'long' })}
            >
              长边翻面
              <small>左右翻 · 书本式</small>
            </button>
            <button
              type="button"
              className={state.flip === 'short' ? 'is-active' : ''}
              onClick={() => patch({ flip: 'short' })}
            >
              短边翻面
              <small>上下翻 · 台历式</small>
            </button>
          </div>

          <button
            type="button"
            className="btn btn--primary"
            onClick={() => desk.setEphemeral({ previewOpen: true })}
            disabled={imp.paddedCount === 0}
          >
            📖 折叠预演
          </button>
        </div>
      </header>

      <div className="summary-bar">
        <span>内容稿 <b>{state.pages.length}</b> 页</span>
        <span>自动补白 <b>{imp.addedBlanks}</b> 页</span>
        <span>成书 <b>{imp.paddedCount}</b> 页 · <b>{imp.sheets.length}</b> 张印张</span>
        <span className={alloc.bookCount > 0 ? 'summary-bar--ok' : ''}>
          现存印张可装 <b>{alloc.bookCount}</b> 本
          {alloc.lockedBooks > 0 && `（已锁 ${alloc.lockedBooks}）`}
        </span>
        {state.inventory.deliveryTarget != null && (
          <span
            className={
              alloc.bookCount >= state.inventory.deliveryTarget
                ? 'summary-bar--ok'
                : 'summary-bar--bad'
            }
          >
            目标 {state.inventory.deliveryTarget} 本 ·{' '}
            {alloc.bookCount >= state.inventory.deliveryTarget
              ? '✓ 已达标'
              : `缺 ${state.inventory.deliveryTarget - alloc.bookCount} 本`}
          </span>
        )}
        <span className={errorCount > 0 ? 'summary-bar--bad' : 'summary-bar--ok'}>
          {errorCount > 0 ? `⚠ ${errorCount} 个版面错误` : '✓ 版面检查通过'}
        </span>
      </div>

      <main className="layout">
        <PageList
          pages={state.pages}
          onReorder={handleReorder}
          onAdd={handleAdd}
          onDelete={handleDelete}
          onChange={handleChange}
        />

        <section className="sheet-area">
          <div className="panel-head">
            <h2>印张拼版（{state.flip === 'long' ? '长边翻面' : '短边翻面'}）</h2>
            <span className="muted">中缝为折口/装订位，虚线为裁切线，外圈色带为出血区；标题与库存矩阵联动</span>
          </div>
          {imp.sheets.length === 0 ? (
            <p className="hint">暂无页面，请在左侧增加至少一个页面。</p>
          ) : (
            <div className="sheet-stack">
              {imp.sheets.map((sheet) => (
                <SheetCard
                  key={sheet.index}
                  sheet={sheet}
                  flip={state.flip}
                  selectedKey={selectedKey}
                  onSelect={setSelectedKey}
                  focused={focusSheet === sheet.index}
                  onFocusChange={(on) => setFocusSheet(on ? sheet.index : null)}
                />
              ))}
            </div>
          )}
        </section>

        <IssuesPanel
          issues={issues}
          onJump={(pageIndex) => {
            desk.setEphemeral({ previewOpen: true, previewIndex: pageIndex });
          }}
        />
      </main>

      <section className="bindery-area" aria-label="折手库存与补印决策">
        <InventoryPanel
          sheets={imp.sheets}
          inventory={state.inventory}
          focusSheet={focusSheet}
          onFocusSheet={setFocusSheet}
          commitInventory={commitInventory}
        />
        <div className="bindery-area__row">
          <KittingPanel
            alloc={alloc}
            inventory={state.inventory}
            batchName={batchName}
            lotName={lotName}
            lotColor={lotColor}
            commitInventory={commitInventory}
          />
          <ReprintPanel
            plan={plan}
            inventory={state.inventory}
            lotColor={lotColor}
            lotName={lotName}
            commitInventory={commitInventory}
          />
        </div>
      </section>

      {state.previewOpen && imp.paddedCount > 0 && (
        <PreviewModal
          imp={imp}
          index={Math.min(state.previewIndex, imp.paddedCount - 1)}
          issues={issues}
          onNavigate={(previewIndex) => desk.setEphemeral({ previewIndex })}
          onClose={() => desk.setEphemeral({ previewOpen: false })}
        />
      )}
    </div>
  );
}
