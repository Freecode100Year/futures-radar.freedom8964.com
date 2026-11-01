// 默认信源。首次运行 /api/admin/init 时写入 sources 表，之后可在表里增删。
// 注意：媒体的 RSS 地址会变，上线前请逐个确认能访问。
export const DEFAULT_SOURCES = [
  // 地缘政治 / 国际
  { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', category: 'geopolitics', lang: 'en' },
  { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml', category: 'geopolitics', lang: 'en' },
  { name: 'The Guardian World', url: 'https://www.theguardian.com/world/rss', category: 'geopolitics', lang: 'en' },
  { name: 'NYT World', url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', category: 'geopolitics', lang: 'en' },
  { name: 'DW', url: 'https://rss.dw.com/rdf/rss-en-world', category: 'geopolitics', lang: 'en' },
  { name: 'BBC 中文', url: 'https://feeds.bbci.co.uk/zhongwen/simp/rss.xml', category: 'geopolitics', lang: 'zh' },
  // 军事 / 防务
  { name: 'Defense News', url: 'https://www.defensenews.com/arc/outboundfeeds/rss/', category: 'military', lang: 'en' },
  { name: 'Breaking Defense', url: 'https://breakingdefense.com/feed/', category: 'military', lang: 'en' },
  // 金融 / 宏观
  { name: 'CNBC World', url: 'https://www.cnbc.com/id/100727362/device/rss/rss.html', category: 'finance', lang: 'en' },
  { name: 'CNBC Economy', url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html', category: 'finance', lang: 'en' },
  { name: 'BBC Business', url: 'https://feeds.bbci.co.uk/news/business/rss.xml', category: 'finance', lang: 'en' },
  { name: 'The Guardian Business', url: 'https://www.theguardian.com/business/rss', category: 'finance', lang: 'en' },
  // 官方数据与政策
  { name: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_all.xml', category: 'policy', lang: 'en' },
  { name: 'EIA Today in Energy', url: 'https://www.eia.gov/rss/todayinenergy.xml', category: 'energy', lang: 'en' },
  { name: 'EIA Press Releases', url: 'https://www.eia.gov/rss/press_rss.xml', category: 'energy', lang: 'en' },
  // GDELT：按大宗商品与宏观关键词覆盖全球媒体（两条查询，分别偏商品与偏宏观/地缘）
  {
    name: 'GDELT 大宗商品',
    type: 'gdelt',
    url: 'https://api.gdeltproject.org/api/v2/doc/doc?query=(OPEC%20OR%20%22crude%20oil%22%20OR%20%22natural%20gas%22%20OR%20LNG%20OR%20wheat%20OR%20soybeans%20OR%20corn%20OR%20copper%20OR%20%22gold%20prices%22%20OR%20silver)%20sourcelang:english&mode=artlist&format=json&maxrecords=50&timespan=1h',
    category: 'commodities',
    lang: 'en',
  },
  {
    name: 'GDELT 宏观与地缘',
    type: 'gdelt',
    url: 'https://api.gdeltproject.org/api/v2/doc/doc?query=(%22Federal%20Reserve%22%20OR%20%22Treasury%20yields%22%20OR%20inflation%20OR%20sanctions%20OR%20tariffs%20OR%20blockade%20OR%20airstrike)%20sourcelang:english&mode=artlist&format=json&maxrecords=50&timespan=1h',
    category: 'macro',
    lang: 'en',
  },
];
