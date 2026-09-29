import {readFile,writeFile,rename} from 'node:fs/promises';
export function createOnboarding(file){
  let state;let queue=Promise.resolve();
  const persist=async()=>{await writeFile(file+'.tmp',JSON.stringify(state));await rename(file+'.tmp',file);};
  return {
    async load(existing){try{state=JSON.parse(await readFile(file,'utf8'));if(state.version!==1)throw Error('Unknown onboarding version');}catch(error){if(error.code!=='ENOENT')throw error;state={version:1,step:1,complete:existing,mode:existing?'aliyun':'none',voice:existing?null:'loongeva_v3.6'};await persist();}},
    get:()=>state,
    update(body){const p=queue.catch(()=>{}).then(async()=>{if(![1,2,3].includes(body.step)||!['aliyun','local','none'].includes(body.mode))throw Object.assign(Error('设置步骤无效。'),{status:400});state={...state,step:body.step,mode:body.mode,complete:body.complete===true,voice:body.mode==='local'?'Aiden':'loongeva_v3.6'};await persist();return state;});queue=p;return p;}
  };
}
