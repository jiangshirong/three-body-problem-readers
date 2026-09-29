// Apply the saved, reviewed verdicts for the 11 cross-family strict-form groups.
// No model calls occur here. Run without --apply for a validation preview.
import {readFile, writeFile, rename} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readerPath = path.join(project, 'outputs', 'three-body-reader.html');
const auditPath = path.join(project, '本地数据', 'strict-form-conflict-adjudication.json');
const backupPath = path.join(project, '本地数据', 'three-body-reader-before-strict-conflicts.html');
const reportPath = path.join(project, 'outputs', '严格词形冲突修复报告.md');
const apply = process.argv.includes('--apply');
const html = await readFile(readerPath, 'utf8');
const audit = JSON.parse(await readFile(auditPath, 'utf8'));
function readBlock(id) {
  const at = html.indexOf('id="' + id + '"');
  if (at < 0) throw new Error('缺少数据块 ' + id);
  const start = html.indexOf('>', at) + 1;
  return JSON.parse(html.slice(start, html.indexOf('</script>', start)));
}
function replaceBlock(source, id, value) {
  const at = source.indexOf('id="' + id + '"');
  const start = source.indexOf('>', at) + 1;
  const end = source.indexOf('</script>', start);
  return source.slice(0, start) + JSON.stringify(value).replace(/</g, '\\u003c') + source.slice(end);
}
const frequency = readBlock('wordFrequencyData');
const families = readBlock('wordFamiliesData');
const oldForms = frequency.forms;
const byStrict = new Map();
for (const [form, item] of Object.entries(oldForms)) {
  const members = byStrict.get(item.strictId) || [];
  members.push(form);
  byStrict.set(item.strictId, members);
}
const conflicts = [...byStrict].filter(([, members]) =>
  new Set(members.map(form => oldForms[form].familyId)).size > 1);
if (!conflicts.length && frequency.strictConflictReview?.groups === 11) {
  const selfCount = Object.entries(oldForms).filter(([form, data]) => form === data.strictId).length;
  if (apply && frequency.summary.selfOnlyStrictFormCount !== selfCount) {
    const refreshed = {...frequency, summary:{...frequency.summary, selfOnlyStrictFormCount:selfCount}};
    const temp = readerPath + '.' + process.pid + '.tmp';
    await writeFile(temp, replaceBlock(html, 'wordFrequencyData', refreshed), 'utf8');
    await rename(temp, readerPath);
    console.log('已更新严格词形摘要：自身词形 ' + selfCount);
  } else console.log('定向修复已应用；无需重复修改。');
  process.exit(0);
}
const known = new Set(conflicts.map(([id]) => id));
if (known.size !== 11 || conflicts.reduce((n, [, list]) => n + list.length, 0) !== 47)
  throw new Error('冲突组已经变化，请重新审计，不套用旧裁定');
if (Object.keys(audit.groups || {}).length !== known.size ||
    Object.keys(audit.groups).some(id => !known.has(id)))
  throw new Error('模型裁定的组数与当前冲突组不符');

const verdicts = new Map();
for (const [id, members] of conflicts) {
  const group = audit.groups[id];
  const got = group?.assignments || [];
  const allowed = new Set([id, ...members, ...members.map(form => oldForms[form].familyId)]);
  if (got.length !== members.length || new Set(got.map(item => item.form)).size !== members.length ||
      got.some(item => !members.includes(item.form) || !allowed.has(item.strictId) || !allowed.has(item.familyId)))
    throw new Error(id + ' 的裁定不完整或不属于此组');
  for (const item of got) verdicts.set(item.form, {...item});
}
// Both spellings were judged against the book and the user's one-form-one-group rule.
// "bore" occurs once as bear's past tense and once as the base verb "bore you":
// the tie stays with its existing group. "ups" is a noun in "ups and downs",
// not an inflection of the overwhelmingly adverbial/prepositional "up".
const corrections = {
  bore:{strictId:'bore',familyId:'bore',reason:'书中 bear 过去式与 bore 原形各一次；平局保留原组'},
  ups:{strictId:'ups',familyId:'ups',reason:'书中为 ups and downs 的名词；与 up 不是同一严格词形'}
};
for (const [form, correction] of Object.entries(corrections)) {
  if (!verdicts.has(form)) throw new Error('校正词形已不在冲突组：' + form);
  Object.assign(verdicts.get(form), correction);
}
verdicts.get('left').reason = '书中主要用作 leave 的过去式，也有方向义；静态归属按主要用法';

