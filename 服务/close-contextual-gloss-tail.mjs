// Resolve the five known non-body/fragment leftovers without another API call.
import {readFile,writeFile,rename,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dataFile=path.join(project,'本地数据','contextual-glosses-v1.json');
const reader=path.join(project,'outputs','three-body-reader.html');
const state=JSON.parse(await readFile(dataFile,'utf8')),html=await readFile(reader,'utf8');
const expected={'14:17:60':'th','3:26:0':'Major-general','4:29:2':'VI','42:8:4':'ED','42:8:6':'OAST'};
for(const [id,word] of Object.entries(expected))if(state.unresolvedDetails?.[id]?.word!==word)throw Error('遗留项已变化，拒绝套用：'+id);
const book=JSON.parse(html.match(/<script id="bookData" type="application\/json">([\s\S]*?)<\/script>/)?.[1]||'null');
if(!book?.[3]?.content?.includes('Major-general of the People'))throw Error('目录原文已变化');
if(!book?.[42]?.content?.includes('OAST'))throw Error('碑文原文已变化');
console.log('已核对五项：目录军衔一项、数字/拆字片段四项。');
if(!process.argv.includes('--apply'))process.exit(0);
const stamp=new Date().toISOString().replace(/[:.]/g,'-');await copyFile(dataFile,path.join(project,'本地数据',`contextual-glosses-before-tail-${stamp}.json`));await copyFile(reader,path.join(project,'本地数据',`reader-before-gloss-tail-${stamp}.html`));
state.entries['3:26:0']='少将';state.excludedTokenFragments||={};
for(const [id,word] of Object.entries(expected)){if(id!=='3:26:0')state.excludedTokenFragments[id]={word,reason:id==='4:29:2'?'roman-numeral':id==='14:17:60'?'ordinal-suffix-fragment':'spaced-inscription-fragment'};delete state.unresolvedDetails[id];delete state.failed[id];}
state.tailClosure={at:new Date().toISOString(),resolved:'3:26:0',excluded:Object.keys(expected).filter(id=>id!=='3:26:0')};
let tmp=dataFile+'.'+process.pid+'.tmp';await writeFile(tmp,JSON.stringify(state,null,2)+'\n');await rename(tmp,dataFile);
const payload=JSON.stringify({version:2,indexVersion:2,entries:state.entries}).replace(/</g,'\\u003c');
const marker=/const contextualGlossData = .*?;/;if(!marker.test(html))throw Error('阅读器句中义数据块不存在');
tmp=reader+'.'+process.pid+'.tmp';await writeFile(tmp,html.replace(marker,`const contextualGlossData = ${payload};`));await rename(tmp,reader);
console.log('句中义 +1；非完整词片段排除 4；待处理清单 0。');
