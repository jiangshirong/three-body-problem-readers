import {createHash} from 'node:crypto';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDpapiSecretStore} from './reader-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, '..');
const inputFile = path.join(project, 'outputs', 'us-pronunciations.json');
const readerFile = path.join(project, 'outputs', 'three-body-reader.html');
const stateFile = path.join(project, '本地数据', 'american-pronunciation-calibration-v2.json');
const canonicalFile = path.join(project, 'outputs', 'us-pronunciations-v2.json');
const reportFile = path.join(project, 'outputs', '美式音标校准报告-v2.md');
const model = 'deepseek-flash', concurrency = 10, maxWords = 30, maxChars = 9000;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const normalize = value => String(value || '').trim().toLowerCase().replaceAll('’', "'");
const hash = value => createHash('sha256').update(value).digest('hex');
const sourcePriority = record => record.origin === 'local-calibration' ? 0 : record.origin === 'wiktionary' ? 1 : record.origin === 'cmudict' ? 2 : 9;
const POS_LABELS = {noun:'名',verb:'动',adj:'形',adv:'副',prep:'介',pron:'代',det:'限定',conj:'连',intj:'叹',num:'数',particle:'小品',name:'专名',contraction:'缩写',symbol:'符号',character:'字符',postp:'后置',phrase:'短语',prep_phrase:'介短语',infix:'插入'};
// Evidenced noun/verb stress contrast for the inflected spelling "contracting".
const POS_OVERRIDES = {contracting:{'/ˈkɑːntræktɪŋ/':'noun','/kənˈtræktɪŋ/':'verb'}};
// CMUdict's unstressed IY in this word is realized as /ɪ/ in standard American
// pronunciation. Cambridge US gives /prɪˈdɪk.ʃən/; keep the raw ARPAbet below
// for source audit while correcting the learner-facing IPA deterministically.
const IPA_OVERRIDES = {prediction:{'/priˈdɪkʃən/':'/prɪˈdɪkʃən/'}};
function canonicalPos(value) {
  const pos = normalize(value);
  if (!pos) return '';
  if (pos === 'vi' || pos === 'vt' || pos === 'v' || pos === 'verb') return 'verb';
  return POS_LABELS[pos] ? pos : pos;
}
function posLabel(pos) { return POS_LABELS[pos] || ''; }
function isUS(record) { return Array.isArray(record?.tags) && record.tags.some(tag => tag === 'US' || tag === 'General-American') && typeof record.ipa === 'string' && record.ipa.trim(); }
function canonicalEntries(rawEntries) {
  const output = {}, stats = {sourceWords:Object.keys(rawEntries).length, americanWords:0, rawRecords:0, keptRecords:0, removedNonAmerican:0, deduplicated:0, multiPronunciation:0, posKnown:0, posUnknown:0};
  for (const [rawWord, records] of Object.entries(rawEntries)) {
    const word = normalize(rawWord); const groups = new Map();
    for (const record of Array.isArray(records) ? records : []) {
      stats.rawRecords++;
      if (!isUS(record)) { stats.removedNonAmerican++; continue; }
      const sourceIpa = record.ipa.trim(); const ipa = IPA_OVERRIDES[word]?.[sourceIpa] || sourceIpa; const pos = canonicalPos(POS_OVERRIDES[word]?.[ipa] || record.pos); const key = `${ipa}\u0000${pos}`;
      const existing = groups.get(key);
      if (existing) {
        existing.sources = [...new Set([...existing.sources, record.source || record.origin || 'unknown'])];
        existing.originalTags = [...new Set([...existing.originalTags, ...(record.tags || [])])];
        stats.deduplicated++;
        continue;
      }
      const candidate = {headword:word,ipa, pos, posLabel:posLabel(pos), accent:'General-American', tags:['General-American'], source:record.source || record.origin || 'unknown', sources:[record.source || record.origin || 'unknown'], originalTags:[...(record.tags || [])], origin:record.origin || 'unknown', reviewVersion:record.reviewVersion || (record.origin === 'local-calibration' ? 'deepseek-review-1' : ''), sourceRevision:record.sourceRevision || '', rawPronunciation:record.rawPronunciation || ipa, conversionVersion:record.conversionVersion || 'learner-us-1'};
      groups.set(key, candidate); stats.keptRecords++; if (pos) stats.posKnown++; else stats.posUnknown++;
    }
    const candidates = [...groups.values()];
    if (!candidates.length) continue;
    if (candidates.length > 1) stats.multiPronunciation++;
    output[word] = candidates;
  }
  stats.americanWords = Object.keys(output).length;
  return {output, stats};
}
function candidateId(word, index) { return `${word}#${index + 1}`; }
function buildJobs(entries) {
  const jobs = [], words = Object.keys(entries).filter(word => new Set(entries[word].map(record => record.ipa)).size > 1);
  let current = [], chars = 0;
  for (const word of words) {
    const item = {word, candidates:entries[word].map((record, index) => ({id:candidateId(word,index), ipa:record.ipa, pos:record.pos || '', label:record.posLabel || ''}))};
    const cost = JSON.stringify(item).length;
    if (current.length && (current.length >= maxWords || chars + cost > maxChars)) { jobs.push(current); current=[]; chars=0; }
    current.push(item); chars += cost;
  }
  if (current.length) jobs.push(current);
  return {jobs, ambiguousWords:words};
}
function makePayload(job) { return {task:'american-pronunciation-order-v2',instructions:'只在每个词已有的 candidates 中排序。不要修改 IPA，不要新增候选，不要删除候选。按现代通用美式英语的常用度和默认朗读优先级排序；名词和动词的读音都保留。返回严格 JSON：{"rankings":[{"word":"","order":["candidate-id",...]}]}。每个词必须返回完整候选 ID 顺序；无法判断时按输入顺序返回。',words:job}; }
async function callDeepSeek(secret, payload) {
  const response = await fetch('https://api.deepseek.com/chat/completions', {method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${secret}`},body:JSON.stringify({model,thinking:{type:'disabled'},temperature:0,response_format:{type:'json_object'},max_tokens:2600,messages:[{role:'system',content:'你是现代美国英语发音词典的候选读音排序器。只能重排已有候选。'},{role:'user',content:JSON.stringify(payload)}]})});
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0,220)}`);
  const body = await response.json(), rawContent = body.choices?.[0]?.message?.content || '';
  return {parsed:JSON.parse(rawContent),rawContent,usage:body.usage || {}};
}
async function atomicJson(file, value) { await mkdir(path.dirname(file),{recursive:true}); const tmp=`${file}.tmp`; await writeFile(tmp,`${JSON.stringify(value,null,2)}\n`,'utf8'); await rename(tmp,file); }
async function embed(entries, meta) {
  const payload = JSON.stringify({schema:3,source:'Kaikki Wiktionary + local calibration',acceptedTags:['US','General-American'],calibration:meta,entries}).replace(/</g,'\\u003c');
  const source = await readFile(readerFile,'utf8'); const pattern=/(<script id="americanPronunciationData" type="application\/json">)[\s\S]*?(<\/script>)/; const next=source.replace(pattern,`$1${payload}$2`);
  if (next === source) throw new Error('没有找到 americanPronunciationData 数据块');
  await writeFile(readerFile,next,'utf8');
}
const raw = JSON.parse(await readFile(inputFile,'utf8')); const {output:entries,stats} = canonicalEntries(raw.entries || {}); const {jobs,ambiguousWords} = buildJobs(entries); const candidateHash=hash(JSON.stringify(entries));
let state={version:2,model,promptVersion:2,candidateHash,orders:{},failed:{},usage:{requests:0,promptTokens:0,completionTokens:0,costYuan:0},completed:false};
try { state={...state,...JSON.parse(await readFile(stateFile,'utf8'))}; } catch {}
state.orders ||= {}; state.failed ||= {}; state.usage ||= {requests:0,promptTokens:0,completionTokens:0,costYuan:0};
const pending=jobs.map((job,index)=>({job,index})).filter(item=>item.job.some(word=>!Array.isArray(state.orders[word.word])));
const store=createDpapiSecretStore(path.join(project,'本地数据','.reader-cache','reader-secrets.dpapi.json')); const secret=(await store.load()).deepseek; if(!secret) throw new Error('没有找到 DeepSeek 密钥；请先设置密钥。');
console.log(JSON.stringify({words:Object.keys(entries).length,ambiguousWords:ambiguousWords.length,jobs:jobs.length,pending:pending.length,stats}));
let cursor=0,writes=Promise.resolve(); const save=()=>writes=writes.then(()=>atomicJson(stateFile,state));
async function worker() {
  while(true) {
    const item=pending[cursor++]; if(!item)return;
    try {
      const result=await callDeepSeek(secret,makePayload(item.job)); const allowed=new Map(item.job.map(word=>[word.word,new Set(word.candidates.map(candidate=>candidate.id))])); let valid=0;
      for(const ranking of result.parsed.rankings || []) {
        const ids=allowed.get(ranking?.word); if(!ids || !Array.isArray(ranking.order)) continue;
        const order=[...new Set(ranking.order.filter(id=>ids.has(id)))]; if(!order.length) continue;
        for(const id of ids) if(!order.includes(id)) order.push(id);
        state.orders[ranking.word]=order; valid++;
      }
      if(valid<item.job.length) for(const word of item.job) if(!Array.isArray(state.orders[word.word])) state.failed[word.word]='missing-or-invalid-ranking';
      const input=Number(result.usage.prompt_tokens||0), output=Number(result.usage.completion_tokens||0); state.usage.requests++; state.usage.promptTokens+=input; state.usage.completionTokens+=output; state.usage.costYuan+=(input+output*4)/1_000_000; await save();
      console.log(`job ${item.index+1}/${jobs.length}: ${valid}/${item.job.length}, ${input}+${output} tokens`);
    } catch(error) {
      for(const word of item.job) if(!Array.isArray(state.orders[word.word])) state.failed[word.word]=`request-failed: ${String(error.message||error).slice(0,180)}`;
      await save(); console.error(`job ${item.index+1}/${jobs.length} failed: ${error.message||error}`);
    }
  }
}
await Promise.all(Array.from({length:concurrency},worker)); await writes;
for(const word of ambiguousWords) if(!Array.isArray(state.orders[word])) state.failed[word] ||= 'not-ranked';
state.completed=ambiguousWords.every(word=>Array.isArray(state.orders[word]) || state.failed[word]); state.finishedAt=new Date().toISOString(); await atomicJson(stateFile,state);
for(const [word,records] of Object.entries(entries)) { const order=state.orders[word]; if(order){ const byId=new Map(records.map((record,index)=>[candidateId(word,index),record])); const sorted=order.map(id=>byId.get(id)).filter(Boolean); for(const record of records) if(!sorted.includes(record)) sorted.push(record); entries[word]=sorted.map((record,index)=>({...record,rank:index+1})); } else entries[word]=records.map((record,index)=>({...record,rank:index+1})); }
const meta={version:2,model,promptVersion:2,candidateHash,stats,ambiguousWords:ambiguousWords.length,rankedWords:Object.keys(state.orders).length,failedWords:Object.keys(state.failed).length,usage:state.usage,finishedAt:state.finishedAt};
await embed(entries,meta);
await writeFile(canonicalFile,`${JSON.stringify({schema:3,source:'Kaikki Wiktionary + local calibration',acceptedTags:['US','General-American'],calibration:meta,entries},null,2)}\n`,'utf8');
const report=`# 美式音标校准报告 v2\n\n- 模型：${model}\n- 美式词条：${stats.americanWords}\n- 保留美式记录：${stats.keptRecords}\n- 删除非美式记录：${stats.removedNonAmerican}\n- 合并重复记录：${stats.deduplicated}\n- 多读音词：${stats.multiPronunciation}\n- 已排序词：${Object.keys(state.orders).length}\n- 无法排序词：${Object.keys(state.failed).length}\n- 明确词性记录：${stats.posKnown}\n- 未知词性记录：${stats.posUnknown}\n- 请求：${state.usage.requests}\n- 估算费用：¥${Number(state.usage.costYuan).toFixed(4)}\n\n排序仅在已有美式候选中进行，未使用模型新生成的 IPA。`;
await writeFile(reportFile,report,'utf8'); console.log(JSON.stringify(meta,null,2));
