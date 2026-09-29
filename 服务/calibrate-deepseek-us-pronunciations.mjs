import {createHash} from 'node:crypto';
import {copyFile, mkdir, readFile, rename, unlink, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDpapiSecretStore} from './reader-server.mjs';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const canonicalPath=path.join(project,'outputs','us-pronunciations-v2.json');
const baselinePath=path.join(project,'本地数据','us-pronunciations-v2-before-deepseek-calibration.json');
const readerPath=path.join(project,'outputs','three-body-reader.html');
const statePath=path.join(project,'本地数据','deepseek-us-pronunciation-calibration-state.json');
const outputPath=path.join(project,'outputs','deepseek-us-pronunciation-calibration.jsonl');
const reportPath=path.join(project,'outputs','DeepSeek美式音标全量校准报告.md');
const model='deepseek-flash',promptVersion=1;
const concurrency=10,maxWords=24,maxChars=6500;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const hash=value=>createHash('sha256').update(value).digest('hex');

let canonicalData=canonicalPath;try{await readFile(baselinePath);canonicalData=baselinePath;}catch{}
const canonical=JSON.parse(await readFile(canonicalData,'utf8'));
const words=Object.keys(canonical.entries).sort((a,b)=>a.localeCompare(b));
const current=word=>(canonical.entries[word]||[]).map(x=>({ipa:x.ipa,pos:x.pos||'',posLabel:x.posLabel||''}));
const jobs=[];let batch=[],size=0;
for(const word of words){const entry={word,current:current(word)};const n=JSON.stringify(entry).length;if(batch.length&&(batch.length>=maxWords||size+n>maxChars)){jobs.push(batch);batch=[];size=0;}batch.push(entry);size+=n;}
if(batch.length)jobs.push(batch);
const candidateHash=hash(JSON.stringify(words.map(word=>[word,current(word)])));
let state={version:1,model,promptVersion,candidateHash,completed:{},failed:{},usage:{requests:0,promptTokens:0,completionTokens:0},startedAt:new Date().toISOString()};
try{const prior=JSON.parse(await readFile(statePath,'utf8'));if(prior.candidateHash===candidateHash&&prior.promptVersion===promptVersion)state={...state,...prior};}catch{}
state.completed||={};state.failed||={};state.usage||={requests:0,promptTokens:0,completionTokens:0};
const pending=jobs.map((job,index)=>({job,index})).filter(({job})=>job.some(x=>!state.completed[x.word]));
const secretStore=createDpapiSecretStore(path.join(project,'本地数据','.reader-cache','reader-secrets.dpapi.json'));
const secret=(await secretStore.load()).deepseek;if(!secret)throw new Error('未找到已保存的 DeepSeek API Key');

