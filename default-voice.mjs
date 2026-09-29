import {readFile} from 'node:fs/promises';
import {createHash,createDecipheriv} from 'node:crypto';
// Client-side protection prevents direct playback, not determined extraction.
export const assetKey=()=>createHash('sha256').update('russian-reader/rong/default/v1/20260912').digest();
export async function readDefaultVoice(){
 const data=await readFile(new URL('./资源/默认音色/rong.bin',import.meta.url));
 if(data.subarray(0,4).toString()!=='RRV1')throw Error('默认音色资源损坏。');
 const decipher=createDecipheriv('aes-256-gcm',assetKey(),data.subarray(4,16));
 decipher.setAuthTag(data.subarray(16,32));
 return Buffer.concat([decipher.update(data.subarray(32)),decipher.final()]);
}
export function createDefaultVoice({voices,getKey,readAudio=readDefaultVoice}){
 let pending;
 return ()=>{
  if(pending)return pending;
  pending=(async()=>{
   const key=getKey();
   if(!key)throw Object.assign(Error('请先配置阿里云密钥。'),{status:409});
   const base='default-rong-'+createHash('sha256').update(key+'|rong-v3-trim-10.5-en').digest('hex').slice(0,32);
   const matches=voices.list().filter(r=>r.id.startsWith(base+'-'));
   const existing=matches.find(r=>!['FAILED','REJECTED'].includes(r.status));
   if(existing)return existing.status==='OK'?existing:voices.refresh(existing.id);
   const bytes=await readAudio();
   try{return await voices.create({requestId:base+'-'+matches.length,name:'默认音色 · 蓉',model:'qwen-audio-3.0-tts-flash',language:'en',consent:true,audio:bytes.toString('base64')});}
   finally{bytes.fill(0);}
  })().finally(()=>{pending=undefined;});
  return pending;
 };
}
