/** 领域模型：内容页、补白页、拼版槽位 */

/** 左侧栏中由制作人员编排的内容页（按阅读顺序排列） */
export interface ArtPage {
  kind: 'art';
  id: string;
  /** 页面标题，缩略图与印张上显示 */
  title: string;
  /** 客户标注的印刷页码；不填表示该页未编号（不参与缺页/重号检查） */
  printed?: number;
  /** 四周出血，单位 mm */
  bleed: number;
  /** 内容稿自身是否被旋转 180°（客户来稿倒置） */
  inverted?: boolean;
  /** 缩略图占位色相（0-360），仅用于区分页面 */
  hue: number;
}

/** 系统自动补入的空白页 */
export interface BlankPage {
  kind: 'blank';
  id: string;
}

/** 补白后的书帖页（阅读顺序中的一个位置） */
export type BookPage = ArtPage | BlankPage;

/** 翻面方式：长边 = 书本式左右翻；短边 = 台历式上下翻 */
export type FlipMode = 'long' | 'short';

export type PlateSide = 'front' | 'back';

/** 成品阅读方向下该页的装订边 */
export type BindingEdge = 'left' | 'right' | 'top' | 'bottom';

/** 制版时页面相对正向的旋转角度 */
export type Rotation = 0 | 180;

/** 槽位在印张上的位置：长边翻左右并排，短边翻上下叠放 */
export type SlotPosition = 'left' | 'right' | 'top' | 'bottom';

export const isArtPage = (p: BookPage): p is ArtPage => p.kind === 'art';

/* ============================ 折手库存与补印 ============================ */

/** 单块印版（某折手的某一面）的检验状态 */
export type PlateStatus = 'ok' | 'hold' | 'scrap';

/** 一次印刷批次中、某一折手（折手 = 拼版的一张纸）的到货记录 */
export interface StockLot {
  id: string;
  /** 对应印张序号（0 基，0 = 最外帖） */
  sheetIndex: number;
  /** 印刷色批（如 A / B）；同一本书允许使用哪些色批由混用规则决定 */
  colorBatch: string;
  /** 正面合格数量 */
  frontQty: number;
  /** 背面合格数量 */
  backQty: number;
  /** 正面检验状态：合格 / 待复检 / 报废 */
  frontStatus: PlateStatus;
  backStatus: PlateStatus;
}

/** 成套批次：按色批混用规则组成的完整一本书所需的各折手组合 */
export interface KitGroup {
  id: string;
  /** 该书册使用的色批集合（参与混用的多个色批用 + 连接） */
  mixKey: string;
  /** 每帖使用的到货批次 id（按 sheetIndex 顺序） */
  lotIds: (string | null)[];
  /** 该成套方案的数量 */
  qty: number;
}

/** 一条补印指令：重印某折手（正反面同批上机）若干张 */
export interface ReprintLine {
  sheetIndex: number;
  /** 重印时使用的色批 */
  colorBatch: string;
  qty: number;
}

/** 补印后生成的新到货批次（采用方案时入库） */
export interface ReprintLot extends ReprintLine {
  id: string;
  frontQty: number;
  backQty: number;
  frontStatus: PlateStatus;
  backStatus: PlateStatus;
}

/** 一个补印候选方案 */
export interface ReprintCandidate {
  id: string;
  lines: ReprintLine[];
  /** 需开机的版组数（每帖正反面两块版） */
  plateGroups: number;
  /** 补印总印张数（含补印超印） */
  sheets: number;
  /** 采用后仍无法配套的现存合格印张总数（剩余浪费） */
  waste: number;
  /** 采用后可装订总数 */
  totalBooks: number;
  /** 采用后锁定成套总数 */
  lockedBooks: number;
  /** 采用后的库存（含重印批次） */
  lots: StockLot[];
  /** 采用后在新库存上的成套分配 */
  groups: KitGroup[];
  /** 采用后仍未配套的合格余量，按折手汇总 */
  surplus: SheetQty[];
  /** 面向主管的逐条说明 */
  explanation: string[];
  /** 无法满足目标时的约束说明 */
  infeasible?: string;
}

/** 按折手汇总的数量 */
export interface SheetQty {
  sheetIndex: number;
  qty: number;
}
