// 词族重建(只合并、不拆分):
//   1. 机械规则召回候选近亲词对(4244 对),只看当前是否被分到了不同族——这些才是需要裁定的;
//   2. DeepSeek 逐对判定"是否同一词族",并在同族时指出更基础的那一个词形作为族头;
//   3. 把判为同族的词对做并查集收敛,再与原有划分合并。原有划分只会被合并,绝不被拆开。
// 这样既修掉"否定前缀把词族拆开"这类漏合并,又不会破坏原本正确的结构。
import {createHash} from 'node:crypto';
import {copyFile, mkdir, readFile, rename, unlink, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDpapiSecretStore} from './reader-server.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readerPath = path.join(project, 'outputs', 'three-body-reader.html');
const statePath = path.join(project, '本地数据', 'word-family-rebuild-state.json');
const auditPath = path.join(project, 'outputs', 'deepseek-word-family-adjudication.jsonl');
const reportPath = path.join(project, 'outputs', '词族重建报告.md');
const model = 'deepseek-flash', promptVersion = 2;
const concurrency = 8, maxPairsPerJob = 24, maxCharsPerJob = 5200;
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const APPLY = argv.includes('--apply');
const onlyArg = argv.find(item => item.startsWith('--only='));
const only = onlyArg ? new RegExp(onlyArg.slice('--only='.length)) : null;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const html = await readFile(readerPath, 'utf8');
function grab(id) {
  const at = html.indexOf(`id="${id}"`);
  if (at < 0) throw new Error(`找不到数据块 ${id}`);
  const start = html.indexOf('>', at) + 1;
  return JSON.parse(html.slice(start, html.indexOf('</script>', start)));
}
const families = grab('wordFamiliesData');
const frequency = grab('wordFrequencyData');
const forms = Object.keys(families.forms);
const vocab = new Set(forms);
const countOf = word => frequency.forms?.[word]?.count ?? 0;
const oldHead = word => frequency.forms?.[word]?.familyId || families.forms[word] || word;

// ---------------------------------------------------------------- 候选近亲词对(纯规则召回)
const PREFIXES = ['in','im','ir','il','un','dis','non','mis','over','under','re','pre','anti','co','de','inter','sub','super','trans','out','up'];
const SUFFIXES = ['s','es','ed','d','ing','ly','ness','ment','er','est','ers','ion','tion','sion','ation','able','ible','ive','ity','ty','al','ful','less','ize','ise','ify','ous','ic','ist','ism','ance','ence','ancy','ency','ant','ent','ary','ory','age','dom','hood','ship','ward','wise','en','ish','some'];
const pairs = new Map();
const link = (a, b, rule) => {
  if (a === b || !vocab.has(a) || !vocab.has(b)) return;
  const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
  if (!pairs.has(key)) pairs.set(key, rule);
};
const byPrefix = new Map();
for (const form of forms) for (let n = 5; n <= 7 && n <= form.length; n++) {
  const head = form.slice(0, n);
  if (!byPrefix.has(head)) byPrefix.set(head, []);
  byPrefix.get(head).push(form);
}
const stemMatches = stem => {
  for (let n = Math.min(7, stem.length); n >= 5; n--) {
    const list = byPrefix.get(stem.slice(0, n));
    if (list && list.length > 1) return list.filter(item => item !== stem);
  }
  return [];
};
for (const form of forms) {
  for (const prefix of PREFIXES) {
    if (!form.startsWith(prefix)) continue;
    const stem = form.slice(prefix.length);
    if (stem.length < 4) continue;
    for (const candidate of [stem, stem.endsWith('e') ? stem.slice(0, -1) : null, `${stem}e`]) if (candidate && vocab.has(candidate)) link(form, candidate, `prefix:${prefix}`);
    if (!vocab.has(stem)) for (const match of stemMatches(stem)) link(form, match, `stem:${prefix}`);
  }
  for (const suffix of SUFFIXES) {
    if (!form.endsWith(suffix)) continue;
    const stem = form.slice(0, form.length - suffix.length);
    if (stem.length < 3) continue;
    const variants = new Set([stem, `${stem}e`]);
    if (stem.endsWith('i')) variants.add(`${stem.slice(0, -1)}y`);
    if (stem.endsWith('at')) variants.add(`${stem}te`);
    if (suffix === 's' && stem.length > 3) variants.add(stem.slice(0, -1));
    for (const candidate of variants) if (vocab.has(candidate)) link(form, candidate, `suffix:${suffix}`);
  }
}
// 上面的召回只剥一层后缀,而且剥出来的中间形式必须本身在书里。派生链一旦跨多层就漏了:
// gravitational 剥 -al 得 gravitation,而 gravitation 书里没出现,于是它谁都连不上。
// 这里补一条穿过多层的召回:先把词干反复剥到不能再剥,再让深词干互为前缀的两族配对
// (grav ⊂ gravit 命中;image / imagin 不算,因为差异在中间而不是词尾)。
const NORMALISE = stem => stem.replace(/y$/, 'i').replace(/e$/, '').replace(/(.)\1$/, '$1');
function deepRoot(word) {
  let current = word;
  for (let step = 0; step < 3; step++) {
    let shortest = null;
    for (const suffix of SUFFIXES) {
      if (!current.endsWith(suffix)) continue;
      const stem = current.slice(0, current.length - suffix.length);
      if (stem.length < 4) continue;
      if (!shortest || stem.length < shortest.length) shortest = stem;
    }
    if (!shortest) break;
    current = NORMALISE(shortest);
  }
  return current;
}
const byRoot = new Map();
for (const form of forms) {
  const root = deepRoot(form);
  if (!byRoot.has(root)) byRoot.set(root, []);
  byRoot.get(root).push(form);
}
for (const [root, here] of byRoot) {
  for (let i = 0; i < here.length; i++) for (let j = i + 1; j < here.length; j++) link(here[i], here[j], `root:${root}`);
  if (root.length < 5) continue;
  for (let n = 4; n < root.length; n++) {
    const shorter = byRoot.get(root.slice(0, n));
    // 前缀越短、两族越大,配出来的越多是"只共享开头几个字母"的噪声,加个规模上限。
    if (!shorter || here.length * shorter.length > 400) continue;
    for (const a of here) for (const b of shorter) link(a, b, `root:${root.slice(0, n)}⊂${root}`);
  }
}

