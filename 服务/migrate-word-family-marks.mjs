// 词族重建后,把按词族 id 存的标记改到新的词族 id 上。
// 不迁移就会出现"标记还在、但正文不再高亮"的静默失效。只合不拆保证旧 id -> 新 id 一对一,迁移是精确的。
//
// 注意各类标记的键并不相同,不能一律按族头改名:
//   学习词、学习词组 —— 键是词族 id,需要迁移;
//   生僻词 —— 键是词形(strictId),与词族 id 无关,重建不会动它,改了反而会把标记挪到别的词上;
//   熟词新用 —— 键是位置(章节:段:词序),同样与词族 id 无关。
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const beforeArg = argv.find(item => item.startsWith('--data-before='));
const beforePath = beforeArg ? beforeArg.slice('--data-before='.length) : path.join(project, '本地数据', 'three-body-reader-before-family-rebuild.html');
const readerPath = path.join(project, 'outputs', 'three-body-reader.html');
const PORT = Number(process.env.READER_PORT || 8766);

function grab(src, id) {
  const at = src.indexOf(`id="${id}"`);
  const start = src.indexOf('>', at) + 1;
  return JSON.parse(src.slice(start, src.indexOf('</script>', start)));
}
const oldSrc = await readFile(beforePath, 'utf8');
const newSrc = await readFile(readerPath, 'utf8');
const oldFreq = grab(oldSrc, 'wordFrequencyData');
const newFreq = grab(newSrc, 'wordFrequencyData');
const newFamilies = grab(newSrc, 'wordFamiliesData');
const formOf = data => word => data.forms[word]?.familyId || word;
const oldHead = formOf(oldFreq), newHead = formOf(newFreq);
const currentIds = new Set(Object.keys(newFreq.familyCounts));
const currentStrictIds = new Set(Object.values(newFreq.forms).map(entry => entry.strictId));
const strictIdOf = word => newFreq.forms[word]?.strictId || word;

// 旧族头 -> 新族头。只合不拆时每个旧族头只会落在一个新族里,冲突意味着重建发生了拆分。
const mapOldToNew = new Map();
let conflicts = 0;
for (const form of Object.keys(oldFreq.forms)) {
  const from = oldHead(form), to = newHead(form);
  if (mapOldToNew.has(from) && mapOldToNew.get(from) !== to) { conflicts++; continue; }
  mapOldToNew.set(from, to);
}
console.log(`旧族头 -> 新族头 映射 ${mapOldToNew.size} 条,冲突 ${conflicts} 条${conflicts ? '（重建出现了拆分,迁移可能有损）' : ''}`);
const migrate = id => {
  if (mapOldToNew.has(id)) return mapOldToNew.get(id);
  if (newFreq.forms[id]) return newHead(id);   // 存的是词形而非族头的情形
  return id;                                    // 无法识别则原样保留,由下面的校验报告
};

// 词组可用性校验:按阅读器的口径(词形→词族后,连续匹配或允许间隔)在全书里找一遍
const chapters = grab(newSrc, 'bookData');
const familyOf = word => newFamilies.forms[word] || word;
const tokenize = text => text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || [];
const chapterFamilies = chapters.map(chapter => tokenize(String(chapter.content).replace(/<[^>]*>/g, ' ')).map(token => familyOf(token.toLowerCase())));
const findPhrase = signature => {
  const target = signature.words;
  for (const families of chapterFamilies) {
    for (let start = 0; start < families.length; start++) {
      let cursor = start, ok = true;
      for (let offset = 0; offset < target.length; offset++) {
        if (signature.allowGaps) { while (cursor < families.length && families[cursor] !== target[offset]) cursor++; }
        else if (cursor >= families.length || families[cursor] !== target[offset]) { ok = false; break; }
        if (cursor >= families.length) { ok = false; break; }
        cursor++;
      }
      if (ok) return true;
    }
  }
  return false;
};

const status = await (await fetch(`http://127.0.0.1:${PORT}/api/status`)).json();
const headers = {'Content-Type': 'application/json', 'X-Reader-Token': status.csrf};
const marks = await (await fetch(`http://127.0.0.1:${PORT}/api/learning-marks`, {method: 'POST', headers, body: '{}'})).json();

