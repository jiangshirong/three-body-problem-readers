import {readFile, appendFile, mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const canonicalPath = path.join(project, 'outputs', 'us-pronunciations-v2.json');
const sourcePath = path.join(project, 'outputs', 'us-pronunciations.json');
const reportPath = path.join(project, 'outputs', 'kaikki-us-pronunciation-audit.jsonl');
const statePath = path.join(project, '本地数据', 'kaikki-us-pronunciation-audit-state.json');
const concurrency = 8;
const checkpointEvery = 50;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const data = JSON.parse(await readFile(canonicalPath, 'utf8'));
const raw = JSON.parse(await readFile(sourcePath, 'utf8'));
const allWords = Object.keys(data.entries).sort((a, b) => a.localeCompare(b));
const selectedWords = process.env.AUDIT_WORDS?.split(',').map(word => word.trim().toLowerCase()).filter(Boolean);
const words = selectedWords?.length ? selectedWords.filter(word => data.entries[word]) : allWords;
let state = {version: 1, source: 'Kaikki/Wiktionary English snapshot 2026-09-02', completed: {}, startedAt: new Date().toISOString()};
try { state = {...state, ...JSON.parse(await readFile(statePath, 'utf8'))}; } catch {}
state.completed ||= {};
await mkdir(path.dirname(reportPath), {recursive: true});

function sourceTitle(word) {
  const records = raw.entries?.[word] || [];
  const candidate = records.find(record => (record.source || '').includes('en.wiktionary.org/wiki/'))?.source;
  if (!candidate) return word;
  const match = candidate.match(/en\.wiktionary\.org\/wiki\/([^#?]+)/i);
  if (!match) return word;
  try { return decodeURIComponent(match[1].replaceAll('+', '_')); } catch { return match[1]; }
}
function jsonlUrl(title) {
  const chars = [...title];
  const dirs = chars.length >= 2 ? [chars[0], chars.slice(0, 2).join(''), title] : [title, title, title];
  const encode = value => encodeURIComponent(value).replaceAll("'", '%27');
  return `https://kaikki.org/dictionary/English/meaning/${dirs.map(encode).join('/')}.jsonl`;
}
function titleCandidates(word) {
  const base=sourceTitle(word), variants=[base,word,word?word[0].toUpperCase()+word.slice(1):word];
  if([...word].length===1)variants.push(word.toUpperCase());
  return [...new Set(variants.filter(Boolean))];
}
function isUS(tags) { return Array.isArray(tags) && tags.some(tag => /^(US|General-American|General American)$/i.test(tag)); }
function ipaKey(ipa) {
  return String(ipa || '').normalize('NFC').toLowerCase()
    .replace(/[\/\[\]ˈˌ.·\s]/g, '')
    .replaceAll('ɚ', 'ər').replaceAll('ɝ', 'ɜːr').replaceAll('ɹ', 'r')
    .replaceAll('ɡ', 'g').replaceAll('ɐ', 'ə');
}
function localForms(word) {
  return (data.entries[word] || []).map(record => ({ipa: record.ipa, pos: record.pos || '', origin: record.origin || ''}));
}
async function fetchWord(word) {
  const titles=titleCandidates(word), attempted=[];
  for(const title of titles){
    const url=jsonlUrl(title);attempted.push(url);
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const response = await fetch(url, {headers: {'user-agent': 'ThreeBodyReaderPronunciationAudit/1.0 (local study project)'}});
        if(response.status===404)break;
        if (response.status === 429 || response.status >= 500) { await delay(800 * (attempt + 1)); continue; }
        if (!response.ok) return {word, title, url, status: `http-${response.status}`, local: localForms(word), sourceUS: []};
        const lines = (await response.text()).trim().split(/\r?\n/).filter(Boolean);
        const entries = lines.map(line => JSON.parse(line)).filter(entry => entry.lang_code === 'en' || entry.lang === 'English');
        const sourceUS = [];
        for (const entry of entries) for (const sound of entry.sounds || []) {
          if (!sound.ipa || !isUS(sound.tags)) continue;
          const chars = [...title];
          const pageDirs = chars.length >= 2 ? [chars[0], chars.slice(0, 2).join(''), title] : [title, title, title];
          const encode = value => encodeURIComponent(value).replaceAll("'", '%27');
          sourceUS.push({ipa: sound.ipa, pos: entry.pos || '', tags: sound.tags || [], audio: sound.audio || '', sourceUrl: `https://kaikki.org/dictionary/English/meaning/${pageDirs.map(encode).join('/')}.html`});
        }
        const unique = [...new Map(sourceUS.map(item => [`${ipaKey(item.ipa)}|${item.pos}|${item.tags.join(',')}`, item])).values()];
        const local = localForms(word);
        const localKeys = new Set(local.map(item => ipaKey(item.ipa)));
        const sourceKeys = new Set(unique.map(item => ipaKey(item.ipa)));
        return {word, title, url, status: unique.length ? 'explicit-us-found' : 'page-found-no-explicit-us-ipa', local,
          sourceUS: unique,
          sourceCandidatesMissingLocally: unique.filter(item => !localKeys.has(ipaKey(item.ipa))),
          localCandidatesNotInWiktionaryUS: local.filter(item => !sourceKeys.has(ipaKey(item.ipa)))};
      } catch (error) {
        if (attempt === 3) return {word, title, url, status: 'request-error', error: String(error.message || error).slice(0, 180), local: localForms(word), sourceUS: []};
        await delay(800 * (attempt + 1));
      }
    }
  }
  return {word, title:titles[0], url:attempted.at(-1), attemptedUrls:attempted, status:'not-found', local:localForms(word), sourceUS:[]};
}

let cursor = 0, doneNow = 0, missing = 0, explicit = 0, noUS = 0, errors = 0;
let writes = Promise.resolve();
async function persist() {
  writes = writes.then(async () => {
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    const all = Object.values(state.completed).sort((a, b) => a.word.localeCompare(b.word));
    await writeFile(reportPath, `${all.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  });
  return writes;
}
async function worker() {
  while (true) {
    const word = words[cursor++];
    if (word === undefined) return;
    if (state.completed[word] && !(process.env.AUDIT_RETRY_ERRORS === '1' && ['not-found', 'request-error'].includes(state.completed[word].status))) continue;
    const result = await fetchWord(word);
    state.completed[word] = result;
    doneNow++;
    if (result.status === 'explicit-us-found') {
      explicit++;
      if (result.sourceCandidatesMissingLocally?.length) missing++;
    } else if (result.status === 'page-found-no-explicit-us-ipa') noUS++;
    else errors++;
    if (doneNow % checkpointEvery === 0) {
      await persist();
      console.log(JSON.stringify({newlyAudited: doneNow, totalComplete: Object.keys(state.completed).length, total: words.length, explicitUS: explicit, pagesWithoutExplicitUS: noUS, missingSourceReadings: missing, errors}));
    }
    await delay(75);
  }
}

console.log(JSON.stringify({total: words.length, resumed: Object.keys(state.completed).length, pending: words.filter(word => !state.completed[word]).length, concurrency, source: state.source, reportPath}));
await Promise.all(Array.from({length: concurrency}, worker));
await persist();
state.finishedAt = new Date().toISOString();
await persist();
const results = Object.values(state.completed);
console.log(JSON.stringify({finished: true, audited: results.length, explicitUS: results.filter(row => row.status === 'explicit-us-found').length, pagesWithoutExplicitUS: results.filter(row => row.status === 'page-found-no-explicit-us-ipa').length, notFound: results.filter(row => row.status === 'not-found').length, errors: results.filter(row => !['explicit-us-found', 'page-found-no-explicit-us-ipa', 'not-found'].includes(row.status)).length, sourceMissing: results.reduce((n, row) => n + (row.sourceCandidatesMissingLocally?.length || 0), 0), reportPath, statePath}));
