/**
 * Generic source for WordPress sites: their RSS feed carries the full article
 * HTML in <content:encoded> and pages with ?paged=N, newest first.
 */

import { fetchText, htmlToText, rawTagContent, rssItems, tagContent, urlSection, type Article, type Source } from './common';

const MAX_FEED_PAGES = 10;

export function wordpressSource(id: string, name: string, feedUrl: string): Source {
  return {
    id,
    name,

    async fetchArticles(from, to) {
      const articles: Article[] = [];
      const seen = new Set<string>();

      for (let page = 1; page <= MAX_FEED_PAGES; page++) {
        let xml: string;
        try {
          xml = await fetchText(page === 1 ? feedUrl : `${feedUrl}?paged=${page}`);
        } catch {
          break; // past the last page WordPress answers 404
        }
        const items = rssItems(xml);
        let oldest = Infinity;
        for (const item of items) {
          const url = tagContent(item, 'link');
          const published = new Date(tagContent(item, 'pubDate'));
          oldest = Math.min(oldest, published.getTime());
          const slug = new URL(url).pathname.split('/').filter(Boolean).pop() ?? url;
          if (published < from || published >= to || seen.has(slug)) continue;
          seen.add(slug);
          articles.push({
            id: slug,
            title: tagContent(item, 'title'),
            url,
            published,
            section: urlSection(url),
            text: htmlToText(rawTagContent(item, 'content:encoded')),
          });
        }
        if (!items.length || oldest < from.getTime()) break;
      }

      return articles.sort((a, b) => a.published.getTime() - b.published.getTime());
    },
  };
}
