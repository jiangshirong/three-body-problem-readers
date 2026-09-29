import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGLISH = path.resolve(HERE, '..');
const READER = path.join(ENGLISH, 'outputs', 'three-body-reader.html');
const WORDLIST_DIR = path.join(ENGLISH, '本地数据', 'exam-wordlists');
const OUTPUT_DIR = path.join(ENGLISH, 'outputs');
const OUTPUT_REPORT = path.join(ENGLISH, 'outputs', '三体第一册考试词表匹配报告.md');
const EXAM_LABELS = { IELTS: '雅思', TOEFL: '托福', TOEIC: '托业' };

function embeddedJson(html, id) {
  const match = html.match(new RegExp(`<script id="${id}" type="application/json">([\\s\\S]*?)</script>`));
  if (!match) throw new Error(`未找到内嵌数据：${id}`);
  return JSON.parse(match[1]);
}

function cleanHead(raw) {
  return String(raw ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/^\s*(?:[-*•]+|\d+[.)])\s*/, '')
    .replace(/[：:]+$/, '')
    .trim();
}

function expandHead(raw) {
  let head = cleanHead(raw);
  if (!head || /^(?:===+|---+|\+{2,}|[A-Za-z\s]+教育)$/.test(head)) return [];
  head = head.replace(/[“”"'`]/g, '');
  const variants = new Set();
  const add = value => {
    const token = value.trim().toLowerCase().normalize('NFKC');
    if (/^[a-z]+(?:[-'][a-z]+)*$/.test(token)) variants.add(token);
  };
  // `aesthetic(al)` -> both forms; this is still a word-list membership check,
  // not a new morphological guess about the book.
  const parenthetical = head.match(/^([A-Za-z-]+)\(([A-Za-z-]+)\)$/);
  if (parenthetical) {
    add(parenthetical[1]);
    add(parenthetical[1] + parenthetical[2]);
    return [...variants];
  }
  // A slash-separated spelling variant is recorded as either spelling.
  if (/^[A-Za-z-]+(?:\/[A-Za-z-]+)+$/.test(head)) {
    for (const part of head.split('/')) add(part);
    return [...variants];
  }
  add(head);
  return [...variants];
}

function parseWordList(text, kind) {
  const words = new Set();
  for (const originalLine of text.split(/\r?\n/)) {
    let line = originalLine.trim();
    if (!line) continue;
    if (kind === 'ielts' && line.includes('|')) line = line.split('|', 1)[0];
    if (kind === 'toefl' && line.includes('\t')) line = line.split('\t', 1)[0];
    if (kind === 'toeic' && line.includes(',')) line = line.split(',', 1)[0];
    if (kind === 'toeic' && /^[0-9]+[.)\s]/.test(line)) line = line.replace(/^[0-9]+[.)\s]+/, '');
    for (const word of expandHead(line)) words.add(word);
  }
  return words;
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const html = await readFile(READER, 'utf8');
const wordFrequency = embeddedJson(html, 'wordFrequencyData');
const forms = wordFrequency.forms ?? {};
const strictCounts = wordFrequency.strictCounts ?? {};

// The reader already owns the inflection grouping. We reuse its strict IDs;
// no second stemming or spelling-guessing pass is performed here.
const rows = Object.entries(strictCounts)
  .map(([word, count]) => ({ word, count: Number(count) || 0 }))
  .filter(row => row.word && row.count > 0)
  .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));

const listFiles = {
  IELTS: ['ielts-vocabulary.txt', 'ielts'],
  TOEFL: ['toefl-core.csv', 'toefl'],
  TOEIC: ['toeic-service-list.csv', 'toeic']
};
const examSets = {};
for (const [exam, [file, kind]] of Object.entries(listFiles)) {
  const content = await readFile(path.join(WORDLIST_DIR, file), 'utf8');
  examSets[exam] = parseWordList(content, kind);
}

const strictMembers = new Map();
for (const [form, data] of Object.entries(forms)) {
  const strictId = data?.strictId || form.toLowerCase();
  const members = strictMembers.get(strictId) ?? new Set();
  members.add(form.toLowerCase());
  members.add(strictId.toLowerCase());
  strictMembers.set(strictId, members);
}
const matchedStrict = {};
for (const [exam, words] of Object.entries(examSets)) {
  const strictIds = new Set([...strictMembers.entries()]
    .filter(([, members]) => [...members].some(member => words.has(member)))
    .map(([strictId]) => strictId));
  matchedStrict[exam] = strictIds;
}

await mkdir(OUTPUT_DIR, { recursive: true });
const outputCsvs = {};
for (const [exam, strictIds] of Object.entries(matchedStrict)) {
  const examRows = [...examSets[exam]].map(word => {
    const ids = [...strictMembers.entries()]
      .filter(([, members]) => members.has(word))
      .map(([strictId]) => strictId);
    const count = ids.reduce((sum, id) => sum + (Number(strictCounts[id]) || 0), 0);
    return { word, count };
  }).sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));
  const csv = ['单词,出现次数', ...examRows.map(row => `${csvCell(row.word)},${row.count}`)].join('\r\n') + '\r\n';
  const outputPath = path.join(OUTPUT_DIR, `三体第一册-${EXAM_LABELS[exam]}词频表.csv`);
  await writeFile(outputPath, '\uFEFF' + csv, 'utf8');
  outputCsvs[exam] = outputPath;
}

