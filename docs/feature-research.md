# 期货网站功能调研与取舍（2026-11）

调研对象：Barchart（期货栏目）、Investing.com（商品/期货技术面）、TradingView（期货页与社区指标）、国内期货 App（新浪财经、期货公司 App 等）。目的是梳理“期货雷达”这类网站的常见参数和功能，决定哪些并入 Futures Radar。

## 一、常见功能清单

| 功能 | Barchart | Investing.com | TradingView | 国内期货 App | 说明 |
|---|:-:|:-:|:-:|:-:|---|
| 市场总览 / 板块分组 | ✓ | ✓ | ✓ | ✓ | 按能源、金属、谷物、股指、利率等分组 |
| 多周期涨跌（1日/1周/1月/年初至今/1年） | ✓ Performance Leaders | ✓ | ✓ | ✓ | 常配热力图着色 |
| 52 周高低点 / 区间位置 | ✓ Highs & Lows | ✓ | ✓ | 部分 | |
| 期货热力图 / Market Map | ✓ | ✓ | ✓ | 部分 | |
| 最活跃合约、成交量排行 | ✓ Most Active | ✓ | ✓ | ✓ | 需要成交量与持仓量数据 |
| 技术指标（RSI、MACD、均线、布林带、ATR） | ✓ | ✓ Technical Indicators | ✓ | ✓ | |
| 技术面“买入/卖出”综合评级 | ✓ Barchart Opinion | ✓ Strong Buy/Sell | ✓ Technical Ratings | 部分 | 属于交易信号 |
| 枢轴点（Classic/Fibonacci/Camarilla 等） | ✓ Cheat Sheet | ✓ Pivot Points | ✓ | 少 | |
| 季节性图表 | ✓ Seasonal | — | ✓ 社区指标 | 少 | 对比历史同期走势 |
| CFTC 持仓报告（COT） | ✓ Legacy/Disaggregated/TFF | ✓ | ✓ 社区指标 | 国内看交易所会员持仓排名 | 美国政府公开数据 |
| 合约规格 / 到期日 / 第一通知日 | ✓ | ✓ | ✓ | ✓ | |
| 期限结构 / 升贴水 / 展期收益 | ✓ 远期曲线 | 部分 | ✓ | ✓ 基差、价差 | |
| 价差与比价（布伦特-WTI、金银比等） | ✓ | 部分 | ✓ 自定义表达式 | ✓ 跨期/跨品种价差 | |
| 相关性 | 少 | ✓ Correlation | ✓ | 少 | |
| 财经日历 | ✓ | ✓ | ✓ | ✓ | EIA、USDA、FOMC、CPI 等 |
| 交易时段 / 开收盘状态 | ✓ | ✓ | ✓ Session | ✓ | |
| 自选 / Watchlist | ✓ | ✓ | ✓ | ✓ | |
| 价格提醒 | ✓ 付费 | ✓ | ✓ | ✓ | |
| 新闻快讯 + 评论 | ✓ Insider Commentary | ✓ | ✓ | ✓ 7×24 快讯 | |
| 期权链 / 隐含波动率 | ✓ | ✓ | ✓ | ✓ | |
| 实时行情 | 付费 | 部分品种 | 付费 | 持牌实时 | 免费版均为 10 分钟以上延迟 |

参考：
- Barchart 免费版：期货总览、热力图、最活跃合约、COT 报告、合约规格、到期日和财经日历；数据延迟 10–15 分钟（thegodfunded.com 评测，2026-10）
- Barchart 期货栏目菜单：Performance Leaders、Most Active、Futures Market Map、Contract Specifications、First Notice Dates、Commitment of Traders（Legacy / Disaggregated / TFF）、Economic Calendar
- Barchart 季节性图表：把多个年份的合约放在同一时间轴上比较（Barchart 帮助文档）
- Investing.com：商品期货枢轴点（Classic / Fibonacci / Camarilla / Woodie's / DeMark's）、技术指标、Strong Buy–Strong Sell 综合评级
- TradingView：CME 期货免费 10 分钟延迟；Technical Ratings 综合评级；社区有 COT 指数、季节性指标

## 二、本次并入 Futures Radar 的功能

| 功能 | 实现位置 | 数据来源 |
|---|---|---|
| 市场总览页（新首页） | `public/tools.js` `renderOverview` · `GET /api/overview` | 下列各项汇总 |
| 多周期涨跌热力表（1日/1周/1月/3月/年初至今/1年）、52 周区间 | `src/analytics.js` `performance` | Yahoo 连续合约日线（延迟） |
| 技术指标：RSI(14)、MACD(12,26,9)、ATR(14)、布林带(20,2)、20/50/200 日均线、20 日历史波动率 | `technicals` | 同上 |
| 经典枢轴点 S3–R3 | `pivots` | 同上 |
| 季节性：各月平均涨跌与上涨概率，今年 vs 近 5/10 年平均路径 | `seasonality` | 10 年日线 |
| 60 日相关性矩阵 | `correlationMatrix` | 日线 |
| 价差/比价：布伦特-WTI、金银比、铜金比、大豆/玉米比价（附 1 年分位、偏离度） | `spreadStats` | 日线 |
| CFTC 持仓：管理基金/杠杆基金净持仓、周变化、占持仓比、COT 指数（3 年区间位置）、拥挤度排名、3 年走势图 | `src/cot.js` | CFTC 公开数据（可转载，注明来源） |
| 财经日历：EIA 原油/天然气库存、USDA 出口销售/作物生长、贝克休斯钻机数、CFTC 发布时间（自动生成），FOMC/WASDE/CPI 等由管理员添加 | `src/calendar.js` · `GET /api/calendar` | 规则生成 + 手动 |
| 合约规格：规模、最小变动价位与一跳价值、名义价值、交割月份、结算方式 | `src/instruments.js` `spec` | 交易所公开规格 |
| 交易时段与开收盘倒计时（美东时间，自动处理夏令时） | `src/sessions.js` | 规则 |
| 自选（★），总览和品种列表可按“自选”筛选 | 前端 localStorage | — |

## 三、没有并入的功能及原因

- **技术面“买入/卖出”综合评级**：属于交易信号。网站定位是分析与归因，不提供交易建议（见 README 合规提示）。技术指标只描述状态，例如“RSI 处于超买区域”。
- **实时行情 / 逐笔成交 / 盘口**：CME 实时数据按用户收取交易所费用，公开再分发需要分发授权；免费渠道都是延迟数据。
- **最活跃合约 / 成交量排行 / 持仓量**：Yahoo 只有成交量、没有持仓量；而且只跟踪 12 个品种，排行意义不大。主力合约识别已经使用成交量。
- **期权链与隐含波动率**：没有合规的免费数据源。
- **到期日与第一通知日**：各品种规则不同（如原油在交割月前一个月的 25 日附近、谷物按月末倒推），容易算错；可以后续从交易所日历导入到 `calendar_events`。
- **价格提醒**：需要用户账户和推送通道，留作后续（可接 Telegram / 邮件）。
- **FedWatch 利率概率**：CME 专有产品。

## 四、可以接着做的

1. EIA 周度库存数据（EIA 开放 API，需免费 key）：原油/汽油/馏分油库存与五年均值对比
2. USDA WASDE 月度供需平衡表：作为农产品解读的依据
3. 到期日与第一通知日自动生成（按交易所规则），写入日历
4. 内外盘对比（需国内行情源）
5. 异动提醒：价格 z 值、COT 指数进入极值、升贴水结构反转时推送
