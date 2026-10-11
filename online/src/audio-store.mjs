// Private R2 is optional; existing D1 audio remains readable during adoption.
export async function reserveStorage(db,metric,amount,limit,period){
 const r=await db.prepare('INSERT INTO storage_budget(metric,period,amount) SELECT ?,?,? WHERE ?<=? ON CONFLICT(metric,period) DO UPDATE SET amount=amount+excluded.amount WHERE amount+excluded.amount<=?').bind(metric,period,amount,amount,limit,limit).run();
 if(!r.meta.changes)throw Error(metric==='tts_neurons'?'今日免费语音与内容复核额度已达上限，现有音频和学习记录保留':'本月音频存储访问额度保护已触发，现有音频和学习记录保留');
}
const month=()=>new Date().toISOString().slice(0,7);
export async function reserveTts(db,text){
 // MeloTTS: 18.63 neurons/minute. Reserve one second per character,
 // conservatively above normal speech duration, within the daily free allocation.
 await reserveStorage(db,'tts_neurons',Math.ceil(text.length*18.63/60)+1,9000,new Date().toISOString().slice(0,10));
}
export async function hasAudio(bucket,db,hash){return !!await db.prepare('SELECT hash FROM audio_objects WHERE hash=? AND status=?').bind(hash,'ready').first()}
export async function writeAudio(bucket,db,hash,bytes){
 if(await hasAudio(bucket,db,hash))return;
 const type=bytes[0]===82&&bytes[1]===73&&bytes[2]===70&&bytes[3]===70?'audio/wav':'audio/mpeg';
 await reserveStorage(db,'write_ops',1,10000,month());
 const r=await db.prepare("INSERT INTO audio_objects(hash,size,status) SELECT ?,?,'reserved' WHERE COALESCE((SELECT SUM(size) FROM audio_objects),0)+?<=8000000000 ON CONFLICT(hash) DO NOTHING").bind(hash,bytes.length,bytes.length).run();
 if(!r.meta.changes&&!await db.prepare('SELECT hash FROM audio_objects WHERE hash=?').bind(hash).first())throw Error('免费音频存储空间保护已触发，原音频保留');
 await bucket.put(hash,bytes,{httpMetadata:{contentType:type},customMetadata:{contentHash:hash}});
 await db.prepare("UPDATE audio_objects SET status='ready' WHERE hash=?").bind(hash).run();
}
export async function readAudio(bucket,db,hash,request){
 if(!await hasAudio(bucket,db,hash))return null;
 await reserveStorage(db,'read_ops',1,100000,month());
 const r=await bucket.get(hash,{range:request.headers});if(!r)return null;
 const headers=new Headers({'Accept-Ranges':'bytes','Cache-Control':'private, max-age=86400'});r.writeHttpMetadata(headers);headers.set('ETag',r.httpEtag);
 if(r.range){const start=r.range.offset||0,length=r.range.length||r.size;headers.set('Content-Range',`bytes ${start}-${start+length-1}/${r.size}`);headers.set('Content-Length',String(length));return new Response(r.body,{status:206,headers})}
 headers.set('Content-Length',String(r.size));return new Response(r.body,{headers});
}
export function speechParts(text,limit=300){
 const parts=[];let rest=text;
 while(rest.length>limit){let end=limit;
  for(let n=limit-1;n>=Math.floor(limit/2);n--)if(/[。！？.!?\n]/.test(rest[n])){end=n+1;break}
  if(end===limit){const space=rest.lastIndexOf(' ',limit);if(space>=Math.floor(limit/2))end=space+1}
  parts.push(rest.slice(0,end));rest=rest.slice(end);
 }
 if(rest)parts.push(rest);return parts;
}
export function joinWaves(parts){
 let format=null,total=0;const data=[];
 for(const bytes of parts){const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),tag=n=>String.fromCharCode(...bytes.subarray(n,n+4));
  if(bytes.length<44||tag(0)!=='RIFF'||tag(8)!=='WAVE')throw Error('语音片段不是有效 WAV');let fmt=null,pcm=null;
  for(let n=12;n+8<=bytes.length;){const size=v.getUint32(n+4,true),start=n+8;if(start+size>bytes.length)throw Error('语音片段不完整');
   if(tag(n)==='fmt '&&size>=16)fmt=[v.getUint16(start,true),v.getUint16(start+2,true),v.getUint32(start+4,true),v.getUint16(start+14,true)];
   if(tag(n)==='data')pcm=bytes.subarray(start,start+size);n=start+size+(size%2);
  }
  if(!fmt||fmt[0]!==1||fmt[3]!==16||!pcm?.length)throw Error('语音片段格式不支持');
  if(format&&fmt.some((x,i)=>x!==format[i]))throw Error('语音片段采样格式不一致');format=fmt;data.push(pcm);total+=pcm.length;
 }
 if(!format)throw Error('语音片段为空');const out=new Uint8Array(44+total),v=new DataView(out.buffer),tag=(n,s)=>[...s].forEach((c,i)=>out[n+i]=c.charCodeAt(0));
 tag(0,'RIFF');v.setUint32(4,36+total,true);tag(8,'WAVE');tag(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,format[1],true);v.setUint32(24,format[2],true);
 const align=format[1]*format[3]/8;v.setUint32(28,format[2]*align,true);v.setUint16(32,align,true);v.setUint16(34,format[3],true);tag(36,'data');v.setUint32(40,total,true);
 let n=44;for(const pcm of data){out.set(pcm,n);n+=pcm.length}return out;
}
