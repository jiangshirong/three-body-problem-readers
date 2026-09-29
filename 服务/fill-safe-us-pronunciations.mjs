// Classify missing in-book forms and add only high-confidence conventional US IPA.
import {createHash} from 'node:crypto';
import {readFile,writeFile,rename,copyFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDpapiSecretStore} from './reader-server.mjs';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const reader=path.join(project,'outputs','three-body-reader.html');
const canonical=path.join(project,'outputs','us-pronunciations-v2.json');
const stateFile=path.join(project,'本地数据','safe-us-pronunciation-fill-state.json');
const reportFile=path.join(project,'outputs','缺音标分类与补全报告.md');
const html=await readFile(reader,'utf8');
const read=id=>{const at=html.indexOf(`id="${id}"`),start=html.indexOf('>',at)+1;return JSON.parse(html.slice(start,html.indexOf('</script>',start)));};
const frequency=read('wordFrequencyData'),embedded=read('americanPronunciationData'),dictionary=read('dictionaryData');
const words=Object.keys(frequency.forms).filter(w=>!embedded.entries[w]?.length).sort((a,b)=>frequency.forms[b].count-frequency.forms[a].count||a.localeCompare(b));
const hash=createHash('sha256').update(JSON.stringify(words)).digest('hex');
const jobs=[];for(let i=0;i<words.length;i+=15)jobs.push(words.slice(i,i+15));
console.log('缺音标',words.length,'分批',jobs.length);
let state={version:1,hash,completed:{},failed:{},usage:{requests:0,input:0,output:0}};
try{const old=JSON.parse(await readFile(stateFile,'utf8'));if(old.hash===hash)state={...state,...old};}catch{}
const apply=process.argv.includes('--apply');
const dry=process.argv.includes('--dry-run');
const system=`你是英语小说的美式音标编辑。对输入词形逐项分类。仅普通现代英语词、或有稳定通行英语读法的人名地名，可给现代通用美式宽式 IPA。小说自造词（例如 Trisolaran、sophon）、汉语拼音或音译人名、临时拼合的连字符短语、罗马数字、缩写、扫描/OCR 碎片，不要编造音标。复合词只有已词汇化且有稳定美式读法才可补。不能确定读法时留空。已有音标无需处理。格式采用 /.../、ˈ ˌ ː ɜːr 等项目学习词典格式，不写英式非卷舌发音。严格返回 JSON：{"items":[{"word":"原词形","kind":"english|established-name|fiction|transliteration|compound|abbreviation|fragment|uncertain","confidence":"high|medium|low","ipa":"/音标/或空字符串","reason":"简短原因"}]}。只有 english 或 established-name 且 high 才可以填写 ipa；其他类别 ipa 必须为空。每个词形恰好一项。`;
function validate(job,raw){const items=JSON.parse(raw)?.items;if(!Array.isArray(items))throw Error('缺少 items');const got=new Map();for(const x of items){if(!job.includes(x?.word)||got.has(x.word))continue;const kind=String(x.kind||''),confidence=String(x.confidence||''),ipa=String(x.ipa||'').trim();if(!['english','established-name','fiction','transliteration','compound','abbreviation','fragment','uncertain'].includes(kind)||!['high','medium','low'].includes(confidence))continue;if(ipa&&(!/^\/[^/\r\n]{2,80}\/$/u.test(ipa)||!['english','established-name'].includes(kind)||confidence!=='high'))continue;got.set(x.word,{word:x.word,kind,confidence,ipa,reason:String(x.reason||'').slice(0,180)});}return got;}
const writeState=async()=>{await mkdir(path.dirname(stateFile),{recursive:true});const tmp=stateFile+'.'+process.pid+'.tmp';await writeFile(tmp,JSON.stringify(state,null,2)+'\n');await rename(tmp,stateFile);};
if(!dry&&!apply){const secret=(await createDpapiSecretStore(path.join(project,'本地数据','.reader-cache','reader-secrets.dpapi.json')).load()).deepseek;if(!secret)throw Error('未配置 DeepSeek');let cursor=0,done=0,queue=Promise.resolve();const save=()=>queue=queue.then(writeState);
  async function worker(){while(true){const i=cursor++;if(i>=jobs.length)return;const previous=state.completed[i];if(previous&&!previous.missing?.length){done++;continue;}const job=previous?.missing?.length?previous.missing:jobs[i];try{const response=await fetch('https://api.deepseek.com/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${secret}`},body:JSON.stringify({model:'deepseek-flash',thinking:{type:'disabled'},temperature:0,response_format:{type:'json_object'},max_tokens:2500,messages:[{role:'system',content:system},{role:'user',content:JSON.stringify({words:job.map(w=>({word:w,count:frequency.forms[w].count,dictionary:String(dictionary.entries[w]?.translation||'').slice(0,80)}))})}]})});if(!response.ok)throw Error('HTTP '+response.status+' '+(await response.text()).slice(0,160));const body=await response.json(),raw=body.choices?.[0]?.message?.content||'',got=validate(job,raw);state.completed[i]={items:[...(previous?.items||[]),...got.values()],missing:job.filter(w=>!got.has(w)),raw,at:new Date().toISOString()};state.usage.requests++;state.usage.input+=body.usage?.prompt_tokens||0;state.usage.output+=body.usage?.completion_tokens||0;delete state.failed[i];}catch(e){state.failed[i]={error:String(e?.message||e),at:new Date().toISOString()};}done++;await save();if(done%5===0||done===jobs.length)console.log(`音标分类 ${done}/${jobs.length}，失败 ${Object.keys(state.failed).length}`);}}
  await Promise.all(Array.from({length:6},worker));await queue;
}
const results=new Map(Object.values(state.completed).flatMap(x=>x.items||[]).map(x=>[x.word,x]));
const confirmation=JSON.parse(await readFile(path.join(project,'本地数据','safe-us-pronunciation-confirmation.json'),'utf8'));
if(confirmation.sourceHash!==hash)throw Error('第二轮核验与当前缺项清单不匹配');
const candidates=[...results.values()].filter(x=>x.ipa&&['english','established-name'].includes(x.kind)&&x.confidence==='high'&&confirmation.results[x.word]?.accept===true&&confirmation.results[x.word]?.ipa===x.ipa&&(x.ipa.match(/ˈ/g)||[]).length<=1&&!/[ɒ]/u.test(x.ipa));
const excluded=words.filter(w=>!candidates.some(x=>x.word===w));
console.log(JSON.stringify({classified:results.size,candidates:candidates.length,remaining:excluded.length,incomplete:Object.values(state.completed).flatMap(x=>x.missing||[]).length,failed:Object.keys(state.failed).length,usage:state.usage}));
if(dry||!apply)process.exit(0);
if(Object.keys(state.failed).length)throw Error('有失败批次，不能应用');
const source=JSON.parse(await readFile(canonical,'utf8'));
for(const item of candidates){if(embedded.entries[item.word]?.length||source.entries[item.word]?.length)throw Error('目标词已存在：'+item.word);const row={headword:item.word,ipa:item.ipa,pos:'',posLabel:'',accent:'General-American',tags:['General-American'],source:'DeepSeek-Flash calibration',sources:[],originalTags:[],origin:'deepseek-flash-calibrated',reviewVersion:'safe-missing-us-1',sourceRevision:'',rawPronunciation:item.ipa,conversionVersion:'learner-us-1',rank:1};embedded.entries[item.word]=[row];source.entries[item.word]=[row];}
const afterMissing=Object.keys(frequency.forms).filter(w=>!embedded.entries[w]?.length);if(afterMissing.length!==words.length-candidates.length)throw Error('覆盖率核对失败');
const stamp=new Date().toISOString().replace(/[:.]/g,'-');await copyFile(reader,path.join(project,'本地数据',`reader-before-safe-ipa-${stamp}.html`));await copyFile(canonical,path.join(project,'本地数据',`us-pronunciations-before-safe-fill-${stamp}.json`));
const at=html.indexOf('id="americanPronunciationData"'),start=html.indexOf('>',at)+1,end=html.indexOf('</script>',start);const next=html.slice(0,start)+JSON.stringify(embedded).replace(/</g,'\\u003c')+html.slice(end);let tmp=reader+'.'+process.pid+'.tmp';await writeFile(tmp,next);await rename(tmp,reader);tmp=canonical+'.'+process.pid+'.tmp';await writeFile(tmp,JSON.stringify(source,null,2)+'\n');await rename(tmp,canonical);
const byKind=Object.groupBy([...results.values()],x=>x.kind);const report=['# 缺音标分类与补全报告','',`原缺项 ${words.length}，新补 ${candidates.length}，仍缺 ${afterMissing.length}。仅补高把握的常规英语词和有通行读法的专名；小说术语、音译名与文本碎片不拟写音标。`,'',...Object.entries(byKind).map(([kind,list])=>`- ${kind}: ${list.length}`),'','## 新补音标','',...candidates.map(x=>`- ${x.word} ${x.ipa}（${x.kind}；${x.reason}）`),'','## 保持缺项','',...excluded.map(w=>{const x=results.get(w);return `- ${w}（${x?.kind||'未分类'}；${x?.reason||'未得到可靠结果'}）`;})];await writeFile(reportFile,report.join('\n')+'\n');console.log('已应用，剩余 '+afterMissing.length);
