import {copyFile, readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reader = path.join(project, 'outputs', 'three-body-reader.html');
const backup = path.join(project, '本地数据', 'three-body-reader-before-part-title-case-fix.html');
const html = await readFile(reader, 'utf8');
const match = html.match(/(<script id="bookData" type="application\/json">)([\s\S]*?)(<\/script>)/);
if (!match) throw new Error('找不到 bookData');
const chapters = JSON.parse(match[2]);
const replacements = new Map([['Part Ii', 'Part II'], ['Part Iii', 'Part III']]);
let changed = 0;
for (const chapter of chapters) {
  const next = replacements.get(chapter.title);
  if (next) { chapter.title = next; changed++; }
}
if (!changed) { console.log('没有需要修正的分部标题。'); process.exit(0); }
await copyFile(reader, backup);
await writeFile(reader, html.replace(match[0], `${match[1]}${JSON.stringify(chapters)}${match[3]}`), 'utf8');
console.log(`已修正 ${changed} 个分部标题；原文件备份：${backup}`);
