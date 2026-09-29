// 用多词专名表收尾:属于某个连续专名的词位,按"整个名字"的中文一次定下来,
// 不再把 Ye / Zhetai 拆开当两个词问人。
//   - 落在专名里的词位 → 用该专名的中文(如 Ye Zhetai → 叶哲泰、Ye Family → 叶家)
//   - 单 token 的代号/术语(Blade、Nüwa、Euler…) → 连上下文问一次
//   - 仍然没把握的才留在手工表
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDpapiSecretStore} from './reader-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, '..');
const readerFile = path.join(project, 'outputs', 'three-body-reader.html');
const stateFile = path.join(project, '本地数据', 'contextual-glosses-v1.json');
const manualFile = path.join(project, 'outputs', '人名释义手工表.json');
const reportFile = path.join(project, 'outputs', '专名副名收尾报告.md');
const model = 'deepseek-flash';
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const dryRun = argv.includes('--dry-run');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const reader = await readFile(readerFile, 'utf8');
const embeddedJson = id => JSON.parse((reader.match(new RegExp('<script id="' + id + '" type="application/json">([^]*?)</script>')) || [])[1]);
const chapters = embeddedJson('bookData');
const nameList = (embeddedJson('properNamesData')?.names || []).map(tokens => tokens.map(String));
const gloss = JSON.parse(reader.match(/const contextualGlossData = (\{[\s\S]*?\});/)[1]);
const state = JSON.parse(await readFile(stateFile, 'utf8'));
const entries = state.entries;
const manual = await readFile(manualFile, 'utf8').then(JSON.parse).catch(() => ({}));