// 生僻词的键必须是词形(strictId):阅读器是拿词的词形去查的,键写成表面写法就永远不会高亮。
// 历史上有一批键是表面写法,按两种线索改正:
//   有首标记记录的,以记录里的那个词为准(它才是当初点下去的词);
//   没有记录的旧标记,键本身就是当初标的写法,直接取它的词形。
const strictKeyOf = text => newFreq.forms[String(text).trim().toLowerCase().replaceAll('’', "'")]?.strictId || null;
const repairedRare = [];
const repairRare = key => {
  const origin = marks.origins?.rare?.[key];
  const target = origin?.word ? strictKeyOf(origin.word) : null;
  const fixed = target || (currentStrictIds.has(key) ? key : strictKeyOf(key) || key);
  if (fixed !== key) repairedRare.push({from: key, to: fixed, word: origin?.word || key});
  return fixed;
};
const next = {
  rare: [...new Set((marks.rare || []).map(repairRare))],
  learning: [...new Set((marks.learning || []).map(migrate))],
  fresh: [...new Set(marks.fresh || [])],
  phrases: (marks.phrases || []).map(item => ({words: (item.words || []).map(migrate), allowGaps: item.allowGaps === true})),
  origins: marks.origins || {}
};
// 位置记录按标记键存放,只跟随各自那一类的改名规则。
const nextOrigins = {rare: {}, learning: {}, fresh: {}, phrases: {}};
for (const kind of ['rare', 'learning', 'fresh', 'phrases']) {
  const rename = kind === 'learning' || kind === 'phrases' ? migrate : kind === 'rare' ? repairRare : key => key;
  for (const [key, value] of Object.entries(marks.origins?.[kind] || {})) nextOrigins[kind][rename(key)] = value;
}
next.origins = nextOrigins;

await writeFile(path.join(project, '本地数据', 'learning-marks-before-family-migrate.json'), `${JSON.stringify(marks, null, 1)}\n`, 'utf8');
console.log(`生僻词 ${(marks.rare || []).length} -> ${next.rare.length}（词形键,与词族 id 无关）`);
console.log(`  其中键被修的 ${repairedRare.length} 条: ${repairedRare.slice(0, 8).map(item => `${item.from}→${item.to}`).join(', ')}${repairedRare.length > 8 ? ' …' : ''}`);
console.log(`学习词 ${(marks.learning || []).length} -> ${next.learning.length}`);
console.log(`熟词新用 ${(marks.fresh || []).length} -> ${next.fresh.length}（位置键,原样保留）`);
console.log(`学习词组 ${(marks.phrases || []).length} -> ${next.phrases.length}`);
// 各类按自己的口径校验:生僻词看词形,其余看词族 id。
const badRare = next.rare.filter(id => !currentStrictIds.has(id));
const badFamilies = [...next.learning, ...next.fresh].filter(id => !currentIds.has(id) && !/^\d+:\d+:\d+$/.test(id));
const originsAskew = next.rare.filter(id => { const origin = nextOrigins.rare[id]; return origin?.word && strictIdOf(origin.word) !== id; });
const phrasesUnmatched = next.phrases.filter(item => !findPhrase({words: item.words, allowGaps: item.allowGaps}));
console.log(`生僻词里不是有效词形的: ${badRare.length}${badRare.length ? ' -> ' + badRare.slice(0, 12).join(', ') : ''}`);
console.log(`学习词里不是有效族 id 的: ${badFamilies.length}${badFamilies.length ? ' -> ' + badFamilies.slice(0, 12).join(', ') : ''}`);
console.log(`生僻词标记与首标记记录里的词不同形的: ${originsAskew.length}${originsAskew.length ? ' -> ' + originsAskew.slice(0, 12).join(', ') : ''}`);
console.log(`迁移后在书中找不到出处的词组: ${phrasesUnmatched.length}${phrasesUnmatched.length ? ' -> ' + phrasesUnmatched.slice(0, 8).map(item => item.words.join(' ')).join(' | ') : ''}`);

if (!APPLY) { console.log('（未加 --apply,仅预演）'); process.exit(0); }
const saved = await (await fetch(`http://127.0.0.1:${PORT}/api/learning-marks`, {method: 'POST', headers, body: JSON.stringify(next)})).json();
console.log(`已写回: 生僻词 ${saved.rare.length}, 学习词 ${saved.learning.length}, 熟词新用 ${saved.fresh.length}, 学习词组 ${saved.phrases.length}`);
