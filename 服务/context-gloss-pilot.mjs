import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDpapiSecretStore} from './reader-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, '..');
const output = path.join(project, 'outputs', '句中释义试跑.html');
const reader = await readFile(path.join(project, 'outputs', 'three-body-reader.html'), 'utf8');
const data = id => JSON.parse(reader.match(new RegExp(`<script id="${id}" type="application/json">([\\s\\S]*?)<\\/script>`))?.[1] || 'null');
const chapters = data('bookData');
const dictionary = data('dictionaryData');
const strip = value => value.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\\s+/g, ' ').trim();
const words = value => [...value.matchAll(/[A-Za-z]+(?:['’'-][A-Za-z]+)*/g)];
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const lexical = word => /^(?:n|v|vi|vt|a|adj|ad|adv|s)\./i.test((dictionary.entries[word.toLowerCase().replaceAll('’', "'")]?.translation || '').trim());
function paragraphs(chapterIndex) {
  return [...chapters[chapterIndex].content.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map(match => strip(match[1])).filter(text => text.length > 0 && /[A-Za-z]/.test(text));
}
const samples = [
  {chapter:10, paragraph:0, label:'叙述：人物语气与动作'},
  {chapter:18, paragraph:0, label:'技术背景：学术与专业词汇'},
  {chapter:28, paragraph:2, label:'对话：评价与抽象表达'}
].map(sample => {
  const all = paragraphs(sample.chapter);
  const text = all[sample.paragraph];
  const targets = words(text).map((match, index) => ({index, word:match[0]})).filter(target => lexical(target.word));
  return {...sample, title:chapters[sample.chapter].title, text, before:all[sample.paragraph - 1] || '', after:all[sample.paragraph + 1] || '', targets};
});
const payload = {task:'contextual-gloss-pilot-v1', instructions:'只解释 targets 中列出的实词。每条 gloss 是该词在对应 target paragraph 中的极短中文句中义，通常 2 到 10 个汉字；不得翻译整句，不得解释语法，不得输出 targets 以外的词，不得复述 context。before 与 after 仅供判断指代和语气。返回严格 JSON：{"entries":[{"id":"chapter:paragraph:index","gloss":""}]}，每个 target 必须恰好一条。', samples:samples.map(sample => ({id:`${sample.chapter}:${sample.paragraph}`, targetParagraph:sample.text, before:sample.before, after:sample.after, targets:sample.targets.map(target => ({id:`${sample.chapter}:${sample.paragraph}:${target.index}`, word:target.word}))}))};
const store = createDpapiSecretStore(path.join(project, '本地数据', '.reader-cache', 'reader-secrets.dpapi.json'));
const secret = (await store.load()).deepseek;
if (!secret) throw new Error('没有找到 DeepSeek 密钥；请先在阅读器设置中保存密钥。');
const system = '你是中文母语者使用的英语小说句中义词典。严格遵守用户 JSON 中的 instructions。';
const response = await fetch('https://api.deepseek.com/chat/completions', {method:'POST', headers:{'Content-Type':'application/json', Authorization:`Bearer ${secret}`}, body:JSON.stringify({model:'deepseek-flash', thinking:{type:'disabled'}, temperature:0, response_format:{type:'json_object'}, max_tokens:2400, messages:[{role:'system',content:system},{role:'user',content:JSON.stringify(payload)}]})});
if (!response.ok) throw new Error(`DeepSeek 请求失败：${response.status} ${await response.text()}`);
const result = await response.json();
const content = result.choices?.[0]?.message?.content;
let parsed;
try { parsed = JSON.parse(content); } catch { throw new Error('模型没有返回可解析的 JSON，未生成检查页。'); }
const targetMap = new Map(samples.flatMap(sample => sample.targets.map(target => [`${sample.chapter}:${sample.paragraph}:${target.index}`, target])));
const entries = new Map();
for (const entry of parsed.entries || []) if (typeof entry?.id === 'string' && typeof entry?.gloss === 'string' && targetMap.has(entry.id)) entries.set(entry.id, entry.gloss.trim());
const missing = [...targetMap.keys()].filter(id => !entries.has(id));
const usage = result.usage || {};
const inputTokens = usage.prompt_tokens || 0, outputTokens = usage.completion_tokens || 0;
const estimatedCost = (inputTokens * 1 + outputTokens * 4) / 1_000_000;
const rows = samples.map(sample => {
  let cursor = 0, ordinal = 0;
  const decorated = words(sample.text).map(match => {
    const start = match.index, word = match[0], id = `${sample.chapter}:${sample.paragraph}:${ordinal++}`;
    const before = escape(sample.text.slice(cursor, start)); cursor = start + word.length;
    const gloss = entries.get(id);
    return before + (gloss ? `<mark title="${escape(gloss)}">${escape(word)}<small>${escape(gloss)}</small></mark>` : escape(word));
  }).join('') + escape(sample.text.slice(cursor));
  const list = sample.targets.map(target => `<tr><td>${escape(target.word)}</td><td>${escape(entries.get(`${sample.chapter}:${sample.paragraph}:${target.index}`) || '—')}</td></tr>`).join('');
  return `<section><p class="meta">${escape(sample.label)} · ${escape(sample.title)}</p><h2>目标段落</h2><p class="paragraph">${decorated}</p><details><summary>仅供模型判断的上下文</summary><p>${escape(sample.before || '（无前文）')}</p><p>${escape(sample.after || '（无后文）')}</p></details><table><thead><tr><th>实词</th><th>模型给出的句中义</th></tr></thead><tbody>${list}</tbody></table></section>`;
}).join('');
const html = `<!doctype html><meta charset="utf-8"><title>句中释义试跑</title><style>body{margin:0;background:#f5f0e6;color:#292720;font:16px/1.7 system-ui,"Microsoft YaHei",sans-serif}.wrap{max-width:960px;margin:auto;padding:34px 24px 80px}h1{font:600 30px/1.25 Georgia,serif;margin:0 0 8px}h2{font:600 18px/1.4 Georgia,serif;margin:20px 0 8px}.intro,.meta,details{color:#766f63}.intro{margin:0 0 24px}.summary{display:flex;flex-wrap:wrap;gap:10px;margin:20px 0 28px}.badge{background:#ebe2d2;border:1px solid #d9cdb9;border-radius:999px;padding:4px 10px;font-size:14px}section{border-top:1px solid #d9cdb9;padding:20px 0}.meta{font-size:14px;margin:0}.paragraph{font:20px/1.8 Georgia,"Times New Roman",serif;margin:8px 0 16px}mark{position:relative;background:#fff0b5;padding:0 2px;border-radius:3px;cursor:help}mark small{display:none;position:absolute;z-index:1;left:0;bottom:100%;white-space:nowrap;background:#39352d;color:#fff;padding:2px 6px;border-radius:4px;font:13px/1.4 system-ui}mark:hover small{display:block}details{border-left:2px solid #d9cdb9;padding-left:12px;margin:14px 0}details p{margin:8px 0;font-size:14px}table{border-collapse:collapse;width:100%;margin-top:16px;background:#fbf8f0}th,td{border:1px solid #ded4c3;padding:7px 10px;text-align:left}th{background:#eee5d6;font-weight:600}td:first-child{width:34%;font-family:Georgia,serif}.warn{color:#9a4937}</style><main class="wrap"><h1>句中释义 · 小范围试跑</h1><p class="intro">黄色词语为模型返回的句中义；悬停可快速查看，下面表格可逐项核对。前后文只发给模型判断，不应被解释。</p><div class="summary"><span class="badge">模型：DeepSeek-V4.1-Flash</span><span class="badge">目标实词：${targetMap.size}</span><span class="badge">返回：${entries.size}</span><span class="badge">输入：${inputTokens.toLocaleString()} tokens</span><span class="badge">输出：${outputTokens.toLocaleString()} tokens</span><span class="badge">本次估算：¥${estimatedCost.toFixed(4)}</span></div>${missing.length ? `<p class="warn">缺少 ${missing.length} 条结果：${escape(missing.join(', '))}</p>` : ''}${rows}</main>`;
await writeFile(output, html, 'utf8');
console.log(JSON.stringify({page:'/句中释义试跑.html', targets:targetMap.size, returned:entries.size, inputTokens, outputTokens, estimatedCost}, null, 2));
