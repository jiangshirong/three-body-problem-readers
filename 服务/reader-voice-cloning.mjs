import {readFile, writeFile, rename} from 'node:fs/promises';
import {randomBytes, createHash} from 'node:crypto';
import path from 'node:path';

export const CLONE_MODELS = ['qwen-audio-3.0-tts-flash', 'qwen-audio-3.0-tts-plus'];
export const CLONE_BODY_LIMIT = 4 * 1024 * 1024;
const ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization';
const fail = (status, message) => Object.assign(new Error(message), {status});
const digest = value => createHash('sha256').update(value).digest('hex');
const validVoice = (voice, model) => typeof voice === 'string' && voice.startsWith(model + '-') && /^[a-zA-Z0-9_.-]{1,200}$/.test(voice);

export function validateClone(body) {
  if (body.consent !== true) throw fail(400, '请确认录音属于你，并同意上传至阿里云创建音色。');
  if (!CLONE_MODELS.includes(body.model)) throw fail(400, '请选择 Flash 或 Plus。');
  if (!['zh', 'en'].includes(body.language)) throw fail(400, '请选择录音使用的语言。');
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 24) throw fail(400, '声音名称请填写 1–24 个字符。');
  if (!/^[a-zA-Z0-9-]{16,64}$/.test(body.requestId || '')) throw fail(400, '请刷新页面后重新选择录音。');
  if (typeof body.audio !== 'string' || body.audio.length > 3900000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.audio)) throw fail(400, '录音数据无效或过大，请重新选择。');
  const bytes = Buffer.from(body.audio, 'base64');
  // The browser converts local WAV/MP3/M4A to a minimal 24 kHz, mono PCM WAV.
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' ||
      bytes.toString('ascii', 12, 16) !== 'fmt ' || bytes.readUInt32LE(16) !== 16 || bytes.readUInt16LE(20) !== 1 ||
      bytes.readUInt16LE(22) !== 1 || bytes.readUInt32LE(24) !== 24000 || bytes.readUInt32LE(28) !== 48000 ||
      bytes.readUInt16LE(32) !== 2 || bytes.readUInt16LE(34) !== 16 || bytes.toString('ascii', 36, 40) !== 'data' ||
      bytes.readUInt32LE(40) !== bytes.length - 44 || bytes.readUInt32LE(4) !== bytes.length - 8 || (bytes.length - 44) % 2) {
    throw fail(400, '录音格式无效，请在页面中重新选择录音文件。');
  }
  const duration = (bytes.length - 44) / 48000;
  if (duration < 5 || duration > 60) throw fail(400, '录音需要 5–60 秒，建议 10–20 秒连续清晰说话。');
  let peak = 0;
  for (let i = 44; i < bytes.length; i += 2) peak = Math.max(peak, Math.abs(bytes.readInt16LE(i)));
  if (peak < 100) throw fail(400, '录音声音太小或没有声音，请重新录制。');
  return {bytes, duration, name:body.name.trim(), model:body.model, language:body.language, requestId:body.requestId};
}

