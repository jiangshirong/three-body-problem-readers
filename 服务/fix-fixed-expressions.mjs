// 一次性收尾:把两次都被模型判歪的两处修正,并把它们所属的固定说法补进专名补充表,
// 使"Flying Blade"/"Stars and Stripes"里的词按整段中文处理(飞刃 / 星条旗)。
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readerFile = path.join(project, 'outputs', 'three-body-reader.html');
const stateFile = path.join(project, '本地数据', 'contextual-glosses-v1.json');
const supplementFile = path.join(project, '本地数据', '专名补充.json');
const model = 'deepseek-flash';
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');

let reader = await readFile(readerFile, 'utf8');
const embeddedJson = id => JSON.parse((reader.match(new RegExp('<script id="' + id + '" type="application/json">([^]*?)</script>')) || [])[1]);
const chapters = embeddedJson('bookData');
const nameData = embeddedJson('properNamesData');
const state = JSON.parse(await readFile(stateFile, 'utf8'));
const entries = state.entries;
const strip = v => String(v).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
const paragraphsOf = c => [...chapters[c].content.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map(m => strip(m[1])).filter(t => t.length > 0 && /[A-Za-z]/.test(t));
const wp = /[\p{L}]+(?:['’'-][\p{L}]+)*/gu;
const asciiWords = v => [...String(v).matchAll(/[A-Za-z]+(?:['’\-][A-Za-z]+)*/g)].length;

// 固定说法 → 整段中文
const SUPPLEMENT = [
  {tokens: ['Flying', 'Blade'], chinese: '飞刃'},
  {tokens: ['Stars', 'and', 'Stripes'], chinese: '星条旗'}
];
const existing = new Set(nameData.names.map(tokens => tokens.map(t => t.toLowerCase()).join(' ')));
const added = [];
for (const item of SUPPLEMENT) if (!existing.has(item.tokens.map(t => t.toLowerCase()).join(' '))) added.push(item.tokens);

// 找出这些说法在书里的每一处,把其词位填上整段中文
const slots = new Map();
for (let chapter = 0; chapter < chapters.length; chapter++) {
  paragraphsOf(chapter).forEach((text, paragraph) => {
    const items = [];
    let ordinal = 0;
    for (const match of String(text).matchAll(wp)) { items.push({word: match[0], id: chapter + ':' + paragraph + ':' + ordinal}); ordinal += Math.max(1, asciiWords(match[0])); }
    for (let index = 0; index < items.length; index++) {
      for (const item of SUPPLEMENT) {
        const ok = item.tokens.every((token, offset) => items[index + offset] && items[index + offset].word.toLowerCase().replaceAll('’', "'").replace(/'s$/, '') === token.toLowerCase());
        if (!ok) continue;
        for (let offset = 0; offset < item.tokens.length; offset++) slots.set(items[index + offset].id, item.chinese);
      }
    }
  });
}
console.log('补充专名: ' + SUPPLEMENT.map(item => item.tokens.join(' ') + '→' + item.chinese).join('，'));
console.log('命中词位 ' + slots.size + ' 处，其中原本没有释义的 ' + [...slots.keys()].filter(id => !Object.hasOwn(entries, id)).length + ' 处');
for (const [id, chinese] of slots) {
  const before = entries[id];
  if (before !== chinese) console.log('  ' + id.padEnd(11) + '原有 ' + JSON.stringify(before || null) + ' → ' + chinese);
}
if (!APPLY) { console.log('\n（未加 --apply，未写入）'); process.exit(0); }

const merged = {...entries};
for (const [id, chinese] of slots) merged[id] = chinese;
const nextNames = [...nameData.names, ...added].sort((a, b) => b.join(' ').length - a.join(' ').length);
const blockId = 'properNamesData';
const payload = JSON.stringify({...nameData, names: nextNames}).replace(/\$/g, '$$$$');
reader = reader.replace(new RegExp('(<script id="' + blockId + '" type="application/json">)[^]*?(</script>)'), '$1' + payload + '$2');
const glossPayload = JSON.stringify({version: 2, indexVersion: 2, entries: merged}).replace(/</g, '\\u003c');
reader = reader.replace(/(const contextualGlossData = ).*?;/, '$1' + glossPayload.replace(/\$/g, '$$$$') + ';');
await writeFile(readerFile, reader, 'utf8');
const atomicJson = async (file, value) => {
  await mkdir(path.dirname(file), {recursive: true});
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
};
await atomicJson(stateFile, {...state, entries: merged});
await atomicJson(supplementFile, {schema: 1, note: '手工补充的固定说法:其中的词按整段中文处理', names: SUPPLEMENT.map(item => ({tokens: item.tokens, chinese: item.chinese}))});
console.log('\n已写入:专名表 ' + nameData.names.length + ' → ' + nextNames.length + '，释义 ' + Object.keys(entries).length + ' → ' + Object.keys(merged).length);
console.log('补充表: ' + supplementFile);
