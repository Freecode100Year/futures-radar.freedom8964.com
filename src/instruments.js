// 跟踪的国际期货品种（每个品类 3 个流动性最好的合约）。
// key 同时用作分析 schema 中 assets[].instrument 的枚举值。
//   root/exchange：Yahoo 单合约代码 = root + 月份字母 + 两位年份 + '.' + exchange，例如 CLZ26.NYM
//   months：上市交割月（CME 月份代码）
//   yahoo：连续主力代码（=F），在识别出具体主力合约之前作为兜底
//   twelve：Twelve Data 备用（现货价近似，不是期货合约）
//   spec：合约规格。pointValue = 价格变动 1 个报价单位对应的美元（谷物报价单位是美分）
//         tick / tickValue = 最小变动价位及其美元价值；session = 交易时段类型（见 sessions.js）
//   cftc：CFTC 持仓报告的合约代码与报告类型（disagg = 分类报告的管理基金；tff = 金融期货报告的杠杆基金）
export const SECTORS = ['能源', '金属', '农产品', '金融期货'];

const MONTHLY = 'FGHJKMNQUVXZ';

export const INSTRUMENTS = [
  // 能源
  { key: 'wti', name: 'WTI原油', sector: '能源', root: 'CL', exchange: 'NYM', months: MONTHLY, yahoo: 'CL=F', unit: '美元/桶', core: false, spec: { size: '1,000 桶', pointValue: 1000, tick: 0.01, tickValue: 10, session: 'globex', settle: '实物交割' }, cftc: { code: '067651', report: 'disagg' } },
  { key: 'brent', name: '布伦特原油', sector: '能源', root: 'BZ', exchange: 'NYM', months: MONTHLY, yahoo: 'BZ=F', twelve: 'XBR/USD', unit: '美元/桶', core: true, spec: { size: '1,000 桶', pointValue: 1000, tick: 0.01, tickValue: 10, session: 'globex', settle: '现金结算' }, cftc: { code: '06765T', report: 'disagg' } },
  { key: 'natgas', name: '天然气', sector: '能源', root: 'NG', exchange: 'NYM', months: MONTHLY, yahoo: 'NG=F', unit: '美元/百万英热', core: false, spec: { size: '10,000 百万英热', pointValue: 10000, tick: 0.001, tickValue: 10, session: 'globex', settle: '实物交割' }, cftc: { code: '023651', report: 'disagg' } },
  // 金属
  { key: 'gold', name: '黄金', sector: '金属', root: 'GC', exchange: 'CMX', months: 'GJMQVZ', yahoo: 'GC=F', twelve: 'XAU/USD', unit: '美元/盎司', core: true, spec: { size: '100 金衡盎司', pointValue: 100, tick: 0.1, tickValue: 10, session: 'globex', settle: '实物交割' }, cftc: { code: '088691', report: 'disagg' } },
  { key: 'silver', name: '白银', sector: '金属', root: 'SI', exchange: 'CMX', months: 'HKNUZ', yahoo: 'SI=F', unit: '美元/盎司', core: false, spec: { size: '5,000 金衡盎司', pointValue: 5000, tick: 0.005, tickValue: 25, session: 'globex', settle: '实物交割' }, cftc: { code: '084691', report: 'disagg' } },
  { key: 'copper', name: '铜', sector: '金属', root: 'HG', exchange: 'CMX', months: 'HKNUZ', yahoo: 'HG=F', unit: '美元/磅', core: true, spec: { size: '25,000 磅', pointValue: 25000, tick: 0.0005, tickValue: 12.5, session: 'globex', settle: '实物交割' }, cftc: { code: '085692', report: 'disagg' } },
  // 农产品
  { key: 'soybeans', name: '大豆', sector: '农产品', root: 'ZS', exchange: 'CBT', months: 'FHKNQUX', yahoo: 'ZS=F', unit: '美分/蒲式耳', core: false, spec: { size: '5,000 蒲式耳', pointValue: 50, tick: 0.25, tickValue: 12.5, session: 'grains', settle: '实物交割' }, cftc: { code: '005602', report: 'disagg' } },
  { key: 'corn', name: '玉米', sector: '农产品', root: 'ZC', exchange: 'CBT', months: 'HKNUZ', yahoo: 'ZC=F', unit: '美分/蒲式耳', core: false, spec: { size: '5,000 蒲式耳', pointValue: 50, tick: 0.25, tickValue: 12.5, session: 'grains', settle: '实物交割' }, cftc: { code: '002602', report: 'disagg' } },
  { key: 'wheat', name: '小麦', sector: '农产品', root: 'ZW', exchange: 'CBT', months: 'HKNUZ', yahoo: 'ZW=F', unit: '美分/蒲式耳', core: false, spec: { size: '5,000 蒲式耳', pointValue: 50, tick: 0.25, tickValue: 12.5, session: 'grains', settle: '实物交割' }, cftc: { code: '001602', report: 'disagg' } },
  // 金融期货
  { key: 'es', name: '标普500期货', sector: '金融期货', root: 'ES', exchange: 'CME', months: 'HMUZ', yahoo: 'ES=F', unit: '指数点', core: true, spec: { size: '50 美元 × 指数', pointValue: 50, tick: 0.25, tickValue: 12.5, session: 'globex', settle: '现金结算' }, cftc: { code: '13874A', report: 'tff' } },
  { key: 'nq', name: '纳指100期货', sector: '金融期货', root: 'NQ', exchange: 'CME', months: 'HMUZ', yahoo: 'NQ=F', unit: '指数点', core: false, spec: { size: '20 美元 × 指数', pointValue: 20, tick: 0.25, tickValue: 5, session: 'globex', settle: '现金结算' }, cftc: { code: '209742', report: 'tff' } },
  { key: 'zn', name: '美国10年期国债期货', sector: '金融期货', root: 'ZN', exchange: 'CBT', months: 'HMUZ', yahoo: 'ZN=F', unit: '点（面值%）', core: true, spec: { size: '面值 100,000 美元', pointValue: 1000, tick: 0.015625, tickValue: 15.625, session: 'globex', settle: '实物交割' }, cftc: { code: '043602', report: 'tff' } },
].map((i) => ({ kind: 'price', twelve: null, ...i }));

export const INSTRUMENT_KEYS = INSTRUMENTS.map((i) => i.key);
export const byKey = Object.fromEntries(INSTRUMENTS.map((i) => [i.key, i]));
