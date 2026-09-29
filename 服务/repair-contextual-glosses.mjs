import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDpapiSecretStore} from './reader-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, '..');
const stateFile = path.join(project, '本地数据', 'contextual-glosses-v1.json');
const readerFile = path.join(project, 'outputs', 'three-body-reader.html');
const model = 'deepseek-flash', concurrency = 10, targetLimit = Number(process.env.CONTEXT_GLOSS_REPAIR_TARGET_LIMIT || 32), forceNonEmpty = process.env.CONTEXT_GLOSS_REPAIR_FORCE_NONEMPTY === '1';
const onlyWords = new Set(String(process.env.CONTEXT_GLOSS_REPAIR_WORDS || '').split(',').map(word=>word.trim().toLowerCase()).filter(Boolean));
const readerHtml = await readFile(readerFile, 'utf8');
const dictionary = JSON.parse(readerHtml.match(/<script id="dictionaryData" type="application\/json">([\s\S]*?)<\/script>/)?.[1] || '{"entries":{}}');
const functionWords = new Set(`a an the this that these those i me my mine myself you your yours yourself he him his himself she her hers herself it its itself we us our ours ourselves they them their theirs themselves who whom whose which what where when why how and or but nor so yet for of in on at by from to with without into onto over under about after before during through between among against around within as if than then while because although though since unless until whether not no yes be am is are was were been being have has had having do does did doing can could may might must shall should will would need dare used there here out up down off away back again also even just only very more most less least much many few all both each every either neither another other some any one two first second third own same such`.split(/\s+/));
const plain = value => String(value).replace(/\s+/g, ' ').trim();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const price = () => {
  const now = new Date(), day = now.getDay(), hour = now.getHours() + now.getMinutes()/60;
  return day >= 1 && day <= 5 && ((hour>=9&&hour<12)||(hour>=14&&hour<18)) ? {input:2,output:8} : {input:1,output:4};
};
async function save(file, value) { await mkdir(path.dirname(file),{recursive:true}); const tmp=`${file}.tmp`; await writeFile(tmp,`${JSON.stringify(value,null,2)}\n`,'utf8'); await rename(tmp,file); }
function eligible(detail) {
  const word = String(detail.word || '');
  if (String(detail.reason || '').startsWith('request-failed:')) return true;
  const normalized = word.toLowerCase().replaceAll('’', "'");
  if (onlyWords.size && !onlyWords.has(normalized)) return false;
  // ECDICT occasionally misclassifies contractions as nouns (e.g. "don't"
  // also means a prohibition). Don't ask for a contextual lexical gloss when
  // the token is functioning as a grammatical contraction.
  if (/^(?:[a-z]+)(?:n't|'s|'d|'ll|'re|'ve|'m)$/.test(normalized)) return false;
  if (functionWords.has(normalized)) return false;
  // Sentence-initial capitalization is not evidence of a proper name. Only
  // skip a capitalized unresolved token when the local dictionary has no
  // content-word part of speech for its lowercase form.
  if (/^[A-Z]/.test(word)) {
    const translation=String(dictionary.entries?.[normalized]?.translation||'');
    if (!/^(?:n|v|vi|vt|a|adj|ad|adv|s)\./i.test(translation.trim())) return false;
  }
  return true;
}
function brokenAccentFragment(detail) {
  const word=String(detail.word||'').toLowerCase();
  return [...String(detail.text||'').matchAll(/[\p{L}]+/gu)].some(match=>/[^\x00-\x7f]/.test(match[0])&&match[0].toLowerCase().includes(word)&&match[0].toLowerCase()!==word);
}
function jobsFor(details) {
  const groups = new Map();
  for (const [id, detail] of details) { const list=groups.get(`${detail.chapter}:${detail.paragraph}`)||[]; list.push({id,word:detail.word}); groups.set(`${detail.chapter}:${detail.paragraph}`,list); }
  const jobs=[];
  for (const [key, targets] of groups) for(let start=0;start<targets.length;start+=targetLimit) {
    const sample=details.find(([,detail])=>`${detail.chapter}:${detail.paragraph}`===key)?.[1];
    jobs.push({chapter:sample.chapter,paragraph:sample.paragraph,text:sample.text,targets:targets.slice(start,start+targetLimit)});
  }
  return jobs;
}
async function call(secret, job) {
  const payload={task:'contextual-gloss-repair-v1',instructions:`只解释 targets 中的词。每条 gloss 是该词在 targetParagraph 里的极短中文句中义，通常 2 到 10 个汉字。不得翻译整句、解释语法、输出 targets 以外的词或额外文字。返回严格 JSON：{"entries":[{"id":"","gloss":""}]}，每个 target 必须恰好一条；无法判断则 gloss 填空字符串。${forceNonEmpty?'本请求只有一个普通英语单词，禁止返回空 entries，必须给它给出一个简短中文义。':''}`,samples:[{id:`${job.chapter}:${job.paragraph}`,targetParagraph:job.text,targets:job.targets}]};
  const response=await fetch('https://api.deepseek.com/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${secret}`},body:JSON.stringify({model,thinking:{type:'disabled'},temperature:0,response_format:{type:'json_object'},max_tokens:1200,messages:[{role:'system',content:'你是英语小说的中文句中义词典。严格只返回指定 JSON。'},{role:'user',content:JSON.stringify(payload)}]})});
  if(!response.ok)throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0,220)}`);
  const body=await response.json(), content=body.choices?.[0]?.message?.content||''; return {entries:JSON.parse(content||'{}').entries||[],usage:body.usage||{},content};
}
async function embed(entries) {
  const payload=JSON.stringify({version:2,indexVersion:2,entries}).replace(/</g,'\\u003c'); const source=await readFile(readerFile,'utf8'); const placeholder=/const contextualGlossData = .*?;/; if(!placeholder.test(source))throw new Error('阅读器中没有找到句中义数据占位符，未写入阅读器。'); const next=source.replace(placeholder,`const contextualGlossData = ${payload};`); if(next===source)return; await writeFile(readerFile,next,'utf8');
}
const state=JSON.parse(await readFile(stateFile,'utf8')); state.entries ||= {}; state.failed ||= {}; state.unresolvedDetails ||= {}; state.excludedTokenFragments ||= {}; state.usage ||= {requests:0,promptTokens:0,completionTokens:0,costYuan:0};
for(const [id,detail] of Object.entries(state.unresolvedDetails)) if(brokenAccentFragment(detail)){state.excludedTokenFragments[id]={...detail,reason:'unicode-tokenization-fragment'};delete state.unresolvedDetails[id];delete state.failed[id];}
const selected=Object.entries(state.unresolvedDetails).filter(([,detail])=>(detail.reason==='repair-empty-or-missing'||detail.reason==='empty-or-missing')&&eligible(detail)); const jobs=jobsFor(selected);
console.log(JSON.stringify({selected:selected.length,jobs:jobs.length,targetLimit,concurrency}));
const store=createDpapiSecretStore(path.join(project,'本地数据','.reader-cache','reader-secrets.dpapi.json')); const secret=(await store.load()).deepseek; if(!secret)throw new Error('没有 DeepSeek 密钥');
let cursor=0, writes=Promise.resolve(); const repair={startedAt:new Date().toISOString(),selected:selected.length,jobs:jobs.length,completed:0,stillEmpty:0,failed:0,inputTokens:0,outputTokens:0,costYuan:0};
const flush=()=>writes=writes.then(()=>save(stateFile,state));
async function worker() {
  while (true) {
    const job=jobs[cursor++]; if (!job) return;
    try {
      const result=await call(secret,job), allowed=new Set(job.targets.map(target=>target.id)), map=new Map();
      for(const item of result.entries) if(allowed.has(item?.id)&&typeof item?.gloss==='string') map.set(item.id,plain(item.gloss).slice(0,24));
      for(const target of job.targets) {
        const gloss=map.get(target.id);
        if(gloss) { state.entries[target.id]=gloss; delete state.failed[target.id]; delete state.unresolvedDetails[target.id]; repair.completed++; }
        else { state.failed[target.id]='repair-empty-or-missing'; Object.assign(state.unresolvedDetails[target.id],{reason:'repair-empty-or-missing',lastModelResponse:result.content.slice(0,4000)}); repair.stillEmpty++; }
      }
      const input=Number(result.usage.prompt_tokens||0), output=Number(result.usage.completion_tokens||0), rate=price();
      repair.inputTokens+=input; repair.outputTokens+=output; repair.costYuan+=(input*rate.input+output*rate.output)/1e6;
      state.usage.requests+=1; state.usage.promptTokens+=input; state.usage.completionTokens+=output; state.usage.costYuan+=(input*rate.input+output*rate.output)/1e6;
      await flush();
    } catch(error) {
      for(const target of job.targets) { state.failed[target.id]=`repair-failed: ${String(error.message||error).slice(0,180)}`; state.unresolvedDetails[target.id].reason=state.failed[target.id]; repair.failed++; }
      await flush();
    }
  }
}
await Promise.all(Array.from({length:concurrency},worker)); await writes; repair.finishedAt=new Date().toISOString(); state.contextualGlossRepairV1=repair; await save(stateFile,state); await embed(state.entries); console.log(JSON.stringify(repair));