// 只在"当前分属不同族"时才需要裁定;同族的词对合不合并结果都一样。
const candidates = [...pairs.entries()].map(([key, rule]) => {
  const [a, b] = key.split('\u0000');
  return {a, b, rule, sameFamilyAlready: oldHead(a) === oldHead(b)};
});
let actionable = candidates.filter(item => !item.sameFamilyAlready);
if (only) actionable = actionable.filter(item => only.test(item.a) || only.test(item.b));

const jobs = [];
let batch = [], size = 0;
for (const pair of actionable) {
  const text = `["${pair.a}","${pair.b}"]`;
  if (batch.length && (batch.length >= maxPairsPerJob || size + text.length + 1 > maxCharsPerJob)) { jobs.push(batch); batch = []; size = 0; }
  batch.push(pair); size += text.length + 1;
}
if (batch.length) jobs.push(batch);

const systemPrompt = `你在为一部英文小说建立词族表。输入是若干对词形,请逐对判断它们是否属于同一词族。
同一词族 = 共享同一词根/词干的屈折形式与派生词:
- 屈折形式(复数 -s/-es、过去式 -ed、进行式 -ing、比较级 -er/-est)与基词同族。
- 派生词(-ly/-ness/-ment/-tion/-sion/-ation/-able/-ible/-ive/-ity/-al/-ance/-ence/-ous/-ize/-ify 等)与基词同族。
- 否定前缀 in-/im-/ir-/il-/un-/dis-/non- 构成的词与其肯定形式同族:incompetent 与 competent 同族,illegal 与 legal 同族,irregular 与 regular 同族,unstable 与 stable 同族。
- 派生链要认到共同的词根:competence、competition、incompetent 同族(incompetent 不要只认到 competent 就停下)。
判断要基于真实的构词关系,不能只看拼写相似。以下都不同族:image/age、income/come、improve/prove、impact/pact、leg/legal、information/form(前者属 inform,后者属 form)、display/play、dismay/may、after/afternoon、again/against、alter/alternate(alter 是"改变",alternate 是"交替",词根不同)。
带连字符的复合形式自成一族,不与其中的单词同族:almost-familiar 与 almost 不同族,already-cold 与 already 不同族,american-accented 与 america、american 都不同族。
对判为同族的词对,再指出两者中更基础(更适合作为族头)的那一个,它必须是这一对里的词之一。
严格返回 JSON:{"pairs":[{"pair":["a","b"],"same":true,"base":"a"},{"pair":["c","d"],"same":false}]}。same 为 false 时省略 base。`;

