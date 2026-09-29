// 音标表原来按"一个词形一条读音"整理,于是"同一书写形式、读音随词性改变"的情况被压成了一条:
//   proceeds 作名词复数(收益)读 /ˈproʊsiːdz/,作动词第三人称单数(进行)读 /prəˈsiːdz/;
//   records 名 /ˈrekərdz/、动 /rɪˈkɔːrdz/;uses 名 /ˈjuːsɪz/、动 /ˈjuːzɪz/。
// 词卡是按音标分组、按词性显示"名/动"标签的,压成一条之后读者就无从分辨。
//
// 候选由规则给出(只生成候选,判归模型):
//   1) 全书词形里"只有一条读音且没有词性"的;
//   2) 屈折形式(-s/-es/-d/-ed/-ing)而其基词已按词性分开读音的。
// 模型对每个词形给出全部读音(按词性分开,读音相同的合并成一条),脚本据此改写该词形的读音集合。
import {copyFile, mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDpapiSecretStore} from './reader-server.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readerPath = path.join(project, 'outputs', 'three-body-reader.html');
const auditPath = path.join(project, 'outputs', 'deepseek-form-pronunciation-audit.jsonl');
const reportPath = path.join(project, 'outputs', '音标按词性补齐报告.md');
const model = 'deepseek-flash', promptVersion = 1;
const concurrency = 3, maxFormsPerJob = 20;   // 账户并发上限是 5,开 6 会吃 429
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run') || !argv.includes('--apply');
const APPLY = argv.includes('--apply');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const html = await readFile(readerPath, 'utf8');
function grab(id) {
  const at = html.indexOf(`id="${id}"`);
  if (at < 0) throw new Error(`找不到数据块 ${id}`);
  const start = html.indexOf('>', at) + 1;
  return JSON.parse(html.slice(start, html.indexOf('</script>', start)));
}
const pronunciation = grab('americanPronunciationData');
const frequency = grab('wordFrequencyData');
const dictionary = grab('dictionaryData');
if (!pronunciation.entries) throw new Error('音标数据块结构与预期不符');

const POS_LABEL = {n: '名', v: '动', adj: '形', adv: '副', prep: '介', pron: '代', det: '限定', conj: '连', intj: '叹', num: '数', aux: '助', pl: '名'};
const posTokens = record => String(record.pos || '').split('/').map(item => item.trim()).filter(Boolean);
const posSetOf = records => new Set(records.flatMap(posTokens));
const inBook = form => Boolean(frequency.forms?.[form]);

// 音标写法差异(ɛ/e、ɚ/ər、ː 长短音符号)不该被当成两条不同的读音。
// 只做这一层归一:不碰重音符号、也不把 ɪ/ʊ 折成 i/u —— /biː/ 与 /bɪ/ 是强读和弱读,
// /ˌɑːrbɪˈtrerəli/ 与 /ˈɑːrbɪˌtrerəli/ 是两种重音位置,合并它们等于丢读音。
const normalizeIpa = ipa => String(ipa).toLowerCase()
  .replace(/ː/g, '')
  .replace(/ɛ/g, 'e')
  .replace(/ɚ/g, 'ər').replace(/ɝ/g, 'ɜr');

const embedBlock = (source, id, value) => {
  const at = source.indexOf(`id="${id}"`);
  const start = source.indexOf('>', at) + 1;
  const end = source.indexOf('</script>', start);
  return source.slice(0, start) + JSON.stringify(value).replace(/</g, '\\u003c') + source.slice(end);
};
const backupPath = path.join(project, '本地数据', 'three-body-reader-before-form-pronunciations.html');
async function writeReader(nextPron, tag) {
  const next = embedBlock(html, 'americanPronunciationData', nextPron);
  await copyFile(readerPath, backupPath);
  const temporary = `${readerPath}.${process.pid}.tmp`;
  await writeFile(temporary, next, 'utf8');
  await rename(temporary, readerPath);
  console.log(`已回写 ${readerPath}（改前版本备份在 ${path.relative(project, backupPath)}）`);
}

