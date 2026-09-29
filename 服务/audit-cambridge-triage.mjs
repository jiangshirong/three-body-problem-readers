import {readFile, writeFile, mkdir, rename} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const allWords=process.env.CAMBRIDGE_AUDIT_ALL==='1';
const uncertainOnly=process.env.CAMBRIDGE_AUDIT_UNCERTAIN==='1';
const triagePath=path.join(project,'outputs','deepseek-pronunciation-triage.jsonl');
const canonicalPath=path.join(project,'outputs','us-pronunciations-v2.json');
const outputPath=path.join(project,'outputs',allWords?'cambridge-us-full-audit.jsonl':uncertainOnly?'cambridge-us-uncertain-audit.jsonl':'cambridge-us-triage-audit.jsonl');
const statePath=path.join(project,'本地数据',allWords?'cambridge-us-full-audit-state.json':uncertainOnly?'cambridge-us-uncertain-audit-state.json':'cambridge-us-triage-audit-state.json');
let words;
if(allWords){const canonical=JSON.parse(await readFile(canonicalPath,'utf8'));words=Object.keys(canonical.entries).sort((a,b)=>a.localeCompare(b));}
else{const data=await readFile(triagePath,'utf8');const wanted=uncertainOnly?'uncertain':'review';words=data.trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)).filter(row=>row.verdict===wanted).map(row=>row.word);}
let state={version:1,completed:{},startedAt:new Date().toISOString()};
try{state={...state,...JSON.parse(await readFile(statePath,'utf8'))};}catch{}
state.completed||={};
if(uncertainOnly){try{const existing=JSON.parse(await readFile(path.join(project,'本地数据','cambridge-us-full-audit-state.json'),'utf8'));for(const word of words)if(existing.completed?.[word])state.completed[word]=existing.completed[word];}catch{}}
const pending=words.filter(word=>!state.completed[word]||(process.env.AUDIT_RETRY_MISSING==='1'&&['us-block-without-ipa','request-error'].includes(state.completed[word].status)));
const concurrency=Math.max(1,Math.min(10,Number(process.env.CAMBRIDGE_CONCURRENCY||4))),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function normalizeSlug(word){return word.trim().replace(/\s+/g,'-');}
function extractIpa(html){
  const found=[];const opener=/<span\b[^>]*class="[^"]*\bipa\b[^"]*"[^>]*>/g;let match;
  while((match=opener.exec(html))){let cursor=opener.lastIndex,depth=1;
    while(depth>0&&cursor<html.length){const nextOpen=html.indexOf('<span',cursor),nextClose=html.indexOf('</span>',cursor);if(nextClose<0)break;if(nextOpen>=0&&nextOpen<nextClose){depth++;cursor=html.indexOf('>',nextOpen)+1;}else{depth--;if(depth===0){let value=html.slice(opener.lastIndex,nextClose).replace(/<[^>]*>/g,'').replaceAll('&nbsp;',' ').replaceAll('&amp;','&').trim();if(value)found.push(value);cursor=nextClose+7;break;}cursor=nextClose+7;}}
    opener.lastIndex=cursor;
  }
  return found;
}
async function fetchEntry(word){
  const slug=normalizeSlug(word);
  const url=`https://dictionary.cambridge.org/us/pronunciation/english/${encodeURIComponent(slug)}`;
  for(let attempt=0;attempt<4;attempt++)try{
    const response=await fetch(url,{headers:{'user-agent':'Mozilla/5.0 (compatible; local pronunciation audit)'},signal:AbortSignal.timeout(30000)});
    if(response.status===404)return {word,url,status:'not-found',ipa:[]};
    if(response.status===429||response.status>=500){await delay(500*(attempt+1));continue;}
    if(!response.ok)return {word,url,status:`http-${response.status}`,ipa:[]};
    const html=await response.text();
    const start=html.indexOf('data-pron-region="US"');
    if(start<0)return {word,url,status:'no-us-region',ipa:[]};
    const possibleEnds=[html.indexOf('</div></div>',start),html.indexOf('<div class="region-block',start+10),html.indexOf('<div class="lmt-20',start)].filter(index=>index>start);
    const end=possibleEnds.length?Math.min(...possibleEnds):Math.min(html.length,start+12000);
    const block=html.slice(start,end);
    const phonetics=extractIpa(block);
    const types=[...block.matchAll(/data-type="(strong|weak)"/g)].map(match=>match[1]);
    const ipa=[...new Map(phonetics.map((value,index)=>[value,{ipa:`/${value}/`,type:types[index]||''}])).values()];
    return {word,url,status:ipa.length?'source-found':'us-block-without-ipa',ipa};
  }catch(error){if(attempt===3)return {word,url,status:'request-error',error:String(error.message||error).slice(0,160),ipa:[]};await delay(600*(attempt+1));}
}
const temp=`${outputPath}.tmp`;
async function save(){const rows=words.filter(word=>state.completed[word]).map(word=>JSON.stringify(state.completed[word]));await mkdir(path.dirname(outputPath),{recursive:true});await writeFile(temp,rows.length?`${rows.join('\n')}\n`:'','utf8');await rename(temp,outputPath);await writeFile(statePath,`${JSON.stringify(state,null,2)}\n`,'utf8');}
let cursor=0,finished=0,writes=Promise.resolve();
async function worker(){while(true){const word=pending[cursor++];if(!word)return;const row=await fetchEntry(word);state.completed[word]=row;finished++;if(finished%25===0||finished===pending.length){writes=writes.then(save);await writes;const completed=Object.values(state.completed).filter(Boolean);console.log(JSON.stringify({newlyAudited:finished,pending:pending.length,totalReviewedWords:words.length,sourceFound:completed.filter(x=>x.status==='source-found').length,notFound:completed.filter(x=>x.status==='not-found').length,errors:completed.filter(x=>String(x.status||'').includes('error')).length}));}await delay(250);}}
console.log(JSON.stringify({triageReviewWords:words.length,resume:Object.keys(state.completed).length,pending:pending.length,concurrency}));
await Promise.all(Array.from({length:concurrency},worker));await writes;state.finishedAt=new Date().toISOString();await save();
console.log(JSON.stringify({finished:true,reviewWords:words.length,audited:Object.keys(state.completed).length,sourceFound:Object.values(state.completed).filter(x=>x.status==='source-found').length,outputPath}));
