import {readFile, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, '..');
const readerFile = path.join(project, 'outputs', 'three-body-reader.html');
const stateFile = path.join(project, '本地数据', 'contextual-glosses-v1.json');

const reader = await readFile(readerFile, 'utf8');
const matchJson = id => {
  const match = reader.match(new RegExp(`<script id="${id}"[^>]*>([\\s\\S]*?)<\\/script>`));
  if (!match) throw new Error(`缺少 ${id}`);
  return JSON.parse(match[1]);
};
const chapters = matchJson('bookData');
const strip = value => String(value)
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/\s+/g, ' ')
  .trim();
const extract = (chapter, includeShort) => [...chapter.content.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)]
  .map(match => strip(match[1]))
  .filter(text => (includeShort ? text.length > 0 : text.length > 40) && /[A-Za-z]/.test(text));
const rekey = (key, maps) => {
  const match = String(key).match(/^(\d+):(\d+):(\d+)$/);
  if (!match) return key;
  const [, chapter, oldParagraph, ordinal] = match;
  const nextParagraph = maps[Number(chapter)]?.[Number(oldParagraph)];
  return nextParagraph === undefined ? key : `${chapter}:${nextParagraph}:${ordinal}`;
};

const state = JSON.parse(await readFile(stateFile, 'utf8'));
const maps = chapters.map(chapter => {
  const oldParagraphs = extract(chapter, false);
  const newParagraphs = extract(chapter, true);
  const result = [];
  let cursor = 0;
  for (const oldText of oldParagraphs) {
    const found = newParagraphs.indexOf(oldText, cursor);
    if (found < 0) throw new Error(`无法映射段落：${oldText.slice(0, 80)}`);
    result.push(found);
    cursor = found + 1;
  }
  return result;
});

function migrateMap(input = {}) {
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    const nextKey = rekey(key, maps);
    if (!(nextKey in output) || nextKey === key) output[nextKey] = value;
  }
  return output;
}

const before = {
  entries: Object.keys(state.entries || {}).length,
  failed: Object.keys(state.failed || {}).length,
  details: Object.keys(state.unresolvedDetails || {}).length
};
state.entries = migrateMap(state.entries);
state.failed = migrateMap(state.failed);
state.unresolvedDetails = migrateMap(state.unresolvedDetails);
state.indexVersion = 2;
state.indexMigratedAt = new Date().toISOString();
const after = {
  entries: Object.keys(state.entries).length,
  failed: Object.keys(state.failed).length,
  details: Object.keys(state.unresolvedDetails).length
};
const tmp = `${stateFile}.tmp`;
await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
await rename(tmp, stateFile);
console.log(JSON.stringify({before, after, chapters: maps.length, migrated: true}, null, 2));
