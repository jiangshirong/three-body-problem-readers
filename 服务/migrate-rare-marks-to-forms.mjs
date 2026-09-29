// 一次性迁移:已有的生僻词标记记的是"词族",生僻词改为按"词形"之后要收敛过去。
// 规则:取该词族的词头(若它本身是书中词形),否则取族内出现最多的那个词形,用它的词形 id。
// 首标记记录(origins.rare)的键同步改名,位置信息保留。
import {execFileSync} from 'node:child_process';

const PORT = Number(process.env.READER_PORT || 8766);
const cwd = 'D:/桌面文件夹/项目/外语阅读';
const html = execFileSync('node', ['-e', "process.stdout.write(require('fs').readFileSync('英语/outputs/three-body-reader.html','utf8'))"], {cwd, encoding: 'utf8', maxBuffer: 1 << 28});
const grab = id => JSON.parse((html.match(new RegExp('<script id="' + id + '" type="application/json">([^]*?)</script>')) || [])[1]);
const frequency = grab('wordFrequencyData');
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');

// 词族 → 该族代表词形
const pickByFamily = new Map();
for (const [form, entry] of Object.entries(frequency.forms || {})) {
  const current = pickByFamily.get(entry.familyId);
  const count = frequency.strictCounts?.[entry.strictId] || 0;
  // 词头优先;否则取出现最多的词形
  const better = !current
    || (form === entry.familyId && current.form !== entry.familyId)
    || (current.form !== current.family && form === entry.familyId)
    || (current.form !== current.family && form !== entry.familyId && count > current.count);
  if (better) pickByFamily.set(entry.familyId, {form, strictId: entry.strictId, count, family: entry.familyId});
}
const migrate = key => {
  const pick = pickByFamily.get(key);
  return pick && pick.strictId !== key ? pick.strictId : key;
};

const status = await (await fetch(`http://127.0.0.1:${PORT}/api/status`)).json();
const headers = {'Content-Type': 'application/json', 'X-Reader-Token': status.csrf};
const marks = await (await fetch(`http://127.0.0.1:${PORT}/api/learning-marks`, {method: 'POST', headers, body: '{}'})).json();

const before = marks.rare || [];
const mapped = before.map(key => ({from: key, to: migrate(key)}));
const next = [...new Set(mapped.map(item => item.to))];
const changed = mapped.filter(item => item.from !== item.to);
console.log('生僻词标记 ' + before.length + ' 条 → ' + next.length + ' 条（词形去重）');
console.log('其中改键的 ' + changed.length + ' 条:');
for (const item of changed.filter(item => item.from !== item.to)) {
  const pick = pickByFamily.get(item.from);
  console.log('  ' + item.from.padEnd(18) + '→ ' + item.to.padEnd(18) + '（族内代表词形 ' + (pick?.form || '?') + '，出现 ' + (pick?.count ?? 0) + ' 次）');
}
const lost = before.filter(key => !frequency.forms?.[key] && !pickByFamily.has(key));
if (lost.length) console.log('无法对应到词形的旧标记(原样保留): ' + lost.join(', '));

const nextOrigins = {...marks.origins, rare: {}};
for (const [key, value] of Object.entries(marks.origins?.rare || {})) nextOrigins.rare[migrate(key)] = value;

if (!APPLY) { console.log('\n（未加 --apply，仅预演）'); process.exit(0); }
const saved = await (await fetch(`http://127.0.0.1:${PORT}/api/learning-marks`, {method: 'POST', headers, body: JSON.stringify({
  rare: next, learning: marks.learning || [], fresh: marks.fresh || [], phrases: marks.phrases || [], origins: nextOrigins
})})).json();
console.log('\n已写回:生僻词 ' + saved.rare.length + ' 条,首标记记录 ' + Object.keys(saved.origins?.rare || {}).length + ' 条');
console.log('（如果还有别的阅读器页面开着,请刷新它,否则旧页面可能把这次迁移覆盖回去）');
