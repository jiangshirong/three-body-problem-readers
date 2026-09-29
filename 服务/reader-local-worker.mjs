import {spawn} from 'node:child_process';
import {appendFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

// A worker owns one model; the caller serializes synthesis requests.
export function createWarmWorker({directory,script,python,spawnProcess=spawn,graceMs=10000,leaseMs=300000}){
  let worker=null,pending=null,modelKey='',started=0,bootSeconds=0,lastActivity=Date.now(),emptySince=0;
  const pages=new Map();
  const log=data=>appendFile(path.join(directory,'timings.jsonl'),JSON.stringify({at:new Date().toISOString(),...data})+'\n').catch(()=>{});
  function release(reason='pages-closed'){
    const old=worker;if(!old)return;
    worker=null;modelKey='';old.kill();
    pending?.reject(Error('本机朗读已结束，请重新点击朗读。'));pending=null;
    log({event:'released',reason});
  }
  function presence({id,active=true}){
    if(typeof id!=='string'||!/^[\w-]{10,80}$/.test(id))throw Object.assign(Error('页面标识无效。'),{status:400});
    if(active){pages.set(id,Date.now());emptySince=0;}else{pages.delete(id);if(!pages.size)emptySince=Date.now();}
    return {pages:pages.size,loaded:Boolean(worker)};
  }
  const sweep=setInterval(()=>{
    const now=Date.now();for(const [id,at] of pages)if(now-at>leaseMs)pages.delete(id);
    if(!pages.size&&worker&&now-(emptySince||lastActivity)>graceMs)release();
  },Math.min(1000,graceMs));sweep.unref();
  function start(kind,device){
    if(worker&&modelKey===kind+device)return;
    release('model-change');modelKey=kind+device;started=performance.now();
    const proc=spawnProcess(python(),[script,'serve',directory,kind,device],{windowsHide:true,env:{...process.env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'},stdio:['pipe','pipe','pipe']});worker=proc;
    let output='',diagnostics='';proc.stdout.setEncoding('utf8');proc.stderr.setEncoding('utf8');
    proc.stderr.on('data',s=>{diagnostics=(diagnostics+s).slice(-12000);});
    proc.stdout.on('data',s=>{
      output+=s;let at;while((at=output.indexOf('\n'))>=0){const line=output.slice(0,at);output=output.slice(at+1);let data;try{data=JSON.parse(line);}catch{continue;}
        if(data.event==='boot'){bootSeconds=(performance.now()-started)/1000;continue;}
        if(worker!==proc||!pending||data.id!==pending.id)continue;
        const request=pending;pending=null;lastActivity=Date.now();
        const entry={...data,event:'synthesis',processStartupSeconds:data.cold?+bootSeconds.toFixed(3):0,totalSeconds:+((performance.now()-request.started)/1000).toFixed(3)};
        log(entry);
        if(data.error){request.reject(Error('本机生成失败，请重试。'));release('generation-error');}
        else request.resolve(entry);
      }
    });
    const ended=()=>{if(worker!==proc)return;worker=null;modelKey='';pending?.reject(Error('本机朗读进程退出，请重试。'));pending=null;log({event:'worker-exit',diagnostics});};
    proc.on('error',ended);proc.on('close',ended);proc.stdin.on('error',()=>{});
  }
  async function speak(kind,device,request){
    if(pending)throw Error('本机正在朗读。');lastActivity=Date.now();start(kind,device);
    return new Promise((resolve,reject)=>{
      const id=randomUUID(),timer=setTimeout(()=>release('generation-timeout'),600000);
      pending={id,started:performance.now(),resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}};
      worker.stdin.write(JSON.stringify({...request,id})+'\n');
    });
  }
  return {speak,presence,release,close(){clearInterval(sweep);release('service-closed');},status:()=>({resident:Boolean(worker),pages:pages.size})};
}