async function call(pairJob) {
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: `Bearer ${secret}`},
    body: JSON.stringify({model, thinking: {type: 'disabled'}, temperature: 0, response_format: {type: 'json_object'}, max_tokens: 4000,
      messages: [{role: 'system', content: systemPrompt}, {role: 'user', content: JSON.stringify({task: 'judge-word-family-pairs', pairs: pairJob.map(item => [item.a, item.b])})}]})
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const body = await response.json();
  return {raw: body.choices?.[0]?.message?.content || '', usage: body.usage || {}};
}
// 词对的归一化键(与先后顺序无关)。
const keyOf = (x, y) => (x < y ? `${x}\u0000${y}` : `${y}\u0000${x}`);
// 收回答:按词对归一化(模型可能把两个词调换先后,顺序不该让整批作废),
// 也接受只答了一部分——漏掉的那几对由调用方缩小题量再问一次。
function validate(pairJob, raw) {
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed?.pairs) ? parsed.pairs : null;
  if (!list) return null;
  const key = (x, y) => (x < y ? `${x}\u0000${y}` : `${y}\u0000${x}`);
  const expected = new Map(pairJob.map(item => [key(item.a, item.b), item]));
  const out = new Map();
  for (const row of list) {
    // 模型偶尔改用紧凑写法:["a","b",false] 是判决,["a","b","a"] 是族头,
    // ["a","b"] 只列了词对没给判决(整批都这样时就是在省略"不同族")。
    // 判决缺失一律按"不同族"处理:漏写的字段绝不能被读成一次合并。
    let pair = null, verdict = false, named = null;
    if (Array.isArray(row)) {
      pair = row.slice(0, 2);
      const third = row[2];
      if (third === true || third === false) verdict = third;
      else if (typeof third === 'string') { named = third; verdict = third === pair[0] || third === pair[1]; }
    } else if (row && typeof row === 'object') {
      pair = Array.isArray(row.pair) ? row.pair : null;
      verdict = row.same === true;
      named = row.base ?? null;
    }
    if (!pair || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string' || pair[0] === pair[1]) continue;
    const at = key(pair[0], pair[1]);
    if (!expected.has(at) || out.has(at)) continue;
    const [a, b] = pair[0] < pair[1] ? [pair[0], pair[1]] : [pair[1], pair[0]];
    const base = verdict && (named === a || named === b) ? named : (verdict ? a : null);
    out.set(at, {a, b, same: verdict, base});
  }
  return out.size ? out : null;
}

// ---------------------------------------------------------------- 状态、并发、落盘
const candidateHash = createHash('sha256').update(JSON.stringify({promptVersion, model, actionable: actionable.map(item => [item.a, item.b])})).digest('hex');
let state = {version: 1, model, promptVersion, candidateHash, completed: {}, failed: {}, usage: {requests: 0, promptTokens: 0, completionTokens: 0}, startedAt: new Date().toISOString()};
try {
  const prior = JSON.parse(await readFile(statePath, 'utf8'));
  if (prior.candidateHash === candidateHash && prior.promptVersion === promptVersion) state = {...state, ...prior};
} catch {}
state.completed ||= {}; state.failed ||= {}; state.usage ||= {requests: 0, promptTokens: 0, completionTokens: 0};
const atomicWrite = async (file, data) => {
  await mkdir(path.dirname(file), {recursive: true});
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, data, 'utf8');
  try { await rename(temp, file); } catch (error) { if (!['EPERM','EEXIST','EBUSY'].includes(error.code)) throw error; await copyFile(temp, file); await unlink(temp); }
};
const saveState = () => atomicWrite(statePath, `${JSON.stringify(state, null, 2)}\n`);
// 本次是 prompt v2 的全量重判,旧的裁定记录会被覆盖,先留档一份备查。
try { await copyFile(auditPath, path.join(project, '本地数据', 'deepseek-word-family-adjudication-previous.jsonl')); } catch {}

console.log(`候选近亲词对 ${candidates.length} 对,其中当前分属不同族(需要裁定) ${actionable.length} 对,分 ${jobs.length} 批。`);
if (dryRun) { console.log('前 2 批样例:'); for (const job of jobs.slice(0, 2)) console.log('  ' + JSON.stringify(job.map(item => [item.a, item.b, item.rule]))); process.exit(0); }

