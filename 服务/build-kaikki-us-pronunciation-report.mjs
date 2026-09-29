import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataPath = path.join(project, 'outputs', 'us-pronunciations-v2.json');
const rowsPath = path.join(project, 'outputs', 'kaikki-us-pronunciation-audit.jsonl');
const reportPath = path.join(project, 'outputs', '美式音标全词库来源比对报告.md');
const canonical = JSON.parse(await readFile(dataPath, 'utf8'));
const rows = (await readFile(rowsPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));

function expandOptional(ipa) {
  const match = String(ipa).match(/\(([^()]*)\)/);
  if (!match) return [ipa];
  const part = match[0];
  return [...new Set([
    ...expandOptional(ipa.replace(part, match[1])),
    ...expandOptional(ipa.replace(part, ''))
  ])];
}
function norm(ipa) {
  return String(ipa || '').normalize('NFC').toLowerCase()
    .replace(/[\/\[\]ˈˌ.·\s]/g, '')
    .replaceAll('ː', '').replaceAll('͡', '').replaceAll('̯', '')
    .replaceAll('ɹ', 'r').replaceAll('ɫ', 'l').replaceAll('ɡ', 'g')
    .replaceAll('ɚ', 'ər').replaceAll('ɝ', 'ɜr').replaceAll('ɜːr', 'ɜr')
    .replaceAll('l̩', 'əl').replaceAll('n̩', 'ən').replaceAll('m̩', 'əm')
    .replaceAll('t̬', 't').replaceAll('ɐ', 'ə');
}
const sourceRows = rows.map(row => {
  const source = row.sourceUS || [];
  const local = row.local || [];
  const sourceByIpa = new Map();
  for (const item of source) {
    const key = norm(item.ipa);
    const group = sourceByIpa.get(key) || [];
    if (!group.some(existing => existing.ipa === item.ipa && existing.pos === item.pos)) group.push(item);
    sourceByIpa.set(key, group);
  }
  const localKeys = new Set(local.flatMap(item => expandOptional(item.ipa).map(norm)));
  const sourceKeys = new Set([...sourceByIpa.entries()].flatMap(([key, items]) => items.flatMap(item => expandOptional(item.ipa).map(norm))));
  const missing = [...sourceByIpa.entries()].filter(([, items]) => !items.some(item => expandOptional(item.ipa).some(form => localKeys.has(norm(form))))).map(([, items]) => items[0]);
  const unmatched = [...new Map(local.filter(item => !expandOptional(item.ipa).some(form => sourceKeys.has(norm(form)))).map(item => [norm(item.ipa), item])).values()];
  return {...row, sourceUS: [...sourceByIpa.values()].flat(), comparison: {
    sourceIpaMatchCount: sourceByIpa.size - missing.length,
    sourceCandidatesMissingLocally: missing,
    localCandidatesNotInExplicitWiktionaryUS: unmatched
  }};
});
const counts = Object.fromEntries([...new Set(sourceRows.map(row => row.status))].sort().map(status => [status, sourceRows.filter(row => row.status === status).length]));
const explicit = sourceRows.filter(row => row.status === 'explicit-us-found');
const missingSource = sourceRows.filter(row => row.comparison.sourceCandidatesMissingLocally.length);
const missingCount = missingSource.reduce((n, row) => n + row.comparison.sourceCandidatesMissingLocally.length, 0);
const localOnly = sourceRows.filter(row => row.comparison.localCandidatesNotInExplicitWiktionaryUS.length);
const pending = sourceRows.filter(row => !['explicit-us-found', 'page-found-no-explicit-us-ipa'].includes(row.status));
const lines = [
  '# 美式音标全词库来源比对报告', '',
  `生成时间：${new Date().toISOString()}`, '',
  `- 当前范围状态：${rows.length === Object.keys(canonical.entries).length ? '全词头已遍历' : `处理中（${rows.length} / ${Object.keys(canonical.entries).length}）`}`,
  `- 词库总词头：${Object.keys(canonical.entries).length.toLocaleString('en-US')}`,
  `- 已获取来源页面：${sourceRows.length.toLocaleString('en-US')} / ${Object.keys(canonical.entries).length.toLocaleString('en-US')}`,
  `- 明确带 US / General-American 标签的词头：${explicit.length.toLocaleString('en-US')}`,
  `- 页面存在但没有明确美式 IPA 标签：${counts['page-found-no-explicit-us-ipa'] || 0}`,
  `- 页面未找到或请求未完成：${pending.length}`,
  `- Wiktionary 明列、但本地未能匹配的不同读音：${missingCount}`,
  `- 有本地读音未出现在该页面明确美式列表中的词头：${localOnly.length}`,
  '',
  '## 判读规则', '',
  '- 来源为 Kaikki 提取的 Wiktionary 英语词条（来源快照日期 2026-09-02）；每词源数据 URL 和词头都保存在配套 JSONL。Wiktionary 是可追溯的开放词典，但不是 Cambridge/Oxford 这类编辑型词典。',
  '- 只抽取声音记录中明确标为 `US` 或 `General-American` 的 IPA；未标口音的 IPA 不当作美式证据。',
  '- 报告中的匹配仅做常见转写规范化（音节点、长度符号、ɹ/ɚ、音节化辅音等）；这只判断是否可能是同一读音，不覆盖来源原始 IPA。',
  '- “来源未匹配”只代表值得核查，不自动认定本地错；单一来源未列出的其他读音也不自动删除。所有缺项和冲突留在 JSONL 逐词行中。', '',
  '## 各词头来源状态', '',
  '| 状态 | 数量 |', '| --- | ---: |',
  ...Object.entries(counts).map(([status, count]) => `| ${status} | ${count} |`), '',
  '## 待复核概览', '',
  '| 词头 | Wiktionary 明列美式读音 | 本地读音 | 需要复核 | 来源页 |',
  '| --- | --- | --- | --- | --- |',
  ...sourceRows.filter(row => row.comparison.sourceCandidatesMissingLocally.length || row.comparison.localCandidatesNotInExplicitWiktionaryUS.length || !['explicit-us-found', 'page-found-no-explicit-us-ipa'].includes(row.status)).map(row => {
    const src = [...new Set(row.sourceUS.map(item => item.ipa))].join(' · ') || '无明确 US 标注';
    const local = [...new Set((row.local || []).map(item => item.ipa))].join(' · ') || '无';
    const issues = [
      row.comparison.sourceCandidatesMissingLocally.length ? `来源有而本地未匹配 ${row.comparison.sourceCandidatesMissingLocally.length}` : '',
      row.comparison.localCandidatesNotInExplicitWiktionaryUS.length ? `本地候选未在来源明确 US 列表中 ${row.comparison.localCandidatesNotInExplicitWiktionaryUS.length}` : '',
      !['explicit-us-found', 'page-found-no-explicit-us-ipa'].includes(row.status) ? row.status : ''
    ].filter(Boolean).join('；') || '核对转写等价性';
    return `| ${row.word.replaceAll('|', '\\|')} | ${src.replaceAll('|', '\\|')} | ${local.replaceAll('|', '\\|')} | ${issues} | [Kaikki/Wiktionary](${row.sourceUS[0]?.sourceUrl || row.url.replace(/\.jsonl$/, '.html')}) |`;
  }), '',
  '## 可复核原始明细', '',
  `逐词 JSONL：\`${path.relative(project, rowsPath).replaceAll('\\', '/')}\`。该文件保留来源 IPA、词性、标签、本地 IPA、候选差异、失败状态和来源页面链接。`, ''
];
await writeFile(reportPath, `${lines.join('\n')}\n`, 'utf8');
console.log(JSON.stringify({reportPath, rows: rows.length, counts, explicitWords: explicit.length, sourceMissingReadingCount: missingCount, localOnlyWords: localOnly.length, pending: pending.length}));
