// Preview or apply only the independently confirmed family splits.
import {readFile,writeFile,rename,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const reader=path.join(project,'outputs','three-body-reader.html');
const first=JSON.parse(await readFile(path.join(project,'本地数据','modern-family-review-state.json'),'utf8'));
const second=JSON.parse(await readFile(path.join(project,'本地数据','modern-family-confirmation-state.json'),'utf8'));
if(first.hash!==second.sourceHash)throw Error('两轮词族审查不是同一批数据');
const original=await readFile(reader,'utf8');
function block(id){const at=original.indexOf(`id="${id}"`),start=original.indexOf('>',at)+1;return JSON.parse(original.slice(start,original.indexOf('</script>',start)));}
function embed(html,id,value){const at=html.indexOf(`id="${id}"`),start=html.indexOf('>',at)+1,end=html.indexOf('</script>',start);return html.slice(0,start)+JSON.stringify(value).replace(/</g,'\\u003c')+html.slice(end);}
const oldFamilies=block('wordFamiliesData'),oldFrequency=block('wordFrequencyData'),book=block('bookData');
// Both model passes were over-eager on some transparent derivatives (for
// example add/addition). Apply only the independently inspected clear cases;
// retain every other proposal for the report and later review.
const safeSplits=new Set(['eras','harm','have','list','past','policies','position','praise','star','generated']);
const accepted=new Map(Object.values(second.completed).filter(x=>x.agree&&safeSplits.has(x.id)).map(x=>[x.id,x.second]));
const count=w=>oldFrequency.forms[w]?.count||0;
const choose=(old,cluster)=>cluster.includes(old)?old:[...cluster].sort((a,b)=>a.length-b.length||count(b)-count(a)||a.localeCompare(b))[0];
const forms={},groups={};
for(const [old,members] of Object.entries(oldFamilies.groups)){
  const clusters=accepted.get(old);
  if(!clusters){groups[old]=[...members];for(const form of members)forms[form]=old;continue;}
  const flat=clusters.flat();if(flat.length!==members.length||new Set(flat).size!==flat.length||flat.some(w=>!members.includes(w)))throw Error('词族裁定不完整：'+old);
  for(const cluster of clusters){const id=choose(old,cluster);if(groups[id])throw Error('新族头碰撞：'+id);groups[id]=[...cluster].sort();for(const form of cluster)forms[form]=id;}
}
if(Object.keys(forms).length!==Object.keys(oldFamilies.forms).length)throw Error('词形总数变化');
const frequencyForms=Object.fromEntries(Object.entries(oldFrequency.forms).map(([w,item])=>[w,{...item,familyId:forms[w]}]));
const familyCounts=Object.fromEntries(Object.entries(groups).map(([id,members])=>[id,members.reduce((n,w)=>n+count(w),0)]));
const strictToFamily=new Map();for(const [w,item] of Object.entries(frequencyForms)){const was=strictToFamily.get(item.strictId);if(was&&was!==item.familyId)throw Error('严格词形组被拆开：'+item.strictId);strictToFamily.set(item.strictId,item.familyId);if(oldFrequency.strictCounts[item.strictId]>familyCounts[item.familyId])throw Error('词形次数超词族：'+w);}
const total=Object.values(oldFrequency.forms).reduce((n,x)=>n+x.count,0);if(Object.values(familyCounts).reduce((a,b)=>a+b,0)!==total||total!==118694)throw Error('词频总数变化');
const updatedFamilies={...oldFamilies,model:'deepseek-flash (modern-derivation, two-pass confirmed)',generatedAt:new Date().toISOString(),forms,groups};
const updatedFrequency={...oldFrequency,forms:frequencyForms,familyCounts,summary:{...oldFrequency.summary,broadFamilies:Object.keys(groups).length}};
const marksFile=path.join(project,'本地数据','.reader-cache','learning-marks.json');
const marks=JSON.parse(await readFile(marksFile,'utf8'));
const normalize=w=>String(w||'').trim().toLowerCase().replaceAll('’',"'");
const migrate=(old,origin)=>{
  const members=oldFamilies.groups[old];if(!members)return forms[old]||old;
  const clicked=normalize(origin?.word);const source=members.includes(clicked)?clicked:members.includes(old)?old:members[0];return forms[source]||old;
};
const next={...marks,learning:[...new Set((marks.learning||[]).map(id=>migrate(id,marks.origins?.learning?.[id])))],
  phrases:(marks.phrases||[]).map(p=>({...p,words:p.words.map(id=>migrate(id))})),origins:{...marks.origins}};
next.origins.learning={};for(const [old,origin] of Object.entries(marks.origins?.learning||{})){const key=migrate(old,origin),existing=next.origins.learning[key];if(!existing||Date.parse(origin.at||'9999')<Date.parse(existing.at||'9999'))next.origins.learning[key]=origin;}
const phraseKey=p=>`${p.allowGaps?'g':'c'}:${p.words.join('\u001f')}`;
next.origins.phrases={};for(const p of marks.phrases||[]){const oldKey=phraseKey(p),rekey=phraseKey({...p,words:p.words.map(id=>migrate(id))}),origin=marks.origins?.phrases?.[oldKey];if(origin&&!next.origins.phrases[rekey])next.origins.phrases[rekey]=origin;}
const phraseTokens=book.map(ch=>String(ch.content).replace(/<[^>]*>/g,' ').match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)?.map(w=>normalize(w))||[]);
// A phrase marked under the old broad family keeps the actual words the reader
// matched, rather than inheriting an arbitrary old family head after a split.
const matchedSurface=p=>{for(const words of phraseTokens){const old=words.map(w=>oldFamilies.forms[w]||w);for(let i=0;i<old.length;i++){let cursor=i,found=true;const surface=[];for(const key of p.words){if(p.allowGaps){while(cursor<old.length&&old[cursor]!==key)cursor++;}else if(old[cursor]!==key){found=false;break;}if(cursor>=old.length){found=false;break;}surface.push(words[cursor]);cursor++;}if(found)return surface;}}return null;};
next.phrases=(marks.phrases||[]).map(p=>{const clicked=String(marks.origins?.phrases?.[phraseKey(p)]?.word||'').match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)?.map(normalize)||[];const exact=clicked.length===p.words.length&&clicked.every((w,i)=>(oldFamilies.forms[w]||w)===p.words[i])?clicked:null;const surface=exact||matchedSurface(p);return {...p,words:surface?surface.map(w=>forms[w]||w):p.words.map(id=>migrate(id))};});
next.origins.phrases={};for(let i=0;i<(marks.phrases||[]).length;i++){const origin=marks.origins?.phrases?.[phraseKey(marks.phrases[i])],key=phraseKey(next.phrases[i]);if(origin&&!next.origins.phrases[key])next.origins.phrases[key]=origin;}
const phraseExists=(p,map)=>phraseTokens.some(words=>{const familyWords=words.map(w=>map[w]||w);for(let i=0;i<familyWords.length;i++){let cursor=i,found=true;for(const key of p.words){if(p.allowGaps){while(cursor<familyWords.length&&familyWords[cursor]!==key)cursor++;}else if(familyWords[cursor]!==key){found=false;break;}if(cursor>=familyWords.length){found=false;break;}cursor++;}if(found)return true;}return false;});
const beforeUnmatched=(marks.phrases||[]).map((p,i)=>phraseExists(p,oldFamilies.forms)?null:i).filter(x=>x!==null);
const afterUnmatched=next.phrases.map((p,i)=>phraseExists(p,forms)?null:i).filter(x=>x!==null);
const newlyUnmatched=afterUnmatched.filter(i=>!beforeUnmatched.includes(i));
const changed=Object.keys(forms).filter(w=>forms[w]!==oldFamilies.forms[w]);
const markedSplits=(marks.learning||[]).filter(id=>accepted.has(id)).map(id=>({old:id,new:migrate(id,marks.origins?.learning?.[id]),origin:marks.origins?.learning?.[id]?.word||null}));
const summary={beforeFamilies:Object.keys(oldFamilies.groups).length,afterFamilies:Object.keys(groups).length,confirmedSplits:accepted.size,changedForms:changed.length,markedSplits:markedSplits.length,learningBefore:marks.learning.length,learningAfter:next.learning.length,phrases:next.phrases.length,beforeUnmatched:beforeUnmatched.length,afterUnmatched:afterUnmatched.length,newlyUnmatched:newlyUnmatched.length,total};
console.log(JSON.stringify(summary));
if(newlyUnmatched.length)console.log('新失配词组：'+newlyUnmatched.slice(0,15).map(i=>phraseKey(next.phrases[i])).join(' | '));
if(process.argv.includes('--apply')){
  if(newlyUnmatched.length)throw Error('词组出现新的匹配失效，拒绝应用');
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  const htmlBackup=path.join(project,'本地数据',`three-body-reader-before-modern-family-${stamp}.html`);
  const marksBackup=path.join(project,'本地数据',`learning-marks-before-modern-family-${stamp}.json`);
  await copyFile(reader,htmlBackup);await copyFile(marksFile,marksBackup);
  let html=embed(original,'wordFamiliesData',updatedFamilies);html=embed(html,'wordFrequencyData',updatedFrequency);
  const tmp=reader+'.'+process.pid+'.tmp';await writeFile(tmp,html);await rename(tmp,reader);
  try{const status=await (await fetch('http://127.0.0.1:8766/api/status')).json();if(status.instanceId!==project)throw Error('本机阅读器服务身份不符');const response=await fetch('http://127.0.0.1:8766/api/learning-marks',{method:'POST',headers:{'Content-Type':'application/json','X-Reader-Token':status.csrf},body:JSON.stringify(next)});if(!response.ok)throw Error('标记迁移 HTTP '+response.status);}catch(error){await copyFile(htmlBackup,reader);throw error;}
  const report=['# 现代派生词族修缮报告','',`- ${JSON.stringify(summary)}`,'','## 标记迁移','',...markedSplits.map(x=>`- ${x.old} → ${x.new}（首次点击：${x.origin||'无记录，按旧族头'}）`),'','## 修改词形','',...changed.map(w=>`- ${w}: ${oldFamilies.forms[w]} → ${forms[w]}`),'','## 待复核','',...Object.values(second.completed).filter(x=>!x.agree).map(x=>`- ${x.id}：两轮裁定不一致，保持原组`),...Object.values(second.completed).filter(x=>x.agree&&!safeSplits.has(x.id)).map(x=>`- ${x.id}：两轮一致但现代派生边界仍存疑，暂缓应用`),...Object.values(first.completed).flatMap(x=>x.missing||[]).map(x=>`- ${x}：第一轮结果不完整，保持原组`)];
  await writeFile(path.join(project,'outputs','现代派生词族修缮报告.md'),report.join('\n')+'\n');
  console.log('已应用；备份：'+htmlBackup+'；'+marksBackup);
}
