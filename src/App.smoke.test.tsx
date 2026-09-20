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

  it('首屏联动折手库存矩阵、成套批次与补印清单（两色批一处短缺示例）', () => {
    // React SSR 会在文本与表达式之间插入 <!-- -->，断言前统一去掉
    const html = renderToString(<App />).replace(/<!-- -->/g, '');
    // 三大新区
    expect(html).toContain('折手库存矩阵');
    expect(html).toContain('成套批次');
    expect(html).toContain('补印决策');
    // 两个色批
    expect(html).toContain('晨雾蓝');
    expect(html).toContain('暖沙金');
    // 现存可装：晨雾蓝 100 + 暖沙金 30（第 3 帖破损）= 130 本
    expect(html).toContain('现存印张可装');
    expect(html).toContain('130');
    // 短板为第 3 帖（合格 30 份）
    expect(html).toContain('短板折手：第 3 帖');
    // 交付目标 150 → 缺 20，最优补印候选为第 3 帖 20 份、1 个开机版组
    expect(html).toContain('缺 20 本');
    expect(html).toContain('开机版组');
    // 候选解释行为完整字符串：重开 1 块版（第 3 帖 20 份）
    expect(html).toContain('第 3 帖 20 份');
    expect(html).toContain('最省开机');
    // 撤销/重做按钮在首屏可见（初始撤销禁用）
    expect(html).toContain('撤销');
    expect(html).toContain('重做');
  });
});
