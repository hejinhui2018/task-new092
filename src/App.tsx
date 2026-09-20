import { useEffect, useMemo, useRef, useState } from 'react';
import type { ArtPage, KitGroup, ReprintCandidate } from './types';
import { useDeskHistory } from './state';
import { buildImposition } from './lib/imposition';
import { diagnose } from './lib/diagnostics';
import {
  adoptReprint,
  allocateKits,
  lockKitGroup,
  lotCapacity,
  lotFree,
  lockedUsageMap,
  normalizeLots,
  reconcileInventory,
  removeLot,
  stockSummary,
  unlockKitGroup,
  updateLot,
} from './lib/inventory';
import { PageList } from './components/PageList';
import { SheetCard } from './components/SheetCard';
import { IssuesPanel } from './components/IssuesPanel';
import { PreviewModal } from './components/PreviewModal';
import { InventoryDesk } from './components/InventoryDesk';
import { uid } from './lib/uid';

export default function App() {
  const { state, canUndo, canRedo, commit, replace, undo, redo } = useDeskHistory();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [focusSheet, setFocusSheet] = useState<number | null>(null);
  const mountRef = useRef(false);

  const imp = useMemo(() => buildImposition(state.pages, state.flip), [state.pages, state.flip]);
  const issues = useMemo(() => diagnose(imp.pages), [imp.pages]);
  const sheetCount = imp.sheets.length;

  // 页面增删后，库存与锁定批次可能引用已不存在的折手：随该次操作一并规整
  const reconcile = (s: typeof state): typeof state => {
    const sc = Math.ceil(s.pages.length / 4);
    const r = reconcileInventory(sc, s.lots, s.lockedGroups);
    return { ...s, lots: r.lots, lockedGroups: r.lockedGroups };
  };

  // 首次载入时把持久化数据中失效的锁定/孤儿库存静默规整一次
  useEffect(() => {
    if (mountRef.current) return;
    mountRef.current = true;
    const r = reconcileInventory(sheetCount, state.lots, state.lockedGroups);
    const byId = new Map(state.lots.map((l) => [l.id, l]));
    const stale =
      r.lots.length !== state.lots.length ||
      r.lots.some((l) => {
        const o = byId.get(l.id);
        return (
          !o ||
          o.sheetIndex !== l.sheetIndex ||
          o.frontQty !== l.frontQty ||
          o.backQty !== l.backQty ||
          o.frontStatus !== l.frontStatus ||
          o.backStatus !== l.backStatus ||
          o.colorBatch !== l.colorBatch
        );
      }) ||
      r.lockedGroups.length !== state.lockedGroups.length ||
      r.lockedGroups.some((g, i) => g !== state.lockedGroups[i]);
    if (stale) replace((s) => reconcile(s));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lots = useMemo(() => normalizeLots(state.lots, sheetCount), [state.lots, sheetCount]);
  const allocation = useMemo(
    () => allocateKits(sheetCount, lots, state.lockedGroups),
    [sheetCount, lots, state.lockedGroups],
  );
  const summary = useMemo(
    () => stockSummary(sheetCount, lots, allocation),
    [sheetCount, lots, allocation],
  );
  // 每条到货记录被有效锁定批次占用的数量（锁定信息的唯一派生来源）
  const lockedUsage = useMemo(
    () => lockedUsageMap(lots, allocation.locked),
    [lots, allocation.locked],
  );
  const hasStock = state.lots.length > 0;

  // 页面减少后，把预演位置收敛到合法范围（瞬态，不入历史）
  useEffect(() => {
    if (state.previewIndex > imp.paddedCount - 1) {
      replace((s) => ({ ...s, previewIndex: Math.max(0, imp.paddedCount - 1) }));
    }
  }, [imp.paddedCount, state.previewIndex, replace]);

  // Cmd/Ctrl+Z 撤销、Cmd/Ctrl+Shift+Z（或 Ctrl+Y）重做
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.key.toLowerCase() !== 'z') return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    };
    const onY = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keydown', onY);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keydown', onY);
    };
  }, [undo, redo]);

  const patchPages = (updater: (pages: ArtPage[]) => ArtPage[]) =>
    commit((s) => reconcile({ ...s, pages: updater(s.pages) }));

  const handleReorder = (pages: ArtPage[]) => patchPages(() => pages);
  const handleAdd = (page: ArtPage) => patchPages((p) => [...p, page]);
  const handleDelete = (id: string) => patchPages((p) => p.filter((pg) => pg.id !== id));
  const handleChange = (id: string, p: Partial<ArtPage>) =>
    patchPages((pg) => pg.map((page) => (page.id === id ? { ...page, ...p } : page)));

  const handleAddLot = (sheetIndex: number) =>
    commit((s) => ({
      ...s,
      lots: [
        ...s.lots,
        {
          id: uid('lot'),
          sheetIndex,
          colorBatch: s.lots.find((l) => l.sheetIndex === sheetIndex)?.colorBatch ?? 'A',
          frontQty: 0,
          backQty: 0,
          frontStatus: 'ok' as const,
          backStatus: 'ok' as const,
        },
      ],
    }));

  const handleChangeLot = (id: string, patch: Partial<Omit<(typeof lots)[number], 'id'>>) =>
    commit((s) => ({ ...s, lots: updateLot(s.lots, id, patch) }));

  const handleRemoveLot = (id: string) =>
    commit((s) => ({ ...s, lots: removeLot(s.lots, id) }));

  const handleLock = (group: KitGroup) =>
    commit((s) => ({ ...s, lockedGroups: [...s.lockedGroups, lockKitGroup(group, () => uid('kit'))] }));

  const handleUnlock = (groupId: string) =>
    commit((s) => ({ ...s, lockedGroups: unlockKitGroup(s.lockedGroups, groupId) }));

  // 交付目标输入频繁变更，静默更新 present（不占用撤销栈）
  const handleTargetChange = (target: number) =>
    replace((s) => ({ ...s, target }));

  const handleAdopt = (candidate: ReprintCandidate) =>
    commit((s) => {
      const { lots: nextLots } = adoptReprint(candidate, s.lots, () => uid('lot'));
      return { ...s, lots: nextLots };
    });

  const handleFocusSheet = (sheetIndex: number) => {
    setFocusSheet(sheetIndex);
    document
      .getElementById('inventory-desk')
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.setTimeout(() => setFocusSheet((cur) => (cur === sheetIndex ? null : cur)), 2400);
  };

  const errorCount = issues.filter((i) => i.level === 'error').length;
  const capBySheet = (s: number) =>
    lots.filter((l) => l.sheetIndex === s).reduce((sum, l) => sum + lotCapacity(l), 0);
  const freeBySheet = (s: number) =>
    lots
      .filter((l) => l.sheetIndex === s)
      .reduce((sum, l) => sum + lotFree(l, lockedUsage.get(l.id) ?? 0), 0);
  const lockedBySheet = (s: number) =>
    lots
      .filter((l) => l.sheetIndex === s)
      .reduce((sum, l) => sum + (lockedUsage.get(l.id) ?? 0), 0);
  const targetGap = state.target > allocation.bookCount ? state.target - allocation.bookCount : 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__brand">
          <h1>骑马钉拼版台</h1>
          <span className="muted">送印前看清每张印张、现存印张能装多少本，以及补印哪几块版最省</span>
        </div>

        <div className="topbar__tools">
          <div className="history-tools" role="group" aria-label="撤销重做">
            <button type="button" className="btn" onClick={undo} disabled={!canUndo} title="撤销 (Ctrl+Z)">
              ↶ 撤销
            </button>
            <button
              type="button"
              className="btn"
              onClick={redo}
              disabled={!canRedo}
              title="重做 (Ctrl+Shift+Z)"
            >
              ↷ 重做
            </button>
          </div>

          <div className="flip-switch" role="group" aria-label="翻面方式">
            <button
              type="button"
              className={state.flip === 'long' ? 'is-active' : ''}
              onClick={() => commit((s) => ({ ...s, flip: 'long' }))}
            >
              长边翻面
              <small>左右翻 · 书本式</small>
            </button>
            <button
              type="button"
              className={state.flip === 'short' ? 'is-active' : ''}
              onClick={() => commit((s) => ({ ...s, flip: 'short' }))}
            >
              短边翻面
              <small>上下翻 · 台历式</small>
            </button>
          </div>

          <button
            type="button"
            className="btn btn--primary"
            onClick={() => replace((s) => ({ ...s, previewOpen: true }))}
            disabled={imp.paddedCount === 0}
          >
            📖 折叠预演
          </button>
        </div>
      </header>

      <div className="summary-bar">
        <span>内容稿 <b>{state.pages.length}</b> 页</span>
        <span>自动补白 <b>{imp.addedBlanks}</b> 页</span>
        <span>成书 <b>{imp.paddedCount}</b> 页 · <b>{imp.sheets.length}</b> 张印张（折手）</span>
        <span className={allocation.bookCount > 0 ? 'summary-bar--ok' : 'summary-bar--bad'}>
          现存可装订 <b>{allocation.bookCount}</b> 本（锁 {allocation.lockedBooks}）
        </span>
        {state.target > 0 && (
          <span className={targetGap > 0 ? 'summary-bar--bad' : 'summary-bar--ok'}>
            目标 {state.target} 本{targetGap > 0 ? ` · 缺 ${targetGap} 本，见补印决策` : ' · 已达成'}
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
            <span className="muted">中缝为折口/装订位；右上角库存徽标点击联动库存矩阵</span>
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
                  capacity={hasStock ? capBySheet(sheet.index) : null}
                  free={freeBySheet(sheet.index)}
                  locked={lockedBySheet(sheet.index)}
                  focused={focusSheet === sheet.index}
                  onFocus={handleFocusSheet}
                />
              ))}
            </div>
          )}
        </section>

        <IssuesPanel
          issues={issues}
          onJump={(pageIndex) => {
            replace((s) => ({ ...s, previewOpen: true, previewIndex: pageIndex }));
          }}
        />
      </main>

      <InventoryDesk
        lots={lots}
        sheetCount={sheetCount}
        focusSheet={focusSheet}
        lockedGroups={state.lockedGroups}
        target={state.target}
        allocation={allocation}
        summary={summary}
        lockedUsage={lockedUsage}
        onAddLot={handleAddLot}
        onChangeLot={handleChangeLot}
        onRemoveLot={handleRemoveLot}
        onLock={handleLock}
        onUnlock={handleUnlock}
        onTargetChange={handleTargetChange}
        onAdopt={handleAdopt}
      />

      {state.previewOpen && imp.paddedCount > 0 && (
        <PreviewModal
          imp={imp}
          index={Math.min(state.previewIndex, imp.paddedCount - 1)}
          issues={issues}
          onNavigate={(previewIndex) => replace((s) => ({ ...s, previewIndex }))}
          onClose={() => replace((s) => ({ ...s, previewOpen: false }))}
        />
      )}
    </div>
  );
}
