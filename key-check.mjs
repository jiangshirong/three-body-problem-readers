export async function checkKey(provider,key,fetcher=fetch){
 if(!['deepseek','aliyun'].includes(provider))return {ok:false,message:'不支持的服务商。'};
 if(typeof key!=='string'||!key.trim())return {ok:false,message:'请先填写密钥。'};
 key=key.trim();
 if(key.length>1000)return {ok:false,message:'密钥长度异常，请检查复制内容。'};
 if(provider==='aliyun'&&key.startsWith('sk-sp-'))return {ok:false,message:'该密钥不适用于朗读'};
 try{
  const response=await fetcher(provider==='deepseek'?'https://api.deepseek.com/user/balance':'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization',{
   method:provider==='deepseek'?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(15000),
   headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},
   ...(provider==='aliyun'?{body:JSON.stringify({model:'voice-enrollment',input:{action:'list_voice',page_index:0,page_size:1}})}:{})
  });
  let data;try{data=await response.json();}catch{return {ok:false,message:'厂商返回了无法解析的响应，请稍后重试。'};}
  const code=String(data.code||data.error?.code||data.error?.type||'');
  if(!response.ok||data.code||data.error){
   let message='厂商暂时未能完成验证，请稍后重试。';
   if(response.status===401||/invalid.*key|authentication/i.test(code))message='密钥无效或已失效，请检查是否完整复制、是否已被删除，以及所属地域是否正确。';
   else if(response.status===402||/balance|arrear|quota/i.test(code))message='余额不足';
   else if(response.status===403)message='密钥没有此接口的访问权限，请检查服务开通状态和业务空间权限。';
   else if(response.status===429)message='请求过于频繁或已达到限额，请稍后重试。';
   else if(response.status===400)message='厂商拒绝了验证请求，请检查密钥类型及地域设置。';
   return {ok:false,message,code:code.replace(/[^a-zA-Z0-9_.-]/g,'').slice(0,80),status:response.status};
  }
  if(provider==='deepseek'){
   if(typeof data.is_available!=='boolean')return {ok:false,message:'厂商响应缺少账户状态，暂时无法确认。'};
   if(!data.is_available)return {ok:false,message:'密钥验证通过，但账户可用余额不足。'};
   return {ok:true,message:'密钥验证通过，账户可用。'};
  }
  if(!data.output||!Array.isArray(data.output.voice_list))return {ok:false,message:'厂商响应缺少音色列表，暂时无法确认。'};
  return {ok:true,message:'密钥验证通过，音色查询接口正常。'};
 }catch(e){return {ok:false,message:e.name==='TimeoutError'||e.name==='AbortError'?'连接超时，请检查网络后重试。':'无法连接厂商服务，请检查网络或代理设置。'};}
}
