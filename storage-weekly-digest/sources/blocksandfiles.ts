/**
 * Blocks and Files: the RSS feed lists articles but carries no body, so the
 * text is pulled from each article page's `bodytext` container.
 */

import { enclosingDiv, fetchText, htmlToText, rssItems, tagContent, urlSection, type Article, type Source } from './common';

const FEED_URL = 'https://www.blocksandfiles.com/feed/';

async function fetchArticleText(url: string): Promise<string> {
  const body = enclosingDiv(await fetchText(url), 'class="bodytext');
  return body ? htmlToText(body).replace(/BANDF AD/g, '') : '';
}

export const blocksAndFiles: Source = {
  id: 'blocksandfiles',
  name: 'Blocks and Files',

  async fetchArticles(from, to) {
    const articles: Article[] = [];
    const seen = new Set<string>();
    for (const item of rssItems(await fetchText(FEED_URL))) {
      const url = tagContent(item, 'link');
      const published = new Date(tagContent(item, 'pubDate'));
      // URLs look like https://www.blocksandfiles.com/<section>/YYYY/MM/DD/<slug>/<id>
      const id = url.split('/').pop() ?? url;
      if (published < from || published >= to || seen.has(id)) continue;
      seen.add(id);
      articles.push({ id, title: tagContent(item, 'title'), url, published, section: urlSection(url), text: '' });
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
  },
};
