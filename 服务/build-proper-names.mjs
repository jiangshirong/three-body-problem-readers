// 生成"多词专名"表:用于让鼠标悬浮时整段名字一起高亮(Ye Zhetai / Giordano Bruno / Leonardo da Vinci)。
// 规则只负责召回候选(连续大写词,允许 da/de/van/von 这类连接词),由 DeepSeek 判定哪些真的指一个实体。
// 结果作为 properNamesData 嵌入阅读器。
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDpapiSecretStore} from './reader-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, '..');
const readerFile = path.join(project, 'outputs', 'three-body-reader.html');
const reportFile = path.join(project, 'outputs', '多词专名报告.md');
const stateFile = path.join(project, '本地数据', 'proper-names-v1.json');
const model = 'deepseek-flash';
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const dryRun = argv.includes('--dry-run');
const concurrency = 4;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const reader = await readFile(readerFile, 'utf8');
const chapters = JSON.parse((reader.match(/<script id="bookData" type="application\/json">([^]*?)<\/script>/) || [])[1]);
const strip = v => String(v).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
const paragraphsOf = c => [...chapters[c].content.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map(m => strip(m[1])).filter(t => t.length > 0 && /[A-Za-z]/.test(t));

// 召回:末尾必须是大写词,中间允许小写连接词(da/de/van/von 等);冠词 The/A/An 去掉后仍在 2 词以上才算
const phrasePattern = /[A-Z][\p{L}’'\-]*(?:\s+(?:[A-Z][\p{L}’'\-]*|da|de|di|van|von|la|le|del|della|der|du|dos|bin))*\s+[A-Z][\p{L}’'\-]*/gu;
const articles = new Set(['The', 'A', 'An']);
const counts = new Map();
const occurrences = new Map();
for (let c = 0; c < chapters.length; c++) {
  paragraphsOf(c).forEach((text, paragraph) => {
    for (const match of String(text).match(phrasePattern) || []) {
      let tokens = match.split(/\s+/);
      if (articles.has(tokens[0]) && tokens.length > 2) tokens = tokens.slice(1);
      const phrase = tokens.join(' ');
      if (tokens.length < 2 || tokens.length > 4) continue;
      if (!/^[A-Z]/.test(tokens[tokens.length - 1])) continue;
      counts.set(phrase, (counts.get(phrase) || 0) + 1);
      if (!occurrences.has(phrase) && occurrences.size < 400) occurrences.set(phrase, {chapter: c, paragraph, text: text.slice(0, 160)});
    }
  });
}
const candidates = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([phrase, count]) => ({phrase, count, sample: occurrences.get(phrase)?.text || ''}));
console.log('候选多词序列 ' + candidates.length + ' 个（出现 >=2 次 ' + candidates.filter(c => c.count >= 2).length + ' 个）。');
if (dryRun) { console.log(candidates.slice(0, 60).map(c => c.count + ' ' + c.phrase).join('\n')); process.exit(0); }

const batches = [];
for (let i = 0; i < candidates.length; i += 60) batches.push(candidates.slice(i, i + 60));
const instructions = [
  '候选串是"连续大写词"的机械切分,里面可能混进了句首的普通词(例如候选 I’m Leonardo da Vinci 里的 I’m、Only Leonardo 里的 Only)。',
  '请对每个候选给出其中真正的专名——即指代某一个具体人物、地点、组织或造物的固定称呼。允许比候选短,例如候选 I’m Leonardo da Vinci 的专名是 Leonardo da Vinci,候选 Only Leonardo 的专名是 Leonardo(单个词的专名不用输出,本表只收两个词以上的)。',
  '保留:人名(含中间的小写连接词,如 Leonardo da Vinci、Giordano Bruno、Von Neumann)、地名(Red Coast、Greater Khingan Mountains)、组织(Red Guards)、造物代号(Trisolaran Fleet)。',
  '排除:通用名词短语与临时说法(Chinese Thomas Pynchon、Wedge Attack Formation、Two Protons、Energy Unit 这类);称呼职务(Professor Ye、Chairman);章节标题与出版用语(Translator’s Note)。',
  '出现次数只作参考:只出现 1 次但确实是真实专名的必须保留。',
  '严格返回 JSON:{"names":[{"phrase":"Ye Zhetai"}]}，phrase 必须逐字取自某个候选(可以是它的一段连续子串,大小写与原候选一致),不要输出候选之外的串,不要解释。'
].join('\n');
const secretStore = createDpapiSecretStore(path.join(project, '本地数据', '.reader-cache', 'reader-secrets.dpapi.json'));
const secret = (await secretStore.load()).deepseek;
if (!secret) throw new Error('未找到已保存的 DeepSeek API Key');