const templateOf = form => {
  const first = (pronunciation.entries[form] || [])[0] || {};
  return {headword: form, accent: first.accent || 'General-American', tags: first.tags || ['General-American'],
    source: first.source || '', sources: first.sources || [], originalTags: first.originalTags || [],
    origin: first.origin || 'deepseek-flash-calibrated', reviewVersion: first.reviewVersion || 'deepseek-flash-1',
    sourceRevision: first.sourceRevision || '', conversionVersion: 'learner-us-1'};
};
const labelOf = pos => pos.split('/').map(token => POS_LABEL[token] || token).join('/');
// 同一音标下的多种词性合成一条:approach 名/动 同音,应写成 "名/动 /əˈproʊtʃ/" 而不是只留"名"。
const groupByIpa = readings => {
  const grouped = new Map();
  for (const reading of readings) {
    const item = grouped.get(reading.ipa) || {ipa: reading.ipa, tokens: [], note: ''};
    for (const token of reading.pos.split('/')) if (token && !item.tokens.includes(token)) item.tokens.push(token);
    if (!item.note && reading.note) item.note = reading.note;
    grouped.set(reading.ipa, item);
  }
  return [...grouped.values()].map(item => ({ipa: item.ipa, pos: item.tokens.join('/'), note: item.note}));
};
const mergeReadings = (form, rawReadings) => {
  const readings = groupByIpa(rawReadings);
  const existing = pronunciation.entries[form] || [];
  const consumed = new Set();
  const result = existing.map(record => {
    if (record.pos) return {...record};
    // 按音标对上就用那条的词性(写法差异不算不同);对不上而这个词形原来只有一条读音,就按模型给的第一条认。
    const match = readings.find(reading => normalizeIpa(reading.ipa) === normalizeIpa(record.ipa)) || (existing.length === 1 ? readings[0] : null);
    if (!match) return {...record};
    consumed.add(match.ipa);   // 认过的读音不再作为新记录追加,免得只差重音符号写成两条
    return {...record, pos: match.pos, posLabel: labelOf(match.pos)};
  });
  for (const reading of readings) {
    if (consumed.has(reading.ipa)) continue;
    if (result.some(record => normalizeIpa(record.ipa) === normalizeIpa(reading.ipa))) continue;
    result.push({...templateOf(form), ipa: reading.ipa, pos: reading.pos, posLabel: labelOf(reading.pos), rawPronunciation: reading.ipa});
  }
  return result.map((record, index) => ({...record, rank: index + 1}));
};
const sameSet = (left, right) => {
  const key = record => `${String(record.pos || '').split('/').filter(Boolean).join('/')}|${record.ipa}`;
  const a = new Set(left.map(key)), b = new Set(right.map(key));
  return a.size === b.size && [...a].every(item => b.has(item));
};
// ---------------------------------------------------------------- --replay:按审计文件里的判定重放,不调模型
// 用途:模型批次因故失败(例如账户欠费)时,已判定的部分可以离线重放,不必再花一次调用。
const replayArg = argv.find(item => item.startsWith('--replay='));
if (replayArg) {
  const replayPath = path.resolve(replayArg.slice('--replay='.length));
  const verdictsFromAudit = new Map();
  for (const line of (await readFile(replayPath, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    for (const item of row.words || []) if (item.readings?.length) verdictsFromAudit.set(item.word, item.readings);
  }
  console.log(`从审计文件读到 ${verdictsFromAudit.size} 个词形的判定：${path.relative(project, replayPath)}`);
  const nextEntries = {...pronunciation.entries};
  const replayChanged = [];
  for (const [form, readings] of verdictsFromAudit) {
    if (!pronunciation.entries[form]) continue;
    const merged = mergeReadings(form, readings);
    if (sameSet(pronunciation.entries[form], merged)) continue;
    replayChanged.push(`${form}: ${(pronunciation.entries[form] || []).map(record => `${record.pos || '?'}=${record.ipa}`).join(' ')} → ${merged.map(record => `${record.pos || '?'}=${record.ipa}`).join(' ')}`);
    nextEntries[form] = merged;
  }
  console.log(`其中需要改动的：${replayChanged.length} 个词形`);
  for (const line of replayChanged.slice(0, 12)) console.log('  ' + line);
  if (!APPLY) { console.log('（未加 --apply:仅预演）'); process.exit(0); }
  await writeReader({...pronunciation, entries: nextEntries, formReadingsUpdatedAt: new Date().toISOString()});
  process.exit(0);
}

// ---------------------------------------------------------------- --dedupe:合并"写法不同、读音相同"的重复记录
if (argv.includes('--dedupe')) {
  let collapsed = 0, touched = 0, examples = [];
  const nextEntries = {};
  for (const [form, records] of Object.entries(pronunciation.entries)) {
    const seen = new Set(), kept = [];
    for (const record of records) {
      const key = `${normalizeIpa(record.ipa)}|${record.pos || ''}`;
      if (seen.has(key)) {
        collapsed += 1;
        if (examples.length < 8) examples.push(`${form}: ${records.map(item => item.ipa).join(' ')} → 只留 ${kept[0]?.ipa}`);
        continue;
      }
      seen.add(key);
      kept.push({...record, rank: kept.length + 1});
    }
    if (kept.length !== records.length) touched += 1;
    nextEntries[form] = kept;
  }
  console.log(`合并重复读音记录 ${collapsed} 条，涉及 ${touched} 个词形`);
  for (const line of examples) console.log('  ' + line);
  if (!APPLY) { console.log('（未加 --apply:仅预演）'); process.exit(0); }
  await writeReader({...pronunciation, entries: nextEntries, formReadingsDedupedAt: new Date().toISOString()});
  process.exit(0);
}

// ---------------------------------------------------------------- 候选(纯规则召回,只生成候选,判归模型)
// 候选要抓住"同一书写形式、读音随词性改变"的三类情形:
//   R1 屈折形式同形异读:proceeds 既是 proceed 的第三人称单数(动),又是"收益"(名词复数);
//   R2 基词已按词性分开读音,屈折形式却没分:records、presents、uses;
//   R3 只有一条无词性的读音,而释义跨了多个词性:approach、design 这类(读音其实相同,缺的是词性标签)。
const VERB_MARKERS = new Set(['v', 'vi', 'vt', 'aux']);
const NOUN_MARKERS = new Set(['n', 'pl']);
const posMarkersOf = translation => {
  const found = new Set();
  for (const line of String(translation || '').split('\n')) {
    const at = line.match(/^\s*\[?([a-z.]+)\]?\s*$/);
    const head = line.match(/^\s*\[?([a-z.]+)\./);
    const token = (head ? head[1] : at ? at[1] : '').replace(/\.$/, '');
    if (token) found.add(token);
    const bracket = line.match(/^\s*\[([^\]]+)\]/);
    if (bracket) found.add(`[${bracket[1]}]`);
  }
  return found;
};
const hasKind = (markers, kind) => [...markers].some(token => (kind === 'verb' ? VERB_MARKERS : NOUN_MARKERS).has(token));
const translationOf = form => dictionary.entries?.[form]?.translation;

const candidates = new Map();   // form -> 命中的规则
const note = (form, rule) => { if (!candidates.has(form)) candidates.set(form, rule); };
const INFLECTIONS = ['s', 'es', 'd', 'ed', 'ing'];
for (const [form, records] of Object.entries(pronunciation.entries)) {
  if (!inBook(form) || !records.length) continue;
  const ownMarkers = posMarkersOf(translationOf(form));
  const base = frequency.forms[form]?.strictId && frequency.forms[form].strictId !== form ? frequency.forms[form].strictId : null;
  const baseMarkers = base ? posMarkersOf(translationOf(base)) : new Set();
  const baseRecords = base ? (pronunciation.entries[base] || []) : [];
  if (base && INFLECTIONS.some(suffix => form === base + suffix || form === base + 'e' + suffix)
      && hasKind(ownMarkers, 'noun') && hasKind(baseMarkers, 'verb')) note(form, 'R1');
  if (baseRecords.length && posSetOf(baseRecords).size >= 2 && posSetOf(records).size < 2) note(form, 'R2');
  if (posSetOf(records).size < 2 && hasKind(ownMarkers, 'noun') && hasKind(ownMarkers, 'verb')) note(form, 'R3');
}
const byRule = new Map();
for (const rule of candidates.values()) byRule.set(rule, (byRule.get(rule) || 0) + 1);
const list = [...candidates.keys()].sort();
console.log(`候选词形 ${list.length} 个（R1 ${byRule.get('R1') || 0} 个 / R2 ${byRule.get('R2') || 0} 个 / R3 ${byRule.get('R3') || 0} 个）`);
console.log('样例:', list.slice(0, 24).join(', '));
// 只列候选不开工:预演不该产生 API 用量。
if (!APPLY) { console.log('（未加 --apply:仅列出候选,不调用模型、不改数据）'); process.exit(0); }

const jobs = [];
for (let at = 0; at < list.length; at += maxFormsPerJob) jobs.push(list.slice(at, at + maxFormsPerJob));

const systemPrompt = `你在校一部英文小说的美式音标表。输入若干词形,请给出每个**书写形式**在通用美式英语里的全部读音,按词性分开。
关键:同一个书写形式常同时是几种词性,读音可能不同,必须全部列出。
- 名词复数和动词第三人称单数常同形:proceeds 作名词复数(收益)读 /ˈproʊsiːdz/,作动词第三人称单数(进行)读 /prəˈsiːdz/ —— 两条都要给。
- 名词与动词重音不同的词,其屈折形式同样分叉:records 名 /ˈrekərdz/、动 /rɪˈkɔːrdz/;uses 名 /ˈjuːsɪz/、动 /ˈjuːzɪz/。
- 两种词性的读音完全相同时合并成一条,pos 写 "n/v" 这样的形式(如 houses 名/动 都是 /ˈhaʊzɪz/)。
- 只按这个书写形式本身给读音,不要把它派生自哪个词的其他形式算进来;该词性若只存在于另一个词形,用 note 说明且不要列出。
pos 只用 n / v / adj / adv / prep / pron / det / conj / num 这些缩写,合并时用 "/" 连接。ipa 用斜杠包住的美式音标。
严格返回 JSON:{"words":[{"word":"...","readings":[{"pos":"n","ipa":"/.../"},{"pos":"v","ipa":"/.../"}],"note":""}]}。每个输入的词形都必须出现一次。`;

const store = createDpapiSecretStore(path.join(project, '本地数据', '.reader-cache', 'reader-secrets.dpapi.json'));
const secret = (await store.load()).deepseek;
if (!secret) throw new Error('未找到已保存的 DeepSeek API Key');

// 只发词形本身:喂词典释义或现有音标会把模型锚在 ECDICT 那种不完整的词性覆盖上
// (contents 曾被判成"仅名词",而它同时是 content 的第三人称单数),不给上下文时判定反而更准。
const contextOf = () => '';
async function call(job) {
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: `Bearer ${secret}`},
    body: JSON.stringify({model, thinking: {type: 'disabled'}, temperature: 0, response_format: {type: 'json_object'}, max_tokens: 4000,
      messages: [{role: 'system', content: systemPrompt}, {role: 'user', content: JSON.stringify({task: 'judge-form-pronunciations', words: job})}]})
  });
  if (response.status === 429) throw new Error(`HTTP 429: ${(await response.text()).slice(0, 120)}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 160)}`);
  const body = await response.json();
  return {raw: body.choices?.[0]?.message?.content || '', usage: body.usage || {}};
}
const clean = value => String(value || '').trim();
function validate(job, raw) {
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed?.words) ? parsed.words : null;
  if (!list) return null;
  const wanted = new Set(job);
  const out = new Map();
  for (const row of list) {
    const word = clean(row?.word).toLowerCase();
    if (!wanted.has(word) || out.has(word)) continue;
    const readings = [];
    for (const item of Array.isArray(row?.readings) ? row.readings : []) {
      const ipa = clean(item?.ipa);
      const pos = clean(item?.pos).toLowerCase().replace(/\s+/g, '').replace(/[^a-z/]/g, '');
      if (!ipa || !pos) continue;
      readings.push({pos, ipa, note: clean(item?.note || row?.note)});
    }
    if (readings.length) out.set(word, readings);
  }
  return out.size ? out : null;
}

