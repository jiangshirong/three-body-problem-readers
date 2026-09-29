// Independent check of the first-pass proposed IPA; no reader edits.
import {readFile,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDpapiSecretStore} from './reader-server.mjs';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const initial=JSON.parse(await readFile(path.join(project,'本地数据','safe-us-pronunciation-fill-state.json'),'utf8'));
const source=Object.values(initial.completed).flatMap(x=>x.items||[]).filter(x=>x.ipa&&['english','established-name'].includes(x.kind)&&x.confidence==='high');
const file=path.join(project,'本地数据','safe-us-pronunciation-confirmation.json');
let state={version:1,sourceHash:initial.hash,results:{},usage:{requests:0,input:0,output:0}};try{const old=JSON.parse(await readFile(file,'utf8'));if(old.sourceHash===initial.hash)state={...state,...old};}catch{}
const secret=(await createDpapiSecretStore(path.join(project,'本地数据','.reader-cache','reader-secrets.dpapi.json')).load()).deepseek;if(!secret)throw Error('未配置 DeepSeek');
const system=`请独立核验候选美式音标。只接受有可靠通行美式读法的英语词、已进入英语词汇的借词或英语世界稳定读法的专名。汉语拼音地名、人名、小说自造词、临时拼写、可能只按拼写猜读的复合词一律不接受。检查 IPA 的音节、重音、元音和美式卷舌；一个普通单词不能有两个主重音符号。不要因为上一轮标为 high 就同意。逐词返回 JSON：{"items":[{"word":"","accept":true,"ipa":"/正确音标/","reason":""}]}。不接受时 accept=false、ipa 空。`;
const jobs=[];for(let i=0;i<source.length;i+=10)jobs.push(source.slice(i,i+10));let cursor=0,queue=Promise.resolve();const save=()=>queue=queue.then(async()=>{const tmp=file+'.'+process.pid+'.tmp';await writeFile(tmp,JSON.stringify(state,null,2)+'\n');await rename(tmp,file);});
async function worker(){while(true){const i=cursor++;if(i>=jobs.length)return;const job=jobs[i].filter(x=>!state.results[x.word]);if(!job.length)continue;try{const r=await fetch('https://api.deepseek.com/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${secret}`},body:JSON.stringify({model:'deepseek-flash',thinking:{type:'disabled'},temperature:0,response_format:{type:'json_object'},max_tokens:1600,messages:[{role:'system',content:system},{role:'user',content:JSON.stringify({candidates:job})}]})});if(!r.ok)throw Error('HTTP '+r.status);const body=await r.json(),raw=body.choices?.[0]?.message?.content||'',items=JSON.parse(raw).items||[];for(const x of items)if(job.some(y=>y.word===x.word))state.results[x.word]={accept:x.accept===true,ipa:String(x.ipa||''),reason:String(x.reason||'').slice(0,160),raw};state.usage.requests++;state.usage.input+=body.usage?.prompt_tokens||0;state.usage.output+=body.usage?.completion_tokens||0;await save();}catch(e){console.log('核验批次失败',i,String(e.message||e));}}}
await Promise.all(Array.from({length:3},worker));await queue;console.log(JSON.stringify({candidates:source.length,returned:Object.keys(state.results).length,agreed:source.filter(x=>state.results[x.word]?.accept&&state.results[x.word]?.ipa===x.ipa).length,usage:state.usage}));