async function callDeepSeek(batch) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${secret}`},
        body: JSON.stringify({model, thinking: {type: 'disabled'}, temperature: 0, response_format: {type: 'json_object'}, max_tokens: 3000,
          messages: [{role: 'system', content: '你是英文小说的专名整理者。严格遵守用户 JSON 里的 instructions。'},
            {role: 'user', content: JSON.stringify({task: 'keep-proper-noun-phrases', instructions, candidates: batch.map(c => ({phrase: c.phrase, count: c.count}))})}]})
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
      const body = await response.json();
      const parsed = JSON.parse(body.choices?.[0]?.message?.content || "{}"); return parsed.names || [];
    } catch (error) { lastError = error; if (attempt < 3) await wait(1200 * attempt * attempt); }
  }
  throw lastError;
}
const kept = new Map();   // 小写短语 -> 原文大小写的词序列
const candidateIndex = candidates.map(item => {
  const tokens = item.phrase.split(/\s+/);
  return {tokens, lower: tokens.map(token => token.toLowerCase().replaceAll('’', "'"))};
});
// 只接受"确实出现在某个候选里"的连续子串,避免模型编造
function accept(phrase) {
  const tokens = String(phrase).trim().split(/\s+/);
  if (tokens.length < 2 || tokens.length > 5) return;
  const lower = tokens.map(token => token.toLowerCase().replaceAll('’', "'"));
  for (const candidate of candidateIndex) {
    for (let start = 0; start + lower.length <= candidate.lower.length; start++) {
      if (lower.every((token, offset) => candidate.lower[start + offset] === token)) {
        kept.set(lower.join(' '), candidate.tokens.slice(start, start + lower.length));
        return;
      }
    }
  }
}
let cursor = 0, done = 0;
async function worker() {
  while (cursor < batches.length) {
    const batch = batches[cursor++];
    try {
      for (const row of await callDeepSeek(batch)) accept(row?.phrase);
    } catch (error) { console.log('批失败: ' + error.message); }
    if (++done % 3 === 0 || done === batches.length) console.log('  进度 ' + done + '/' + batches.length + '，已保留 ' + kept.size);
    await wait(80);
  }
}
await Promise.all(Array.from({length: concurrency}, worker));
const names = [...kept.values()].sort((a, b) => b.join(' ').length - a.join(' ').length);
console.log('\n保留多词专名 ' + names.length + ' 个:');
console.log('  ' + names.map(tokens => tokens.join(' ')).slice(0, 120).join(' | '));
if (!APPLY) { console.log('\n（未加 --apply，未写入）'); process.exit(0); }

const payload = JSON.stringify({schema: 1, book: 'the-three-body-problem', model, generatedAt: new Date().toISOString(), names});
const blockId = 'properNamesData';
let next = reader;
if (next.includes('id="' + blockId + '"')) {
  next = next.replace(new RegExp('(<script id="' + blockId + '" type="application/json">)[^]*?(</script>)'), '$1' + payload.replace(/\$/g, '$$$$') + '$2');
} else {
  const anchor = '<script id="wordFamiliesData" type="application/json">';
  if (!next.includes(anchor)) throw new Error('找不到插入锚点');
  next = next.replace(anchor, '<script id="' + blockId + '" type="application/json">' + payload.replace(/\$/g, '$$$$') + '</script>' + anchor);
}
await writeFile(readerFile, next, 'utf8');
const atomicJson = async (file, value) => {
  await mkdir(path.dirname(file), {recursive: true});
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
};
await atomicJson(stateFile, {schema: 1, model, generatedAt: new Date().toISOString(), candidates: candidates.length, names});
await writeFile(reportFile, ['# 多词专名报告', '', `- 模型：${model}`, `- 候选（连续大写序列）：${candidates.length} 个`,
  `- 保留：${names.length} 个`, '', '## 保留清单', '', ...names.map(tokens => '- ' + tokens.join(' ')), '',
  '## 被排除的候选（前 200）', '', ...[...counts.keys()].filter(phrase => !kept.has(phrase)).slice(0, 200).map(phrase => '- ' + phrase)].join('\n') + '\n', 'utf8');
console.log('\n已写入阅读器（properNamesData）与报告 ' + reportFile);
