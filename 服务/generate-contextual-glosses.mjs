import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDpapiSecretStore} from './reader-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, '..');
const readerFile = path.join(project, 'outputs', 'three-body-reader.html');
const stateFile = path.join(project, '本地数据', 'contextual-glosses-v1.json');
const logFile = path.join(project, '本地数据', 'contextual-glosses-v1.log');
const model = 'deepseek-flash';
const concurrency = 10;
const wordPattern = /[\p{L}]+(?:['’'-][\p{L}]+)*/gu;

const reader = await readFile(readerFile, 'utf8');
const embeddedJson = id => JSON.parse(reader.match(new RegExp(`<script id="${id}" type="application/json">([\\s\\S]*?)<\\/script>`))?.[1] || 'null');
const chapters = embeddedJson('bookData');
const dictionary = embeddedJson('dictionaryData');
const strip = value => String(value).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
// The reader's existing occurrence IDs count ASCII chunks inside accented
// words (so naïve contributes "na" + "ve"). Keep that stable ID scheme while
// treating each Unicode spelling as one target token for dictionary lookup.
const words = value => {
  let ordinal = 0;
  return [...String(value).matchAll(wordPattern)].map(match => {
    const item = {word:match[0], offset:match.index, ordinal};
    ordinal += Math.max(1, [...match[0].matchAll(/[A-Za-z]+(?:['’\-][A-Za-z]+)*/g)].length);
    return item;
  });
};
const contentPos = /^(?:n|v|vi|vt|a|adj|ad|adv|s)\./i;
const anyPos = /^(?:n|v|vi|vt|a|adj|ad|adv|s|aux|pron|prep|conj|det|art|abbr|num|int|interj|phr|sym|pref|suff)\./i;
// ECDICT marks plurals and participles with pl./pp./vbl. rather than a noun or verb tag.
const inflectionPos = /^(?:pl|pp|p\.p|p\.pr|past|pple|ing|vbl)\./i;
const splitDictionarySenses = translation => String(translation || '').split(/\r?\n|\\n/);
const hasContentSense = translation => splitDictionarySenses(translation).some(line => contentPos.test(line.trim()));
const isContraction = word => /^[a-z]+(?:n't|'s|'d|'ll|'re|'ve|'m)$/i.test(String(word).replaceAll('’', "'"));
const isUrlToken = (text, index) => [...String(text).matchAll(/(?:https?:\/\/|www\.)[^\s]+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?/giu)]
  .some(match => index >= match.index && index < match.index + match[0].length);
const functionWords = new Set(`a an the this that these those i me my mine myself you your yours yourself he him his himself she her hers herself it its itself we us our ours ourselves they them their theirs themselves who whom whose which what where when why how and or but nor so yet for of in on at by from to with without into onto over under about after before during through between among against around within as if than then while because although though since unless until whether not no yes be am is are was were been being have has had having do does did doing can could may might must shall should will would need dare used there here out up down off away back again also even just only very more most less least much many few all both each every either neither another other some any one two first second third own same such`.split(/\s+/));
const lexical = word => {
  const normalized = word.toLowerCase().replaceAll('’', "'");
  const entry = dictionary.entries[normalized];
  if (!entry || isContraction(word) || (/^[a-z]$/i.test(word) && !['a','i'].includes(normalized))) return false;
  // Ought is a modal, but the user explicitly wants its sentence meaning.
  if (normalized === 'ought') return true;
  if (functionWords.has(normalized)) return false;
  const translation = entry.translation || '';
  // Inspect all dictionary senses. Some entries begin with a function-word
  // sense but also have noun/adverb senses (e.g. "beyond").
  if (hasContentSense(translation)) return true;
  // A plural or participle tag is a content word, not a function word
  // (candelabra: "pl. 枝状大烛台").
  if (inflectionPos.test(translation.trim())) return true;
  // An inflected form can carry a function-word sense of its own while its lemma is a
  // content word, and the text uses the content sense
  // (provided → provide: "provided a drowsy light").
  const lemma = entry.exchange?.match(/(?:^|\/)0:([^/]+)/)?.[1];
  if (lemma && lemma.toLowerCase() !== normalized && hasContentSense(dictionary.entries[lemma.toLowerCase()]?.translation)) return true;
  // POS-tagged entries containing only function/utility senses stay excluded.
  if (splitDictionarySenses(translation).some(line => anyPos.test(line.trim()))) return false;
  // ECDICT occasionally supplies a domain-tagged Chinese gloss without POS or
  // lemma metadata (e.g. rehydration: "[医] 再水化"). Include it for review;
  // the prompt still tells the model to leave proper names/uncertain items blank.
  // 词典里有中文释义就够了(ECDICT 对不少合成词只给裸中文,如 three-bladed 的「三叶的」)。
  return /[\u3400-\u9fff]/.test(translation);
};
const keyOf = (chapter, paragraph, word) => `${chapter}:${paragraph}:${word}`;
const short = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 24);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const priceAt = date => {
  const day = date.getDay(), hour = date.getHours() + date.getMinutes() / 60;
  return day >= 1 && day <= 5 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)) ? {input:2, output:8, label:'高峰'} : {input:1, output:4, label:'优惠'};
};

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), {recursive:true});
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}
async function note(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  await writeFile(logFile, line, {encoding:'utf8', flag:'a'});
  process.stdout.write(line);
}
async function embedInReader(entries) {
  const payload = JSON.stringify({version:2, indexVersion:2, entries}).replace(/</g, '\\u003c');
  const source = await readFile(readerFile, 'utf8');
  const placeholder = /const contextualGlossData = .*?;/;
  if (!placeholder.test(source)) throw new Error('阅读器中没有找到句中义数据占位符，未写入阅读器。');
  const next = source.replace(placeholder, `const contextualGlossData = ${payload};`);
  if (next === source) return;
  await writeFile(readerFile, next, 'utf8');
}
function sourceParagraphs(chapterIndex) {
  // Keep every English paragraph, including short dialogue. The reader and
  // generator must use the same paragraph index or a short paragraph would
  // be silently skipped and every later gloss key could drift.
  return [...chapters[chapterIndex].content.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map(match => strip(match[1])).filter(text => text.length > 0 && /[A-Za-z]/.test(text));
}
function prepareBatches() {
  const all = [];
  for (let chapter = 0; chapter < chapters.length; chapter++) {
    const paragraphs = sourceParagraphs(chapter);
    paragraphs.forEach((text, paragraph) => {
      const targets = words(text).map(match => ({id:keyOf(chapter, paragraph, match.ordinal), word:match.word, index:match.offset})).filter(target => lexical(target.word) && !isUrlToken(text, target.index));
      if (targets.length) all.push({chapter, paragraph, text, before:paragraphs[paragraph - 1] || '', after:paragraphs[paragraph + 1] || '', targets});
    });
  }
  const batches = []; let current = [], targetCount = 0, characters = 0;
  for (const paragraph of all) {
    const cost = paragraph.text.length + Math.min(paragraph.before.length, 650) + Math.min(paragraph.after.length, 650);
    if (current.length && (targetCount + paragraph.targets.length > 86 || characters + cost > 10500)) {
      batches.push(current); current = []; targetCount = 0; characters = 0;
    }
    current.push(paragraph); targetCount += paragraph.targets.length; characters += cost;
  }
  if (current.length) batches.push(current);
  return {all, batches};
}
function makePayload(batch) {
  return {
    task:'contextual-glosses-v1',
    instructions:'只解释 targets 中列出的实词。每条 gloss 必须是该词在 targetParagraph 中的极短中文句中义，通常 2 到 10 个汉字。不得翻译整句，不得解释语法，不得输出 targets 以外的词，不得复述 before 或 after。返回严格 JSON：{"entries":[{"id":"chapter:paragraph:index","gloss":""}]}。每个 target 必须恰好一条；遇到专名或无法判断也填“”。',
    samples:batch.map(item => ({
      id:`${item.chapter}:${item.paragraph}`,
      targetParagraph:item.text,
      before:item.before.slice(-650),
      after:item.after.slice(0,650),
      targets:item.targets.map(target => ({id:target.id, word:target.word}))
    }))
  };
}
async function callDeepSeek(secret, payload) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${secret}`},
        body:JSON.stringify({model,thinking:{type:'disabled'},temperature:0,response_format:{type:'json_object'},max_tokens:2400,messages:[
          {role:'system',content:'你是中文母语者使用的英语小说句中义词典。严格遵守用户 JSON 中的 instructions。'},
          {role:'user',content:JSON.stringify(payload)}
        ]})
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0,300)}`);
      const body = await response.json();
      const rawContent = body.choices?.[0]?.message?.content || '';
      const parsed = JSON.parse(rawContent);
      return {parsed, rawContent, usage:body.usage || {}};
    } catch (error) {
      lastError = error;
      if (attempt < 3) await wait(1000 * attempt * attempt);
    }
  }
  throw lastError;
}

