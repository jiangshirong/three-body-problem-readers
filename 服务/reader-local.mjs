import {readFile,writeFile,mkdir,rename,stat,statfs} from 'node:fs/promises';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {validateClone} from './reader-voice-cloning.mjs';
import {createWarmWorker} from './reader-local-worker.mjs';
const exec=promisify(execFile),HERE=path.dirname(fileURLToPath(import.meta.url));
const manifest=JSON.parse(await readFile(path.join(HERE,'local-models.json'),'utf8'));
export const LOCAL_VOICES=['Aiden'];
const fail=(code,message,action='local')=>Object.assign(new Error(message),{status:409,code,action});
export function createLocal({directory}){
  let job={state:'idle'},child=null,queue=Promise.resolve(),records=[],busy=false;
  const serialized=fn=>{const p=queue.catch(()=>{}).then(fn);queue=p;return p;};
  const readyFile=kind=>path.join(directory,kind+'.ready.json');
  const runtime=()=>path.join(directory,existsSync(path.join(directory,'runtime/Scripts/python.exe'))?'runtime/Scripts/python.exe':'runtime/python.exe');
  const warm=createWarmWorker({directory,script:path.join(HERE,'local-tts.py'),python:runtime});
  async function load(){await mkdir(directory,{recursive:true});try{records=JSON.parse(await readFile(path.join(directory,'voices.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}}
  async function installed(kind){try{const r=JSON.parse(await readFile(readyFile(kind),'utf8'));if(r.version!==1)return false;await stat(runtime());await stat(path.join(directory,'models',kind,'model.safetensors'));return r;}catch{return false;}}
  async function status(){const [preset,base]=await Promise.all([installed('CustomVoice'),installed('Base')]);return {job,ready:Boolean(preset||base),presetReady:Boolean(preset),baseReady:Boolean(base),device:preset?.device||base?.device,voices:LOCAL_VOICES,customVoices:records.map(({reference,transcript,...rest})=>rest),busy,...warm.status()};}
  async function preflight(kind='CustomVoice'){
    if(!['CustomVoice','Base'].includes(kind))throw fail('INVALID_MODEL','不支持的本地模型。');
    await mkdir(directory,{recursive:true});let gpu='';try{gpu=(await exec('nvidia-smi',['--query-gpu=name,memory.total','--format=csv,noheader'],{windowsHide:true,timeout:5000})).stdout.trim();}catch{}
    const disk=await statfs(directory);return {windows:process.platform==='win32',gpu,freeBytes:Number(disk.bavail)*Number(disk.bsize),modelBytes:manifest[kind].reduce((s,f)=>s+f.size,0),runtimeEstimateBytes:4*1024**3,requiredFreeBytes:8*1024**3};
  }
  function run(action,kind,device,input){return new Promise((resolve,reject)=>{
    const python=action==='install'?'powershell.exe':runtime();
    const args=action==='install'?['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(HERE,'bootstrap-local.ps1'),'-DataRoot',directory,'-Model',kind,'-Device',device]:[path.join(HERE,'local-tts.py'),action,directory,kind,device];
    const proc=spawn(python,args,{windowsHide:true,env:{...process.env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'},stdio:['pipe','pipe','pipe']});child=proc;
    let output='',diagnostic='';const metrics=[];
    proc.stdout.setEncoding('utf8');proc.stderr.setEncoding('utf8');
    proc.stderr.on('data',s=>{diagnostic=(diagnostic+s).slice(-12000);});
    proc.stdout.on('data',s=>{output+=s;let index;while((index=output.indexOf('\n'))>=0){const line=output.slice(0,index);output=output.slice(index+1);try{const data=JSON.parse(line);if(data.error)diagnostic+=' '+data.error;else{metrics.push(data);if(action==='install')job={...job,...data,state:'installing'};}}catch{}}});
    const timer=setTimeout(()=>{exec('taskkill',['/PID',String(proc.pid),'/T','/F'],{windowsHide:true}).catch(()=>{});},action==='install'?3600000:600000);
    proc.on('error',()=>{clearTimeout(timer);child=null;reject(fail('RUNTIME_MISSING','无法启动本机 Python 环境，请检查 Python 安装。'));});
    proc.on('close',async code=>{clearTimeout(timer);child=null;await writeFile(path.join(directory,'last-operation.log'),diagnostic,'utf8').catch(()=>{});if(code===0)resolve(metrics);else reject(fail('LOCAL_FAILED',diagnostic.includes('DISK_SPACE')?'磁盘空间不足，请至少留出 8 GB。':diagnostic.includes('GPU_UNAVAILABLE')?'显卡不可用，请选择 CPU 模式或检查驱动。':'本机处理失败，可重试；详细记录保存在本地朗读目录。'));});
    proc.stdin.end(input?JSON.stringify(input):'');
  });}
  async function install({kind='CustomVoice',device='cuda',...sample}){
    if(kind!=='CustomVoice'||!['cuda','cpu'].includes(device))throw fail('INVALID_MODEL','仅提供内置声音版，不下载复刻模型。');
    if(child||job.state==='installing'||busy)throw fail('LOCAL_BUSY','本机正在处理任务，请稍后。');
    warm.release('installation');
    const check=await preflight(kind);if(!check.windows)throw fail('UNSUPPORTED_OS','第一版仅支持 Windows。');
    if(check.freeBytes<check.requiredFreeBytes)throw fail('DISK_SPACE','磁盘空间不足，请至少留出 8 GB。');
    if(device==='cuda'&&!check.gpu)throw fail('GPU_UNAVAILABLE','未找到 NVIDIA 显卡，请选择 CPU 模式。');
    let reference;
    if(kind==='Base'){
      if(sample.audio){
        if(typeof sample.transcript!=='string'||!sample.transcript.trim())throw fail('TRANSCRIPT_REQUIRED','请先填写录音原文。');
        const checked=validateClone({...sample,model:'qwen-audio-3.0-tts-flash'});
        reference={reference:path.join(directory,'installation-reference.wav'),transcript:sample.transcript.trim()};
        await writeFile(reference.reference,checked.bytes);
      }else if(!await installed('CustomVoice'))throw fail('REFERENCE_REQUIRED','单独安装复刻版时，请先选择自己的录音并填写原文。');
    }
    job={state:'installing',stage:'准备安装',kind,device};
    run('install',kind,device,reference).then(()=>{job={state:'ready',stage:'可用',kind};},e=>{job={state:job.state==='cancelled'?'cancelled':'failed',stage:e.message,kind};});return job;
  }
  async function cancel(){if(job.state==='installing'&&child){job={...job,state:'cancelled',stage:'正在取消'};await exec('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true}).catch(()=>{});}return job;}
  function spec(body){
    if(typeof body.text!=='string'||!body.text.trim()||body.text.length>4500)throw Object.assign(fail('INVALID_TEXT','请选择 1–4500 字符的文字。'),{status:400});
    const custom=records.find(r=>r.voice===body.voice);
    if(body.voice!=='Aiden')throw fail('INVALID_VOICE','本机朗读固定使用 Aiden。');
    return {provider:'local',model:custom?'0.6B-Base':'0.6B-CustomVoice',revision:createHash('sha256').update(JSON.stringify(manifest[custom?'Base':'CustomVoice'])).digest('hex').slice(0,16),voice:body.voice,language:'English',text:body.text.trim(),format:'mp3',instructions:''};
  }
  async function synthesize(spec,output){return serialized(async()=>{
    if(job.state==='installing')throw fail('LOCAL_BUSY','模型正在安装，请稍后朗读。');
    const kind=spec.model==='0.6B-Base'?'Base':'CustomVoice',installedModel=await installed(kind);
    if(!installedModel)throw fail('LOCAL_NOT_READY','本地语音模型尚未安装，请先下载。');
    busy=true;try{const record=records.find(r=>r.voice===spec.voice);return await warm.speak(kind,installedModel.device,{...spec,output,...(record?{reference:path.join(directory,record.reference),transcript:record.transcript}:{})});}finally{busy=false;}
  });}
  async function clone(body){
    if(!await installed('Base'))throw fail('LOCAL_NOT_READY','请先下载本地声音复刻模型。');
    if(body.consent!==true)throw fail('CONSENT_REQUIRED','请确认这是你的声音，并同意在本机保存。');
    if(typeof body.transcript!=='string'||!body.transcript.trim()||body.transcript.length>2000)throw fail('TRANSCRIPT_REQUIRED','请填写录音中实际说出的文字。');
    const checked=validateClone({...body,model:'qwen-audio-3.0-tts-flash'});
    const voice='local-'+createHash('sha256').update(checked.bytes).update(body.transcript).digest('hex').slice(0,24);
    const prior=records.find(r=>r.voice===voice);if(prior)return prior;
    const record={voice,id:voice,model:'0.6B-Base',name:checked.name,status:'OK',reference:voice+'.wav',transcript:body.transcript.trim()};
    await writeFile(path.join(directory,record.reference),checked.bytes);
    // No enrollment API is needed: Base conditions on the locally stored reference.
    records.push(record);await writeFile(path.join(directory,'voices.json.tmp'),JSON.stringify(records));await rename(path.join(directory,'voices.json.tmp'),path.join(directory,'voices.json'));
    const {reference,transcript,...view}=record;return view;
  }
  return {load,status,preflight,install,cancel,spec,synthesize,clone,presence:warm.presence,close:warm.close};
}
