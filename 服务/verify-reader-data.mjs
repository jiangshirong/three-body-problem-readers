// Offline regression for the embedded English book data and saved marks.
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const html=await readFile(path.join(project,'outputs','three-body-reader.html'),'utf8');
const block=id=>{const at=html.indexOf(`id="${id}"`),start=html.indexOf('>',at)+1;if(at<0)throw Error('缺数据块 '+id);return JSON.parse(html.slice(start,html.indexOf('</script>',start)));};
const frequency=block('wordFrequencyData'),families=block('wordFamiliesData'),pronunciation=block('americanPronunciationData');
const gloss=JSON.parse(html.match(/^  const contextualGlossData = (.+);$/m)?.[1]||'null');
const marks=JSON.parse(await readFile(path.join(project,'本地数据','.reader-cache','learning-marks.json'),'utf8'));
const state=JSON.parse(await readFile(path.join(project,'本地数据','contextual-glosses-v1.json'),'utf8'));
const fail=message=>{throw Error(message);};
const total=Object.values(frequency.forms).reduce((n,v)=>n+v.count,0);
if(total!==118694||Object.values(frequency.familyCounts).reduce((a,b)=>a+b,0)!==total)fail('总词频不守恒');
if(frequency.summary.broadFamilies!==Object.keys(families.groups).length)fail('词族摘要不一致');
const strictFamily=new Map();for(const [word,item] of Object.entries(frequency.forms)){if(families.forms[word]!==item.familyId)fail('词族映射不一致 '+word);if(frequency.strictCounts[item.strictId]>frequency.familyCounts[item.familyId])fail('严格词形次数超过词族次数 '+word);if(strictFamily.has(item.strictId)&&strictFamily.get(item.strictId)!==item.familyId)fail('严格词形组跨词族 '+item.strictId);strictFamily.set(item.strictId,item.familyId);}
for(const [head,members] of Object.entries(families.groups))for(const word of members)if(families.forms[word]!==head)fail('词族成员不一致 '+word);
if(frequency.forms.wounded.strictId!=='wound'||frequency.forms.wounded.familyId!=='wound')fail('wounded 回归到 wind');
const missing=Object.keys(frequency.forms).filter(word=>!pronunciation.entries[word]?.length);if(missing.length!==246)fail('音标缺项数量变化：'+missing.length);
if(gloss.entries['3:26:0']!=='少将'||Object.keys(state.unresolvedDetails||{}).length)fail('句中义遗留项未关闭');
const book=block('bookData'),strictSeen=new Set(),familySeen=new Set();for(const chapter of book){const plain=String(chapter.content).replace(/<[^>]*>/g,' ');for(const token of plain.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)||[]){const word=token.toLowerCase().replaceAll('’',"'");strictSeen.add(frequency.forms[word]?.strictId||word);familySeen.add(families.forms[word]||word);}}
const lostRare=(marks.rare||[]).filter(id=>!strictSeen.has(id)),lostLearning=(marks.learning||[]).filter(id=>!familySeen.has(id));if(lostRare.length||lostLearning.length)fail(`标记静默失效：生僻 ${lostRare.length} 学习 ${lostLearning.length}`);
console.log(JSON.stringify({wordOccurrences:total,strictGroups:Object.keys(frequency.strictCounts).length,families:Object.keys(families.groups).length,missingIPA:missing.length,glosses:Object.keys(gloss.entries).length,rareMarks:marks.rare.length,learningMarks:marks.learning.length,phraseMarks:marks.phrases.length,lostMarks:0}));