const nextForms = Object.fromEntries(Object.entries(oldForms).map(([form, data]) => {
  const verdict = verdicts.get(form);
  return [form, verdict ? {...data, strictId:verdict.strictId, familyId:verdict.familyId} : {...data}];
}));
const nextFamilyForms = {...families.forms};
for (const [form, verdict] of verdicts) nextFamilyForms[form] = verdict.familyId;
const nextStrictCounts = {}, nextFamilyCounts = {}, nextGroups = {};
for (const [form, data] of Object.entries(nextForms)) {
  const count = data.count || 0;
  nextStrictCounts[data.strictId] = (nextStrictCounts[data.strictId] || 0) + count;
  nextFamilyCounts[data.familyId] = (nextFamilyCounts[data.familyId] || 0) + count;
}
for (const [form, family] of Object.entries(nextFamilyForms)) {
  (nextGroups[family] ||= []).push(form);
  if (nextForms[form] && nextForms[form].familyId !== family)
    throw new Error('词形与词族表不一致：' + form);
}
for (const members of Object.values(nextGroups)) members.sort();
for (const family of Object.keys(nextGroups)) nextFamilyCounts[family] ??= 0;
const strictFamilies = new Map();
for (const [form, data] of Object.entries(nextForms)) {
  (strictFamilies.get(data.strictId) || strictFamilies.set(data.strictId, new Set()).get(data.strictId)).add(data.familyId);
  if (nextStrictCounts[data.strictId] > nextFamilyCounts[data.familyId])
    throw new Error('词形次数超过词族次数：' + form);
}
const remaining = [...strictFamilies].filter(([, ids]) => ids.size > 1);
if (remaining.length) throw new Error('仍有跨词族的严格词形组：' + remaining.map(([id]) => id).join(', '));
const beforeTotal = Object.values(oldForms).reduce((n, item) => n + (item.count || 0), 0);
const afterTotal = Object.values(nextForms).reduce((n, item) => n + (item.count || 0), 0);
if (beforeTotal !== afterTotal ||
    Object.values(nextStrictCounts).reduce((a, b) => a + b, 0) !== afterTotal ||
    Object.values(nextFamilyCounts).reduce((a, b) => a + b, 0) !== afterTotal)
  throw new Error('词频总数不守恒');
const changed = [...verdicts.values()].filter(item =>
  oldForms[item.form].strictId !== nextForms[item.form].strictId ||
  oldForms[item.form].familyId !== nextForms[item.form].familyId);
const nextFrequency = {...frequency, forms:nextForms,
  strictCounts:nextStrictCounts, familyCounts:nextFamilyCounts,
  summary:{...frequency.summary, strictGroups:Object.keys(nextStrictCounts).length,
    broadFamilies:Object.keys(nextGroups).length,
    selfOnlyStrictFormCount:Object.entries(nextForms).filter(([form, data]) => form === data.strictId).length},
  strictConflictReview:{model:'deepseek-flash', groups:conflicts.length,
    forms:verdicts.size, corrections:Object.keys(corrections)}};
const nextFamilies = {...families, forms:nextFamilyForms, groups:nextGroups};
const examples = ['wind','wound','wounded','rose','rise','leaf','leaves','leave','left','bore','bored','up','ups'];
const report = [
  '# 严格词形冲突修复报告', '',
  '候选来自当前 strictId 跨越多个词族的组。DeepSeek-Flash 按书中语境逐组裁定；应用前对平局和结构约束作了两处校正。', '',
  '- 冲突组：' + conflicts.length,
  '- 审查词形：' + verdicts.size,
  '- 修改归属：' + changed.length,
  '- 剩余跨族严格组：' + remaining.length,
  '- 全书词汇出现总数：' + afterTotal,
  '- 严格词形组：' + Object.keys(nextStrictCounts).length,
  '- 广义词族：' + Object.keys(nextGroups).length,
  '', '## 校正模型结果', '',
  '- bore：书中「bore the ultimate responsibility」和「bore you」各一次；平局保留原归属 bore。',
  '- ups：书中为名词，如「ups and downs」；独立于介词／副词 up 的严格词形组。',
  '', '## 修改的词形', ''
];
for (const item of changed) {
  const before = oldForms[item.form], after = nextForms[item.form];
  report.push('- ' + item.form + '：词形 ' + before.strictId + ' → ' + after.strictId +
    '；词族 ' + before.familyId + ' → ' + after.familyId + '。' + item.reason);
}
report.push('', '## 核心词频', '');
for (const form of examples) {
  const data = nextForms[form];
  report.push('- ' + form + '：词形 ' + nextStrictCounts[data.strictId] +
    '，词族 ' + nextFamilyCounts[data.familyId] + '（' + data.strictId + ' / ' + data.familyId + '）');
}
if (!apply) {
  console.log('预演通过：' + conflicts.length + ' 组、' + verdicts.size + ' 词形，修改 ' +
    changed.length + ' 个；剩余跨族组 ' + remaining.length);
  for (const form of examples) {
    const item = nextForms[form];
    console.log(form + ': ' + item.strictId + '/' + item.familyId +
      ' 词形 ' + nextStrictCounts[item.strictId] + ' 词族 ' + nextFamilyCounts[item.familyId]);
  }
  process.exit(0);
}
let nextHtml = replaceBlock(html, 'wordFamiliesData', nextFamilies);
nextHtml = replaceBlock(nextHtml, 'wordFrequencyData', nextFrequency);
await writeFile(backupPath, html, 'utf8');
const temp = readerPath + '.' + process.pid + '.tmp';
await writeFile(temp, nextHtml, 'utf8');
await rename(temp, readerPath);
await writeFile(reportPath, report.join('\n') + '\n', 'utf8');
console.log('已应用：' + changed.length + ' 个归属变化，剩余跨族组 ' + remaining.length +
  '；备份已保存。');
