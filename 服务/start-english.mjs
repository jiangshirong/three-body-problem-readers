import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import {createReaderServer,createDpapiSecretStore} from './reader-server.mjs';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const cacheRoot=path.join(project,'本地数据/.reader-cache');
const server=createReaderServer({root:path.join(project,'outputs'),cacheRoot,
  instanceId:project,secretStore:createDpapiSecretStore(path.join(cacheRoot,'reader-secrets.dpapi.json')),
  serveStatic:async(_req,res,url)=>{
    if(url.pathname!=='/pilot-contextual-glosses')return false;
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
    res.end(await readFile(path.join(project,'outputs','句中释义交互试页.html')));
    return true;
  }});
server.on('error',error=>{console.error(error.code==='EADDRINUSE'?'Port 8766 is already occupied.':'Reader startup failed.');process.exitCode=1;});
server.listen(Number(process.env.READER_PORT||8766),'127.0.0.1',()=>console.log('English reader ready'));
