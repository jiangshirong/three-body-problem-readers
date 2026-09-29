import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDpapiSecretStore} from './reader-server.mjs';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const canonicalPath=path.join(project,'outputs','us-pronunciations-v2.json');
const statePath=path.join(project,'本地数据','deepseek-us-pronunciation-calibration-state.json');
const calibrationPath=path.join(project,'outputs','deepseek-us-pronunciation-calibration.jsonl');
const reportPath=path.join(project,'outputs','DeepSeek美式音标全量校准报告.md');
const canonical=JSON.parse(await readFile(canonicalPath,'utf8'));
const state=JSON.parse(await readFile(statePath,'utf8'));
const words=Object.keys(state.completed||{}).filter(word=>state.completed[word].status==='uncertain');
if(!words.length){
  if(!state.uncertainFollowup){console.log('没有待做尽力判断的词头');process.exit(0);}
  const total=Object.keys(canonical.entries).length;
  canonical.calibration={...(canonical.calibration||{}),totalWords:total,calibratedWords:total,uncertainWords:0,failedWords:Object.keys(state.failed||{}).length,followupBestEffortWords:state.uncertainFollowup.calibrated,usage:state.usage,finishedAt:state.uncertainFollowup.finishedAt};
  const embed=JSON.stringify(canonical).replace(/</g,'\\u003c');const htmlPath=path.join(project,'outputs','three-body-reader.html');const html=await readFile(htmlPath,'utf8');const pattern=/(<script id="americanPronunciationData" type="application\/json">)[\s\S]*?(<\/script>)/;const next=html.replace(pattern,`$1${embed}$2`);if(next===html)throw new Error('找不到网页音标数据块');await writeFile(htmlPath,next,'utf8');await writeFile(canonicalPath,`${JSON.stringify(canonical,null,2)}\n`,'utf8');
  console.log(JSON.stringify({finalized:true,totalWords:total,metadata:canonical.calibration}));process.exit(0);
}
const input=words.map(word=>({word,previousCandidates:canonical.entries[word]?.map(x=>x.ipa)||[]}));
const store=createDpapiSecretStore(path.join(project,'本地数据','.reader-cache','reader-secrets.dpapi.json'));
const secret=(await store.load()).deepseek;if(!secret)throw new Error('没有已保存的 DeepSeek API Key');
const response=await fetch('https://api.deepseek.com/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${secret}`},body:JSON.stringify({model:'deepseek-flash',thinking:{type:'disabled'},temperature:0,response_format:{type:'json_object'},max_tokens:5000,messages:[
  {role:'system',content:'你是英语《三体》阅读器音标的最终校准者。上一轮你对以下专名/罕见词标记了 uncertain，但用户明确选择完全以 DeepSeek-Flash 判断为准。现在请尽最大努力，给每个词一个现代通用美式英语读者最可能采用的读法；中文拼音/人名按英文读者可能的英语化读法处理，不必追求汉语母语发音。不要因低置信度留空。只保留常见读法，不给英式音；词性只有在同形词不同词性确实改变读音时才标注。用 /.../ 包裹宽式 IPA，不加音节点。严格输出 JSON：{"items":[{"word":"","pronunciations":[{"ipa":"/.../","pos":"proper noun|noun|verb|adjective|adverb|other|unknown","rank":1}],"confidence":"low|medium|high"}]}。'} ,
  {role:'user',content:JSON.stringify({task:'best-effort-final-American-English-pronunciation',words:input})}
]})});
if(!response.ok)throw new Error(`DeepSeek HTTP ${response.status}: ${(await response.text()).slice(0,200)}`);
const body=await response.json(),parsed=JSON.parse(body.choices?.[0]?.message?.content||'{}');
const posMap={noun:'n',verb:'v',adjective:'adj',adverb:'adv',proper:'name','proper noun':'name',other:'',unknown:''};
const results=new Map();
for(const row of parsed.items||[]){if(!words.includes(row.word)||!Array.isArray(row.pronunciations))continue;const list=[];for(const x of row.pronunciations){let ipa=String(x.ipa||'').trim().replace(/^\/+|\/+$/g,'').replace(/\s*\.\s*/g,'');if(!ipa||/[\/\r\n]/.test(ipa))continue;list.push({ipa:`/${ipa}/`,pos:posMap[String(x.pos||'').toLowerCase()]??'',rank:Math.max(1,Number(x.rank)||list.length+1)});}if(list.length)results.set(row.word,{word:row.word,status:'calibrated-best-effort',confidence:row.confidence||'low',pronunciations:list});}
for(const word of words){const result=results.get(word);if(result){const distinctPos=new Set(result.pronunciations.map(x=>x.pos).filter(Boolean));if(distinctPos.size<2||result.pronunciations.length<2)for(const x of result.pronunciations)x.pos='';state.completed[word]=result;canonical.entries[word]=result.pronunciations.map(x=>({headword:word,ipa:x.ipa,pos:x.pos,posLabel:({'n':'名','v':'动','adj':'形','adv':'副','name':'专名'}[x.pos]||''),accent:'General-American',tags:['General-American'],source:'DeepSeek-Flash calibration',sources:[],originalTags:[],origin:'deepseek-flash-calibrated',reviewVersion:'deepseek-flash-uncertain-followup-1',sourceRevision:'',rawPronunciation:x.ipa,conversionVersion:'learner-us-1',rank:x.rank}));}}
state.usage.requests++;state.usage.promptTokens+=Number(body.usage?.prompt_tokens||0);state.usage.completionTokens+=Number(body.usage?.completion_tokens||0);state.uncertainFollowup={requested:words.length,calibrated:results.size,raw:body.choices?.[0]?.message?.content||'',usage:body.usage||{},finishedAt:new Date().toISOString()};
await writeFile(statePath,`${JSON.stringify(state,null,2)}\n`,'utf8');
const allRows=Object.keys(state.completed).sort((a,b)=>a.localeCompare(b)).map(word=>JSON.stringify(state.completed[word]));
await writeFile(calibrationPath,`${allRows.join('\n')}\n`,'utf8');
const embedded=JSON.stringify({...canonical,source:'DeepSeek-Flash calibration'}).replace(/</g,'\\u003c');
const htmlPath=path.join(project,'outputs','three-body-reader.html'),html=await readFile(htmlPath,'utf8');
const pattern=/(<script id="americanPronunciationData" type="application\/json">)[\s\S]*?(<\/script>)/;
const next=html.replace(pattern,`$1${embedded}$2`);if(next===html)throw new Error('找不到网页音标数据块');
await writeFile(htmlPath,next,'utf8');
await writeFile(canonicalPath,`${JSON.stringify(canonical,null,2)}\n`,'utf8');
const uncertain=[...new Set(words.filter(word=>!results.has(word)))];
const report=`# DeepSeek-Flash 美式音标全量校准报告\n\n- 模型：deepseek-flash\n- 词头总数：${Object.keys(canonical.entries).length}\n- 已校准：${Object.values(state.completed).filter(x=>x.status!=='uncertain').length}\n- 首轮不确定、二轮尽力判断：${results.size}\n- 仍无法给出读音：${uncertain.length}\n- API 请求：${state.usage.requests}\n- Token：输入 ${state.usage.promptTokens}，输出 ${state.usage.completionTokens}\n\n本次完全按用户指定以 DeepSeek-Flash 判断为准，不逐词查外部词典。\n\n## 仍未能判断的词头\n\n${uncertain.map(x=>`- ${x}`).join('\n')||'无'}\n`;
await writeFile(reportPath,report,'utf8');
console.log(JSON.stringify({requested:words.length,calibrated:results.size,stillUncertain:uncertain,followupUsage:body.usage||{},totalWords:Object.keys(canonical.entries).length}));