const verdicts = new Map();
const audit = [];
let cursor = 0, finished = 0, usage = {requests: 0, prompt: 0, completion: 0};
const failures = [];
async function worker() {
  while (cursor < jobs.length) {
    const index = cursor++;
    const job = jobs[index];
    let pending = job, error = '';
    for (let attempt = 0; attempt < 3 && pending.length; attempt++) {
      try {
        const response = await call(pending);
        usage.requests += 1;
        usage.prompt += Number(response.usage.prompt_tokens) || 0;
        usage.completion += Number(response.usage.completion_tokens) || 0;
        const got = validate(pending, response.raw);
        if (got) for (const [word, readings] of got) verdicts.set(word, readings);
        else error = '返回内容与输入不一致';
      } catch (e) { error = e.message; }
      pending = pending.filter(word => !verdicts.has(word));
      if (pending.length) await wait(400 * (attempt + 1));
    }
    if (pending.length) failures.push({job: index, words: pending, error});
    audit.push({batch: index, ok: !pending.length, error: pending.length ? error : '', words: job.map(word => ({word, readings: verdicts.get(word) || null}))});
    finished++;
    if (finished % 5 === 0 || finished === jobs.length) console.log(`  进度 ${finished}/${jobs.length}`);
    await wait(60);
  }
}
await Promise.all(Array.from({length: concurrency}, worker));
console.log(`模型判定完成:${verdicts.size}/${list.length} 个词形,失败 ${failures.length} 批;用量 ${usage.requests} 次请求,${usage.prompt + usage.completion} tokens`);

