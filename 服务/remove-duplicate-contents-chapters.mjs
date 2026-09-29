import {copyFile, readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reader = path.join(project, 'outputs', 'three-body-reader.html');
const localData = path.join(project, '本地数据');
const cache = path.join(localData, '.reader-cache');
const removedIndex = 4;

const isDuplicateContentsChapter = chapter => {
  const title = String(chapter?.title || '').trim();
  const plain = String(chapter?.content || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return /^Part\s+[IVX]+\s*·\s*.+$/i.test(title) && /^CONTENTS\b/i.test(plain);
};
const shiftChapter = value => {
  const chapter = Number(value);
  if (!Number.isSafeInteger(chapter) || chapter < 0) return value;
  if (chapter === removedIndex) return removedIndex;
  return chapter > removedIndex ? chapter - 1 : chapter;
};
const shiftFreshKey = key => {
  const match = String(key).match(/^(\d+):(.*)$/);
  if (!match) return key;
  if (Number(match[1]) === removedIndex) return null;
  return `${shiftChapter(match[1])}:${match[2]}`;
};
const shiftOrigins = origins => Object.fromEntries(Object.entries(origins || {}).map(([kind, entries]) => [kind, Object.fromEntries(Object.entries(entries || {}).filter(([, item]) => Number(item?.chapter) !== removedIndex).map(([key, item]) => [key, {...item, chapter:shiftChapter(item.chapter)}]))]));
const shiftedMarks = marks => ({...marks, fresh:[...(marks?.fresh || [])].map(shiftFreshKey).filter(Boolean), origins:shiftOrigins(marks?.origins)});
const shiftGlossData = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const entriesKey = Object.hasOwn(value, 'entries:') ? 'entries:' : 'entries';
  if (!value[entriesKey] || typeof value[entriesKey] !== 'object') return value;
  const entries = Object.fromEntries(Object.entries(value[entriesKey]).filter(([key]) => Number(key.split(':')[0]) !== removedIndex).map(([key, item]) => {
    const parts = key.split(':');
    return [`${shiftChapter(parts[0])}:${parts.slice(1).join(':')}`, item];
  }));
  return {...value, [entriesKey]:entries};
};
const rewriteJson = async (file, backup, transform) => {
  try {
    const raw = await readFile(file, 'utf8');
    const next = JSON.stringify(transform(JSON.parse(raw)), null, 2) + '\n';
    await copyFile(file, backup);
    await writeFile(file, next, 'utf8');
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
};

const html = await readFile(reader, 'utf8');
const bookMatch = html.match(/(<script id="bookData" type="application\/json">)([\s\S]*?)(<\/script>)/);
if (!bookMatch) throw new Error('找不到 bookData');
const chapters = JSON.parse(bookMatch[2]);
const duplicateIndexes = chapters.flatMap((chapter, index) => isDuplicateContentsChapter(chapter) ? [index] : []);
if (!duplicateIndexes.length) {
  console.log('没有发现重复的分部目录页，未修改。');
  process.exit(0);
}
if (duplicateIndexes.length !== 1 || duplicateIndexes[0] !== removedIndex) throw new Error(`发现未预期的重复项：${duplicateIndexes.join(', ')}`);

const nextChapters = chapters.filter((_, index) => index !== removedIndex);
let updated = html.replace(bookMatch[0], `${bookMatch[1]}${JSON.stringify(nextChapters)}${bookMatch[3]}`);
const oldChapterInit = "const chapters=JSON.parse(document.getElementById('bookData').textContent),$=s=>document.querySelector(s);let current=Math.min(Number(localStorage.threeBodyChapter||0),chapters.length-1)";
const newChapterInit = "const chapters=JSON.parse(document.getElementById('bookData').textContent),$=s=>document.querySelector(s);const chapterIndexMigrationKey='threeBodyChapterIndexVersion';const rawChapter=Number(localStorage.threeBodyChapter||0);if(localStorage.getItem(chapterIndexMigrationKey)!=='1'){if(Number.isFinite(rawChapter)&&rawChapter>4)localStorage.threeBodyChapter=String(rawChapter-1);localStorage.setItem(chapterIndexMigrationKey,'1')}let current=Math.min(Number(localStorage.threeBodyChapter||0),chapters.length-1)";
if (!updated.includes(oldChapterInit)) throw new Error('找不到章节位置迁移入口');
updated = updated.replace(oldChapterInit, newChapterInit);
const glossMatch = updated.match(/(const contextualGlossData\s*=\s*)(\{[\s\S]*?\})(;)/);
if (!glossMatch) throw new Error('找不到 contextualGlossData');
const gloss = JSON.parse(glossMatch[2]);
const shiftedGloss = shiftGlossData(gloss);
updated = updated.replace(glossMatch[0], `${glossMatch[1]}${JSON.stringify(shiftedGloss)}${glossMatch[3]}`);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
await copyFile(reader, path.join(localData, `three-body-reader-before-duplicate-contents-fix-${stamp}.html`));
await writeFile(reader, updated, 'utf8');
const glossFile = path.join(localData, 'contextual-glosses-v1.json');
await rewriteJson(glossFile, path.join(localData, `contextual-glosses-v1-before-duplicate-contents-fix-${stamp}.json`), shiftGlossData);
await rewriteJson(path.join(cache, 'learning-marks.json'), path.join(localData, `learning-marks-before-duplicate-contents-fix-${stamp}.json`), shiftedMarks);
console.log(`已删除重复目录页：${removedIndex}（${chapters[removedIndex].title}）`);
const glossEntriesKey = Object.hasOwn(gloss, 'entries:') ? 'entries:' : 'entries';
console.log(`章节数：${chapters.length} → ${nextChapters.length}；句中义条目：${Object.keys(gloss[glossEntriesKey] || {}).length} → ${Object.keys(shiftedGloss[glossEntriesKey] || {}).length}`);
console.log(`所有备份已保存到：${localData}`);
