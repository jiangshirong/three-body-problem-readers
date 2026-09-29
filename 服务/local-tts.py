"""Private local worker. Only our Node service supplies paths and arguments."""
import sys, os, json, time, hashlib, urllib.request, urllib.parse, shutil, subprocess
from pathlib import Path
WORKER_STARTED=time.monotonic()
_loaded=None

def emit(**data):
    print(json.dumps(data,ensure_ascii=False),flush=True)

def download_models(root,kind,manifest=None):
    if manifest is None:manifest=json.loads(Path(__file__).with_name('local-models.json').read_text(encoding='utf-8'))[kind]
    total=sum(f['size'] for f in manifest);done=0
    target=root/'models'/kind;target.mkdir(parents=True,exist_ok=True)
    def digest(p):
        h=hashlib.sha256()
        with p.open('rb') as stream:
            for block in iter(lambda:stream.read(1024*1024),b''):h.update(block)
        return h.hexdigest()
    for f in manifest:
        dest=(target/f['path']).resolve()
        if not dest.is_relative_to(target.resolve()):raise ValueError('Unsafe model path')
        dest.parent.mkdir(parents=True,exist_ok=True)
        if dest.exists() and dest.stat().st_size==f['size'] and digest(dest)==f['sha256']:
            done+=f['size'];continue
        partial=dest.with_suffix(dest.suffix+'.part')
        url='https://modelscope.cn/api/v1/models/Qwen/Qwen3-TTS-12Hz-0.6B-'+kind+'/repo?Revision='+f['revision']+'&FilePath='+urllib.parse.quote(f['path'])
        for attempt in range(3):
            offset=partial.stat().st_size if partial.exists() else 0
            try:
                req=urllib.request.Request(url,headers={'Range':f'bytes={offset}-'} if offset else {})
                with urllib.request.urlopen(req,timeout=60) as response:
                    if response.status!=206:offset=0
                    with partial.open('ab' if offset else 'wb') as out:
                        while True:
                            block=response.read(1024*1024)
                            if not block:break
                            out.write(block);offset+=len(block)
                            emit(stage='下载模型',done=done+offset,total=total)
                if partial.stat().st_size!=f['size'] or digest(partial)!=f['sha256']:
                    partial.unlink(missing_ok=True);raise ValueError('Model checksum mismatch')
                partial.replace(dest);break
            except Exception:
                if attempt==2:raise
                time.sleep(1)
        done+=f['size']
    return target

def synthesize(root,kind,device,request):
    global _loaded
    start=time.monotonic();cold=_loaded is None
    os.environ['HF_HUB_OFFLINE']='1';os.environ['TRANSFORMERS_OFFLINE']='1'
    import torch, numpy as np, soundfile as sf
    from qwen_tts import Qwen3TTSModel
    if device=='cuda' and not torch.cuda.is_available():raise RuntimeError('GPU_UNAVAILABLE')
    imports_done=time.monotonic()
    if _loaded is None:
        model=Qwen3TTSModel.from_pretrained(str(root/'models'/kind),device_map='cuda:0' if device=='cuda' else 'cpu',dtype=torch.bfloat16 if device=='cuda' else torch.float32,attn_implementation='sdpa',local_files_only=True)
        _loaded=model
    else:model=_loaded
    if device=='cuda':torch.cuda.synchronize();torch.cuda.reset_peak_memory_stats()
    loaded_at=time.monotonic()
    params=dict(text=request['text'],language=request.get('language','English'),max_new_tokens=2048)
    with torch.inference_mode():
        if kind=='Base':
            wavs,sr=model.generate_voice_clone(**params,ref_audio=request['reference'],ref_text=request['transcript'])
        else:wavs,sr=model.generate_custom_voice(**params,speaker=request.get('voice','Aiden'))
    if device=='cuda':torch.cuda.synchronize()
    generated_at=time.monotonic();audio=np.asarray(wavs[0]);
    if not audio.size or not np.isfinite(audio).all() or np.max(np.abs(audio))<1e-5:raise RuntimeError('EMPTY_AUDIO')
    sf.write(request['output'],audio,sr,format='MP3')
    finished=time.monotonic()
    emit(stage='生成完成',id=request.get('id'),cold=cold,importsSeconds=round(imports_done-start,3),loadSeconds=round(loaded_at-imports_done,3),generationSeconds=round(generated_at-loaded_at,3),encodingSeconds=round(finished-generated_at,3),seconds=round(finished-start,3),duration=round(len(audio)/sr,2),peakMB=round(torch.cuda.max_memory_allocated()/1048576) if device=='cuda' else None)

