import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rawFile = path.join(project, 'outputs', 'us-pronunciations.json');
const canonicalFile = path.join(project, 'outputs', 'us-pronunciations-v2.json');
const readerFile = path.join(project, 'outputs', 'three-body-reader.html');
const labels = new Map([
  ['/ˈkɑːntræktɪŋ/', ['noun', '名']],
  ['/kənˈtræktɪŋ/', ['verb', '动']]
]);

function apply(entries, canonical) {
  const records = entries.contracting;
  if (!Array.isArray(records)) throw new Error('词典数据中没有 contracting 音标记录。');
  const found = new Set();
  for (const record of records) {
    const mapping = labels.get(record.ipa);
    if (!mapping) continue;
    record.pos = mapping[0];
    if (canonical) record.posLabel = mapping[1];
    found.add(record.ipa);
  }
  if (found.size !== labels.size) throw new Error(`contracting 音标记录不完整：${[...found].join(', ')}`);
}

const raw = JSON.parse(await readFile(rawFile, 'utf8'));
apply(raw.entries || {}, false);
await writeFile(rawFile, `${JSON.stringify(raw)}\n`, 'utf8');

const canonical = JSON.parse(await readFile(canonicalFile, 'utf8'));
apply(canonical.entries || {}, true);
await writeFile(canonicalFile, `${JSON.stringify(canonical)}\n`, 'utf8');

const html = await readFile(readerFile, 'utf8');
const embedded = JSON.stringify(canonical).replace(/</g, '\\u003c');
const pattern = /(<script id="americanPronunciationData" type="application\/json">)[\s\S]*?(<\/script>)/;
if (!pattern.test(html)) throw new Error('阅读器中没有找到美式音标数据区域。');
await writeFile(readerFile, html.replace(pattern, `$1${embedded}$2`), 'utf8');
console.log(JSON.stringify({word:'contracting',records:[...labels].map(([ipa,[pos,label]])=>({ipa,pos,label}))}, null, 2));