const secretStore = createDpapiSecretStore(path.join(project, '本地数据', '.reader-cache', 'reader-secrets.dpapi.json'));
const secret = (await secretStore.load()).deepseek;
if (!secret) throw new Error('未找到已保存的 DeepSeek API Key');

const verdicts = new Map();   // "a\u0000b" -> {same, base}
const audit = [];
let cursor = 0, finished = 0, writes = Promise.resolve();
async function worker() {
  while (cursor < jobs.length) {
    const index = cursor++;
    const job = jobs[index];
    if (state.completed[index]) {
      const cached = state.completed[index];
      for (const row of cached.pairs) verdicts.set(`${row.a}\u0000${row.b}`, row);
      if (!cached.missing) { finished++; continue; }
    }
    // 模型偶尔漏答、或把整批写成紧凑/坏掉的形状(24 对时尤其容易走样)。
    // 漏掉的那几对不再整批重问,而是缩到更小的题量再问一次:题量小的时候输出更规矩。
    let result = new Map(), error = '', raw = '';
    if (state.completed[index]) {
      for (const row of state.completed[index].pairs) result.set(keyOf(row.a, row.b), row);
    }
    const ask = async pairs => {
      try {
        const response = await call(pairs);
        raw = String(response.raw).slice(0, 600);
        state.usage.requests += 1;
        state.usage.promptTokens += Number(response.usage.prompt_tokens) || 0;
        state.usage.completionTokens += Number(response.usage.completion_tokens) || 0;
        return validate(pairs, response.raw) || new Map();
      } catch (e) { error = e.message; return new Map(); }
    };
    let queue = [job.filter(item => !result.has(keyOf(item.a, item.b)))];
    for (let round = 0; round < 3 && queue.length; round++) {
      const next = [];
      for (const chunk of queue) {
        const missing = chunk.filter(item => !result.has(keyOf(item.a, item.b)));
        if (!missing.length) continue;
        const got = await ask(missing);
        for (const [key, row] of got) result.set(key, row);
        const still = missing.filter(item => !result.has(keyOf(item.a, item.b)));
        if (!still.length) continue;
        // 还漏就把题量劈成四份:再漏也没关系,下一轮继续劈。
        const size = still.length <= 6 ? still.length : Math.ceil(still.length / 4);
        if (still.length > 6) for (let at = 0; at < still.length; at += size) next.push(still.slice(at, at + size));
        error = `${still.length} 对未作答`;
      }
      queue = next;
      if (queue.length) await wait(400);
    }
    const unanswered = job.filter(item => !result.has(keyOf(item.a, item.b)));
    if (result.size) {
      const rows = [...result.values()];
      for (const row of rows) verdicts.set(`${row.a}\u0000${row.b}`, row);
      state.completed[index] = {pairs: rows, missing: unanswered.length, at: new Date().toISOString()};
      audit.push({batch: index, ok: true, missing: unanswered.length, error: unanswered.length ? error : '', pairs: rows});
      if (unanswered.length) {
        state.failed[index] = {error, at: new Date().toISOString()};
        console.log(`批 ${index} 有 ${unanswered.length} 对未作答(${error}),这些词对维持原判。`);
      } else delete state.failed[index];
    } else {
      state.failed[index] = {error, at: new Date().toISOString()};
      audit.push({batch: index, ok: false, error, raw, pairs: job.map(item => [item.a, item.b])});
      console.log(`批 ${index} 失败(${error}),这些词对维持原判。`);
    }
    finished++;
    if (finished % 5 === 0 || finished === jobs.length) console.log(`  进度 ${finished}/${jobs.length}`);
    writes = writes.catch(() => {}).then(() => Promise.all([saveState(), atomicWrite(auditPath, audit.map(row => JSON.stringify(row)).join('\n') + '\n')]));
    await writes;
    await wait(60);
  }
}
await Promise.all(Array.from({length: concurrency}, worker));
await writes;
const judged = [...verdicts.values()].filter(row => row.same).length;
console.log(`裁定完成:成功 ${Object.keys(state.completed).length} 批,失败 ${Object.keys(state.failed).length} 批,判为同族 ${judged} 对。`);

