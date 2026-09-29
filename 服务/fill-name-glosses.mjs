// 补齐专有名词的句中释义(人名、地名、机构名、造词,以及拼音形式的中文名)。
// 两类目标:
//   A 历史上被判定"留空"的位置(提示词曾要求专名留空,模型执行得不一致);
//   B 从未被选过的专名:句中大写、不在功能词表、词典里没有实词义(如 ye / mozi / wenjie / trisolaran / sophon / v-suit)。
// 每个目标由模型三选一:给出中文 / 判定不是专名(忽略)/ 是专名但没把握(记入手工表)。
// 手工表 outputs/人名释义手工表.json,填好 gloss 后再跑一次合入,不会重复询问。
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDpapiSecretStore} from './reader-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, '..');
const readerFile = path.join(project, 'outputs', 'three-body-reader.html');
const stateFile = path.join(project, '本地数据', 'contextual-glosses-v1.json');
const manualFile = path.join(project, 'outputs', '人名释义手工表.json');
const reportFile = path.join(project, 'outputs', '人名释义补齐报告.md');
const logFile = path.join(project, '本地数据', 'contextual-glosses-names.log');
const model = 'deepseek-flash';
const concurrency = 6;
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const dryRun = argv.includes('--dry-run');
const onlyArg = argv.find(item => item.startsWith('--only='));
const only = onlyArg ? new RegExp(onlyArg.slice('--only='.length)) : null;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const reader = await readFile(readerFile, 'utf8');
const embeddedJson = id => JSON.parse((reader.match(new RegExp('<script id="' + id + '" type="application/json">([^]*?)</script>')) || [])[1]);
const chapters = embeddedJson('bookData');
const dictionary = embeddedJson('dictionaryData');
const gloss = JSON.parse(reader.match(/const contextualGlossData = (\{[\s\S]*?\});/)[1]);
const state = JSON.parse(await readFile(stateFile, 'utf8'));
const entries = state.entries;
const blanked = state.unresolvedDetails || {};

