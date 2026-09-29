// Refresh the missing-word CSV and compact coverage JSON from embedded data.
import {readFile,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),out=path.join(project,'outputs');
const html=await readFile(path.join(out,'three-body-reader.html'),'utf8');
const get=id=>{const at=html.indexOf(`id="${id}"`),start=html.indexOf('>',at)+1;return JSON.parse(html.slice(start,html.indexOf('</script>',start)));};
const frequency=get('wordFrequencyData'),pronunciation=get('americanPronunciationData');
const csvFile=path.join(out,'美式音标缺失词.csv'),rows=(await readFile(csvFile,'utf8')).trimEnd().split(/\r?\n/);
const head=rows.shift().replace(/^\uFEFF/,'');if(!head.startsWith('单词,'))throw Error('缺失词 CSV 结构变化');
const remaining=rows.filter(row=>!pronunciation.entries[row.split(',')[0]]?.length);
const actual=Object.keys(frequency.forms).filter(word=>!pronunciation.entries[word]?.length);
if(remaining.length!==actual.length||new Set(remaining.map(row=>row.split(',')[0])).size!==actual.length)throw Error('缺失词 CSV 与阅读器不一致');
const exact=Object.keys(frequency.forms).length-actual.length;
const missingOccurrences=actual.reduce((n,word)=>n+frequency.forms[word].count,0);
const total=Object.values(frequency.forms).reduce((n,row)=>n+row.count,0);
const coverage={uniqueWords:Object.keys(frequency.forms).length,wordOccurrences:total,exact,lemmaOnly:remaining.filter(x=>x.includes(',仅原形有美式音标,')).length,missing:remaining.filter(x=>!x.includes(',仅原形有美式音标,')).length,exactCoveragePercent:Math.round(exact/Object.keys(frequency.forms).length*10000)/100,exactOccurrenceCoveragePercent:Math.round((total-missingOccurrences)/total*10000)/100};
console.log(coverage);
if(process.argv.includes('--apply')){let tmp=csvFile+'.'+process.pid+'.tmp';await writeFile(tmp,[head,...remaining].join('\n')+'\n');await rename(tmp,csvFile);const json=path.join(out,'pronunciation-coverage.json');tmp=json+'.'+process.pid+'.tmp';await writeFile(tmp,JSON.stringify(coverage,null,2)+'\n');await rename(tmp,json);}
