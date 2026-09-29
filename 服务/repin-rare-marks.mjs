// 1) 锚点解析的最后兜底:原先按"词族"找词,会跳到同族里另一个词形(例如 empty 的锚点跳到 emptiness,
//    而那处并没有标记)。改为按"词形"匹配。
// 2) 迁移修正:旧的词族级标记,其首标记记录里存着当初标记的那个词;把标记键改到那个词的词形上,
//    这样标记、高亮、首标记位置三者才一致。
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';

const html = 'D:/桌面文件夹/项目/外语阅读/英语/outputs/three-body-reader.html';
const PORT = Number(process.env.READER_PORT || 8766);
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');

// ---------- 1) 客户端:兜底改为按词形 ----------
const source = fs.readFileSync(html, 'utf8');
const from = "      return inner.find(item => familyOf(item.textContent) === familyOf(word)) || null;";
const to = "      // 最后兜底只在同一词形内找:跨词形会把锚点落到另一个词上(那处可能根本没被标记)。\n      return inner.find(item => strictKeyOf(item.textContent) === strictKeyOf(word)) || null;";
const at = source.indexOf(from);
if (at < 0) console.log('（客户端兜底已是词形匹配，跳过）');
if (at >= 0) fs.writeFileSync(html, source.slice(0, at) + to + source.slice(at + from.length), 'utf8');
console.log('已修改锚点解析的兜底(词族 → 词形)');

// ---------- 2) 数据:把标记键挪到首标记记录所指的词形 ----------
const reader = fs.readFileSync(html, 'utf8');
const frequency = JSON.parse((reader.match(/<script id="wordFrequencyData" type="application\/json">([^]*?)<\/script>/) || [])[1]);
const strictKeyOf = text => { const entry = frequency.forms?.[String(text).trim().toLowerCase().replaceAll('’', "'")]; return entry ? entry.strictId : null; };
const status = await (await fetch(`http://127.0.0.1:${PORT}/api/status`)).json();
const headers = {'Content-Type': 'application/json', 'X-Reader-Token': status.csrf};
const marks = await (await fetch(`http://127.0.0.1:${PORT}/api/learning-marks`, {method: 'POST', headers, body: '{}'})).json();

const moves = [], kept = new Set();
for (const key of marks.rare || []) {
  const origin = marks.origins?.rare?.[key];
  const wanted = origin?.word ? strictKeyOf(origin.word) : null;
  if (wanted && wanted !== key) moves.push({from: key, to: wanted, word: origin.word, chapter: origin.chapter});
  else kept.add(key);
}
console.log('\n生僻词 ' + (marks.rare || []).length + ' 条:需要改到首标记所在词形的 ' + moves.length + ' 条');
for (const move of moves.slice(0, 25)) console.log('  ' + move.from.padEnd(16) + '→ ' + move.to.padEnd(16) + '（当初标在 "' + move.word + '"，第 ' + (move.chapter + 1) + ' 章）');
if (moves.length > 25) console.log('  …还有 ' + (moves.length - 25) + ' 条');
if (!APPLY) { console.log('\n（未加 --apply，仅预演）'); process.exit(0); }

const nextRare = [...new Set([...kept, ...moves.map(move => move.to)])];
const nextOrigins = {...marks.origins, rare: {}};
for (const [key, value] of Object.entries(marks.origins?.rare || {})) {
  const move = moves.find(item => item.from === key);
  nextOrigins.rare[move ? move.to : key] = value;
}
const saved = await (await fetch(`http://127.0.0.1:${PORT}/api/learning-marks`, {method: 'POST', headers, body: JSON.stringify({
  rare: nextRare, learning: marks.learning || [], fresh: marks.fresh || [], phrases: marks.phrases || [], origins: nextOrigins
})})).json();
console.log('\n已写回:生僻词 ' + saved.rare.length + ' 条,首标记记录 ' + Object.keys(saved.origins?.rare || {}).length + ' 条');
console.log('（若还有别的阅读器页面开着,请刷新,否则旧页面可能覆盖这次修正）');
