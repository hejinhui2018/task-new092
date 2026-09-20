import type { ArtPage } from '../types';
import {
  defaultCompat,
  type FoldStock,
  type InventoryDoc,
  type PrintBatch,
  type ColorLot,
} from './inventory';
import { uid } from './uid';

/**
 * 内置 16 页产品手册（骑马钉标准书帖：4 张纸）。
 * 首尾两页出血 2mm，是有意保留的「出血不足」示例，
 * 方便首屏即看到诊断结果；可随时在左侧修正。
 */
export function createSamplePages(): ArtPage[] {
  const titles = [
    '封面 · 星云咖啡机 X1',
    '目录',
    '品牌故事',
    '核心技术一览',
    '研磨系统',
    '恒温萃取',
    '奶泡打发',
    '触控面板',
    '清洁与保养',
    '规格参数',
    '咖啡食谱',
    '配件清单',
    '保修条款',
    '常见问题',
    '经销商网络',
    '封底 · 联系方式',
  ];

  return titles.map((title, i) => ({
    kind: 'art',
    id: uid('sample'),
    title,
    printed: i + 1,
    // 封面与封底是跨整页的图片页，来稿只留了 2mm 出血
    bleed: i === 0 || i === titles.length - 1 ? 2 : 3,
    hue: Math.round((i * 360) / titles.length),
  }));
}

/**
 * 内置折手库存示例（与 16 页 / 4 帖手册配套）：
 * - 两个色批「晨雾蓝 / 暖沙金」，默认仅同色批配套；
 * - 晨雾蓝批四帖各 100 份；暖沙金批四帖各 50 份，
 *   但第 3 帖运输破损只剩 30 份正反面（一处短缺）；
 * - 交付目标 150 本 → 现存可装 130 本，补印第 3 帖（暖沙金）20 份即可。
 * 库存 id 固定，保证示例与测试稳定。
 */
export function createSampleInventory(sheetCount: number): InventoryDoc {
  const colorLots: ColorLot[] = [
    { id: 'lot-blue', name: '晨雾蓝' },
    { id: 'lot-sand', name: '暖沙金' },
  ];
  const batches: PrintBatch[] = [
    { id: 'batch-blue', name: '晨雾蓝首批', colorLotId: 'lot-blue' },
    { id: 'batch-sand', name: '暖沙金首批', colorLotId: 'lot-sand' },
  ];
  const stocks: FoldStock[] = [];
  for (let si = 0; si < sheetCount; si++) {
    stocks.push({ batchId: 'batch-blue', sheetIndex: si, frontQty: 100, backQty: 100, status: 'ok' });
    // 第 3 帖（index 2）运输破损：正反面合格仅 30
    const sandQty = si === 2 ? 30 : 50;
    stocks.push({ batchId: 'batch-sand', sheetIndex: si, frontQty: sandQty, backQty: sandQty, status: 'ok' });
  }
  return {
    colorLots,
    batches,
    stocks,
    compat: defaultCompat(),
    locks: [],
    deliveryTarget: 150,
  };
}