const strip = value => String(value).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
const sourceParagraphs = chapterIndex => [...chapters[chapterIndex].content.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map(m => strip(m[1])).filter(text => text.length > 0 && /[A-Za-z]/.test(text));
const wordPattern = /[\p{L}]+(?:['’'-][\p{L}]+)*/gu;
const asciiWords = value => [...String(value).matchAll(/[A-Za-z]+(?:['’\-][A-Za-z]+)*/g)].length;
const nameToken = text => String(text).trim().toLowerCase().replaceAll('’', "'").replace(/'s$/, '');

// 把全书每个词位与专名表对一遍,记下"这个位置属于哪个专名"
const byFirst = new Map();
for (const tokens of nameList) {
  const key = nameToken(tokens[0]);
  if (!byFirst.has(key)) byFirst.set(key, []);
  byFirst.get(key).push(tokens.map(nameToken));
}
const slotName = new Map();       // 词位 id -> 专名(原文写法)
const slotContext = new Map();    // 词位 id -> 所在段落
const slotWord = new Map();
const nameSlots = new Map();      // 专名 -> [词位 id]
for (let chapter = 0; chapter < chapters.length; chapter++) {
  sourceParagraphs(chapter).forEach((text, paragraph) => {
    const items = [];
    let ordinal = 0;
    for (const match of String(text).matchAll(wordPattern)) {
      items.push({word: match[0], ordinal, id: chapter + ':' + paragraph + ':' + ordinal});
      ordinal += Math.max(1, asciiWords(match[0]));
    }
    for (const item of items) { slotContext.set(item.id, text.slice(0, 300)); slotWord.set(item.id, item.word); }
    for (let index = 0; index < items.length; index++) {
      const candidates = byFirst.get(nameToken(items[index].word));
      if (!candidates) continue;
      const hit = candidates.find(tokens => tokens.every((token, offset) => items[index + offset] && nameToken(items[index + offset].word) === token));
      if (!hit) continue;
      const phrase = nameList.find(tokens => tokens.map(nameToken).join('\u001f') === hit.join('\u001f'));
      const display = phrase ? phrase.join(' ') : hit.join(' ');
      for (let offset = 0; offset < hit.length; offset++) {
        const id = items[index + offset].id;
        if (!slotName.has(id)) { slotName.set(id, display); }
        if (!nameSlots.has(display)) nameSlots.set(display, []);
        nameSlots.get(display).push(id);
      }
    }
  });
}
console.log('专名覆盖的词位 = ' + slotName.size + '，涉及专名 ' + nameSlots.size + ' 个');

// 待收尾的词位:手工表里的 + 仍记为留空的,且都还没有释义
const targets = new Map();
const knownNotProper = new Set(state.notProperTokens || []);
for (const id of Object.keys(manual)) if (!Object.hasOwn(entries, id) && !knownNotProper.has(id)) targets.set(id, {id, from: '手工表'});
for (const id of Object.keys(state.unresolvedDetails || {})) if (!Object.hasOwn(entries, id) && !targets.has(id) && !knownNotProper.has(id)) targets.set(id, {id, from: '留空'});
console.log('待收尾 ' + targets.size + ' 处');

// 分成两组:属于专名的 / 独立的单 token
const inName = new Map();     // 专名 -> [词位 id]
const lone = [];
for (const {id} of targets.values()) {
  const name = slotName.get(id);
  if (name) { if (!inName.has(name)) inName.set(name, []); inName.get(name).push(id); }
  else lone.push({id, word: slotWord.get(id) || '', context: slotContext.get(id) || ''});
}
console.log('  落在已知专名里的 ' + [...inName.values()].reduce((sum, list) => sum + list.length, 0) + ' 处（涉及 ' + inName.size + ' 个专名）');
console.log('  独立的单 token ' + lone.length + ' 处: ' + [...new Set(lone.map(item => item.word))].join(', '));
if (dryRun) {
  console.log('\n专名样例: ' + [...inName.keys()].slice(0, 30).join(' | '));
  process.exit(0);
}

const secretStore = createDpapiSecretStore(path.join(project, '本地数据', '.reader-cache', 'reader-secrets.dpapi.json'));
const secret = (await secretStore.load()).deepseek;
if (!secret) throw new Error('未找到已保存的 DeepSeek API Key');
async function ask(instructions, payload) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${secret}`},
        body: JSON.stringify({model, thinking: {type: 'disabled'}, temperature: 0, response_format: {type: 'json_object'}, max_tokens: 2600,
          messages: [{role: 'system', content: '你是中文母语者使用的英语小说专名对照表。严格遵守用户 JSON 里的 instructions。'},
            {role: 'user', content: JSON.stringify({task: 'chinese-for-names', instructions, ...payload})}]})
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
      const body = await response.json();
      return JSON.parse(body.choices?.[0]?.message?.content || '{}');
    } catch (error) { lastError = error; if (attempt < 3) await wait(1200 * attempt * attempt); }
  }
  throw lastError;
}

// 1) 每个专名的中文(整名一个答案,不再逐词问)
const nameChinese = new Map(Object.entries(state.nameChinese || {}));
const nameTodos = [...inName.keys()].filter(name => !nameChinese.has(name));
const nameBatches = [];
for (let index = 0; index < nameTodos.length; index += 30) nameBatches.push(nameTodos.slice(index, index + 30));
for (const batch of nameBatches) {
  const sample = id => String(slotContext.get((inName.get(id) || [])[0]) || '').slice(0, 120);
  try {
    const result = await ask([
      '下面是英文科幻小说《三体》里的专有名词。请给出每个名词通行的中文写法。',
      '人名给中文姓名:Ye Zhetai→叶哲泰、Ye Wenjie→叶文洁、Wang Miao→汪淼、Da Shi→大史、Mike Evans→迈克·伊文斯。',
      '地名机构名给通行译名:Red Coast→红岸、Greater Khingan Mountains→大兴安岭、Ancient Greek→古希腊。',
      '造物与代号按词义:Blade→飞刃、Sophon→智子、Trisolaran Fleet→三体舰队。',
      '短语若只是原文的临时组合(The Compressor 之类)按字面给中文即可。',
      '严格返回 JSON:{"names":[{"phrase":"Ye Zhetai","chinese":"叶哲泰"}]}，每项都要有，不要解释。'
    ].join('\n'), {names: batch.map(id => ({phrase: id, sample: sample(id)}))});
    for (const row of result.names || []) {
      const phrase = String(row?.phrase || '').trim();
      const chinese = String(row?.chinese || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      if (batch.includes(phrase) && chinese) nameChinese.set(phrase, chinese);
    }
  } catch (error) { console.log('专名批失败: ' + error.message); }
  console.log('  专名中文: ' + nameChinese.size + '/' + inName.size);
  await wait(80);
}

// 2) 独立的单 token
const loneBatches = [];
for (let index = 0; index < lone.length; index += 40) loneBatches.push(lone.slice(index, index + 40));
const loneChinese = new Map(Object.entries(state.loneChinese || {}));
const notProper = new Set(state.notProperTokens || []);
for (const batch of loneBatches) {
  try {
    const result = await ask([
      '下面是《三体》英文版里的词及其所在段落。先判断它在这里是不是专名、代号或术语,再给中文。',
      '是专名就给通行中文写法(2~12 字):人名地名机构名给通行译名;科学家名给标准中文名(Nüwa→女娲、Euler→欧拉、Lagrange→拉格朗日)。',
      '不是专名的,请把 proper 设为 false 且 chinese 留空——包括:只是普通词恰好大写(Three、Data)、书目编号或分类号里的字母(PL2947.C59S3613 里的 PL/C/S)、引用里的姓名缩写(Dr. Harry Peter… 里的 G),以及任何不需要释义的普通词。',
      '是专名但依据该段确实没把握的,proper 设 true、chinese 留空。',
      '严格返回 JSON:{"words":[{"id":"13:59:10","proper":true,"chinese":""}]}，每项都要有,不要解释。'
    ].join('\n'), {words: batch.map(item => ({id: item.id, word: item.word, paragraph: String(item.context).slice(0, 200)}))});
    for (const row of result.words || []) {
      const id = String(row?.id || '');
      const chinese = String(row?.chinese || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      if (row?.proper === false) notProper.add(id);
      else if (chinese) loneChinese.set(id, chinese);
    }
  } catch (error) { console.log('单 token 批失败: ' + error.message); }
  console.log('  单 token:已定 ' + loneChinese.size + '，判定非专名 ' + notProper.size + ' / 共 ' + lone.length);
  await wait(80);
}

// 3) 汇总
const produced = new Map();
for (const [name, ids] of inName) {
  const chinese = nameChinese.get(name);
  if (!chinese) continue;
  for (const id of ids) if (!Object.hasOwn(entries, id) && !produced.has(id)) produced.set(id, chinese);
}
for (const [id, chinese] of loneChinese) if (!Object.hasOwn(entries, id) && !produced.has(id)) produced.set(id, chinese);
console.log('\n可定下来 ' + produced.size + ' 处；仍留人工 ' + (targets.size - produced.size) + ' 处');
console.log('样例:');
for (const [id, value] of [...produced.entries()].slice(0, 20)) console.log('  ' + id.padEnd(10) + String(slotWord.get(id) || '').padEnd(12) + (slotName.get(id) ? '（' + slotName.get(id) + '）' : '') + ' → ' + value);
if (!APPLY) { console.log('\n（未加 --apply，未写入）'); process.exit(0); }

const merged = {...entries};
for (const [id, value] of produced) merged[id] = value;
const nextManual = {};
for (const [id, row] of Object.entries(manual)) if (!merged[id] && !notProper.has(id)) nextManual[id] = row;
const nextUnresolved = {};
for (const [id, row] of Object.entries(state.unresolvedDetails || {})) if (!merged[id]) nextUnresolved[id] = row;
const nextState = {...state, entries: merged, unresolvedDetails: nextUnresolved,
  nameChinese: Object.fromEntries(nameChinese), loneChinese: Object.fromEntries(loneChinese), notProperTokens: [...notProper], notProper: notProper.size};
const atomicJson = async (file, value) => {
  await mkdir(path.dirname(file), {recursive: true});
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
};
await atomicJson(stateFile, nextState);
await atomicJson(manualFile, nextManual);
const payload = JSON.stringify({version: 2, indexVersion: 2, entries: merged}).replace(/</g, '\\u003c');
const placeholder = /const contextualGlossData = .*?;/;
if (!placeholder.test(reader)) throw new Error('阅读器中没有找到句中义数据占位符');
await writeFile(readerFile, reader.replace(placeholder, `const contextualGlossData = ${payload};`), 'utf8');
await writeFile(reportFile, ['# 专名副名收尾报告', '', `- 专名中文：${nameChinese.size} 个`, `- 单 token 定下：${loneChinese.size} 处`,
  `- 本次写入释义：${produced.size} 处`, `- 仍需人工：${Object.keys(nextManual).length} 处`, '',
  '## 专名 → 中文', '', ...[...nameChinese.entries()].map(([name, chinese]) => '- ' + name + ' → ' + chinese), '',
  '## 单 token → 中文', '', ...[...loneChinese.entries()].map(([id, chinese]) => '- `' + id + '` ' + (slotWord.get(id) || '') + ' → ' + chinese), '',
  '## 仍需人工', '', ...Object.entries(nextManual).map(([id, row]) => '- `' + id + '` ' + row.word + ' — ' + String(row.context || '').slice(0, 80))].join('\n') + '\n', 'utf8');
console.log('\n已写入:释义 ' + Object.keys(entries).length + ' → ' + Object.keys(merged).length + '；手工表剩 ' + Object.keys(nextManual).length + ' 处');
console.log('报告: ' + reportFile);
