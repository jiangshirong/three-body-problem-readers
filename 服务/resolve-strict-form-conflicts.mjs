// Ask DeepSeek to split only strict-form groups that cross existing families.
import {readFile, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDpapiSecretStore} from './reader-server.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readerPath = path.join(project, 'outputs', 'three-body-reader.html');
const auditPath = path.join(project, '本地数据', 'strict-form-conflict-adjudication.json');
const html = await readFile(readerPath, 'utf8');
function block(id) {
  const at = html.indexOf('id="' + id + '"');
  if (at < 0) throw new Error('缺少 ' + id);
  const start = html.indexOf('>', at) + 1;
  return JSON.parse(html.slice(start, html.indexOf('</script>', start)));
}
const frequency = block('wordFrequencyData');
const dictionary = block('dictionaryData');
const chapters = block('bookData');
const byStrict = new Map();
for (const [form, data] of Object.entries(frequency.forms)) {
  const members = byStrict.get(data.strictId) || [];
  members.push(form);
  byStrict.set(data.strictId, members);
}
const conflicts = [...byStrict].filter(([, members]) =>
  new Set(members.map(form => frequency.forms[form].familyId)).size > 1);
const only = process.argv.find(arg => arg.startsWith('--only='))?.slice('--only='.length);
const force = process.argv.includes('--force');

const paragraphs = chapters.flatMap((chapter, chapterIndex) =>
  [...String(chapter.content).matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((match, paragraphIndex) => ({
    chapter: chapterIndex, paragraph: paragraphIndex,
    text: match[1].replace(/<[^>]*>/g, ' ').replace(/&(?:[a-z]+|#\d+);/gi, ' ').replace(/\s+/g, ' ').trim()
  })));
function contexts(form) {
  const escaped = form.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  const re = new RegExp('(^|[^\\p{L}])(' + escaped + ')(?=$|[^\\p{L}])', 'giu');
  const found = [];
  for (const p of paragraphs) for (const match of p.text.matchAll(re)) {
    const at = match.index + match[1].length;
    found.push(p.chapter + ':' + p.paragraph + ' …' +
      p.text.slice(Math.max(0, at - 65), Math.min(p.text.length, at + form.length + 65)) + '…');
  }
  if (found.length <= 16) return found;
  return Array.from({length:16}, (_, index) => found[Math.floor(index * (found.length - 1) / 15)]);
}
function candidate(id, members) {
  return {
    id, families:[...new Set(members.map(form => frequency.forms[form].familyId))],
    forms:members.map(form => ({
      form, count:frequency.forms[form].count,
      currentStrictId:frequency.forms[form].strictId,
      currentFamilyId:frequency.forms[form].familyId,
      exchange:dictionary.entries?.[form]?.exchange || '',
      translation:String(dictionary.entries?.[form]?.translation || '').slice(0, 260),
      definition:String(dictionary.entries?.[form]?.definition || '').slice(0, 200),
      contexts:contexts(form)
    }))
  };
}

const secret = (await createDpapiSecretStore(path.join(project, '本地数据', '.reader-cache', 'reader-secrets.dpapi.json')).load()).deepseek;
if (!secret) throw new Error('未找到已保存的 DeepSeek 密钥');
let state;
try { state = JSON.parse(await readFile(auditPath, 'utf8')); }
catch { state = {version:1, model:'deepseek-flash', groups:{}}; }
const prompt = [
  '你在整理一本英语小说的词形频度。输入中每个组的 strictId 错把多个不同词混到一起。',
  '结合书中例句、词典释义与英语词形关系，为每个 form 输出一个静态归属。',
  'strictId 表示同一词的单复数、动词时态或形容词比较级；familyId 表示广义派生词族。',
  '一个表面词形只能计入一组；同形异义时按本书例句里的主要用途决定，不能复制计数。',
  '两种用途相当且无法区分时，优先保留现有 familyId。',
  '最终共享同一个 strictId 的所有词形必须共享同一个 familyId，不能让词形组跨广义词族。',
  '按提供的本书例句判断主要用途。例如 lay 如果多数为 lie(躺)的过去式，应归 lie；bore 如果两种用法一样多，保留现有 bore 族。',
  'ups 表示 ups and downs 的名词复数，与 up 介词/副词不属于同一个严格词形组。',
  '允许拆开现有组，把明显错放的形式并到输入中的基础词。',
  'ECDICT 的 0: 只是线索，可能有错误，不能机械上溯。',
  '特别注意 rose 的实际用法、wound 的伤口义与 wind 的过去式、lay 的两个动词用法，以及 leaves 的树叶义与 leave 的第三人称单数。',
  '只输出 JSON：{"assignments":[{"form":"原输入形式","strictId":"规范基础词形","familyId":"广义词族头","reason":"简短理由"}]}。',
  '必须覆盖全部形式。strictId、familyId 必须取自输入 forms 的 form/currentStrictId/currentFamilyId，不能发明拼写。'
].join('\n');
async function adjudicate(group) {
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer ' + secret},
    body:JSON.stringify({model:'deepseek-flash', thinking:{type:'disabled'}, temperature:0,
      response_format:{type:'json_object'}, max_tokens:2000,
      messages:[{role:'system',content:prompt},{role:'user',content:JSON.stringify(group)}]})
  });
  if (!response.ok) throw new Error('DeepSeek HTTP ' + response.status + ': ' + (await response.text()).slice(0, 180));
  const raw = await response.json();
  const content = raw.choices?.[0]?.message?.content || '';
  const result = JSON.parse(content);
  const allowedForms = new Set(group.forms.map(item => item.form));
  const allowedIds = new Set([...allowedForms, ...group.families, group.id]);
  const assignments = result.assignments;
  if (!Array.isArray(assignments) || assignments.length !== allowedForms.size ||
      new Set(assignments.map(item => item.form)).size !== allowedForms.size ||
      assignments.some(item => !allowedForms.has(item.form) || !allowedIds.has(item.strictId) || !allowedIds.has(item.familyId)))
    throw new Error('模型对 ' + group.id + ' 的归类不完整或使用了组外词形');
  return {input:group, assignments, raw:content, usage:raw.usage || null};
}
async function save() {
  const temp = auditPath + '.' + process.pid + '.tmp';
  await writeFile(temp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  await rename(temp, auditPath);
}
for (const [id, members] of conflicts) {
  if (only && id !== only) continue;
  if (!force && state.groups[id]?.assignments?.length === members.length) continue;
  try {
    state.groups[id] = await adjudicate(candidate(id, members));
    await save();
    console.log(id + ': ' + state.groups[id].assignments.map(item =>
      item.form + '→' + item.strictId + '/' + item.familyId).join(', '));
  } catch (error) {
    console.error(id + ': ' + error.message);
    process.exitCode = 1;
  }
}
console.log('冲突组 ' + conflicts.length + '，词形 ' +
  conflicts.reduce((sum, [, list]) => sum + list.length, 0) +
  '；已裁定 ' + Object.keys(state.groups).length + ' 组。');
