// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import App from './App';

describe('App 冒烟渲染', () => {
  it('首屏渲染内置 16 页手册的拼版台（无 localStorage 时回退示例）', () => {
    const html = renderToString(<App />);
    expect(html).toContain('骑马钉拼版台');
    // 16 页 = 4 帖：最外帖 + 向内第 2/3/4 层
    expect(html).toContain('最外帖');
    expect(html).toContain('由外向内第 4 层');
    expect(html).not.toContain('由外向内第 5 层');
    // 出血不足示例（封面/封底 2mm）会在首屏即被诊断
    expect(html).toContain('版面错误');
    expect(html).toContain('折叠预演');
  });

  it('首屏联动库存矩阵、成套批次与补印清单（两色批、第 3 帖短缺）', () => {
    const html = renderToString(<App />);
    // 库存工作台与矩阵
    expect(html).toContain('折手库存与补印决策');
    expect(html).toContain('库存矩阵');
    // A 批 470 + B 批 120 = 590 本，不是各折手最小值的错误解读（应为 470 后混用兜底）
    expect(html).toContain('现存可装订');
    expect(html).toContain('>590<');
    // 短板与报废示例可见
    expect(html).toContain('已报废');
    // 补印目标 600 与候选排序指标
    expect(html).toContain('补印决策');
    expect(html).toContain('组版');
    // 印张卡片上的库存徽标与矩阵联动（第 3 帖 A470 + B120 = 590）
    expect(html).toContain('库存 590');
    // 撤销/重做按钮首屏存在
    expect(html).toContain('撤销');
    expect(html).toContain('重做');
  });
});
