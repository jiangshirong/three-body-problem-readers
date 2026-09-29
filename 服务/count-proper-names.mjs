// 给专名表补上"整个名字在书里出现几次"(纯本地统计,不调用接口)。
// 注意:每个候选必须映射回它自己那条名字,不能靠"词形相同"去找(否则 Red Coast / Red Coast's 会挤进同一个桶)。
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readerFile = path.join(project, 'outputs', 'three-body-reader.html');
let reader = await readFile(readerFile, 'utf8');
const json = id => JSON.parse((reader.match(new RegExp('<script id="' + id + '" type="application/json">([^]*?)</script>')) || [])[1]);
const chapters = json('bookData');
const nameData = json('properNamesData');
const frequency = json('wordFrequencyData');

const strip = v => String(v).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
const paragraphsOf = c => [...chapters[c].content.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map(m => strip(m[1])).filter(t => t.length > 0 && /[A-Za-z]/.test(t));
const wp = /[\p{L}]+(?:['’'-][\p{L}]+)*/gu;
const token = text => String(text).trim().toLowerCase().replaceAll('’', "'").replace(/'s$/, '');
// 合计时忽略虚词,否则 THE/of 会把数值带偏
const stop = new Set('the a an of and to in on at for with by from'.split(/\s+/));

const names = nameData.names.map(tokens => tokens.map(String));
const byFirst = new Map();
for (const tokens of names) {
  const phrase = tokens.join(' ');
  const key = token(tokens[0]);
  if (!byFirst.has(key)) byFirst.set(key, []);
  byFirst.get(key).push({phrase, tokens: tokens.map(token)});
}
const counts = new Map(names.map(tokens => [tokens.join(' '), 0]));
for (let chapter = 0; chapter < chapters.length; chapter++) {
  paragraphsOf(chapter).forEach(text => {
    const items = [...String(text).matchAll(wp)].map(m => m[0]);
    for (let index = 0; index < items.length; index++) {
      const candidates = byFirst.get(token(items[index]));
      if (!candidates) continue;
      for (const entry of candidates) {
        if (!entry.tokens.every((word, offset) => items[index + offset] && token(items[index + offset]) === word)) continue;
        counts.set(entry.phrase, (counts.get(entry.phrase) || 0) + 1);
      }
    }
  });
}
const formCount = word => frequency.forms?.[token(word)]?.count || 0;
const summary = {};
for (const tokens of names) {
  const phrase = tokens.join(' ');
  const sum = tokens.filter(word => !stop.has(token(word))).reduce((total, word) => total + formCount(word), 0);
  summary[phrase] = {name: counts.get(phrase) || 0, words: sum};
}
const top = Object.entries(summary).sort((a, b) => b[1].name - a[1].name).slice(0, 12);
console.log('专名 ' + names.length + ' 个。出现最多的:');
for (const [phrase, info] of top) console.log('  ' + String(info.name).padStart(4) + ' 次  ' + phrase + '（其中各实义词词形合计 ' + info.words + '）');
console.log('统计为 0 次: ' + Object.values(summary).filter(info => info.name === 0).length + ' 个');

const payload = JSON.stringify({...nameData, counts: summary}).replace(/\$/g, '$$$$');
reader = reader.replace(/(<script id="properNamesData" type="application\/json">)[^]*?(<\/script>)/, '$1' + payload + '$2');
await writeFile(readerFile, reader, 'utf8');
console.log('已写入 properNamesData.counts');
