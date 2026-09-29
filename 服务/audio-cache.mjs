import {readdir,stat,unlink} from 'node:fs/promises';
import path from 'node:path';
export const AUDIO_CACHE_LIMIT=800*1024*1024;
export async function pruneAudio(cache,limit=AUDIO_CACHE_LIMIT){
 const files=[];
 for(const name of await readdir(cache)){
  if(!/^(speech|local)-[a-f0-9]{64}\.(mp3|wav)$/.test(name))continue;
  try{const info=await stat(path.join(cache,name));if(info.isFile())files.push({name,size:info.size,time:info.mtimeMs});}catch(e){if(e.code!=='ENOENT')throw e;}
 }
 let bytes=files.reduce((n,f)=>n+f.size,0);
 files.sort((a,b)=>a.time-b.time||a.name.localeCompare(b.name));
 for(const f of files){
  if(bytes<=limit)break;
  await unlink(path.join(cache,f.name)).catch(e=>{if(e.code!=='ENOENT')throw e;});bytes-=f.size;
  await unlink(path.join(cache,f.name.replace(/\.(mp3|wav)$/,'.meta.json'))).catch(e=>{if(e.code!=='ENOENT')throw e;});
 }
 return bytes;
}
