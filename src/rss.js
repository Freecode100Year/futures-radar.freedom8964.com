// 轻量 RSS 2.0 / Atom / GDELT 解析（Workers 里没有 DOMParser）

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const dropTags = (s) => s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');

export function stripHtml(s) {
  // 很多 RSS 的 description 是转义过的 HTML：先去标签、解码，再去一次标签
  const once = decodeEntities(dropTags((s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')));
  return decodeEntities(dropTags(once)).replace(/\s+/g, ' ').trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : null;
}

function toIso(d) {
  if (!d) return null;
  const t = Date.parse(d.trim());
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export function parseFeed(xml) {
  const items = [];
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const re = isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi;
  for (const block of xml.match(re) || []) {
    let link;
    if (isAtom) {
      const alt = block.match(/<link[^>]*rel=["']alternate["'][^>]*>/i) || block.match(/<link[^>]*>/i);
      link = alt?.[0].match(/href=["']([^"']+)["']/i)?.[1];
    } else {
      link = stripHtml(tag(block, 'link') || '') || tag(block, 'guid');
    }
    const title = stripHtml(tag(block, 'title') || '');
    if (!link || !title) continue;
    items.push({
      url: decodeEntities(link.trim()),
      title,
      summary: stripHtml(tag(block, 'description') || tag(block, 'summary') || tag(block, 'content') || '').slice(0, 1000),
      published_at: toIso(tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated') || tag(block, 'dc:date')),
    });
  }
  return items;
}

// GDELT DOC 2.0 API（mode=artlist&format=json）
export function parseGdelt(json) {
  return (json.articles || []).map((a) => {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(a.seendate || '');
    return {
      url: a.url,
      title: a.title,
      summary: '',
      published_at: m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z` : null,
      source_name: a.domain,
    };
  });
}