const strip = value => String(value).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
const sourceParagraphs = chapterIndex => [...chapters[chapterIndex].content.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map(m => strip(m[1])).filter(text => text.length > 0 && /[A-Za-z]/.test(text));
const wordPattern = /[\p{L}]+(?:['’'-][\p{L}]+)*/gu;
const asciiWords = value => [...String(value).matchAll(/[A-Za-z]+(?:['’\-][A-Za-z]+)*/g)].length;

// 从未被选过的专名:句中大写(不是句子开头的大写) + 不在功能词表 + 词典里没有实词义
const functionWords = new Set(`a an the this that these those i me my mine myself you your yours yourself he him his himself she her hers herself it its itself we us our ours ourselves they them their theirs themselves who whom whose which what where when why how and or but nor so yet for of in on at by from to with without into onto over under about after before during through between among against around within as if than then while because although though since unless until whether not no yes be am is are was were been being have has had having do does did doing can could may might must shall will would need dare used there here out up down off away back again also even just only very more most less least much many few all both each every either neither another other some any one two first second third own same such`.split(/\s+/));
const isContraction = word => /^[a-z]+(?:n't|'s|'d|'ll|'re|'ve|'m)$/i.test(String(word).replaceAll('’', "'"));
const contentPos = /^(?:n|v|vi|vt|a|adj|ad|adv|s)\./i;
const hasContentSense = word => String(dictionary.entries[word]?.translation || '').split(/\r?\n|\\n/).some(line => contentPos.test(line.trim()));
const sentenceBoundary = /[.!?;:"“”‘’—–(\[]/;
const midSentenceCapital = (text, index) => {
  let at = index - 1;
  while (at >= 0 && /\s/.test(text[at])) at--;
  return at >= 0 && !sentenceBoundary.test(text[at]);
};
function buildUntargetedCandidates() {
  const stats = new Map();
  for (let chapter = 0; chapter < chapters.length; chapter++) {
    sourceParagraphs(chapter).forEach((text, paragraph) => {
      let ordinal = 0;
      for (const match of String(text).matchAll(wordPattern)) {
        const id = chapter + ':' + paragraph + ':' + ordinal;
        ordinal += Math.max(1, asciiWords(match[0]));
        const key = match[0].toLowerCase().replaceAll('’', "'");
        if (!stats.has(key)) stats.set(key, {word: match[0], slots: [], midCap: 0});
        const entry = stats.get(key);
        entry.slots.push({id, chapter, paragraph, text});
        if (/^[A-Z]/.test(match[0]) && midSentenceCapital(text, match.index)) entry.midCap++;
      }
    });
  }
  const out = [];
  for (const [key, info] of stats) {
    if (!info.midCap) continue;
    if (functionWords.has(key) || isContraction(key)) continue;
    if (hasContentSense(key)) continue;
    const glossed = info.slots.filter(slot => Object.hasOwn(entries, slot.id)).length;
    if (glossed / info.slots.length > 0.5) continue;
    out.push({key, word: info.word, slots: info.slots});
  }
  return out;
}

const manual = await readFile(manualFile, 'utf8').then(JSON.parse).catch(() => ({}));
const manualFilled = new Map(Object.entries(manual).filter(([, row]) => String(row?.gloss || '').trim()).map(([id, row]) => [id, String(row.gloss).trim()]));

// 目标 A:历史上留空的位置
const pending = new Map();
for (const [id, row] of Object.entries(blanked)) {
  if (Object.hasOwn(entries, id) || manualFilled.has(id)) continue;
  if (manual[id] && !manualFilled.has(id)) continue;
  const [chapter, paragraph] = id.split(':').map(Number);
  if (!Number.isInteger(chapter) || !Number.isInteger(paragraph)) continue;
  pending.set(id, {id, word: row.word, chapter, paragraph, text: row.text || '', source: '留空'});
}
const blankCount = pending.size;
// 目标 B:从未被选过的专名
let candidateCount = 0;
for (const candidate of buildUntargetedCandidates()) {
  for (const slot of candidate.slots) {
    if (Object.hasOwn(entries, slot.id) || manualFilled.has(slot.id)) continue;
    if (manual[slot.id] && !manualFilled.has(slot.id)) continue;
    if (pending.has(slot.id)) continue;
    pending.set(slot.id, {...slot, word: candidate.word, source: '新专名'});
    candidateCount++;
  }
}
const targets = [...pending.values()].filter(item => !only || only.test(String(item.word)));
for (const item of targets) if (!item.text) item.text = (sourceParagraphs(item.chapter)[item.paragraph] || '');

const byParagraph = new Map();
for (const item of targets) {
  const key = item.chapter + ':' + item.paragraph;
  if (!byParagraph.has(key)) byParagraph.set(key, {chapter: item.chapter, paragraph: item.paragraph, targets: []});
  byParagraph.get(key).targets.push({id: item.id, word: item.word});
}
const groups = [...byParagraph.values()].map(group => {
  const paragraphs = sourceParagraphs(group.chapter);
  return {...group, text: paragraphs[group.paragraph] || '', before: paragraphs[group.paragraph - 1] || '', after: paragraphs[group.paragraph + 1] || ''};
});
const batches = [];
let current = [], targetCount = 0, characters = 0;
for (const group of groups) {
  const cost = group.text.length + Math.min(group.before.length, 650) + Math.min(group.after.length, 650);
  if (current.length && (targetCount + group.targets.length > 86 || characters + cost > 10500)) { batches.push(current); current = []; targetCount = 0; characters = 0; }
  current.push(group); targetCount += group.targets.length; characters += cost;
}
if (current.length) batches.push(current);
const distinct = new Map();
for (const item of targets) distinct.set(item.word, (distinct.get(item.word) || 0) + 1);
console.log('目标 ' + targets.length + ' 处（历史留空 ' + Math.min(blankCount, targets.length) + ' + 新专名 ' + candidateCount + '），涉及 ' + distinct.size + ' 个词，分 ' + batches.length + ' 批。');
console.log('手工表已填 ' + manualFilled.size + ' 处。出现最多: ' + [...distinct.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([w, n]) => w + '(' + n + ')').join(', '));
if (dryRun) { console.log('\n前 1 批: ' + JSON.stringify(batches[0]?.[0])); process.exit(0); }
if (!targets.length) { console.log('没有需要处理的目标。'); process.exit(0); }

const makePayload = batch => ({
  task: 'contextual-glosses-proper-nouns',
  instructions: [
    '判断 targets 里每个词在它所在段落中是不是专有名词，并给出该处的中文写法，通常 2 到 12 个汉字。',
    '西文人名、地名、机构名给通行中文译名：Newton→牛顿、Copernicus→哥白尼、Von→冯、Neumann→诺伊曼、ETO→地球三体组织。',
    '以拼音形式出现的中国人名、地名要还原成汉字：Mozi→墨子、Wang→汪、Shen→申、Shi→史、Ye→叶、Wenjie→文洁、Zhetai→哲泰、Da→大。',
    '同一个拼写在不同段落可能指不同的人：Ye 在前文多指叶哲泰、后文多指叶文洁，必须依据 targetParagraph 判断，不要照搬别处。',
    '造词与代号按词义给出中文：trisolaran→三体人、trisolaris→三体世界、sophon→智子、v-suit→V 装具、Red Coast→红岸。',
    '若这个词只是普通词恰好大写(数词、代词、感叹词、单字母、罗马数字、普通缩写)，请在 proper 填 false、gloss 留空——不要给它释义。',
    '若是专名但依据 targetParagraph 没有把握，请把 uncertain 设为 true、gloss 留空，并可在 guess 里写一个猜测。不要为了凑答案硬猜。',
    '判断依据只有 targetParagraph、before、after，不要引用你记忆里的其他章节。只判断 targets 里的词，不要输出别的词。',
    '返回严格 JSON：{"entries":[{"id":"chapter:paragraph:index","proper":true,"gloss":"","guess":"","uncertain":false}]}，每个 target 恰好一条。'
  ].join('\n'),
  samples: batch.map(group => ({id: group.chapter + ':' + group.paragraph, targetParagraph: group.text, before: group.before.slice(-650), after: group.after.slice(0, 650), targets: group.targets.map(t => ({id: t.id, word: t.word}))}))
});
const secretStore = createDpapiSecretStore(path.join(project, '本地数据', '.reader-cache', 'reader-secrets.dpapi.json'));
const secret = (await secretStore.load()).deepseek;
if (!secret) throw new Error('未找到已保存的 DeepSeek API Key');

async function callDeepSeek(payload) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${secret}`},
        body: JSON.stringify({model, thinking: {type: 'disabled'}, temperature: 0, response_format: {type: 'json_object'}, max_tokens: 2400,
          messages: [{role: 'system', content: '你是中文母语者使用的英语小说专名对照表。严格遵守用户 JSON 中的 instructions。'}, {role: 'user', content: JSON.stringify(payload)}]})
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const body = await response.json();
      return {parsed: JSON.parse(body.choices?.[0]?.message?.content || ''), usage: body.usage || {}};
    } catch (error) { lastError = error; if (attempt < 3) await wait(1000 * attempt * attempt); }
  }
  throw lastError;
}

const produced = new Map(), uncertainRows = [], notProper = [];
const usage = {requests: 0, promptTokens: 0, completionTokens: 0};
let cursor = 0, done = 0;
async function worker() {
  while (cursor < batches.length) {
    const batch = batches[cursor++];
    const allowed = new Map();
    for (const group of batch) for (const target of group.targets) allowed.set(target.id, {word: target.word, text: group.text});
    try {
      const {parsed, usage: used} = await callDeepSeek(makePayload(batch));
      usage.requests++; usage.promptTokens += Number(used.prompt_tokens) || 0; usage.completionTokens += Number(used.completion_tokens) || 0;
      const seen = new Set();
      for (const row of (Array.isArray(parsed?.entries) ? parsed.entries : [])) {
        const id = String(row?.id || '');
        if (!allowed.has(id) || seen.has(id)) continue;
        seen.add(id);
        const info = allowed.get(id);
        const value = String(row?.gloss || '').trim().replace(/\s+/g, ' ').slice(0, 40);
        const guess = String(row?.guess || '').trim().replace(/\s+/g, ' ').slice(0, 40);
        if (row?.proper === false) notProper.push({id, word: info.word});
        else if (value && row?.uncertain !== true) produced.set(id, value);
        else uncertainRows.push({id, word: info.word, guess: guess || value, context: info.text.slice(0, 300), gloss: ''});
      }
      for (const [id, info] of allowed) if (!seen.has(id)) uncertainRows.push({id, word: info.word, guess: '', context: info.text.slice(0, 300), gloss: ''});
    } catch (error) {
      for (const [id, info] of allowed) uncertainRows.push({id, word: info.word, guess: '', context: info.text.slice(0, 300), gloss: ''});
      console.log('批失败: ' + error.message);
    }
    if (++done % 10 === 0 || done === batches.length) console.log('  进度 ' + done + '/' + batches.length + '，已确定 ' + produced.size + ' 处');
    await wait(60);
  }
}
await Promise.all(Array.from({length: concurrency}, worker));
console.log('\n模型确定 ' + produced.size + ' 处；判定不是专名 ' + notProper.length + ' 处；需人工 ' + uncertainRows.length + ' 处。');
console.log('用量: 请求 ' + usage.requests + '，prompt ' + usage.promptTokens + '，completion ' + usage.completionTokens + ' tokens');
console.log('\n确定的样例:');
for (const [id, value] of [...produced.entries()].slice(0, 25)) console.log('  ' + id.padEnd(11) + String(pending.get(id)?.word || '').padEnd(14) + ' → ' + value);
console.log('判定不是专名的样例: ' + notProper.slice(0, 25).map(item => item.word).join(', '));
console.log('需人工的样例:');
for (const row of uncertainRows.slice(0, 15)) console.log('  ' + row.id.padEnd(11) + row.word + (row.guess ? '（猜测: ' + row.guess + '）' : '（无猜测）'));
if (!APPLY) { console.log('\n（未加 --apply，未写入）'); process.exit(0); }

const merged = {...entries};
let fromManual = 0;
for (const [id, value] of produced) merged[id] = value;
for (const [id, value] of manualFilled) { merged[id] = value; fromManual++; }
const recorded = new Set([...notProper.map(item => item.id), ...uncertainRows.map(row => row.id)]);
const nextUnresolved = {};
for (const [id, row] of Object.entries(blanked)) if (!merged[id] && !recorded.has(id)) nextUnresolved[id] = row;
const nextManual = {};
for (const [id, row] of Object.entries(manual)) {
  if (merged[id]) continue;
  if (Number.isFinite(Number(id.split(':')[0]))) nextManual[id] = {...row, gloss: String(row.gloss || '').trim()};
}
for (const row of uncertainRows) if (!nextManual[row.id]) nextManual[row.id] = row;
const nextState = {...state, entries: merged, unresolvedDetails: nextUnresolved,
  usage: {requests: (state.usage?.requests || 0) + usage.requests, promptTokens: (state.usage?.promptTokens || 0) + usage.promptTokens, completionTokens: (state.usage?.completionTokens || 0) + usage.completionTokens, costYuan: state.usage?.costYuan},
  nameGlossFill: {at: new Date().toISOString(), model, fromModel: produced.size, fromManual, notProper: notProper.length, pendingManual: Object.keys(nextManual).length, requests: usage.requests}};
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
const report = ['# 专名句中释义补齐报告', '', `- 模型：${model}`,
  `- 本次由模型确定：${produced.size} 处；由手工表合入：${fromManual} 处`,
  `- 模型判定"不是专名、无需释义"：${notProper.length} 处`,
  `- 仍需人工处理：${Object.keys(nextManual).length} 处（见 outputs/人名释义手工表.json）`,
  `- 释义总数：${Object.keys(entries).length} → ${Object.keys(merged).length}`, '', '## 模型确定的部分', ''];
for (const [id, value] of [...produced.entries()].slice(0, 150)) report.push(`- \`${id}\` ${pending.get(id)?.word || ''} → ${value}`);
report.push('', '## 判定为普通词、不释义的', '', notProper.slice(0, 150).map(item => item.word).join(', '), '', '## 仍需人工处理', '');
for (const [id, row] of Object.entries(nextManual).slice(0, 300)) report.push(`- \`${id}\` **${row.word}**${row.guess ? '（猜测: ' + row.guess + '）' : ''} — ${String(row.context || '').slice(0, 90)}…`);
await writeFile(reportFile, report.join('\n') + '\n', 'utf8');
await writeFile(logFile, `${new Date().toISOString()} 专名补漏:确定 ${produced.size},非专名 ${notProper.length},待人工 ${Object.keys(nextManual).length},请求 ${usage.requests}\n`, {encoding: 'utf8', flag: 'a'});
console.log('\n已写入:释义 ' + Object.keys(entries).length + ' → ' + Object.keys(merged).length);
console.log('手工表: ' + manualFile + '（待处理 ' + Object.keys(nextManual).length + ' 处）');
console.log('报告: ' + reportFile);