// ---------------------------------------------------------------- 合并成新的读音记录
// 只加不删:原有读音一条都不丢,给没有词性的补上词性,缺的那条(如 proceeds 的动词读法)才新增。
const nextByForm = new Map();
const changed = [];
for (const [form, readings] of verdicts) {
  const merged = mergeReadings(form, readings);
  if (sameSet(pronunciation.entries[form] || [], merged)) continue;
  nextByForm.set(form, merged);
  changed.push({form,
    before: (pronunciation.entries[form] || []).map(record => `${record.pos || '?'}=${record.ipa}`).join('  '),
    after: merged.map(record => `${record.pos || '?'}=${record.ipa}`).join('  '),
    note: readings.map(reading => reading.note).filter(Boolean)[0] || ''});
}
console.log(`读音集合需要改动的:${changed.length} 个`);

const report = ['# 音标按词性补齐报告', '',
  '音标表原按"一个词形一条读音"整理,把"同一书写形式、读音随词性改变"的情况压成了一条:',
  'proceeds 作名词复数(收益)读 /ˈproʊsiːdz/,作动词第三人称单数(进行)读 /prəˈsiːdz/,而表里只有前一条。',
  '本报告只补这类分叉:**原有读音一条不删**,给没有词性的补上词性,缺的那条才新增。', '',
  `- 模型：${model}（prompt v${promptVersion}）`,
  `- 候选词形：${list.length} 个；模型给出判定的：${verdicts.size} 个`,
  `- 读音集合发生变化的：${changed.length} 个`,
  `- API 用量：请求 ${usage.requests} 次，prompt ${usage.prompt} tokens，completion ${usage.completion} tokens`,
  '', '## 逐词对照', ''];
for (const row of changed) report.push(`- **${row.form}**：${row.before || '(无)'} → ${row.after}${row.note ? `　（${row.note}）` : ''}`);
await mkdir(path.dirname(reportPath), {recursive: true});
await writeFile(reportPath, report.join('\n') + '\n', 'utf8');
await writeFile(auditPath, audit.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
console.log(`报告已写入 ${reportPath}`);
if (!APPLY) { console.log('（未加 --apply,仅预演:数据未改动）'); process.exit(0); }

const nextPron = {...pronunciation, entries: Object.fromEntries(Object.entries(pronunciation.entries).map(([form, records]) => [form, nextByForm.get(form) || records])),
  formReadingsModel: `${model}（同一词形的读音按词性分开,规则召回 + 模型裁定）`, formReadingsUpdatedAt: new Date().toISOString()};
await writeReader(nextPron);