// ---------------------------------------------------------------- 合并(只合不拆)
// 原有划分整体保留:每个词形先接上自己的原族头;再把"判为同族"的词对连起来。
const head = new Map(forms.map(form => [form, oldHead(form)]));
const nodes = new Map();
const ensureNode = node => { if (!nodes.has(node)) nodes.set(node, node); return node; };
const find = x => { while (nodes.get(x) !== x) { nodes.set(x, nodes.get(nodes.get(x))); x = nodes.get(x); } return x; };
const union = (a, b) => { const ra = find(ensureNode(a)), rb = find(ensureNode(b)); if (ra !== rb) nodes.set(ra, rb); };
for (const form of forms) { ensureNode(form); union(form, head.get(form)); }
for (const row of verdicts.values()) if (row.same) union(row.a, row.b);
const grouped = new Map();
for (const form of forms) {
  const root = find(form);
  if (!grouped.has(root)) grouped.set(root, []);
  grouped.get(root).push(form);
}
const baseVotes = new Map();
for (const row of verdicts.values()) if (row.same && row.base) baseVotes.set(row.base, (baseVotes.get(row.base) || 0) + 1);
const references = new Map();
for (const form of forms) references.set(head.get(form), (references.get(head.get(form)) || 0) + 1);
const finalHead = new Map();
for (const members of grouped.values()) {
  const pick = members.find(member => baseVotes.has(member))
    || members.find(member => (references.get(member) || 0) > 0)
    || [...members].sort((a, b) => countOf(b) - countOf(a) || a.length - b.length || a.localeCompare(b))[0];
  for (const member of members) finalHead.set(member, pick);
}
// 族头落在书中不存在的词上时(旧数据遗留),改用族内被指向最多的真实词形,成员与计数都不变。
for (const members of grouped.values()) {
  const current = finalHead.get(members[0]);
  if (vocab.has(current)) continue;
  const pick = [...members].sort((a, b) => (references.get(b) || 0) - (references.get(a) || 0) || countOf(b) - countOf(a) || a.length - b.length || a.localeCompare(b))[0];
  for (const member of members) finalHead.set(member, pick);
}

// ---------------------------------------------------------------- 报告
const beforeFamilies = new Map(), afterFamilies = new Map();
for (const form of forms) {
  const before = oldHead(form);
  if (!beforeFamilies.has(before)) beforeFamilies.set(before, []);
  beforeFamilies.get(before).push(form);
  const after = finalHead.get(form);
  if (!afterFamilies.has(after)) afterFamilies.set(after, []);
  afterFamilies.get(after).push(form);
}
const NEGATION_PREFIXES = ['in', 'im', 'ir', 'il', 'un', 'dis', 'non'];
const INFLECTIONS = ['s', 'es', 'ed', 'd', 'ing'];
const inBook = word => vocab.has(word) && Boolean(frequency.forms?.[word]);
const measure = (rules) => {
  const list = [];
  for (const form of forms) for (const candidate of rules(form)) if (candidate !== form && inBook(candidate)) list.push([form, candidate]);
  const rate = fn => list.length ? (list.filter(([a, b]) => fn(a) === fn(b)).length / list.length * 100).toFixed(1) : 'n/a';
  return {total: list.length, before: rate(oldHead), after: rate(word => finalHead.get(word)), list};
};
const negation = measure(form => NEGATION_PREFIXES.filter(p => form.startsWith(p) && form.length - p.length >= 4).map(p => form.slice(p.length)));
const inflection = measure(form => INFLECTIONS.filter(suffix => form.endsWith(suffix) && form.length - suffix.length >= 3).map(suffix => form.slice(0, form.length - suffix.length)));

