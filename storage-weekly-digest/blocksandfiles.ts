/**
 * Fetches the article list from the Blocks and Files RSS feed and extracts
 * the plain text of each article.
 */

const FEED_URL = 'https://www.blocksandfiles.com/feed/';
const USER_AGENT = 'Mozilla/5.0 (compatible; storage-weekly-digest/1.0)';

export interface Article {
  id: string;
  title: string;
  url: string;
  published: Date;
  section: string;
  text: string;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.text();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return String.fromCodePoint(n);
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? m;
  });
}

function tagContent(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  if (!m) return '';
  return decodeEntities(m[1].replace(/^<!\[CDATA\[|\]\]>$/g, '').trim());
}

/** Returns the outer HTML of the <div> containing `marker`, by balancing div tags. */
function enclosingDiv(html: string, marker: string): string | null {
  const markerPos = html.indexOf(marker);
  if (markerPos < 0) return null;
  const start = html.lastIndexOf('<div', markerPos);
  let depth = 0;
  for (const m of html.slice(start).matchAll(/<div\b|<\/div>/g)) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) return html.slice(start, start + m.index! + m[0].length);
  }
  return null;
}

function htmlToText(html: string): string {
  const text = html
    .replace(/<(script|style|figure|noscript)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|h[1-6]|li|blockquote|tr)>|<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(text)
    .replace(/BANDF AD/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

async function fetchArticleText(url: string): Promise<string> {
  const body = enclosingDiv(await fetchText(url), 'class="bodytext');
  return body ? htmlToText(body) : '';
}

/** Lists articles published in [from, to), with their text. */
export async function fetchArticles(from: Date, to: Date): Promise<Article[]> {
  const feed = await fetchText(FEED_URL);
  const items = [...feed.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);

  const articles: Article[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const url = tagContent(item, 'link');
    const published = new Date(tagContent(item, 'pubDate'));
    const id = url.split('/').pop() ?? url;
    if (published < from || published >= to || seen.has(id)) continue;
    seen.add(id);
    // URLs look like https://www.blocksandfiles.com/<section>/YYYY/MM/DD/<slug>/<id>
    const section = new URL(url).pathname.split('/')[1] ?? '';
    articles.push({ id, title: tagContent(item, 'title'), url, published, section, text: '' });
  }

  articles.sort((a, b) => a.published.getTime() - b.published.getTime());
  for (const article of articles) {
    try {
      article.text = await fetchArticleText(article.url);
    } catch (err) {
      console.warn(`  ⚠️  Could not fetch ${article.url}: ${(err as Error).message}`);
    }
  }
  return articles;
}
