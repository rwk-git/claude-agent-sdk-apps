/**
 * Types and HTML/RSS helpers shared by all news sources.
 */

export interface Article {
  id: string;
  title: string;
  url: string;
  published: Date;
  section: string;
  text: string;
}

export interface Source {
  /** Short id used on the command line and in output paths, e.g. "blocksandfiles". */
  id: string;
  /** Display name used on slides and in prompts, e.g. "Blocks and Files". */
  name: string;
  /** Articles published in [from, to), oldest first, with their plain text. */
  fetchArticles(from: Date, to: Date): Promise<Article[]>;
}

const USER_AGENT = 'Mozilla/5.0 (compatible; storage-weekly-digest/1.0)';

export async function fetchText(url: string): Promise<string> {
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

/** Text content of the first <tag> in an RSS item, with CDATA unwrapped. Entities are not decoded. */
export function rawTagContent(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  if (!m) return '';
  return m[1].trim().replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1');
}

export const tagContent = (xml: string, tag: string) => decodeEntities(rawTagContent(xml, tag));

export const rssItems = (xml: string) => [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);

/** Returns the outer HTML of the <div> containing `marker`, by balancing div tags. */
export function enclosingDiv(html: string, marker: string): string | null {
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

export function htmlToText(html: string): string {
  const text = html
    .replace(/<(script|style|figure|noscript)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|h[1-6]|li|blockquote|tr)>|<br\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ') // keep benchmark tables readable
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/** First path segment of a URL, e.g. "news" for https://example.com/news/foo. */
export const urlSection = (url: string) => new URL(url).pathname.split('/')[1] ?? '';
