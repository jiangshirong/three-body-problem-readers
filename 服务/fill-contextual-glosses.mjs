// 补齐句中释义的漏判词:原生成脚本的 lexical() 只认 ECDICT 的实词词性前缀,
// 导致 "pl." 标注的复数名词(如 candelabra)和"本词条目是功能词、词根才是实词"的屈折形式
// (如 provided←provide)从未被选为释义目标。本脚本只补这些漏判词位,不动已有释义,
// 也不重问当时被判定为专名而故意留空的部分。
import {createHash} from 'node:crypto';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDpapiSecretStore} from './reader-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, '..');
const readerFile = path.join(project, 'outputs', 'three-body-reader.html');
const stateFile = path.join(project, '本地数据', 'contextual-glosses-v1.json');
const logFile = path.join(project, '本地数据', 'contextual-glosses-fill.log');
const model = 'deepseek-flash';
const concurrency = 6;
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const dryRun = argv.includes('--dry-run');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const reader = await readFile(readerFile, 'utf8');
const embeddedJson = id => JSON.parse((reader.match(new RegExp('<script id="' + id + '" type="application/json">([^]*?)</script>')) || [])[1]);
const chapters = embeddedJson('bookData');
const dictionary = embeddedJson('dictionaryData');
const state = JSON.parse(await readFile(stateFile, 'utf8'));
const entries = state.entries;
const alreadyBlank = new Set([...Object.keys(state.unresolvedDetails || {}), ...Object.keys(state.excludedTokenFragments || {})]);

