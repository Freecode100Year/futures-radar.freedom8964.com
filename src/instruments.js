// 跟踪的国际期货品种（每个品类 3 个流动性最好的合约）。
// key 同时用作分析 schema 中 assets[].instrument 的枚举值。
//   root/exchange：Yahoo 单合约代码 = root + 月份字母 + 两位年份 + '.' + exchange，例如 CLZ26.NYM
//   months：上市交割月（CME 月份代码）
//   yahoo：连续主力代码（=F），在识别出具体主力合约之前作为兜底
//   twelve：Twelve Data 备用（现货价近似，不是期货合约）
export const SECTORS = ['能源', '金属', '农产品', '金融期货'];

const MONTHLY = 'FGHJKMNQUVXZ';

export const INSTRUMENTS = [
  // 能源
  { key: 'wti', name: 'WTI原油', sector: '能源', root: 'CL', exchange: 'NYM', months: MONTHLY, yahoo: 'CL=F', unit: '美元/桶', core: false },
  { key: 'brent', name: '布伦特原油', sector: '能源', root: 'BZ', exchange: 'NYM', months: MONTHLY, yahoo: 'BZ=F', twelve: 'XBR/USD', unit: '美元/桶', core: true },
  { key: 'natgas', name: '天然气', sector: '能源', root: 'NG', exchange: 'NYM', months: MONTHLY, yahoo: 'NG=F', unit: '美元/百万英热', core: false },
  // 金属
  { key: 'gold', name: '黄金', sector: '金属', root: 'GC', exchange: 'CMX', months: 'GJMQVZ', yahoo: 'GC=F', twelve: 'XAU/USD', unit: '美元/盎司', core: true },
  { key: 'silver', name: '白银', sector: '金属', root: 'SI', exchange: 'CMX', months: 'HKNUZ', yahoo: 'SI=F', unit: '美元/盎司', core: false },
  { key: 'copper', name: '铜', sector: '金属', root: 'HG', exchange: 'CMX', months: 'HKNUZ', yahoo: 'HG=F', unit: '美元/磅', core: true },
  // 农产品
  { key: 'soybeans', name: '大豆', sector: '农产品', root: 'ZS', exchange: 'CBT', months: 'FHKNQUX', yahoo: 'ZS=F', unit: '美分/蒲式耳', core: false },
  { key: 'corn', name: '玉米', sector: '农产品', root: 'ZC', exchange: 'CBT', months: 'HKNUZ', yahoo: 'ZC=F', unit: '美分/蒲式耳', core: false },
  { key: 'wheat', name: '小麦', sector: '农产品', root: 'ZW', exchange: 'CBT', months: 'HKNUZ', yahoo: 'ZW=F', unit: '美分/蒲式耳', core: false },
  // 金融期货
  { key: 'es', name: '标普500期货', sector: '金融期货', root: 'ES', exchange: 'CME', months: 'HMUZ', yahoo: 'ES=F', unit: '指数点', core: true },
  { key: 'nq', name: '纳指100期货', sector: '金融期货', root: 'NQ', exchange: 'CME', months: 'HMUZ', yahoo: 'NQ=F', unit: '指数点', core: false },
  { key: 'zn', name: '美国10年期国债期货', sector: '金融期货', root: 'ZN', exchange: 'CBT', months: 'HMUZ', yahoo: 'ZN=F', unit: '点（面值%）', core: true },
].map((i) => ({ kind: 'price', twelve: null, ...i }));

export const INSTRUMENT_KEYS = INSTRUMENTS.map((i) => i.key);
export const byKey = Object.fromEntries(INSTRUMENTS.map((i) => [i.key, i]));