const systemPrompt=`你是本项目英语词典的最终美式发音校准器。以你对现代通用美式英语的判断为准，不需要引用或查询外部来源。对输入中的每个英语词头，检查现有 IPA 是否正确、是否漏掉常用美式读音，并直接返回校准后的最终读音。
标准：只给现代通用美式英语；使用学习者熟悉的宽式 IPA，保留重音符号和必要的长音符号，不加音节分隔点，不混入英式音。列常用读音，不罗列罕见地区变体。对不同词性确实有不同读音的同形词分别标词性；不要给同一词性下相同的多个音标重复贴同一个词性标签。IPA 必须用 /.../ 包裹。
允许纠正错误转写、删除错误候选、补上常见读音并调整常用顺序。除非确实无法判断（如低频专名缺乏把握），不要返回 uncertain。若无法判断，保留输入候选，并将 status 设为 uncertain。不要解释，不要输出输入中没有的词。
严格返回 JSON：{"items":[{"word":"...","status":"calibrated|uncertain","confidence":"high|medium|low","pronunciations":[{"ipa":"/.../","pos":"noun|verb|adjective|adverb|preposition|pronoun|conjunction|determiner|interjection|proper noun|other|unknown","rank":1}]}]}。同一个词只需返回不同读音；跨词性同音项合并，不标词性。若不同词性读音不同，在相应读音上标词性。rank 从 1 开始，1 为最常用。`;
async function call(job){
  const response=await fetch('https://api.deepseek.com/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${secret}`},body:JSON.stringify({model,thinking:{type:'disabled'},temperature:0,response_format:{type:'json_object'},max_tokens:5200,messages:[{role:'system',content:systemPrompt},{role:'user',content:JSON.stringify({task:'calibrate-all-us-pronunciations',words:job})}]})});
  if(!response.ok)throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0,240)}`);
  const body=await response.json(),raw=body.choices?.[0]?.message?.content||'';
  return {parsed:JSON.parse(raw),raw,usage:body.usage||{}};
}
const posMap={noun:'n',verb:'v',adjective:'adj',adverb:'adv',preposition:'prep',pronoun:'pron',conjunction:'conj',determiner:'det',interjection:'intj','proper noun':'name',other:'',unknown:''};
function validateItem(row,allowed){
  if(!row||!allowed.has(row.word)||!['calibrated','uncertain'].includes(row.status)||!Array.isArray(row.pronunciations))return null;
  const pronunciations=[];
  for(const item of row.pronunciations){let ipa=String(item?.ipa||'').trim();ipa=ipa.replace(/^\/+|\/+$/g,'').replace(/\s*\.\s*/g,'');if(!ipa||/[\/\r\n]/.test(ipa)||ipa.includes('undefined'))continue;pronunciations.push({ipa:`/${ipa}/`,pos:posMap[String(item.pos||'').toLowerCase()]??'',rank:Math.max(1,Number(item.rank)||pronunciations.length+1)});}
  if(row.status==='calibrated'&&!pronunciations.length)return null;
  const sameIpa=new Map();for(const item of pronunciations){const key=item.ipa.toLowerCase();if(!sameIpa.has(key))sameIpa.set(key,item);else{const old=sameIpa.get(key);if(old.pos&&item.pos&&old.pos!==item.pos)old.pos=[...new Set([...old.pos.split(','),...item.pos.split(',')])].sort((a,b)=>({n:0,v:1,adj:2,adv:3,prep:4,pron:5,conj:6,det:7,intj:8,name:9}[a]??99)-({n:0,v:1,adj:2,adv:3,prep:4,pron:5,conj:6,det:7,intj:8,name:9}[b]??99)).join(',');}}
  const list=[...sameIpa.values()].sort((a,b)=>a.rank-b.rank);
  const distinctPos=new Set(list.flatMap(x=>x.pos.split(',').filter(Boolean)));
  if(distinctPos.size<2||list.length<2)for(const item of list)item.pos='';
  return {word:row.word,status:row.status,confidence:['high','medium','low'].includes(row.confidence)?row.confidence:'',pronunciations:list};
}
async function atomicWrite(file,data){await mkdir(path.dirname(file),{recursive:true});const temp=`${file}.${process.pid}.${Date.now()}.tmp`;await writeFile(temp,data,'utf8');try{await rename(temp,file);}catch(error){if(!['EPERM','EEXIST','EBUSY'].includes(error.code))throw error;await copyFile(temp,file);await unlink(temp);}}
async function save(){
  await atomicWrite(statePath,`${JSON.stringify(state,null,2)}\n`);
}
let cursor=0,finished=0,writes=Promise.resolve();
async function worker(){while(true){const task=pending[cursor++];if(!task)return;try{
  const result=await call(task.job),allowed=new Set(task.job.map(x=>x.word));const returned=new Map();
  for(const raw of result.parsed.items||[]){const item=validateItem(raw,allowed);if(item)returned.set(item.word,item);}
  for(const entry of task.job){const item=returned.get(entry.word);if(item){state.completed[entry.word]={...item,model,job:task.index+1};delete state.failed[entry.word];}else state.failed[entry.word]='missing-or-invalid-model-result';}
  state.usage.requests++;state.usage.promptTokens+=Number(result.usage.prompt_tokens||0);state.usage.completionTokens+=Number(result.usage.completion_tokens||0);
  state.rawBatches||={};state.rawBatches[task.index+1]=result.raw;
  finished++;writes=writes.then(save);await writes;
  console.log(JSON.stringify({batch:task.index+1,totalBatches:jobs.length,doneBatches:finished,pendingBatches:pending.length,completedWords:Object.keys(state.completed).length,uncertain:Object.values(state.completed).filter(x=>x.status==='uncertain').length,failedWords:Object.keys(state.failed).length,tokens:state.usage.promptTokens+state.usage.completionTokens}));
  await wait(80);
}catch(error){for(const entry of task.job)if(!state.completed[entry.word])state.failed[entry.word]=String(error.message||error).slice(0,220);finished++;writes=writes.then(save);await writes;console.error(JSON.stringify({batch:task.index+1,error:String(error.message||error).slice(0,220)}));}}}
console.log(JSON.stringify({model,words:words.length,jobs:jobs.length,pendingJobs:pending.length,completed:Object.keys(state.completed).length,concurrency}));
await Promise.all(Array.from({length:concurrency},worker));await writes;
state.finishedAt=new Date().toISOString();await save();
const resultRows=words.filter(word=>state.completed[word]).map(word=>JSON.stringify(state.completed[word]));
await writeFile(outputPath,resultRows.length?`${resultRows.join('\n')}\n`:'','utf8');

const outputEntries={};let calibrated=0,uncertain=0;
const posOrder={n:0,v:1,adj:2,adv:3,prep:4,pron:5,conj:6,det:7,intj:8,name:9};
const posNames={n:'名',v:'动',adj:'形',adv:'副',prep:'介',pron:'代',conj:'连',det:'限定',intj:'叹',name:'专名'};
for(const word of words){const result=state.completed[word];if(!result||result.status==='uncertain'){uncertain++;outputEntries[word]=canonical.entries[word]||[];continue;}calibrated++;outputEntries[word]=result.pronunciations.map(item=>{const pos=item.pos.split(',').filter(Boolean).sort((a,b)=>(posOrder[a]??99)-(posOrder[b]??99)).join(',');return {headword:word,ipa:item.ipa,pos,posLabel:pos.split(',').map(value=>posNames[value]||'').filter(Boolean).join(' · '),accent:'General-American',tags:['General-American'],source:'DeepSeek-Flash calibration',sources:[],originalTags:[],origin:'deepseek-flash-calibrated',reviewVersion:`deepseek-flash-${promptVersion}`,sourceRevision:'',rawPronunciation:item.ipa,conversionVersion:'learner-us-1',rank:item.rank};});}
const meta={model,promptVersion,totalWords:words.length,calibratedWords:calibrated,uncertainWords:uncertain,failedWords:Object.keys(state.failed).length,usage:state.usage,finishedAt:state.finishedAt};
const embedded=JSON.stringify({schema:3,source:'DeepSeek-Flash calibration',acceptedTags:['US','General-American'],calibration:meta,entries:outputEntries}).replace(/</g,'\\u003c');
const html=await readFile(readerPath,'utf8'),pattern=/(<script id="americanPronunciationData" type="application\/json">)[\s\S]*?(<\/script>)/;
const next=html.replace(pattern,`$1${embedded}$2`);if(next===html)throw new Error('未找到阅读器音标数据块');
await writeFile(readerPath,next,'utf8');
await atomicWrite(canonicalPath,`${JSON.stringify({schema:3,source:'DeepSeek-Flash calibration',acceptedTags:['US','General-American'],calibration:meta,entries:outputEntries},null,2)}\n`);
const uncertainWords=words.filter(word=>!state.completed[word]||state.completed[word].status==='uncertain'||state.failed[word]);
const report=['# DeepSeek-Flash 美式音标全量校准报告','',`- 模型：${model}`,`- 词头总数：${words.length}`,`- 已校准：${calibrated}`,`- 模型标为不确定并保留旧记录：${uncertain}`,`- 请求或格式失败：${Object.keys(state.failed).length}`,`- API 请求：${state.usage.requests}`,`- Token：输入 ${state.usage.promptTokens}，输出 ${state.usage.completionTokens}`,`- 完成时间：${state.finishedAt||'未完成'}`,'','本次按用户指定以 DeepSeek-Flash 的判断作为校准标准，不进行逐词网页查证。模型标记为 uncertain 的词保留原有音标；所有原始批次返回、逐词结果与失败原因保存在配套 JSONL / 检查点中。','','## 待确认词头','',...uncertainWords.map(word=>`- ${word}${state.failed[word]?` — 请求失败：${state.failed[word]}`:state.completed[word]?.confidence?` — 模型信心：${state.completed[word].confidence}`:''}`),''];
await writeFile(reportPath,report.join('\n'),'utf8');
console.log(JSON.stringify({...meta,reportPath,outputPath,canonicalUpdated:true}));