const sizes = [...afterFamilies.values()].map(list => list.length);
const report = [
  '# 词族重建报告', '',
  '本报告只做合并、不做拆分:原有划分整体保留,只补齐"同一词族却被分到不同族"的情况。',
  '',
  `- 模型：${model}（prompt v${promptVersion}）`,
  `- 候选近亲词对：${candidates.length} 对；其中当前分属不同族、需要裁定：${actionable.length} 对`,
  `- 裁定：成功 ${Object.keys(state.completed).length} 批 / 失败 ${Object.keys(state.failed).length} 批；判为同族 ${judged} 对`,
  `- API 用量：请求 ${state.usage.requests} 次，prompt ${state.usage.promptTokens} tokens，completion ${state.usage.completionTokens} tokens`,
  `- 词族数：${beforeFamilies.size} → ${afterFamilies.size}（净减少 ${beforeFamilies.size - afterFamilies.size} 族）`,
  `- 只含 1 个词的族：${[...beforeFamilies.values()].filter(l => l.length === 1).length} → ${sizes.filter(n => n === 1).length}`,
  `- 词形归属发生变化的：${forms.filter(form => oldHead(form) !== finalHead.get(form)).length} 个`,
  '', '## 验收指标（近亲词对同族率）', '',
  `- 否定前缀词对（in-/im-/ir-/il-/un-/dis-/non-）：${negation.before}% → **${negation.after}%**（${negation.total} 对）`,
  `- 屈折变化词对（-s/-ed/-ing）：${inflection.before}% → **${inflection.after}%**（${inflection.total} 对）`,
  '', '## 关键样例', ''
];
for (const word of ['competence', 'incompetent', 'illegal', 'legal', 'unstable', 'stable', 'information', 'form', 'image', 'leg', 'irregular', 'responsible', 'gravity', 'gravitational']) {
  if (!vocab.has(word)) { report.push(`- ${word}：书中没有此词形`); continue; }
  const members = afterFamilies.get(finalHead.get(word)) || [];
  report.push(`- **${word}** → 族头 \`${finalHead.get(word)}\`（原为 \`${oldHead(word)}\`），本族 ${members.length} 词：${members.slice(0, 16).join(', ')}${members.length > 16 ? ' …' : ''}`);
}
report.push('', '## 本次新增的合并（原分属不同族）', '');
const merges = [];
for (const [root, members] of afterFamilies) {
  if (members.length < 2) continue;
  const before = [...new Set(members.map(oldHead))];
  if (before.length > 1) merges.push({root, total: members.length, before});
}
merges.sort((a, b) => b.total - a.total);
report.push(`共 ${merges.length} 个族由多族合并而成。最大的 25 个：`, '');
for (const merge of merges.slice(0, 25)) report.push(`- \`${merge.root}\`（${merge.total} 词）原分属 ${merge.before.length} 族：${merge.before.slice(0, 10).map(r => `\`${r}\``).join(', ')}${merge.before.length > 10 ? ' …' : ''}`);
report.push('', '## 仍被分开的否定前缀词对（需要人工看一眼）', '');
const still = negation.list.filter(([a, b]) => finalHead.get(a) !== finalHead.get(b));
report.push(`共 ${still.length} 对：`, '');
for (const [a, b] of still.slice(0, 40)) report.push(`- ${a}（\`${finalHead.get(a)}\`） vs ${b}（\`${finalHead.get(b)}\`）`);
await atomicWrite(reportPath, report.join('\n') + '\n');
console.log(`报告已写入 ${reportPath}`);
console.log(`否定前缀词对同族率 ${negation.before}% → ${negation.after}%;屈折词对 ${inflection.before}% → ${inflection.after}%`);

// ---------------------------------------------------------------- 回写 HTML
if (APPLY) {
  const nextFamiliesData = {...families, schema: families.schema || 1, model: `${model}（rule-recall + pairwise-adjudication + transitive-closure）`, generatedAt: new Date().toISOString(),
    forms: Object.fromEntries(forms.map(form => [form, finalHead.get(form)])),
    groups: Object.fromEntries([...afterFamilies].map(([root, members]) => [root, [...members].sort()]))};
  const nextFamilyCounts = {};
  for (const [root, members] of afterFamilies) nextFamilyCounts[root] = members.reduce((sum, member) => sum + countOf(member), 0);
  const nextFrequencyData = {...frequency, familyCounts: nextFamilyCounts,
    forms: Object.fromEntries(Object.entries(frequency.forms).map(([form, entry]) => [form, {...entry, familyId: finalHead.get(form)}]))};
  const embed = (source, id, value) => {
    const at = source.indexOf(`id="${id}"`);
    const start = source.indexOf('>', at) + 1;
    const end = source.indexOf('</script>', start);
    return source.slice(0, start) + JSON.stringify(value).replace(/</g, '\\u003c') + source.slice(end);
  };
  let next = embed(html, 'wordFamiliesData', nextFamiliesData);
  next = embed(next, 'wordFrequencyData', nextFrequencyData);
  await atomicWrite(path.join(project, '本地数据', 'three-body-reader-before-family-rebuild.html'), html);
  await atomicWrite(readerPath, next);
  console.log(`已回写 ${readerPath}（原文件备份在 本地数据/three-body-reader-before-family-rebuild.html）`);
}
