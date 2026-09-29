export function splitSpeech(text,limit=600){
  const parts=[];let rest=text;
  while(rest.length>limit){
    const head=rest.slice(0,limit);let end=-1;
    for(const m of head.matchAll(/[.!?][”"’']?\s+/g))end=m.index+m[0].length;
    if(end<limit/3)end=head.lastIndexOf(' ')+1;
    if(end<1)end=limit;
    if(/[\uD800-\uDBFF]/.test(rest[end-1]))end--;
    parts.push(rest.slice(0,end));rest=rest.slice(end);
  }
  if(rest)parts.push(rest);return parts;
}
export function joinWav(files){
  let format;const blocks=[];
  for(const bytes of files){
    if(bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE')throw Error('阿里云返回的不是有效 WAV 音频。');
    let fmt,data;
    for(let i=12;i+8<=bytes.length;){
      const declared=bytes.readUInt32LE(i+4);
      // 流式合成的 WAV 把 RIFF/data 的长度写成接近 32 位上限的占位值(真实长度下载完才知道),
      // 这类占位只能按"一直到文件末尾"来解释;声明长度正常的仍然严格按长度切,真截断照样报错。
      const n=declared>=0x7fff0000?bytes.length-i-8:declared;
      const end=i+8+n;
      if(end>bytes.length)throw Error('音频文件不完整。');
      const id=bytes.toString('ascii',i,i+4);
      if(id==='fmt ')fmt=bytes.subarray(i+8,end);
      if(id==='data')data=bytes.subarray(i+8,end);
      i=end+(n%2);
    }
    if(!fmt||fmt.length<16||![1,3].includes(fmt.readUInt16LE(0))||!data?.length)throw Error('音频格式不支持或内容为空。');
    if(format&&!format.equals(fmt))throw Error('音频片段格式不一致，请重试。');format=fmt;blocks.push(data);
  }
  const payload=Buffer.concat(blocks),pad=format.length%2;
  const tail=Buffer.alloc(payload.length%2);
  const header=Buffer.alloc(28+format.length+pad);header.write('RIFF');header.writeUInt32LE(header.length+payload.length+tail.length-8,4);header.write('WAVEfmt ',8);header.writeUInt32LE(format.length,16);format.copy(header,20);header.write('data',20+format.length+pad);header.writeUInt32LE(payload.length,24+format.length+pad);
  return Buffer.concat([header,payload,tail]);
}