const strip = value => String(value).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
const wordPattern = /[\p{L}]+(?:['’'-][\p{L}]+)*/gu;
const words = value => {
  let ordinal = 0;
  return [...String(value).matchAll(wordPattern)].map(match => {
    const item = {word: match[0], offset: match.index, ordinal};
    ordinal += Math.max(1, [...match[0].matchAll(/[A-Za-z]+(?:['’\-][A-Za-z]+)*/g)].length);
    return item;
  });
};
const sourceParagraphs = chapterIndex => [...chapters[chapterIndex].content.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map(m => strip(m[1])).filter(text => text.length > 0 && /[A-Za-z]/.test(text));

const contentPos = /^(?:n|v|vi|vt|a|adj|ad|adv|s)\./i;
const anyPos = /^(?:n|v|vi|vt|a|adj|ad|adv|s|aux|pron|prep|conj|det|art|abbr|num|int|interj|phr|sym|pref|suff)\./i;
// ECDICT 用 pl./pp./vbl. 等标注复数与分词,这些条目本身是实词
const inflectionPos = /^(?:pl|pp|p\.p|p\.pr|past|pple|ing|vbl)\./i;
const splitSenses = translation => String(translation || '').split(/\r?\n|\\n/);
const hasContentSense = translation => splitSenses(translation).some(line => contentPos.test(line.trim()));
const isContraction = word => /^[a-z]+(?:n't|'s|'d|'ll|'re|'ve|'m)$/i.test(String(word).replaceAll('’', "'"));
const isUrlToken = (text, index) => [...String(text).matchAll(/(?:https?:\/\/|www\.)[^\s]+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?/giu)].some(m => index >= m.index && index < m.index + m[0].length);
const functionWords = new Set(`a an the this that these those i me my mine myself you your yours yourself he him his himself she her hers herself it its itself we us our ours ourselves they them their theirs themselves who whom whose which what where when why how and or but nor so yet for of in on at by from to with without into onto over under about after before during through between among against around within as if than then while because although though since unless until whether not no yes be am is are was were been being have has had having do does did doing can could may might must shall should will would need dare used there here out up down off away back again also even just only very more most less least much many few all both each every either neither another other some any one two first second third own same such`.split(/\s+/));
const lemmaOf = normalized => dictionary.entries[normalized]?.exchange?.match(/(?:^|\/)0:([^/]+)/)?.[1];
function lexical(word) {
  const normalized = word.toLowerCase().replaceAll('’', "'");
  const entry = dictionary.entries[normalized];
  if (!entry || isContraction(word) || (/^[a-z]$/i.test(word) && !['a', 'i'].includes(normalized))) return false;
  if (normalized === 'ought') return true;
  if (functionWords.has(normalized)) return false;
  const translation = entry.translation || '';
  if (hasContentSense(translation)) return true;
  if (inflectionPos.test(translation.trim())) return true;
  const lemma = lemmaOf(normalized);
  if (lemma && lemma.toLowerCase() !== normalized && hasContentSense(dictionary.entries[lemma.toLowerCase()]?.translation)) return true;
  if (splitSenses(translation).some(line => anyPos.test(line.trim()))) return false;
  // 词典里有中文释义就够了。ECDICT 对不少合成词只给裸中文(如 three-bladed 的「三叶的」),
  // 原先要求必须带词性前缀或 [医] 这类方括号标注,把这一整类词漏掉了。
  return /[\u3400-\u9fff]/.test(translation);
}

// 版权页等含网址的段落不释义:标签被剥离后网址会碎成 www/com/net 之类的碎片。
const looksLikeUrlParagraph = text => /(?:https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|org|net|edu|gov|cn)\b)/i.test(text);

// 只取"该释义但从未有过条目、且不曾被判定为专名"的词位
const pending = [];
for (let chapter = 0; chapter < chapters.length; chapter++) {
  const paragraphs = sourceParagraphs(chapter);
  paragraphs.forEach((text, paragraph) => {
    if (looksLikeUrlParagraph(text)) return;
    const targets = words(text)
      .filter(match => lexical(match.word) && !isUrlToken(text, match.index))
      .map(match => ({id: `${chapter}:${paragraph}:${match.ordinal}`, word: match.word}))
      .filter(target => !Object.hasOwn(entries, target.id) && !alreadyBlank.has(target.id));
    if (targets.length) pending.push({chapter, paragraph, text, before: paragraphs[paragraph - 1] || '', after: paragraphs[paragraph + 1] || '', targets});
  });
}
const batches = [];
let current = [], targetCount = 0, characters = 0;
for (const paragraph of pending) {
  const cost = paragraph.text.length + Math.min(paragraph.before.length, 650) + Math.min(paragraph.after.length, 650);
  if (current.length && (targetCount + paragraph.targets.length > 86 || characters + cost > 10500)) { batches.push(current); current = []; targetCount = 0; characters = 0; }
  current.push(paragraph); targetCount += paragraph.targets.length; characters += cost;
}
if (current.length) batches.push(current);
const totalTargets = pending.reduce((sum, item) => sum + item.targets.length, 0);
const distinct = new Map();
for (const item of pending) for (const target of item.targets) distinct.set(target.word.toLowerCase(), (distinct.get(target.word.toLowerCase()) || 0) + 1);
console.log(`待补释义:${totalTargets} 个词位,${distinct.size} 个不同的词,分布在 ${pending.length} 个段落,分 ${batches.length} 批。`);
console.log('涉及词:' + [...distinct.entries()].sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w}(${n})`).join(', '));
if (dryRun) { console.log('前 1 批目标:' + JSON.stringify(batches[0]?.map(item => item.targets.map(t => t.id + ' ' + t.word)))); process.exit(0); }

const makePayload = batch => ({
  task: 'contextual-glosses-v1',
  instructions: '只解释 targets 中列出的实词。每条 gloss 必须是该词在 targetParagraph 中的极短中文句中义，通常 2 到 10 个汉字。不得翻译整句，不得解释语法，不得输出 targets 以外的词，不得复述 before 或 after。返回严格 JSON：{"entries":[{"id":"chapter:paragraph:index","gloss":""}]}。每个 target 必须恰好一条；遇到专名或无法判断也填""。',
  samples: batch.map(item => ({id: `${item.chapter}:${item.paragraph}`, targetParagraph: item.text, before: item.before.slice(-650), after: item.after.slice(0, 650), targets: item.targets.map(t => ({id: t.id, word: t.word}))}))
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
          messages: [{role: 'system', content: '你是中文母语者使用的英语小说句中义词典。严格遵守用户 JSON 中的 instructions。'}, {role: 'user', content: JSON.stringify(payload)}]})
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const body = await response.json();
      return {parsed: JSON.parse(body.choices?.[0]?.message?.content || ''), usage: body.usage || {}};
    } catch (error) { lastError = error; if (attempt < 3) await wait(1000 * attempt * attempt); }
  }
  throw lastError;
}

const produced = new Map(), stillBlank = new Map(), usage = {requests: 0, promptTokens: 0, completionTokens: 0};
let cursor = 0, done = 0;
async function worker() {
  while (cursor < batches.length) {
    const batch = batches[cursor++];
    const allowed = new Map();
    for (const item of batch) for (const target of item.targets) allowed.set(target.id, target.word);
    try {
      const {parsed, usage: used} = await callDeepSeek(makePayload(batch));
      usage.requests++; usage.promptTokens += Number(used.prompt_tokens) || 0; usage.completionTokens += Number(used.completion_tokens) || 0;
      const rows = Array.isArray(parsed?.entries) ? parsed.entries : [];
      const seen = new Set();
      for (const row of rows) {
        const id = String(row?.id || '');
        if (!allowed.has(id) || seen.has(id)) continue;
        seen.add(id);
        const gloss = String(row?.gloss || '').trim().replace(/\s+/g, ' ').slice(0, 40);
        if (gloss) produced.set(id, gloss); else stillBlank.set(id, {word: allowed.get(id), reason: 'empty-or-missing'});
      }
      for (const [id, word] of allowed) if (!seen.has(id)) stillBlank.set(id, {word, reason: 'empty-or-missing'});
    } catch (error) {
      for (const [id, word] of allowed) stillBlank.set(id, {word, reason: `request-failed: ${error.message}`.slice(0, 160)});
      console.log(`批失败: ${error.message}`);
    }
    if (++done % 5 === 0 || done === batches.length) console.log(`  进度 ${done}/${batches.length},已产出 ${produced.size}`);
    await wait(80);
  }
}
await Promise.all(Array.from({length: concurrency}, worker));
console.log(`产出 ${produced.size} 条释义,仍留空 ${stillBlank.size} 条。`);
console.log(`用量: 请求 ${usage.requests},prompt ${usage.promptTokens},completion ${usage.completionTokens} tokens`);
if (!APPLY) { console.log('（未加 --apply,未写入）'); process.exit(0); }

// 合并并回写:保留全部已有释义
const merged = {...entries};
for (const [id, gloss] of produced) merged[id] = gloss;
const nextState = {...state, entries: merged, unresolvedDetails: {...state.unresolvedDetails, ...Object.fromEntries(stillBlank)},
  usage: {requests: (state.usage?.requests || 0) + usage.requests, promptTokens: (state.usage?.promptTokens || 0) + usage.promptTokens, completionTokens: (state.usage?.completionTokens || 0) + usage.completionTokens, costYuan: state.usage?.costYuan},
  glossFill: {at: new Date().toISOString(), model, produced: produced.size, stillBlank: stillBlank.size, requests: usage.requests}};
const atomicJson = async (file, value) => {
  await mkdir(path.dirname(file), {recursive: true});
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
};
await atomicJson(stateFile, nextState);
const payload = JSON.stringify({version: 2, indexVersion: 2, entries: merged}).replace(/</g, '\\u003c');
const placeholder = /const contextualGlossData = .*?;/;
if (!placeholder.test(reader)) throw new Error('阅读器中没有找到句中义数据占位符');
await writeFile(readerFile, reader.replace(placeholder, `const contextualGlossData = ${payload};`), 'utf8');
await writeFile(logFile, `${new Date().toISOString()} 补漏:产出 ${produced.size},留空 ${stillBlank.size},请求 ${usage.requests}\n`, {encoding: 'utf8', flag: 'a'});
console.log(`已写入:释义总数 ${Object.keys(entries).length} → ${Object.keys(merged).length}`);
const check = ['21:6:58', '21:6:66'];
for (const id of check) console.log(`  ${id} → ${JSON.stringify(merged[id] || '(仍无)')}`);