const totalOccurrences = rows.reduce((sum, row) => sum + row.count, 0);
const report = [
  '# 《三体》第一册词频与考试词表匹配',
  '',
  `生成时间：${new Date().toISOString()}`,
  '',
  '三张表都严格复用阅读器已有的“严格词形”分组：例如 `word` 与 `words` 共享同一个词形 ID，因此各自只输出一行；没有重新进行词干猜测。',
  '',
  `- 严格词形行数：${rows.length.toLocaleString('en-US')}`,
  `- 合计出现次数：${totalOccurrences.toLocaleString('en-US')}`,
  `- IELTS 词表条目（可匹配单词）：${examSets.IELTS.size.toLocaleString('en-US')}`,
  `- TOEFL 词表条目（可匹配单词）：${examSets.TOEFL.size.toLocaleString('en-US')}`,
  `- TOEIC 词表条目（可匹配单词）：${examSets.TOEIC.size.toLocaleString('en-US')}`,
  '',
  '| 考试 | 《三体》匹配的严格词形数 | 匹配词形的出现次数 |',
  '| --- | ---: | ---: |',
  ...Object.entries(matchedStrict).map(([exam, ids]) => {
    const count = [...ids].reduce((sum, id) => sum + (Number(strictCounts[id]) || 0), 0);
    const formRate = rows.length ? (ids.size / rows.length * 100).toFixed(2) : '0.00';
    const occurrenceRate = totalOccurrences ? (count / totalOccurrences * 100).toFixed(2) : '0.00';
    return `| ${exam} | ${ids.size.toLocaleString('en-US')}（${formRate}%） | ${count.toLocaleString('en-US')}（${occurrenceRate}%） |`;
  }),
  '',
  ...Object.entries(examSets).map(([exam, words]) => {
    const zeroCount = [...words].filter(word => ![...strictMembers.values()].some(members => members.has(word))).length;
    return `- ${EXAM_LABELS[exam]}表：本书出现过 ${ (words.size - zeroCount).toLocaleString('en-US') } 个，出现次数为 0 的词 ${zeroCount.toLocaleString('en-US')} 个`;
  }),
  '',
  '词表文件保存在 `英语/本地数据/exam-wordlists/`；该目录属于本机数据，不会自动提交到 Git。',
  ...Object.entries(outputCsvs).map(([exam, outputPath]) => `- ${EXAM_LABELS[exam]}：\`${path.relative(process.cwd(), outputPath)}\``)
].join('\n') + '\n';
await writeFile(OUTPUT_REPORT, report, 'utf8');

console.log(JSON.stringify({
  outputCsvs,
  outputReport: OUTPUT_REPORT,
  rows: rows.length,
  totalOccurrences,
  matched: Object.fromEntries(Object.entries(matchedStrict).map(([exam, ids]) => [exam, {
    strictForms: ids.size,
    occurrences: [...ids].reduce((sum, id) => sum + (Number(strictCounts[id]) || 0), 0)
  }]))
}, null, 2));
