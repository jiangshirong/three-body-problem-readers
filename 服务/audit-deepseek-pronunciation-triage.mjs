import {readFile, writeFile, mkdir, rename} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDpapiSecretStore} from './reader-server.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const canonicalPath = path.join(project, 'outputs', 'us-pronunciations-v2.json');
const kaikkiPath = path.join(project, 'outputs', 'kaikki-us-pronunciation-audit.jsonl');
const statePath = path.join(project, '本地数据', 'deepseek-pronunciation-triage-state.json');
const outputPath = path.join(project, 'outputs', 'deepseek-pronunciation-triage.jsonl');
const model = 'deepseek-flash', concurrency = 10, maxWords = 30, maxChars = 7800;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const canonical = JSON.parse(await readFile(canonicalPath, 'utf8'));
const kaikkiRows = new Map((await readFile(kaikkiPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(line => {const row=JSON.parse(line);return [row.word,row];}));
const words = [...kaikkiRows.keys()].filter(word => canonical.entries[word]).sort((a,b)=>a.localeCompare(b));
const payloadWord = word => {
  const local = (canonical.entries[word] || []).map(item => ({ipa:item.ipa,pos:item.pos||'',origin:item.origin||''}));
  const source = [...new Set((kaikkiRows.get(word)?.sourceUS || []).map(item => JSON.stringify({ipa:item.ipa,pos:item.pos||'',tags:item.tags||[]})))].map(value=>JSON.parse(value));
  return {word, local, wiktionaryUS:source};
};
const jobs=[];let batch=[],size=0;
for(const word of words){const entry=payloadWord(word);const n=JSON.stringify(entry).length;if(batch.length&&(batch.length>=maxWords||size+n>maxChars)){jobs.push(batch);batch=[];size=0;}batch.push(entry);size+=n;}
if(batch.length)jobs.push(batch);
let state={version:1,model,promptVersion:1,completed:{},failed:{},usage:{requests:0,promptTokens:0,completionTokens:0},startedAt:new Date().toISOString()};
try{state={...state,...JSON.parse(await readFile(statePath,'utf8'))};}catch{}
state.completed||={};state.failed||={};state.usage||={requests:0,promptTokens:0,completionTokens:0};
const pending=jobs.map((job,index)=>({job,index})).filter(({job})=>job.some(item=>!state.completed[item.word]));
const store=createDpapiSecretStore(path.join(project,'本地数据','.reader-cache','reader-secrets.dpapi.json'));
const secret=(await store.load()).deepseek;if(!secret)throw new Error('DeepSeek 密钥未配置');
async function call(job){
  const response=await fetch('https://api.deepseek.com/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${secret}`},body:JSON.stringify({model,thinking:{type:'disabled'},temperature:0,response_format:{type:'json_object'},max_tokens:2200,messages:[
    {role:'system',content:'你是美式英语音标的批量审校助手。逐词对照本地 IPA 与 Wiktionary 明确标记 US/General-American 的 IPA。目标是找出可能错误、漏掉的常见读音、口音混入或仅为窄式音标差异的条目。不得自己编造任何 IPA，也不得把模型记忆当作来源；无足够依据必须 uncertain。Wiktionary 仅为 crowdsourced evidence，不等同编辑型词典。只输出 JSON：{"items":[{"word":"","verdict":"agree|review|uncertain","reason":"简短说明"}]}。每个输入词恰好返回一项；不需要给任何新音标。'},
    {role:'user',content:JSON.stringify({task:'triage-only-not-source-verification',words:job})}
  ]})});
  if(!response.ok)throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0,180)}`);
  const result=await response.json();return {parsed:JSON.parse(result.choices?.[0]?.message?.content||'{}'),usage:result.usage||{}};
}
const temp=`${outputPath}.tmp`;
async function save(){
  const ordered=words.filter(word=>state.completed[word]).map(word=>JSON.stringify(state.completed[word]));
  await writeFile(temp,ordered.length?`${ordered.join('\n')}\n`:'' ,'utf8');await rename(temp,outputPath);
  await writeFile(statePath,`${JSON.stringify(state,null,2)}\n`,'utf8');
}
let cursor=0,done=0,writes=Promise.resolve();
async function worker(){while(true){const item=pending[cursor++];if(!item)return;try{
  const result=await call(item.job),allowed=new Set(item.job.map(entry=>entry.word));let valid=0;
  for(const row of result.parsed.items||[])if(allowed.has(row?.word)&&['agree','review','uncertain'].includes(row.verdict)){state.completed[row.word]={word:row.word,verdict:row.verdict,reason:String(row.reason||'').slice(0,400),job:item.index+1,model,triageOnly:true};delete state.failed[row.word];valid++;}
  for(const entry of item.job)if(!state.completed[entry.word])state.failed[entry.word]='missing-or-invalid-model-result';
  state.usage.requests++;state.usage.promptTokens+=Number(result.usage.prompt_tokens||0);state.usage.completionTokens+=Number(result.usage.completion_tokens||0);done++;
  writes=writes.then(save);await writes;
  if(done%10===0||done===pending.length)console.log(JSON.stringify({completedJobs:done,totalPendingJobs:pending.length,wordDecisions:Object.keys(state.completed).length,totalWords:words.length,review:Object.values(state.completed).filter(x=>x.verdict==='review').length,uncertain:Object.values(state.completed).filter(x=>x.verdict==='uncertain').length,failed:Object.keys(state.failed).length,tokens:state.usage.promptTokens+state.usage.completionTokens}));
  await wait(100);
}catch(error){for(const entry of item.job)if(!state.completed[entry.word])state.failed[entry.word]=String(error.message||error).slice(0,180);done++;writes=writes.then(save);await writes;console.error(JSON.stringify({job:item.index+1,error:String(error.message||error).slice(0,180)}));}}}
console.log(JSON.stringify({words:words.length,jobs:jobs.length,pendingJobs:pending.length,resume:Object.keys(state.completed).length,model}));
await Promise.all(Array.from({length:concurrency},worker));await writes;
state.finishedAt=new Date().toISOString();await save();
console.log(JSON.stringify({finished:true,words:Object.keys(state.completed).length,review:Object.values(state.completed).filter(x=>x.verdict==='review').length,uncertain:Object.values(state.completed).filter(x=>x.verdict==='uncertain').length,failed:Object.keys(state.failed).length,usage:state.usage,outputPath}));