const {all, batches} = prepareBatches();
const allTargets = new Set(all.flatMap(item => item.targets.map(target => target.id)));
const targetDetails = new Map(all.flatMap(item => item.targets.map(target => [target.id, {word:target.word,chapter:item.chapter,paragraph:item.paragraph,text:item.text}])));
let state = {version:1,model,promptVersion:1,entries:{},failed:{},usage:{requests:0,promptTokens:0,completionTokens:0,costYuan:0},completed:false,createdAt:new Date().toISOString()};
try { state = {...state, ...JSON.parse(await readFile(stateFile, 'utf8'))}; } catch {}
state.entries ||= {}; state.failed ||= {}; state.unresolvedDetails ||= {}; state.usage ||= {requests:0,promptTokens:0,completionTokens:0,costYuan:0};
for (const key of Object.keys(state.entries)) if (!allTargets.has(key)) delete state.entries[key];
for (const key of Object.keys(state.failed)) if (!allTargets.has(key)) { delete state.failed[key]; delete state.unresolvedDetails[key]; }
for (const key of Object.keys(state.failed)) if (key in state.entries) { delete state.failed[key]; delete state.unresolvedDetails[key]; }
for (const [id, reason] of Object.entries(state.failed)) if (!state.unresolvedDetails[id] && targetDetails.has(id)) state.unresolvedDetails[id] = {...targetDetails.get(id), reason};
if (process.argv.includes('--dry-run')) {
  const missing = [...allTargets].filter(id => !(id in state.entries) && !(id in state.failed));
  const unresolved = [...allTargets].filter(id => !(id in state.entries));
  const byWord = new Set(missing.map(id => targetDetails.get(id)?.word?.toLowerCase()).filter(Boolean));
  const unresolvedByWord = new Set(unresolved.map(id => targetDetails.get(id)?.word?.toLowerCase()).filter(Boolean));
  const focusCounts = {};
  for (const item of all) for (const target of item.targets) if (/^(?:rehydration|beyond|extinguishing|insightful)$/i.test(target.word)) focusCounts[target.word.toLowerCase()] = (focusCounts[target.word.toLowerCase()] || 0) + 1;
  const unresolvedByReason = {};
  for (const id of unresolved) { const reason=state.failed[id]||'not-yet-requested'; unresolvedByReason[reason]=(unresolvedByReason[reason]||0)+1; }
  console.log(JSON.stringify({paragraphs:all.length,batches:batches.length,targetOccurrences:allTargets.size,notYetRequestedOccurrences:missing.length,notYetRequestedWordForms:byWord.size,unresolvedOccurrences:unresolved.length,unresolvedWordForms:unresolvedByWord.size,unresolvedByReason,regressionFocusOccurrences:focusCounts,focusStillMissing:[...unresolvedByWord].filter(word=>/rehydrat|extinguish|insightful/.test(word)),sampleUnresolved:[...unresolvedByWord].slice(0,40)},null,2));
  process.exit(0);
}
const secretStore = createDpapiSecretStore(path.join(project, '本地数据', '.reader-cache', 'reader-secrets.dpapi.json'));
const secret = (await secretStore.load()).deepseek;
if (!secret) throw new Error('没有找到 DeepSeek 密钥；请先在阅读器设置中保存密钥。');
let pending = batches.map((batch, index) => ({batch,index, targets:batch.flatMap(item => item.targets)})).filter(item => item.targets.some(target => !(target.id in state.entries) && !(target.id in state.failed)));
await note(`开始：正文段落 ${all.length}，目标实词 ${allTargets.size}，待处理批次 ${pending.length}，并发 ${concurrency}`);
let saving = Promise.resolve();
const save = () => { saving = saving.then(() => atomicJson(stateFile, state)); return saving; };
let cursor = 0;
async function worker(workerId) {
  while (true) {
    const job = pending[cursor++]; if (!job) return;
    const unresolved = job.targets.filter(target => !(target.id in state.entries) && !(target.id in state.failed));
    if (!unresolved.length) continue;
    const filtered = job.batch.map(item => ({...item,targets:item.targets.filter(target => unresolved.some(candidate => candidate.id === target.id))})).filter(item => item.targets.length);
    try {
      const started = new Date(); const {parsed, rawContent, usage} = await callDeepSeek(secret, makePayload(filtered));
      const allowed = new Set(unresolved.map(target => target.id)); const received = new Map();
      for (const item of parsed.entries || []) if (allowed.has(item?.id) && typeof item.gloss === 'string') received.set(item.id, short(item.gloss));
      for (const target of unresolved) {
        const gloss = received.get(target.id);
        if (gloss) { state.entries[target.id] = gloss; delete state.failed[target.id]; delete state.unresolvedDetails[target.id]; }
        else { state.failed[target.id] = 'empty-or-missing'; state.unresolvedDetails[target.id] = {...targetDetails.get(target.id),reason:'empty-or-missing',lastModelResponse:rawContent.slice(0,4000)}; }
      }
      const input = Number(usage.prompt_tokens || 0), output = Number(usage.completion_tokens || 0), rate = priceAt(started);
      state.usage.requests += 1; state.usage.promptTokens += input; state.usage.completionTokens += output; state.usage.costYuan += (input * rate.input + output * rate.output) / 1_000_000;
      await save();
      await note(`批次 ${job.index + 1}/${batches.length}（任务 ${workerId}）：${received.size}/${unresolved.length} 条，${input}+${output} tokens，${rate.label}计费`);
    } catch (error) {
      for (const target of unresolved) { const reason=`request-failed: ${String(error.message || error).slice(0,180)}`; state.failed[target.id] = reason; state.unresolvedDetails[target.id] = {...targetDetails.get(target.id),reason}; }
      await save(); await note(`批次 ${job.index + 1}/${batches.length} 失败：${String(error.message || error)}`);
    }
  }
}
await Promise.all(Array.from({length:concurrency},(_,index)=>worker(index+1)));
await saving;
state.completed = Object.keys(state.entries).length + Object.keys(state.failed).length >= allTargets.size;
state.finishedAt = new Date().toISOString();
await atomicJson(stateFile, state);
if (state.completed) await embedInReader(state.entries);
await note(`结束：已生成 ${Object.keys(state.entries).length}/${allTargets.size}，失败或空结果 ${Object.keys(state.failed).length}，请求 ${state.usage.requests}，估算 ¥${Number(state.usage.costYuan).toFixed(4)}`);