if __name__=='__main__':
    root=Path(sys.argv[2]).resolve();root.mkdir(parents=True,exist_ok=True)
    os.environ.update(HF_HOME=str(root/'cache'),PIP_CACHE_DIR=str(root/'downloads'),TMP=str(root/'tmp'),TEMP=str(root/'tmp'),PYTHONUTF8='1')
    (root/'tmp').mkdir(exist_ok=True)
    action=sys.argv[1];kind=sys.argv[3];device=sys.argv[4]
    try:
        if action=='install':
            if shutil.disk_usage(root).free<8*1024**3:raise RuntimeError('DISK_SPACE')
            env=root/'runtime';python=env/'Scripts'/'python.exe'
            if not python.exists() and (env/'python.exe').exists():python=env/'python.exe'
            if not python.exists():
                emit(stage='准备独立运行环境');subprocess.run([sys.executable,'-m','venv',str(env)],check=True,stdout=sys.stderr)
            emit(stage='安装运行依赖')
            subprocess.run([str(python),'-m','pip','install','--disable-pip-version-check','--only-binary=:all:','torch==2.6.0'+('+cu124' if device=='cuda' else '+cpu'),'torchaudio==2.6.0'+('+cu124' if device=='cuda' else '+cpu'),'--index-url','https://mirrors.aliyun.com/pypi/simple/','--extra-index-url','https://download.pytorch.org/whl/'+('cu124' if device=='cuda' else 'cpu')],check=True,stdout=sys.stderr)
            subprocess.run([str(python),'-m','pip','install','--disable-pip-version-check','-r',str(Path(__file__).with_name('local-requirements.txt')),'--index-url','https://mirrors.aliyun.com/pypi/simple/'],check=True,stdout=sys.stderr)
            download_models(root,kind)
            emit(stage='验证本机生成')
            sample={'text':'This is a short reading test.','voice':'Aiden','output':str(root/('test-'+kind+'.mp3'))}
            if kind=='Base':
                supplied=sys.stdin.read().strip()
                sample.update(json.loads(supplied) if supplied else dict(reference=str(root/'test-CustomVoice.mp3'),transcript='This is a short reading test.'))
            completed=subprocess.run([str(python),str(Path(__file__).resolve()),'speak',str(root),kind,device],input=json.dumps(sample),text=True,encoding='utf-8',check=True,capture_output=True)
            for line in completed.stdout.splitlines():
                if line.startswith('{'):print(line,flush=True)
            (root/(kind+'.ready.json')).write_text(json.dumps({'version':1,'device':device,'testedAt':time.time()}),encoding='utf-8')
            emit(stage='可用',ready=True)
        elif action=='speak':synthesize(root,kind,device,json.load(sys.stdin))
        elif action=='serve':
            emit(event='boot',seconds=round(time.monotonic()-WORKER_STARTED,3))
            for line in sys.stdin:
                request=json.loads(line)
                try:synthesize(root,kind,device,request)
                except Exception as error:
                    print(str(error),file=sys.stderr);emit(id=request.get('id'),error='LOCAL_FAILED')
    except Exception as error:
        if isinstance(error,subprocess.CalledProcessError) and error.stderr:print(error.stderr,file=sys.stderr)
        print(str(error),file=sys.stderr);emit(error=str(error) if str(error) in ['GPU_UNAVAILABLE','DISK_SPACE','EMPTY_AUDIO'] else 'LOCAL_FAILED');sys.exit(1)
