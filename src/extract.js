// 用 HTMLRewriter 抓取文章正文段落（失败时退回 RSS 摘要）
import { decodeEntities } from './rss.js';
const MAX = 6000;

export async function extractArticleText(url) {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; NewsRadar/1.0)' },
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
    });
    if (!res.ok || !(res.headers.get('content-type') || '').includes('html')) return null;

    const paras = [];
    let current = '';
    let inPara = false;
    await new HTMLRewriter()
      .on('p', {
        element(el) {
          inPara = true;
          current = '';
          el.onEndTag(() => {
            const t = decodeEntities(current).replace(/\s+/g, ' ').trim();
            if (t.length > 40) paras.push(t);
            inPara = false;
          });
        },
        text(chunk) {
          if (inPara) current += chunk.text;
        },
      })
      .transform(res)
      .arrayBuffer();

    const text = paras.join('\n').slice(0, MAX);
    return text.length > 200 ? text : null;
  } catch {
    return null;
  }
}
