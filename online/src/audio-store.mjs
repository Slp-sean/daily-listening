// Private R2 is optional; existing D1 audio remains readable during adoption.
export async function reserveStorage(db,metric,amount,limit,period){
 const r=await db.prepare('INSERT INTO storage_budget(metric,period,amount) SELECT ?,?,? WHERE ?<=? ON CONFLICT(metric,period) DO UPDATE SET amount=amount+excluded.amount WHERE amount+excluded.amount<=?').bind(metric,period,amount,amount,limit,limit).run();
 if(!r.meta.changes)throw Error('免费音频存储额度保护已触发，现有音频和学习记录保留');
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
