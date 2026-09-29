import http from 'node:http';
import {checkKey} from '../key-check.mjs';
import { readFile, writeFile, mkdir, rename, unlink, readdir, stat } from 'node:fs/promises';
import {pruneAudio} from './audio-cache.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dictionaryAudio } from './reader-dictionary.mjs';
import { createVoiceCloning, CLONE_BODY_LIMIT } from './reader-voice-cloning.mjs';
import {createLocal} from './reader-local.mjs';
import {createOnboarding} from './reader-onboarding.mjs';
import {createDefaultVoice} from '../default-voice.mjs';
import {splitSpeech,joinWav} from './reader-qwen-flash.mjs';

import {DEFAULT_RUSSIAN_PROMPT,editableRussianPrompt,composeRussianPrompt} from '../ai-prompt.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTRUCTIONS = '使用自然美式英语。旁白沉稳，对话体现人物意图；根据句意变化重音、节奏和语调。避免每句话使用相同的抑扬模式。保持原文，不添加台词，不刻意夸张。';
const LEGACY_INSTRUCTIONS = 'Read the supplied English text verbatim in natural General American English, as a thoughtful audiobook narrator. Use meaning-based phrasing, natural connected speech and reductions, and restrained emotion. Respect paragraph and sentence boundaries without exaggerated pauses. Do not add an introduction, commentary, or sound effects.';
const VOICES = ['marin', 'cedar', 'coral'];
const ALI_MODELS = Object.freeze({
  'qwen3-tts-flash': Object.freeze(['Jennifer','Aiden']),
  'qwen-audio-3.0-tts-flash': Object.freeze(['loongjohn', 'loongeva_v3.6']),
  'qwen-audio-3.0-tts-plus': Object.freeze(['longanlingxin', 'longanlufeng'])
});
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });
const SECRET_FIELDS = ['aliyun', 'deepseek', 'openai', 'elevenlabs', 'merriam'];
// Marking payloads carry per-mark first-location records on top of the mark lists.
const MARK_BODY_LIMIT = 3 * 1024 * 1024;
const DPAPI_BOOTSTRAP = "$ErrorActionPreference='Stop'; $env:PSModulePath=[Environment]::GetEnvironmentVariable('PSModulePath','Machine')+';'+[Environment]::GetEnvironmentVariable('PSModulePath','User'); Import-Module Microsoft.PowerShell.Security -ErrorAction Stop; ";
const DPAPI_ENCRYPT = DPAPI_BOOTSTRAP + "$plain=[Console]::In.ReadToEnd(); $secure=ConvertTo-SecureString -String $plain -AsPlainText -Force; [Console]::Out.Write((ConvertFrom-SecureString -SecureString $secure))";
const DPAPI_DECRYPT = DPAPI_BOOTSTRAP + "$cipher=[Console]::In.ReadToEnd().Trim(); $secure=ConvertTo-SecureString -String $cipher; $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure); try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }";

function powerShell(script, input) {
  return new Promise((resolve, reject) => {
    const systemPowerShell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(systemPowerShell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide:true, stdio:['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill(), 15000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject);
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(stderr || 'PowerShell failed')); });
    child.stdin.end(input, 'utf8');
  });
}

