/**
 * Registry of supported news sites. To add a WordPress site, add a
 * wordpressSource(...) line; other sites need their own module like
 * blocksandfiles.ts.
 */

import { blocksAndFiles } from './blocksandfiles';
import { wordpressSource } from './wordpress';
import type { Source } from './common';

export type { Article, Source } from './common';

export const SOURCES: Source[] = [
  blocksAndFiles,
  wordpressSource('storagereview', 'StorageReview', 'https://www.storagereview.com/feed'),
];
