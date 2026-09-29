// 历史预演脚本：其中的词元链规则会误改正确词形，禁止用于回写当前阅读器。
// 当前定向修复见 resolve-strict-form-conflicts.mjs 和 apply-strict-form-conflicts.mjs。
if (process.argv.includes('--apply')) throw new Error('此词元链方案已废弃，不能回写；请使用定向冲突修复结果。');
// 词形组(strictId)原来是顺着 ECDICT 的词元链一路推到底,而这条链会跨过同形词:
// ECDICT 把 wound 的词元记为 wind(它确实是 wind 的过去式),于是 wounded → wound → wind
// 一并到底,`wounded` / `wounding` / `wounds` 就成了 wind 的词形 —— 可它们只属于"使受伤"那个词。
// 结果是词形计数把两个词的出现次数加在一起,出现"词形比词族还多"。
//
// 修法:词元链跨到"属于别的词族"的词就停下。
//   strictId(F) = 顺着 F 的 0:(词元) 往上一层层走,只要那一层的词族与 F 自己的词族相同就继续,
//                 一旦不同(或没有词元)就停在当前这一层。
// 这样同一个词形组里的词都同族,词形计数恒不超过词族计数。
import {copyFile, readFile, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readerPath = path.join(project, 'outputs', 'three-body-reader.html');
const reportPath = path.join(project, 'outputs', '词形组重算报告.md');
const APPLY = process.argv.includes('--apply');

const html = await readFile(readerPath, 'utf8');
function grab(id) {
  const at = html.indexOf(`id="${id}"`);
  if (at < 0) throw new Error(`找不到数据块 ${id}`);
  const start = html.indexOf('>', at) + 1;
  return JSON.parse(html.slice(start, html.indexOf('</script>', start)));
}
const frequency = grab('wordFrequencyData');
const dictionary = grab('dictionaryData');
const forms = Object.keys(frequency.forms);

const lemmaOf = form => {
  const exchange = dictionary.entries?.[form]?.exchange;
  if (!exchange) return null;
  const part = String(exchange).split('/').find(item => item.startsWith('0:'));
  return part ? part.slice(2).trim().toLowerCase() || null : null;
};
const familyOf = form => frequency.forms[form]?.familyId;
// 顺词元链上溯。只有一种情况该停下:词元本身是书里的词、且属于别的词族 ——
// 那说明链跨到了另一个词(wounded → wound → wind 里的 wind)。
// 词元不在这本书里(abolishing 的词元 abolish 没出现)不算跨词,词形身份本来就是词本身的性质,
// 与基词在不在书中无关;同族的词元当然继续上溯。
function clampedRoot(form) {
  const family = familyOf(form);
  let current = form;
  const seen = new Set([form]);
  for (let step = 0; step < 8; step++) {
    const lemma = lemmaOf(current);
    if (!lemma || seen.has(lemma)) break;
    if (frequency.forms[lemma] && familyOf(lemma) !== family) break;   // 跨到别的词族:停
    seen.add(lemma);
    current = lemma;
  }
  return current;
}

const nextStrict = new Map(forms.map(form => [form, clampedRoot(form)]));
const changed = forms.filter(form => frequency.forms[form].strictId !== nextStrict.get(form));

const nextStrictCounts = {};
for (const form of forms) {
  const key = nextStrict.get(form);
  nextStrictCounts[key] = (nextStrictCounts[key] || 0) + (frequency.forms[form].count || 0);
}

const groupMembers = id => forms.filter(form => nextStrict.get(form) === id);
const rows = [];
for (const form of changed) {
  const before = frequency.forms[form].strictId, after = nextStrict.get(form);
  rows.push({form, before, after, members: groupMembers(after).join(', '),
    beforeCount: frequency.strictCounts[before], afterCount: nextStrictCounts[after], familyCount: frequency.familyCounts[familyOf(form)]});
}
console.log(`词形 ${forms.length} 个,strictId 需要改的 ${changed.length} 个,涉及 ${new Set(changed.map(form => nextStrict.get(form))).size} 个新词形组`);
for (const row of rows.slice(0, 20)) {
  console.log(`  ${row.form.padEnd(12)} ${String(row.before).padEnd(10)} → ${String(row.after).padEnd(10)} 词形 ${row.beforeCount} → ${row.afterCount}  词族 ${row.familyCount}  [${row.members}]`);
}

// 验收:重算后不该再有"词形 > 词族"
const violations = forms.filter(form => {
  const strict = nextStrictCounts[nextStrict.get(form)], family = frequency.familyCounts[familyOf(form)];
  return Number.isFinite(strict) && Number.isFinite(family) && strict > family;
});
console.log(`\n验收:词形 > 词族 的词形 ${violations.length} 个${violations.length ? ': ' + violations.slice(0, 10).join(', ') : ''}`);

const report = ['# 词形组重算报告', '',
  '词形组(strictId)原按 ECDICT 的词元链一路推到底,而这条链会跨过同形词:',
  'ECDICT 把 wound 的词元记为 wind(它确实是 wind 的过去式),于是 wounded → wound → wind 一并到底,',
  '`wounded` / `wounding` / `wounds` 被算成了 wind 的词形 —— 可它们只属于"使受伤"那个词。',
  '于是词形计数把两个词的出现次数相加,出现"词形比词族还多"。', '',
  '修法:词元链跨到属于别的词族的词就停下,只在同一词族内上溯。', '',
  `- 改动的词形：${changed.length} 个`,
  `- 重算后"词形 > 词族"残留：${violations.length} 个`, '',
  '## 逐词对照', ''];
for (const row of rows) report.push(`- **${row.form}**：\`${row.before}\` → \`${row.after}\`（词形 ${row.beforeCount} → ${row.afterCount}，词族 ${row.familyCount}）　组内：${row.members}`);
await writeFile(reportPath, report.join('\n') + '\n', 'utf8');
console.log(`报告已写入 ${reportPath}`);
if (!APPLY) { console.log('（未加 --apply:仅预演,数据未改动）'); process.exit(0); }

const nextFrequency = {...frequency,
  strictCounts: nextStrictCounts,
  forms: Object.fromEntries(forms.map(form => [form, {...frequency.forms[form], strictId: nextStrict.get(form)}])),
  formGroupModel: 'strictId 只在同一词族内沿 ECDICT 词元链上溯(跨族即止)',
  formGroupUpdatedAt: new Date().toISOString()};
const at = html.indexOf('id="wordFrequencyData"');
const start = html.indexOf('>', at) + 1;
const end = html.indexOf('</script>', start);
const next = html.slice(0, start) + JSON.stringify(nextFrequency).replace(/</g, '\\u003c') + html.slice(end);
const backup = path.join(project, '本地数据', 'three-body-reader-before-form-groups.html');
await copyFile(readerPath, backup);
const temporary = `${readerPath}.${process.pid}.tmp`;
await writeFile(temporary, next, 'utf8');
await rename(temporary, readerPath);
console.log(`已回写 ${readerPath}（改前版本备份在 ${path.relative(project, backup)}）`);