export function createDpapiSecretStore(file) {
  return {
    async load() {
      let encoded;
      try { encoded = JSON.parse(await readFile(file, 'utf8')); } catch { return {}; }
      if (encoded?.version !== 1 || !encoded.secrets || typeof encoded.secrets !== 'object') return {};
      const entries = await Promise.all(SECRET_FIELDS.map(async key => {
        const value = encoded.secrets[key];
        if (typeof value !== 'string' || value.length > 10000) return [key, ''];
        try { return [key, await powerShell(DPAPI_DECRYPT, value)]; } catch { return [key, '']; }
      }));
      return Object.fromEntries(entries);
    },
    async save(secrets) {
      const entries = await Promise.all(SECRET_FIELDS.map(async key => [key, secrets[key] ? await powerShell(DPAPI_ENCRYPT, secrets[key]) : '']));
      const temporary = file + '.tmp';
      await writeFile(temporary, JSON.stringify({ version:1, secrets:Object.fromEntries(entries) }), { encoding:'utf8', mode:0o600 });
      await rename(temporary, file);
    },
    async clear() { try { await unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  };
}
export function speechSpec(body, customVoices = []) {
  if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 4500) throw fail(400, '请选择 1–4500 字符的段落。超长段落请选取完整句子。');
  const text = body.text.trim();
  if (body.instructions !== undefined && (typeof body.instructions !== 'string' || body.instructions.length > 1000)) throw fail(400, '朗读提示词最多 1000 字符。');
  const instructions = body.instructions?.trim() || INSTRUCTIONS;
  if (body.provider === 'aliyun') {
    if(body.model==='qwen3-tts-flash'){
      if(!ALI_MODELS[body.model].includes(body.voice))throw fail(400,'请选择男声或女声。');
      return {provider:'aliyun',model:body.model,voice:body.voice,text,language:'English',format:'wav',segmentationVersion:1};
    }
    if (!Object.hasOwn(ALI_MODELS, body.model) || !(ALI_MODELS[body.model].includes(body.voice) || customVoices.some(v=>v.voice===body.voice&&v.model===body.model))) throw fail(400, '请选择有效的阿里云 Flash 或 Plus 音色。');
    return { provider:'aliyun', model:body.model, voice:body.voice, text, instructions, format:'mp3', sampleRate:24000 };
  }
  if (body.provider === 'openai') {
    if (!VOICES.includes(body.voice)) throw fail(400, '请选择有效的 OpenAI 音色。');
    return { provider: 'openai', voice: body.voice, model: 'gpt-4o-mini-tts', text, instructions };
  }
  if (body.provider === 'elevenlabs') {
    if (!/^[a-zA-Z0-9_-]{10,100}$/.test(body.voice || '') || !['eleven_multilingual_v2', 'eleven_v3'].includes(body.model)) throw fail(400, '请先选择 ElevenLabs 音色与模型。');
    return { provider: 'elevenlabs', voice: body.voice, model: body.model, text };
  }
  throw fail(400, '未知的朗读服务。');
}

export function createReaderServer({ root = HERE, cacheRoot, instanceId, fetchImpl = fetch, keys = {}, secretStore, serveStatic, language = 'en' } = {}) {
  const secrets = { aliyun: keys.aliyun ?? process.env.DASHSCOPE_API_KEY ?? '', deepseek: keys.deepseek ?? process.env.DEEPSEEK_API_KEY ?? '', openai: keys.openai || process.env.OPENAI_API_KEY || '', elevenlabs: keys.elevenlabs || process.env.ELEVENLABS_API_KEY || '', merriam: keys.merriam || process.env.MERRIAM_WEBSTER_API_KEY || '' };
  const csrf = randomBytes(24).toString('hex');
  const cache = cacheRoot || path.join(root, '.reader-cache');
  let audioQueue=Promise.resolve();
  function audioOperation(fn){const task=audioQueue.catch(()=>{}).then(fn);audioQueue=task;return task;}
  const local=createLocal({directory:cacheRoot?path.resolve(cacheRoot,'../../本地朗读'):path.join(cache,'local-tts')});
  const onboarding=createOnboarding(path.join(cache,'onboarding.json'));
  const aiPrompt=createAiPrompt(path.join(cacheRoot?path.dirname(cache):cache,language==='ru'?'ai-prompt-ru.json':'ai-prompt.json'),language==='ru'?DEFAULT_RUSSIAN_PROMPT:DEFAULT_AI_PROMPT,language==='ru'?editableRussianPrompt:undefined);
  const pending = new Map();
  const usageFile = path.join(cache, 'usage.json');
  const learningMarksFile = path.join(cache, 'learning-marks.json');
  const customVoices = createVoiceCloning({cache,upstream,getKey:()=>secrets.aliyun});
  const ensureDefaultVoice=createDefaultVoice({voices:customVoices,getKey:()=>secrets.aliyun});
  let customVoiceError = '';
  const persistedSecrets = secretStore || (root === HERE ? createDpapiSecretStore(path.join(cache, 'reader-secrets.dpapi.json')) : null);
  let usage, usageWrites = Promise.resolve();
  let learningMarks = { version:1, rare:[], learning:[], fresh:[], phrases:[], origins:{}, updatedAt:null };
  let learningMarksWrites = Promise.resolve();
  const cleanMarkList = value => Array.isArray(value) ? [...new Set(value.filter(item => typeof item === 'string' && item.trim() && item.length <= 200))] : [];
  const MARK_ORIGIN_KINDS = ['rare', 'learning', 'fresh', 'phrases'];
  const MARK_ORIGIN_LIMIT = 4000;
  // A first-mark record is where and when the reader first tagged this word or phrase.
  // The anchor points at one specific word: chapter, block (paragraph ordinal in the chapter),
  // block fingerprint, the word's ordinal inside that block, its ordinal across the chapter,
  // and the surface forms of up to three words on each side for disambiguation.
  const cleanOrigin = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const chapter = Number(value.chapter);
    if (!Number.isSafeInteger(Math.trunc(chapter)) || chapter < 0) return null;
    const ordinal = (input, fallback) => {
      const number = Number(input);
      return Number.isSafeInteger(Math.trunc(number)) && number >= 0 ? Math.trunc(number) : fallback;
    };
    const text = input => typeof input === 'string' ? input.slice(0, 200) : '';
    const surfaces = input => Array.isArray(input) ? input.filter(item => typeof item === 'string' && item.trim() && item.length <= 100).slice(0, 5) : [];
    return {
      chapter:Math.trunc(chapter),
      block:ordinal(value.block, ordinal(value.index, -1)),
      blockText:text(value.blockText) || text(value.text),
      wordIndex:ordinal(value.wordIndex, 0),
      ordinal:ordinal(value.ordinal, 0),
      word:text(value.word).slice(0, 100),
      before:surfaces(value.before),
      after:surfaces(value.after),
      at:typeof value.at === 'string' && value.at.length <= 40 && !Number.isNaN(Date.parse(value.at)) ? value.at : null
    };
  };
  const cleanOrigins = value => {
    const out = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
    for (const kind of MARK_ORIGIN_KINDS) {
      const source = value[kind];
      if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
      const entries = {};
      for (const [key, item] of Object.entries(source)) {
        if (Object.keys(entries).length >= MARK_ORIGIN_LIMIT) break;
        if (typeof key !== 'string' || !key.trim() || key.length > 200) continue;
        const origin = cleanOrigin(item);
        if (origin) entries[key] = origin;
      }
      if (Object.keys(entries).length) out[kind] = entries;
    }
    return out;
  };
  const cleanLearningMarks = value => ({
    version:1,
    rare:cleanMarkList(value?.rare),
    learning:cleanMarkList(value?.learning),
    fresh:cleanMarkList(value?.fresh),
    phrases:Array.isArray(value?.phrases) ? value.phrases.flatMap(item => {
      const words = Array.isArray(item) ? item : item?.words;
      if (!Array.isArray(words) || words.length < 2 || words.length > 100 || !words.every(word => typeof word === 'string' && word.trim() && word.length <= 100)) return [];
      return [{words:[...words],allowGaps:item?.allowGaps === true}];
    }) : [],
    origins:cleanOrigins(value?.origins),
    updatedAt:typeof value?.updatedAt === 'string' ? value.updatedAt : null
  });
  // 生僻词的标记键必须是词形(strictId):阅读器是拿词的词形去查的,键写成表面写法(embers)
  // 或旧词族名(acted),标记在正文里根本不会高亮。旧页面持有的是载入时的整份标记,它一写就会
  // 把已经修好的键覆盖回去——一个开着的旧标签页足以让修复失效,所以写入时按与阅读器相同的口径再归并一次。
  let strictIdsOfForm = null;
  let strictIdsVersion = '';
  async function loadStrictIds() {
    try {
      const file = path.join(root, 'three-body-reader.html');
      const info = await stat(file);
      const version = info.mtimeMs + ':' + info.size;
      if (strictIdsOfForm && strictIdsVersion === version) return strictIdsOfForm;
      const html = await readFile(file, 'utf8');
      const at = html.indexOf('id="wordFrequencyData"');
      const block = JSON.parse(html.slice(html.indexOf('>', at) + 1, html.indexOf('</script>', html.indexOf('>', at) + 1)));
      const fresh = new Map();
      for (const [form, entry] of Object.entries(block.forms || {})) fresh.set(form, entry.strictId || form);
      strictIdsOfForm = fresh;
      strictIdsVersion = version;
    } catch { return strictIdsOfForm || new Map(); }
    return strictIdsOfForm;
  }
  const strictKeyFrom = (table, key, origin) => {
    const word = String(origin?.word || key).trim().toLowerCase().replaceAll('’', "'");
    return table.get(word) || word;
  };
  async function normalizeRareKeys(cleaned) {
    const table = await loadStrictIds();
    if (!table.size) return cleaned;
    const origins = cleaned.origins?.rare || {};
    cleaned.rare = [...new Set(cleaned.rare.map(key => strictKeyFrom(table, key, origins[key])))];
    if (cleaned.origins?.rare) cleaned.origins.rare = Object.fromEntries(Object.entries(cleaned.origins.rare).map(([key, origin]) => [strictKeyFrom(table, key, origin), origin]));
    return cleaned;
  }
  async function saveLearningMarks(value) {
    const next = {...await normalizeRareKeys(cleanLearningMarks(value)), updatedAt:new Date().toISOString()};
    learningMarksWrites = learningMarksWrites.catch(()=>{}).then(async()=>{
      const temporary = learningMarksFile + '.tmp';
      await writeFile(temporary, JSON.stringify(next), {encoding:'utf8', mode:0o600});
      await rename(temporary, learningMarksFile);
      learningMarks = next;
      return next;
    });
    return learningMarksWrites;
  }
  const ready = (async () => {
    await mkdir(cache, { recursive: true });
    if(language==='ru')await audioOperation(()=>pruneAudio(cache));
    await aiPrompt.load();
    try { await customVoices.load(); } catch { customVoiceError='无法读取已保存的声音，请保留音色文件，不要重复创建。'; }
    try { usage = JSON.parse(await readFile(usageFile, 'utf8')); } catch { usage = {}; }
    try { learningMarks = await normalizeRareKeys(cleanLearningMarks(JSON.parse(await readFile(learningMarksFile, 'utf8')))); } catch { learningMarks = {version:1,rare:[],learning:[],fresh:[],phrases:[],origins:{},updatedAt:null}; }
    if (persistedSecrets && Object.keys(keys).length === 0) {
      const restored = await persistedSecrets.load();
      for (const key of SECRET_FIELDS) if (typeof restored[key] === 'string' && restored[key] && (!secrets[key] || key === 'deepseek')) secrets[key] = restored[key];
    }
  })();
  const enhancedReady=ready.then(async()=>{await local.load();await onboarding.load(Boolean(secrets.aliyun||secrets.deepseek||(await readdir(cache)).some(n=>n.endsWith('.mp3'))));});
  function day() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()); }
  function status() { return { app: 'three-body-reader', version:14, instanceId, csrf, onboarding:onboarding.get(), configured: Object.fromEntries(Object.entries(secrets).map(([k,v]) => [k, Boolean(v)])), used: usage[day()] || 0, customVoices:customVoiceError?[]:customVoices.list(), customVoiceError }; }
  async function recordSpeech(spec) {
    const id = 'speech-' + hash(spec);
    const file = path.join(cache, id + (spec.format==='wav'?'.wav':'.mp3'));
    const info = await stat(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(!info)return null;
    const record = { id, ...spec, createdAt:info.mtime.toISOString() };
    await writeFile(path.join(cache,id+'.meta.json'),JSON.stringify(record),{flag:'wx'}).catch(error=>{if(error.code!=='EEXIST')throw error;});
    return record;
  }
  let libraryQueue = Promise.resolve();
  async function speechLibrary(prompt) {
    const names = new Set(await readdir(cache));
    const unknown = new Set([...names].filter(n=>/^speech-[a-f0-9]{64}\.mp3$/.test(n) && !names.has(n.replace('.mp3','.meta.json'))));
    // Old caches only contain hashes. Recover exact matches, never guess from audio.
    if(unknown.size) {
      const paragraphs = await readFile(path.join(root,'speech-paragraphs.json'),'utf8').then(JSON.parse).catch(()=>[]);
      const instructions = [...new Set([INSTRUCTIONS,LEGACY_INSTRUCTIONS,prompt].filter(x=>typeof x==='string' && x.trim() && x.length<=1000).map(x=>x.trim()))];
      const voices = Object.entries(ALI_MODELS).flatMap(([model,vs])=>vs.map(voice=>({provider:'aliyun',model,voice}))).concat(VOICES.map(voice=>({provider:'openai',voice})));
      for(const text of paragraphs) {
        if(!unknown.size)break;
        if(typeof text!=='string'||!text.trim()||text.length>4500)continue;
        for(const v of voices)for(const instruction of instructions) {
          const spec=speechSpec({...v,text,instructions:instruction});
          const filename='speech-'+hash(spec)+'.mp3';
          if(unknown.has(filename)){await recordSpeech(spec);unknown.delete(filename);}
        }
      }
    }
    const files=await readdir(cache);
    const entries=[];
    for(const name of files.filter(n=>/^speech-[a-f0-9]{64}\.meta\.json$/.test(n))) {
      try {
        const entry=JSON.parse(await readFile(path.join(cache,name),'utf8'));
        if(name!==entry.id+'.meta.json'||typeof entry.text!=='string')continue;
        const info=await stat(path.join(cache,entry.id+(entry.format==='wav'?'.wav':'.mp3')));
        if(info.size>0)entries.push(entry);
      }catch{}
    }
    return {entries:entries.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),unmatched:unknown.size};
  }
  async function upstream(url, options) {
    let response;
    const { timeoutMs = 90000, ...requestOptions } = options;
    try { response = await fetchImpl(url, { ...requestOptions, signal: AbortSignal.timeout(timeoutMs) }); }
    catch { throw fail(502, '无法连接服务，请检查网络连接后重试。'); }
    if (!response.ok) {
      const rejected = (status, message) => Object.assign(fail(status, message), {upstreamStatus:response.status});
      if (new URL(url).hostname === 'dashscope.aliyuncs.com') {
        // Only map known codes; never echo an upstream message, URL or key.
        const details = await response.json().catch(() => ({}));
        if (details.code === 'AllocationQuota.FreeTierOnly') throw rejected(502, '阿里云免费额度已用完，且已开启“免费额度用完即停”。请在北京区百炼控制台关闭当前模型的该开关，之后即可按量付费继续使用；账户有余额也不会自动解除此限制。');
        // Arrearage comes back as HTTP 400, so without this it surfaces as a generic 400.
        // Quota is per model: a funded model can still succeed while this one is refused.
        if (details.code === 'Arrearage') throw rejected(502, '阿里云拒绝本次语音合成：账户欠费或余额不足，或该模型已无可用额度。请在北京区百炼控制台结清欠款、充值或更换音色后再试。');
        if (response.status === 401) throw rejected(502, '阿里云密钥无效或地域不匹配。请使用北京区百炼 API Key，不要使用 Coding Plan 专用密钥。');
        if (response.status === 403) throw rejected(502, '阿里云拒绝调用。请检查北京区 Flash / Plus 模型权限、免费额度有效期和账户状态。');
      }
      const messages = { 401: '密钥无效，请在服务设置里更新。', 403: '服务拒绝访问，请检查账户权限或服务可用地区。', 402: '账户余额不足。', 429: '额度不足或请求太频繁，请检查账户后稍候重试。', 404: '未找到词条、音色或模型，请检查所选项目。' };
      throw rejected(502, messages[response.status] || `服务暂时不可用（${response.status}），请稍后重试。`);
    }
    return response;
  }
  async function cached(category, spec, generate) {
    const key = category + '-' + hash(spec);
    const filename = path.join(cache, key + (category === 'speech' ? (spec.format==='wav'?'.wav':'.mp3') : '.json'));
    try { return { data: await readFile(filename), cached: true }; } catch {}
    if (pending.has(key)) return pending.get(key);
    const task = (async () => {
      const data = await generate();
      const temporary = filename + '.tmp';
      const persist=async()=>{await writeFile(temporary,data);await rename(temporary,filename);if(category==='speech'&&language==='ru')await pruneAudio(cache);};
      if(category==='speech'&&language==='ru')await audioOperation(persist);else await persist();
      return { data, cached: false };
    })();
    pending.set(key, task);
    try { return await task; } finally { pending.delete(key); }
  }
  const server = http.createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    const send = (code, data, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, { 'Content-Type': type });
      res.end(Buffer.isBuffer(data) || typeof data === 'string' ? data : JSON.stringify(data));
    };
    try {
      await enhancedReady;
      if (req.headers.host !== new URL(origin).host) throw fail(403, '请使用本机阅读器地址。');
      const url = new URL(req.url, origin);
      if (req.headers.origin && req.headers.origin !== origin) throw fail(403, '请求来源不匹配。');
      if (req.headers['sec-fetch-site'] === 'cross-site') throw fail(403, '请求来源不匹配。');
      if (req.method === 'GET' && serveStatic && await serveStatic(req,res,url)) return;
      if (req.method === 'GET' && ['/', '/reader.html'].includes(url.pathname)) return send(200, await readFile(path.join(root, 'three-body-reader.html')), 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/api/status') return send(200, status());
      if (req.method !== 'POST' || !url.pathname.startsWith('/api/')) throw fail(404, '未找到页面。');
      if (req.headers['x-reader-token'] !== csrf || !req.headers['content-type']?.startsWith('application/json')) throw fail(403, '请刷新页面后重试。');
      let raw = '';
      const bodyLimit=['/api/voice-clone','/api/local-clone','/api/local-install'].includes(url.pathname)?CLONE_BODY_LIMIT:(url.pathname==='/api/learning-marks'?MARK_BODY_LIMIT:40000);
      for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > bodyLimit) throw fail(413, '提交内容过大，请缩短录音或文字。'); }
      let body; try { body = JSON.parse(raw); } catch { throw fail(400, '请求内容无效。'); }
      if(!body || typeof body!=='object' || Array.isArray(body))throw fail(400,'请求内容无效。');
      if(url.pathname==='/api/local-status')return send(200,await local.status());
      if(url.pathname==='/api/ai-prompt')return send(200,Object.hasOwn(body,'prompt')?await aiPrompt.save(body.prompt):aiPrompt.get());
      if(url.pathname==='/api/local-presence')return send(200,local.presence(body));
      if(url.pathname==='/api/local-preflight')return send(200,await local.preflight(body.kind));
      if(url.pathname==='/api/local-install')return send(200,await local.install(body));
      if(url.pathname==='/api/local-cancel')return send(200,await local.cancel());
      if(url.pathname==='/api/learning-marks') {
        if (Object.keys(body).length === 0) return send(200, learningMarks);
        return send(200, await saveLearningMarks(body));
      }
      if(url.pathname==='/api/local-clone')throw fail(410,'已取消本机录入个人声音功能。');
      if(url.pathname==='/api/onboarding') {
        if(body.complete&&body.mode==='aliyun'&&!secrets.aliyun)throw fail(409,'请先填写阿里云密钥，或选择暂不设置。');
        if(body.complete&&body.mode==='local'&&!(await local.status()).ready)throw fail(409,'请等待本机安装完成，或选择暂不设置。');
        return send(200,await onboarding.update(body));
      }
      if(url.pathname==='/api/default-voice' && language==='ru'){
        if(customVoiceError)throw fail(500,customVoiceError);
        return send(200,await ensureDefaultVoice());
      }
      if(url.pathname==='/api/voice-clone' || url.pathname==='/api/voice-clone-status'){
        if(customVoiceError)throw fail(500,customVoiceError);
        return send(200,url.pathname==='/api/voice-clone'?await customVoices.create(body):await customVoices.refresh(body.id));
      }
      if(url.pathname==='/api/speech-library') {
        const task=libraryQueue.catch(()=>{}).then(()=>speechLibrary(body.instructions));libraryQueue=task;
        return send(200,await task);
      }
      if(url.pathname==='/api/speech-file') {
        if(typeof body.id!=='string'||!/^speech-[a-f0-9]{64}$/.test(body.id))throw fail(400,'音频编号无效。');
        let data,type='audio/mpeg';try{data=await readFile(path.join(cache,body.id+'.mp3'));}catch{try{data=await readFile(path.join(cache,body.id+'.wav'));type='audio/wav';}catch{throw fail(404,'旧音频文件已不存在，请重新朗读。');}}
        if(!data.length)throw fail(404,'旧音频文件为空，请重新朗读。');
        res.setHeader('X-Reader-Cached','true');return send(200,data,type);
      }
      if (url.pathname === '/api/settings/check' && language === 'ru') {
        res.setHeader('Cache-Control','no-store');
        return send(200,await checkKey(body.provider,body.key,fetchImpl));
      }
      if (url.pathname === '/api/settings/reveal') {
        res.setHeader('Cache-Control','no-store');
        return send(200,{deepseek:secrets.deepseek,aliyun:secrets.aliyun});
      }
      if (url.pathname === '/api/settings') {
        if (typeof body.aliyun === 'string' && body.aliyun.trim().startsWith('sk-sp-')) throw fail(400, '这是套餐专用密钥。朗读请使用北京区百炼的普通 API Key。');
        const nextSecrets = body.clear === true ? Object.fromEntries(SECRET_FIELDS.map(key => [key, ''])) : { ...secrets };
        for (const key of SECRET_FIELDS) {
          if (typeof body[key] === 'string' && body[key].trim()) {
            if (body[key].length > 1000) throw fail(400, '密钥过长。');
            nextSecrets[key] = body[key].trim();
          }
        }
        if (persistedSecrets) {
          try { if (body.clear === true && !SECRET_FIELDS.some(key => nextSecrets[key])) await persistedSecrets.clear(); else await persistedSecrets.save(nextSecrets); }
          catch { throw fail(500, '无法保存本机加密密钥；密钥未被更改，请稍后重试。'); }
        }
        Object.assign(secrets, nextSecrets);
        return send(200, status());
      }
      if (url.pathname === '/api/voices') {
        if (!secrets.elevenlabs) throw fail(409, '请先配置 ElevenLabs API 密钥。');
        const response = await upstream('https://api.elevenlabs.io/v1/voices', { timeoutMs:20000, headers: { 'xi-api-key': secrets.elevenlabs } });
        const data = await response.json();
        return send(200, { voices: (data.voices || []).map(v => ({ id:v.voice_id, name:v.name, accent:v.labels?.accent || '', gender:v.labels?.gender || '' })) });
      }
      if (url.pathname === '/api/dictionary') {
        const word = body.word;
        if (typeof word !== 'string' || !/^[a-zA-Z'’ -]{1,90}$/.test(word)) throw fail(400, '请选择英文单词或短语。');
        const merriam = Boolean(secrets.merriam);
        const result = await cached('dictionary', { word:word.toLowerCase(), merriam }, async () => {
          const endpoint = merriam ? `https://www.dictionaryapi.com/api/v3/references/learners/json/${encodeURIComponent(word)}?key=${encodeURIComponent(secrets.merriam)}` : `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`;
          const response = await upstream(endpoint, { timeoutMs:12000 });
          return Buffer.from(JSON.stringify({ source:merriam ? 'Merriam-Webster Learner’s Dictionary' : 'Free Dictionary API / Wiktionary', kind:merriam ? 'merriam' : 'free', entries:await response.json() }));
        });
        return send(200, dictionaryAudio(JSON.parse(result.data.toString('utf8')), word));
      }
      if (url.pathname === '/api/explain') {
        if (typeof body.word !== 'string' || !body.word.trim() || body.word.length > 4000 || typeof body.context !== 'string' || body.context.length > 6500 || (body.question !== undefined && (typeof body.question !== 'string' || body.question.length > 1000))) throw fail(400, '请选择不超过 4000 字符的文字，问题不超过 1000 字符。');
        const prompt=language==='ru'?composeRussianPrompt(aiPrompt.get().prompt):composeEnglishPrompt(aiPrompt.get().prompt);
        const spec = { word:body.word.trim(), context:body.context, question:(body.question||'').trim(), provider:'deepseek', model:'deepseek-v4-flash', version:language==='ru'?5:6, promptHash:hash(prompt) };
        const result = await cached('explain', spec, async () => {
          if (!secrets.deepseek) throw Object.assign(fail(409, '尚未设置 DeepSeek 密钥，暂时无法问 AI。'),{code:'KEY_REQUIRED',action:'deepseek'});
          const response = await upstream('https://api.deepseek.com/chat/completions', {
            timeoutMs:60000, method:'POST', redirect:'error', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${secrets.deepseek}` },
            body:JSON.stringify({ model:spec.model, thinking:{type:'disabled'}, stream:false, max_tokens:language==='ru'?6000:2600, messages:[{ role:'system', content:prompt }, { role:'user', content:JSON.stringify({ selection:spec.word, context:spec.context, question:spec.question }) }] })
          });
          const data = await response.json();
          const explanation = data.choices?.[0]?.message?.content;
          if(data.choices?.[0]?.finish_reason==='length')throw fail(502,'这次讲解超过了单次回答长度，未能完整生成。请缩小选文范围后重试。');
          if (typeof explanation !== 'string' || !explanation.trim()) throw fail(502, '未收到解释，请重试。');
          return Buffer.from(JSON.stringify({ explanation }));
        });
        return send(200, result.data);
      }
      if (url.pathname === '/api/speech') {
        if(language==='ru'){
          if(body.provider!=='aliyun'||body.model!=='qwen-audio-3.0-tts-flash'||!customVoices.list().some(v=>v.voice===body.voice&&v.model===body.model))throw fail(400,'请先在声音设置中创建并选择俄语复刻音色。');
          body.instructions='Read the supplied Russian text verbatim in natural Russian. Respect stress marks. Do not translate or add commentary.';
        }
        const spec = body.provider==='local'?local.spec(body):speechSpec(body,customVoiceError?[]:customVoices.list());
        if(language==='ru')spec.language='ru';
        const result = await cached('speech', spec, async () => {
          if(spec.provider==='local'){
            const output=path.join(cache,'local-'+hash(spec)+'.mp3');
            await local.synthesize(spec,output);
            const bytes=await readFile(output);await unlink(output);return bytes;
          }
          if(spec.provider==='aliyun' && customVoices.has(spec.voice,spec.model) && !customVoices.usable(spec.voice,spec.model))throw fail(409,'这条复刻声音尚未就绪，请在“我的声音”中刷新状态。');
          if (!secrets[spec.provider]) throw Object.assign(fail(409, '尚未设置阿里云密钥。'),{code:'KEY_REQUIRED',action:'aliyun'});
          if (spec.provider === 'aliyun' && secrets.aliyun.startsWith('sk-sp-')) throw fail(400, '朗读请使用北京区百炼普通 API Key，不支持套餐专用密钥。');
          const today = day();
          // Reserve before the network request; uncertain failures may already be billed.
          usage[today] = (usage[today] || 0) + spec.text.length;
          const snapshot = JSON.stringify(usage);
          usageWrites = usageWrites.catch(() => {}).then(async () => {
            await writeFile(usageFile + '.tmp', snapshot);
            await rename(usageFile + '.tmp', usageFile);
          });
          await usageWrites;
          let response;
          if(spec.model==='qwen3-tts-flash'){
            const pieces=[];
            for(const text of splitSpeech(spec.text)){
              const part=await cached('speech',{...spec,text,part:true},async()=>{
                const synthesis=await upstream('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${secrets.aliyun}`,'Content-Type':'application/json'},body:JSON.stringify({model:spec.model,input:{text,voice:spec.voice,language_type:spec.language}})});
                const data=await synthesis.json();if(data.code||data.output?.finish_reason!=='stop')throw fail(502,'阿里云未完成语音合成，请检查模型权限后重试。');
                let url;try{url=new URL(data.output.audio.url);}catch{throw fail(502,'阿里云未返回有效音频地址。');}
                if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.port||!/^[a-z0-9-]+\.oss-cn-beijing\.aliyuncs\.com$/.test(url.hostname))throw fail(502,'阿里云返回了不受支持的音频地址。');url.protocol='https:';
                const audio=await upstream(url.href,{timeoutMs:45000,redirect:'error'});let size=0;const chunks=[];for await(const chunk of audio.body||[]){size+=chunk.length;if(size>25*1024*1024)throw fail(502,'音频文件过大。');chunks.push(Buffer.from(chunk));}
                try{return joinWav([Buffer.concat(chunks)]);}catch(e){throw fail(502,e.message);}
              });pieces.push(part.data);
            }
            try{return joinWav(pieces);}catch(e){throw fail(502,e.message);}
          }
          if (spec.provider === 'openai') response = await upstream('https://api.openai.com/v1/audio/speech', {
            method:'POST', headers:{ Authorization:`Bearer ${secrets.openai}`, 'Content-Type':'application/json' },
            body:JSON.stringify({ model:spec.model, voice:spec.voice, input:spec.text, instructions:spec.instructions, response_format:'mp3' })
          });
          else if (spec.provider === 'aliyun') {
            const synthesis = await upstream('https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer', {
              method:'POST', redirect:'error', headers:{ Authorization:`Bearer ${secrets.aliyun}`, 'Content-Type':'application/json' },
              body:JSON.stringify({ model:spec.model, input:{ text:spec.text, voice:spec.voice, format:spec.format, sample_rate:spec.sampleRate, language_hints:[spec.language||'en'], instruction:spec.instructions, enable_ssml:false } })
            });
            const data = await synthesis.json();
            if (data.code || data.output?.finish_reason !== 'stop') throw fail(502, '阿里云未完成语音合成，请检查模型权限后重试。');
            let audioUrl;
            try { audioUrl = new URL(data.output.audio.url); } catch { throw fail(502, '阿里云未返回有效音频地址，请重试。'); }
            // The official response uses a signed Beijing OSS URL. Upgrade HTTP
            // to HTTPS, restrict destinations, and never forward the API key.
            if (!['https:', 'http:'].includes(audioUrl.protocol) || audioUrl.username || audioUrl.password || audioUrl.port || !/^[a-z0-9-]+\.oss-cn-beijing\.aliyuncs\.com$/.test(audioUrl.hostname)) throw fail(502, '阿里云返回了不受支持的音频地址，已停止下载。');
            audioUrl.protocol = 'https:';
            response = await upstream(audioUrl.href, { timeoutMs:45000, redirect:'error' });
            const chunks = []; let size = 0;
            for await (const chunk of response.body || []) {
              size += chunk.length;
              if (size > 25 * 1024 * 1024) throw fail(502, '音频文件过大，请选择更短的段落。');
              chunks.push(Buffer.from(chunk));
            }
            const bytes = Buffer.concat(chunks);
            if (!(bytes.subarray(0,3).toString() === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))) throw fail(502, '阿里云返回的不是有效 MP3 音频，请稍后重试。');
            return bytes;
          }
          else response = await upstream(`https://api.elevenlabs.io/v1/text-to-speech/${spec.voice}?output_format=mp3_44100_128`, {
            method:'POST', headers:{ 'xi-api-key':secrets.elevenlabs, 'Content-Type':'application/json' },
            body:JSON.stringify({ text:spec.text, model_id:spec.model })
          });
          const bytes = Buffer.from(await response.arrayBuffer());
          if (!bytes.length) throw fail(502, '服务返回了空音频，请重试。');
          return bytes;
        });
        if(language==='ru')await audioOperation(()=>recordSpeech(spec));else await recordSpeech(spec);
        res.setHeader('X-Reader-Cached', String(result.cached));
        return send(200, result.data, spec.format==='wav'?'audio/wav':'audio/mpeg');
      }
      throw fail(404, '未找到功能。');
    } catch (error) { send(error.status || 500, { error:error.status ? error.message : '本机服务暂时出错，请重试。',code:error.code,action:error.action }); }
  });
  server.on('close',()=>local.close());
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createReaderServer();
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? 'Reader port is already in use. Open http://127.0.0.1:8766' : 'Reader could not start.'); process.exitCode = 1; });
  server.listen(Number(process.env.READER_PORT || 8766), '127.0.0.1', () => console.log(`Three-Body Reader: http://127.0.0.1:${server.address().port}`));
}
import {createAiPrompt,DEFAULT_AI_PROMPT,composeEnglishPrompt} from './reader-ai-prompt.mjs';
