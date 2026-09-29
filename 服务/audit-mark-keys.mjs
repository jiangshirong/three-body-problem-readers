// 核对词族重建后的标记是否还会高亮:阅读器是拿"词形(strictId)"查生僻词、拿"词族 id"查学习词,
// 标记键若不在全书出现过的键集合里,那条标记就是静默失效(标记还在,正文不再高亮)。
import {readFileSync} from 'node:fs';

const html = readFileSync(new URL('../outputs/three-body-reader.html', import.meta.url), 'utf8');
const grab = id => { const at = html.indexOf(`id="${id}"`); const s = html.indexOf('>', at) + 1; return JSON.parse(html.slice(s, html.indexOf('</script>', s))); };
const families = grab('wordFamiliesData'), frequency = grab('wordFrequencyData'), book = grab('bookData');
const norm = text => String(text).trim().toLowerCase().replaceAll('\u2019', "'");
const strictKeyOf = text => frequency.forms?.[norm(text)]?.strictId || norm(text);
const familyOf = text => families.forms?.[norm(text)] || norm(text);
const strictSeen = new Set(), familySeen = new Set();
for (const chapter of book) {
  const text = String(chapter.content ?? '').replace(/<[^>]*>/g, ' ');
  for (const token of text.match(/[A-Za-z]+(?:[\u2019'-][A-Za-z]+)*/g) || []) { strictSeen.add(strictKeyOf(token)); familySeen.add(familyOf(token)); }
}
const marks = JSON.parse(readFileSync(new URL('../本地数据/.reader-cache/learning-marks.json', import.meta.url), 'utf8'));
const silentRare = (marks.rare || []).filter(key => !strictSeen.has(key));
const silentLearning = (marks.learning || []).filter(key => !familySeen.has(key));
console.log(`全书：词形组 ${strictSeen.size} 个，词族 ${familySeen.size} 个`);
console.log(`标记：${JSON.stringify({生僻词: marks.rare.length, 学习词: marks.learning.length, 熟词新用: marks.fresh.length, 词组: marks.phrases.length})}`);
console.log(`标记了但全书没有对应词形的 —— 生僻词 ${silentRare.length}${silentRare.length ? ': ' + silentRare.slice(0, 12).join(', ') : ''}`);
console.log(`                              学习词 ${silentLearning.length}${silentLearning.length ? ': ' + silentLearning.slice(0, 12).join(', ') : ''}`);
console.log(`gravity 的词族：${JSON.stringify({gravity: familyOf('gravity'), gravitational: familyOf('gravitational'), gravitationally: familyOf('gravitationally'), gravely: familyOf('gravely'), grave: familyOf('grave')})}`);
