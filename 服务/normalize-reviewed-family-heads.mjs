// One-time normalization of four head names after the first modern-family apply.
import {readFile,writeFile,rename,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const reader=path.join(project,'outputs','three-body-reader.html'),html=await readFile(reader,'utf8');
const get=id=>{const at=html.indexOf(`id="${id}"`),start=html.indexOf('>',at)+1;return JSON.parse(html.slice(start,html.indexOf('</script>',start)));};
const put=(source,id,value)=>{const at=source.indexOf(`id="${id}"`),start=source.indexOf('>',at)+1,end=source.indexOf('</script>',start);return source.slice(0,start)+JSON.stringify(value).replace(/</g,'\\u003c')+source.slice(end);};
const families=get('wordFamiliesData'),freq=get('wordFrequencyData');
const change={listener:'listen',prayer:'pray',stared:'stare',rosy:'rose'};
for(const [before,after] of Object.entries(change)){if(!families.groups[before]||families.groups[after]||!families.groups[before].includes(before)&&before!=='rosy')throw Error('族头状态不符：'+before);}
for(const [before,after] of Object.entries(change)){const members=families.groups[before];delete families.groups[before];families.groups[after]=members;for(const word of members){families.forms[word]=after;if(freq.forms[word])freq.forms[word].familyId=after;}freq.familyCounts[after]=freq.familyCounts[before];delete freq.familyCounts[before];}
for(const [word,item] of Object.entries(freq.forms))if(freq.strictCounts[item.strictId]>freq.familyCounts[item.familyId])throw Error('词形超过词族：'+word);
console.log('族头规范化：'+Object.entries(change).map(([a,b])=>a+'→'+b).join('、'));
if(!process.argv.includes('--apply'))process.exit(0);
const stamp=new Date().toISOString().replace(/[:.]/g,'-');await copyFile(reader,path.join(project,'本地数据',`reader-before-family-head-normalize-${stamp}.html`));let next=put(html,'wordFamiliesData',families);next=put(next,'wordFrequencyData',freq);const tmp=reader+'.'+process.pid+'.tmp';await writeFile(tmp,next);await rename(tmp,reader);
