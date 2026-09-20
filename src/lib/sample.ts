import type { ArtPage, StockLot } from '../types';
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
 * 内置折手库存（与 16 页 4 帖手册配套）：
 * - A、B 两个色批均已到货；
 * - 第 3 帖 A 批有 30 张运输破损、正面报废，仅 470 张合格——全书唯一短板，
 *   A 批单色可配 470 本、B 批单色 120 本，两批合计只能装 590 本，
 *   其余三帖各余 30 张无法配套。
 */
export function createSampleLots(): StockLot[] {
  const rows: Array<[number, string, number, number, StockLot['frontStatus'], StockLot['backStatus']]> = [
    [0, 'A', 500, 500, 'ok', 'ok'],
    [0, 'B', 120, 120, 'ok', 'ok'],
    [1, 'A', 500, 500, 'ok', 'ok'],
    [1, 'B', 120, 120, 'ok', 'ok'],
    [2, 'A', 470, 470, 'ok', 'ok'],
    [2, 'A', 30, 30, 'scrap', 'ok'],
    [2, 'B', 120, 120, 'ok', 'ok'],
    [3, 'A', 500, 500, 'ok', 'ok'],
    [3, 'B', 120, 120, 'ok', 'ok'],
  ];
  return rows.map(([sheetIndex, colorBatch, frontQty, backQty, frontStatus, backStatus]) => ({
    id: `lot-s${sheetIndex}-${colorBatch}-${frontStatus === 'ok' ? 'ok' : 'scrap'}`,
    sheetIndex,
    colorBatch,
    frontQty,
    backQty,
    frontStatus,
    backStatus,
  }));
}