export function createVoiceCloning({cache, upstream, getKey}) {
  const file = path.join(cache, 'custom-voices.json');
  let records = [], writes = Promise.resolve(), queue = Promise.resolve();
  const view = record => ({id:record.id, name:record.name, model:record.model, voice:record.voice || '', status:record.status, message:record.message || '', createdAt:record.createdAt});
  async function save() {
    const json = JSON.stringify({version:1, records});
    writes = writes.catch(()=>{}).then(async()=>{await writeFile(file+'.tmp',json,{mode:0o600});await rename(file+'.tmp',file);});
    await writes;
  }
  const serialized = task => {const result=queue.catch(()=>{}).then(task);queue=result;return result;};
  function key() {const value=getKey();if(!value || value.startsWith('sk-sp-'))throw fail(409,'请先保存北京区百炼的普通阿里云密钥。');return value;}
  async function call(input, apiKey, resolveOss=false) {
    const response=await upstream(ENDPOINT,{method:'POST',redirect:'error',timeoutMs:90000,
      headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json',...(resolveOss?{'X-DashScope-OssResourceResolve':'enable'}:{})},
      body:JSON.stringify({model:'voice-enrollment',input})});
    const data=await response.json();
    if(data.code)throw Object.assign(fail(502,'阿里云拒绝了音色操作，请检查录音和模型权限。'),{upstreamStatus:400});
    if(!data.output)throw fail(502,'阿里云未确认音色操作结果，请先刷新状态，不要重复创建。');
    return data.output;
  }
  async function upload(bytes, apiKey) {
    const response=await upstream('https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model=voice-enrollment',{
      method:'GET',redirect:'error',timeoutMs:20000,headers:{Authorization:`Bearer ${apiKey}`}});
    const policy=(await response.json()).data;
    let url;
    try{url=new URL(policy.upload_host);}catch{throw fail(502,'未获得有效的阿里云录音上传地址。');}
    if(url.protocol!=='https:' || url.username || url.password || url.port || !/^dashscope-file-[a-z0-9-]+\.oss-cn-beijing\.aliyuncs\.com$/.test(url.hostname) ||
      !/^dashscope-instant\/[a-zA-Z0-9/_-]+$/.test(policy.upload_dir || '') || policy.x_oss_object_acl!=='private')throw fail(502,'录音上传地址或隐私设置不符合要求，已停止上传。');
    if(policy.max_file_size_mb && bytes.length>policy.max_file_size_mb*1024*1024)throw fail(400,'录音超过阿里云当前上传限制。');
    const objectKey=policy.upload_dir+'/'+randomBytes(12).toString('hex')+'.wav';
    const form=new FormData();
    for(const [field,name] of [['OSSAccessKeyId','oss_access_key_id'],['Signature','signature'],['policy','policy'],['x-oss-object-acl','x_oss_object_acl'],['x-oss-forbid-overwrite','x_oss_forbid_overwrite']]){
      if(typeof policy[name]!=='string' || !policy[name])throw fail(502,'阿里云上传凭证不完整，已停止上传。');
      form.append(field,policy[name]);
    }
    form.append('key',objectKey);form.append('success_action_status','200');
    form.append('file',new Blob([bytes],{type:'audio/wav'}),'sample.wav');
    // API key is never sent to OSS; only its short-lived, model-bound policy.
    await upstream(url.href,{method:'POST',redirect:'error',timeoutMs:60000,body:form});
    return 'oss://'+objectKey;
  }
  async function refresh(record, apiKey) {
    if(!record.voice){
      const output=await call({action:'list_voice',prefix:record.prefix,page_index:0,page_size:100},apiKey);
      const matches=(output.voice_list || []).filter(v=>validVoice(v.voice_id,record.model)&&v.voice_id.startsWith(record.model+'-'+record.prefix+'-'));
      if(matches.length!==1){record.message='暂未找到可确认的音色，请稍后刷新状态；不会自动重新创建。';await save();return view(record);}
      record.voice=matches[0].voice_id;
      // Save the recovered ID before the next network operation.
      record.status='DEPLOYING';await save();
    }
    const output=await call({action:'query_voice',voice_id:record.voice},apiKey);
    if(output.target_model!==record.model)throw fail(502,'音色与朗读模型不匹配，暂不可使用。');
    if(!['OK','DEPLOYING','UNDEPLOYED'].includes(output.status))throw fail(502,'阿里云返回了未知音色状态，请稍后刷新。');
    record.status=output.status;record.message='';await save();return view(record);
  }
  return {
    async load() {
      try{const data=JSON.parse(await readFile(file,'utf8'));if(data.version!==1 || !Array.isArray(data.records))throw Error('invalid');records=data.records;
        if(records.some(r=>!r || !CLONE_MODELS.includes(r.model) || typeof r.id!=='string' || typeof r.name!=='string' || !/^[a-z0-9]{10}$/.test(r.prefix) || (r.voice&&!validVoice(r.voice,r.model))))throw Error('invalid');
      }catch(error){records=[];if(error.code!=='ENOENT')throw Error('无法读取已保存的复刻音色；请保留文件，勿重复创建。');}
      for(const record of records){
        if(record.status==='UPLOADING'){record.status='FAILED';record.message='上次上传被中断，尚未提交复刻，可以重新选择录音创建。';}
        if(record.status==='CREATING'){record.status='UNKNOWN';record.message='上次创建被中断，请刷新状态确认结果，避免重复创建。';}
      }
    },
    list:()=>records.map(view),
    has:(voice,model)=>records.some(r=>r.voice===voice&&r.model===model),
    usable:(voice,model)=>records.some(r=>r.voice===voice&&r.model===model&&r.status==='OK'),
    create(body) {
      const input=validateClone(body), apiKey=key();
      const signature=digest(Buffer.concat([Buffer.from(input.model+'|'+input.language+'|'),input.bytes]));
      return serialized(async()=>{
        const sameId=records.find(r=>r.id===input.requestId);
        if(sameId){if(sameId.signature!==signature)throw fail(409,'同一创建请求不能更换录音或模型。');return view(sameId);}
        const account=digest(apiKey);
        const previous=records.find(r=>r.account===account&&r.signature===signature&&!['FAILED','REJECTED'].includes(r.status));
        if(previous)return view(previous);
        const record={id:input.requestId,name:input.name,model:input.model,language:input.language,signature,account,
          prefix:'r'+randomBytes(5).toString('hex').slice(0,9),voice:'',status:'UPLOADING',createdAt:new Date().toISOString()};
        records.push(record);await save();
        try{
          const url=await upload(input.bytes,apiKey);
          record.status='CREATING';await save();
          const output=await call({action:'create_voice',target_model:record.model,prefix:record.prefix,url,language_hints:[record.language],max_prompt_audio_length:30},apiKey,true);
          if(!validVoice(output.voice_id,record.model))throw fail(502,'阿里云未返回有效音色编号，请刷新状态确认结果。');
          record.voice=output.voice_id;record.status='DEPLOYING';await save();
          try{return await refresh(record,apiKey);}catch{record.message='音色已保存，暂未确认是否就绪；请刷新状态。';await save();return view(record);}
        }catch(error){
          if(record.status==='UPLOADING'){record.status='FAILED';record.message='录音上传未完成，尚未提交复刻。'+(error.status?error.message:'请稍后重试。');}
          else if(record.status==='CREATING' && [400,401,402,403,404,413,415,422,429].includes(error.upstreamStatus)){record.status='REJECTED';record.message='复刻请求被拒绝，未创建音色。'+error.message;}
          else{record.status='UNKNOWN';record.message='创建结果尚未确认，请刷新状态；不要重复上传创建。';}
          await save();return view(record);
        }
      });
    },
    refresh(id) {return serialized(async()=>{const record=records.find(r=>r.id===id);if(!record)throw fail(404,'未找到这条声音记录。');return refresh(record,key());});}
  };
}
