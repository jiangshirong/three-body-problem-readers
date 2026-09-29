// Review suspicious existing broad families without changing reader data.
// The saved verdicts are later applied only after a complete, validated preview.
import {createHash} from 'node:crypto';
import {readFile, writeFile, rename, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDpapiSecretStore} from './reader-server.mjs';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const html=await readFile(path.join(project,'outputs','three-body-reader.html'),'utf8');
const block=id=>{const at=html.indexOf(`id="${id}"`),start=html.indexOf('>',at)+1;return JSON.parse(html.slice(start,html.indexOf('</script>',start)));};
const families=block('wordFamiliesData'),frequency=block('wordFrequencyData');
const stateFile=path.join(project,'本地数据','modern-family-review-state.json');
const only=process.argv.find(x=>x.startsWith('--only='))?.slice(7);
const dry=process.argv.includes('--dry-run');
const suffixes=['s','es','ed','d','ing','ly','ness','ment','er','est','ers','ion','tion','sion','ation','able','ible','ive','ity','ty','al','ful','less','ize','ise','ify','ous','ic','ist','ism','ance','ence','ancy','ency','ant','ent','ary','ory','age','dom','hood','ship','ward','wise','en','ish'];
const directlyRelated=(a,b)=>{
  const [short,long]=[a,b].sort((x,y)=>x.length-y.length);
  if(suffixes.some(s=>long===short+s||long===short.replace(/e$/,'')+s||long===short.replace(/y$/,'i')+s))return true;
  return ['un','in','im','ir','il','dis','non','re','mis'].some(p=>long===p+short);
};
const groups=[];
for(const [id,forms] of Object.entries(families.groups)){
  const strict=[...new Set(forms.map(w=>frequency.forms[w]?.strictId||w))];
  if(strict.length<2)continue;
  let edges=0;
  for(let i=0;i<strict.length;i++)for(let j=i+1;j<strict.length;j++)if(directlyRelated(strict[i],strict[j]))edges++;
  if(edges>=strict.length-1)continue;
  if(only&&!(id.includes(only)||forms.some(w=>w.includes(only))))continue;
  groups.push({id,forms,strict});
}
groups.sort((a,b)=>a.id.localeCompare(b.id));
const hash=createHash('sha256').update(JSON.stringify(groups)).digest('hex');
const jobs=[];for(let i=0;i<groups.length;i+=4)jobs.push(groups.slice(i,i+4));
console.log(`可疑词族 ${groups.length} 组，${jobs.length} 批。`);
if(dry){console.log(JSON.stringify(groups.slice(0,12)));process.exit(0);}
const secret=(await createDpapiSecretStore(path.join(project,'本地数据','.reader-cache','reader-secrets.dpapi.json')).load()).deepseek;
if(!secret)throw Error('尚未配置 DeepSeek 密钥');
let state={version:1,hash,model:'deepseek-flash',completed:{},failed:{},usage:{requests:0,input:0,output:0}};
try{const old=JSON.parse(await readFile(stateFile,'utf8'));if(old.hash===hash)state={...state,...old};}catch{}
const system=`你在审查英语小说的词族。词族只含现代英语使用者能够识别的屈折变化和真实派生关系（如 create/creation/creative）。只有遥远共同词源，或仅仅拼写相似，不算同族。不要为了减少词族数量而硬合并。小说中的复合词只在明显由该词直接构成时才合并。输入按现有词族给出；请把每个词族的全部词形划分为一个或多个新词族。严格形态组 strict 中的成员必须在同一个新族中，不能拆开。不要创造或漏掉词形。返回 JSON：{"groups":[{"id":"旧族头","clusters":[["词形1","词形2"],["词形3"]]}]}。无法可靠裁定时，原组不拆。`;
let cursor=0,done=0,saveQueue=Promise.resolve();
const save=()=>{saveQueue=saveQueue.then(async()=>{await mkdir(path.dirname(stateFile),{recursive:true});const tmp=stateFile+'.'+process.pid+'.tmp';await writeFile(tmp,JSON.stringify(state,null,2)+'\n');await rename(tmp,stateFile);});return saveQueue;};
function validate(job,raw){
  const data=JSON.parse(raw),rows=data?.groups;if(!Array.isArray(rows))throw Error('缺少 groups');
  const got=new Map();
  for(const row of rows){
    const source=job.find(g=>g.id===row?.id);if(!source||got.has(row.id)||!Array.isArray(row.clusters))continue;
    const flat=row.clusters.flat();
    if(row.clusters.some(c=>!Array.isArray(c)||!c.length)||flat.length!==source.forms.length||new Set(flat).size!==flat.length||flat.some(w=>!source.forms.includes(w)))continue;
    const clusterOf=new Map(row.clusters.flatMap((c,i)=>c.map(w=>[w,i])));
    const byStrict=new Map();let splitStrict=false;for(const form of source.forms){const key=frequency.forms[form]?.strictId||form;const index=clusterOf.get(form);if(byStrict.has(key)&&byStrict.get(key)!==index)splitStrict=true;byStrict.set(key,index);}
    if(splitStrict)continue;
    got.set(row.id,row.clusters.map(c=>[...c].sort()));
  }
  return got;
}
async function worker(){while(true){const i=cursor++;if(i>=jobs.length)return;const job=jobs[i];if(state.completed[i]){done++;continue;}
  try{
    const payload=job.map(group=>({...group,strictGroups:Object.groupBy(group.forms,w=>frequency.forms[w]?.strictId||w)}));
    const response=await fetch('https://api.deepseek.com/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${secret}`},body:JSON.stringify({model:'deepseek-flash',thinking:{type:'disabled'},temperature:0,response_format:{type:'json_object'},max_tokens:5000,messages:[{role:'system',content:system},{role:'user',content:JSON.stringify({groups:payload})}]})});
    if(!response.ok)throw Error('HTTP '+response.status+' '+(await response.text()).slice(0,200));
    const body=await response.json(),raw=body.choices?.[0]?.message?.content||'';
    state.usage.requests++;state.usage.input+=body.usage?.prompt_tokens||0;state.usage.output+=body.usage?.completion_tokens||0;
    const valid=validate(job,raw);state.completed[i]={raw,clusters:Object.fromEntries(valid),missing:job.filter(g=>!valid.has(g.id)).map(g=>g.id),at:new Date().toISOString()};
    delete state.failed[i];
  }catch(error){state.failed[i]={error:String(error?.message||error),at:new Date().toISOString()};}
  done++;await save();if(done%10===0||done===jobs.length)console.log(`词族审查 ${done}/${jobs.length}，失败 ${Object.keys(state.failed).length}`);
}}
await Promise.all(Array.from({length:8},worker));await saveQueue;
console.log(JSON.stringify({jobs:jobs.length,completed:Object.keys(state.completed).length,failed:Object.keys(state.failed).length,usage:state.usage}));
