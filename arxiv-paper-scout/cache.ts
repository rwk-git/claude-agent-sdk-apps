/**
 * JSON cache files that survive interrupted runs: writes go to a temporary
 * file that is then renamed, so a file is either complete or absent.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Cache file for an arXiv id (old-style ids such as "cs/0101001" contain a slash). */
export const cacheFile = (dir: string, id: string) => path.join(dir, `${id.replace(/\//g, '_')}.json`);

export function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

/** Parsed contents of `file`, or undefined if it is missing or unreadable. */
export function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}
