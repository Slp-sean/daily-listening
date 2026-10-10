import {hasAudio,writeAudio,readAudio} from './audio-store.mjs';
import {RULE_VERSION,key,addDays,shanghaiDay,applyRating,insertRecheck,selectWords,makeTask,sha,groupSignature} from './srs.mjs';
import {validateGroup,prompt,contentHash} from './content.mjs';
const json=(x,status=200)=>new Response(JSON.stringify(x),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const err=(message,status=400)=>Object.assign(Error(message),{status});
const read=async(db,sql,...values)=>db.prepare(sql).bind(...values).first();
const rows=async(db,sql,...values)=>(await db.prepare(sql).bind(...values).all()).results;
const parse=r=>r?JSON.parse(r.body):null;
let certCache={expires:0,keys:[]};
const b64=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
async function identity(request,env){
 if(env.LOCAL_TEST==='true'&&new URL(request.url).hostname==='127.0.0.1')return 'local-isolated-test';
 if(!env.ACCESS_TEAM||!env.ACCESS_AUD||!env.OWNER_EMAIL)throw err('身份验证尚未配置',503);
 const token=request.headers.get('Cf-Access-Jwt-Assertion');if(!token)throw err('请通过 Cloudflare Access 登录',401);
 try{
  const parts=token.split('.');if(parts.length!==3)throw Error();const h=JSON.parse(new TextDecoder().decode(b64(parts[0]))),p=JSON.parse(new TextDecoder().decode(b64(parts[1])));
  const issuer=`https://${env.ACCESS_TEAM}.cloudflareaccess.com`,now=Math.floor(Date.now()/1000);
  if(h.alg!=='RS256'||p.iss!==issuer||!p.aud?.includes(env.ACCESS_AUD)||p.exp<=now||p.nbf>now+30||p.email?.toLowerCase()!==env.OWNER_EMAIL.toLowerCase())throw Error();
  if(certCache.expires<Date.now()||!certCache.keys.some(k=>k.kid===h.kid)){const r=await fetch(issuer+'/cdn-cgi/access/certs');if(!r.ok)throw Error();certCache={expires:Date.now()+300000,keys:(await r.json()).keys}}
  const jwk=certCache.keys.find(k=>k.kid===h.kid);if(!jwk)throw Error();const pub=await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
  if(!await crypto.subtle.verify('RSASSA-PKCS1-v1_5',pub,b64(parts[2]),new TextEncoder().encode(parts[0]+'.'+parts[1])))throw Error();return p.email;
 }catch{throw err('登录已失效，请重新登录',401)}
}
async function taskFor(db,day){return parse(await read(db,'SELECT body FROM sessions WHERE day=?',day))}
async function cardsFor(db,task){const list=task.new_words||task.groups.flatMap(g=>g.words);return (await rows(db,`SELECT body FROM cards WHERE word IN (${list.map(()=>'?').join(',')})`,...list.map(key))).map(r=>({...parse(r),image_path:''}))}
async function allStates(db){return Object.fromEntries((await rows(db,'SELECT word,body FROM states')).map(r=>[r.word,JSON.parse(r.body)]))}
async function queueStatements(db,task,revision){const out=[];for(const g of task.groups){const gid='G'+String(g.group_id).padStart(2,'0'),sig=await groupSignature(task.project_id,task.date,gid,g.words);out.push(db.prepare("INSERT INTO jobs(day,group_id,signature,status) SELECT ?,?,?,'pending' WHERE EXISTS(SELECT 1 FROM project WHERE revision=?) ON CONFLICT(day,group_id) DO NOTHING").bind(task.date,gid,sig,revision))}return out}
async function mutate(db,body,kind){
 if(!/^[A-Za-z0-9_-]{12,100}$/.test(body.op_id||''))throw err('缺少操作唯一编号');
 const hash=await sha(JSON.stringify({kind,...body}));
 for(let tries=0;tries<5;tries++){
  const previous=await read(db,'SELECT * FROM operations WHERE op_id=?',body.op_id);
  if(previous){if(previous.payload_hash!==hash)throw err('同一操作编号内容不一致',409);return {...JSON.parse(previous.response),duplicate:true}}
  const meta=await read(db,'SELECT * FROM project WHERE id=1');if(!meta)throw err('正式学习数据尚未导入',503);
  const settings=JSON.parse(meta.settings),task=await taskFor(db,body.date);
  if(!task||task.session_id!==body.session_id)throw err('学习任务已变化，请刷新；待同步记录保留',409);
  const current=await taskFor(db,meta.current_date);
  if(task.date!==meta.current_date&&!task.items.every(i=>i.completed))throw err('当前学习日期已变化',409);
  const stmts=[],rev=meta.revision;let response={ok:true,session_id:task.session_id,revision:rev+1};
  if(kind==='rate'){
   const item=task.items.find(i=>i.item_id===body.item_id);
   if(!item)throw err('词条不属于正式 Daily Session',409);
   if(item.completed){if(item.rating!==body.rating)throw err('另一终端已完成不同评级，待同步操作保留',409);return {ok:true,duplicate:true,session_id:task.session_id,item_id:item.item_id}}
   if(task.date!==meta.current_date)throw err('该日期只供回看',409);
   const old=parse(await read(db,'SELECT body FROM states WHERE word=?',key(item.word)))||{};
   const now=new Date().toISOString(),state=applyRating(old,task,item,body.rating,body.latency_ms??null,now);
   let recheck=false;if(body.rating==='vague'&&settings.same_day_recheck_enabled&&!item.is_same_day_recheck)recheck=insertRecheck(task,item);
   const previewed=(task.previewed_words||[]).includes(key(item.word));item.completed=true;item.rating=body.rating;item.latency_ms=body.latency_ms??null;item.rated_at=now;
   const log={log_id:task.session_id+':'+item.item_id,session_id:task.session_id,item_id:item.item_id,was_previewed_today:previewed,review_stage:state.stage,timestamp:now,local_date:task.date,project_id:task.project_id,word:item.word,session_type:'single_word',rating:item.rating,latency_ms:item.latency_ms,is_same_day_recheck:!!item.is_same_day_recheck,rule_version:RULE_VERSION};
   stmts.push(db.prepare('UPDATE states SET body=? WHERE word=? AND EXISTS(SELECT 1 FROM project WHERE revision=?)').bind(JSON.stringify(state),key(item.word),rev));
   stmts.push(db.prepare('INSERT INTO review_log(log_id,body) SELECT ?,? WHERE EXISTS(SELECT 1 FROM project WHERE revision=?)').bind(log.log_id,JSON.stringify(log),rev));
   response={...response,item_id:item.item_id,all_completed:task.items.every(i=>i.completed),recheck_scheduled:recheck};
   if(response.all_completed){
    const nextDay=addDays(task.date,1);let next=await taskFor(db,nextDay);
    if(!next){const cards=(await rows(db,'SELECT body FROM cards')).map(parse),states=await allStates(db);states[key(item.word)]=state;next=await makeTask(meta.project_id,nextDay,selectWords(cards,states,nextDay,settings.daily_new_count),settings.group_size,task.session_id);
     stmts.push(db.prepare('INSERT INTO sessions(day,session_id,body) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM project WHERE revision=?) ON CONFLICT(day) DO NOTHING').bind(nextDay,next.session_id,JSON.stringify(next),rev));}
    stmts.push(...await queueStatements(db,next,rev));response.next_date=nextDay;response.next_session_id=next.session_id;
   }
  }else{
   if(!Array.isArray(body.words)||body.words.some(w=>!task.new_words.map(key).includes(key(w))))throw err('预览词不属于正式任务');
   task.previewed_words=[...new Set([...(task.previewed_words||[]),...body.words.map(key)])];
  }
  stmts.push(db.prepare('UPDATE sessions SET body=? WHERE day=? AND EXISTS(SELECT 1 FROM project WHERE revision=?)').bind(JSON.stringify(task),task.date,rev));
  stmts.push(db.prepare('INSERT INTO operations(op_id,payload_hash,response) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM project WHERE revision=?)').bind(body.op_id,hash,JSON.stringify(response),rev));
  stmts.push(db.prepare('UPDATE project SET revision=revision+1 WHERE id=1 AND revision=?').bind(rev));
  await db.batch(stmts);
  const saved=await read(db,'SELECT response,payload_hash FROM operations WHERE op_id=?',body.op_id);if(saved){if(saved.payload_hash!==hash)throw err('同一操作编号内容不一致',409);return JSON.parse(saved.response);}
 }
 throw err('其他终端正在提交，请稍后重试',409);
}
async function advance(db){
 for(let tries=0;tries<4;tries++){
  const m=await read(db,'SELECT * FROM project WHERE id=1');if(!m)return;const current=await taskFor(db,m.current_date);
  if(!current?.items.length||!current.items.every(i=>i.completed))return;
  const next=await taskFor(db,addDays(current.date,1));if(!next||next.date>shanghaiDay())return;
  const result=await db.prepare('UPDATE project SET current_date=?,revision=revision+1 WHERE revision=? AND id=1').bind(next.date,m.revision).run();if(result.meta.changes)return;
 }
}
async function snapshot(db,day,environment='preview',writable=true){
 await advance(db);const m=await read(db,'SELECT * FROM project WHERE id=1');if(!m)throw err('学习数据尚未导入',503);
 const task=await taskFor(db,day||m.current_date);if(!task)throw err('该日任务尚未冻结',404);
 const jobs=await rows(db,'SELECT group_id,status,content,content_hash,error FROM jobs WHERE day=?',task.date);
 const playback=await rows(db,'SELECT group_id,revision,body FROM playback WHERE session_id=?',task.session_id);
 return {ok:true,environment,writable,authority:'cloud-d1',rule_version:RULE_VERSION,revision:m.revision,current_date:m.current_date,task,cards:await cardsFor(db,task),listening:jobs.map(j=>({...j,content:j.content?JSON.parse(j.content):null})),playback:playback.map(p=>({...p,body:JSON.parse(p.body)})),dates:(await rows(db,'SELECT day FROM sessions ORDER BY day DESC')).map(r=>r.day)};
}
async function progress(db,body){
 const task=await taskFor(db,body.date);if(!task||task.session_id!==body.session_id)throw err('听读任务已变化',409);
 if(!task.groups.some(g=>'G'+String(g.group_id).padStart(2,'0')===body.group_id))throw err('Group 不属于该日任务');
 if(!Number.isFinite(body.position)||body.position<0||body.position>86400||![.8,1,1.2,1.5,2].includes(body.rate))throw err('播放位置或倍速不合法');
 const existing=await read(db,'SELECT revision,body FROM playback WHERE session_id=? AND group_id=?',body.session_id,body.group_id);if(existing){const previous=JSON.parse(existing.body);if(previous.client_id===body.client_id&&previous.position===body.position&&previous.rate===body.rate)return {ok:true,revision:existing.revision}}
 const p={position:body.position,rate:body.rate,updated_at:new Date().toISOString(),client_id:body.client_id};
 const result=await db.prepare('INSERT INTO playback(session_id,group_id,revision,body) SELECT ?,?,1,? WHERE ?=0 ON CONFLICT(session_id,group_id) DO UPDATE SET revision=revision+1,body=excluded.body WHERE playback.revision=?').bind(body.session_id,body.group_id,JSON.stringify(p),body.revision,body.revision).run();
 // Existing records require UPDATE when the caller has a nonzero version.
 if(!result.meta.changes&&body.revision>0){const r=await db.prepare('UPDATE playback SET revision=revision+1,body=? WHERE session_id=? AND group_id=? AND revision=?').bind(JSON.stringify(p),body.session_id,body.group_id,body.revision).run();if(r.meta.changes)return {ok:true,revision:body.revision+1}}
 if(result.meta.changes)return {ok:true,revision:body.revision+1};throw err('另一终端已更新播放位置，请读取云端进度后继续',409);
}
async function serveAudio(db,hash,request,bucket,storageDb=db){
 if(!/^[a-f0-9]{64}$/.test(hash))throw err('音频地址异常');if(bucket){const object=await readAudio(bucket,storageDb,hash,request);if(object)return object}
 const chunks=await rows(db,'SELECT data FROM audio WHERE hash=? ORDER BY chunk',hash);if(!chunks.length)throw err('音频正在生产',404);
 const parts=chunks.map(r=>new Uint8Array(r.data)),length=parts.reduce((n,b)=>n+b.length,0),all=new Uint8Array(length);let n=0;for(const b of parts){all.set(b,n);n+=b.length}
 const headers={'Content-Type':all[0]===82&&all[1]===73&&all[2]===70&&all[3]===70?'audio/wav':'audio/mpeg','Accept-Ranges':'bytes','Cache-Control':'private, max-age=86400'};
 const range=request.headers.get('Range');if(range){const m=range.match(/^bytes=(\d*)-(\d*)$/);if(!m)return new Response(null,{status:416});let start=m[1]?+m[1]:Math.max(0,length-Number(m[2])),end=m[1]?(m[2]?Math.min(+m[2],length-1):length-1):length-1;if(start>end||start>=length)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${length}`}});return new Response(all.slice(start,end+1),{status:206,headers:{...headers,'Content-Range':`bytes ${start}-${end}/${length}`,'Content-Length':String(end-start+1)}})}
 return new Response(all,{headers:{...headers,'Content-Length':String(length)}});
}
async function reserve(db){
 const day=shanghaiDay(),month=day.slice(0,7);
 // Reserve 0.08 RMB before each <=4k output request. Conservative peak tariff upper bound.
 const r=await db.prepare("INSERT INTO budget(day,calls,reserved_fen) SELECT ?,1,8 WHERE COALESCE((SELECT SUM(reserved_fen) FROM budget WHERE day LIKE ?),0)+8<=1000 ON CONFLICT(day) DO UPDATE SET calls=calls+1,reserved_fen=reserved_fen+8 WHERE calls<4 AND COALESCE((SELECT SUM(reserved_fen) FROM budget WHERE day LIKE ?),0)+8<=1000").bind(day,month+'%',month+'%').run();return !!r.meta.changes;
}
async function produce(env){
 if(env.GENERATION_ENABLED!=='true'||!env.DEEPSEEK_KEY)return;
 const db=env.DB.withSession('first-primary');
 const budgetDb=(env.BUDGET||env.DB).withSession('first-primary');
 const job=await read(db,"SELECT * FROM jobs WHERE status IN ('pending','retry','generating') AND lease_until<? AND (attempts<4 OR content IS NOT NULL) ORDER BY day,group_id LIMIT 1",Date.now());if(!job)return;
 const token=crypto.randomUUID();const lease=await db.prepare("UPDATE jobs SET status='generating',lease_until=?,lease_token=?,attempts=attempts+CASE WHEN content IS NULL THEN 1 ELSE 0 END WHERE day=? AND group_id=? AND lease_until<? AND (attempts<4 OR content IS NOT NULL)").bind(Date.now()+300000,token,job.day,job.group_id,Date.now()).run();if(!lease.meta.changes)return;
 try{
  const task=await taskFor(db,job.day),g=task.groups.find(g=>'G'+String(g.group_id).padStart(2,'0')===job.group_id);if(!g||await groupSignature(task.project_id,task.date,job.group_id,g.words)!==job.signature)throw Error('冻结 Group 签名不匹配');
  const cards=(await cardsFor(db,task)).filter(c=>g.words.map(key).includes(key(c.word)));
  let segments=job.content?validateGroup({group_id:job.group_id,segments:JSON.parse(job.content)},job.group_id,g.words):null;
  if(!segments){if(new TextEncoder().encode(prompt(job.group_id,cards)).length>16000)throw Error('生成输入超过预算允许长度');if(!await reserve(budgetDb))throw Error('每日或月度模型预算已达上限');
   const r=await fetch('https://api.deepseek.com/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+env.DEEPSEEK_KEY,'Content-Type':'application/json'},body:JSON.stringify({model:'deepseek-flash',thinking:{type:'disabled'},messages:[{role:'user',content:prompt(job.group_id,cards)}],response_format:{type:'json_object'},max_tokens:4000,temperature:.7}),signal:AbortSignal.timeout(120000)});
   if(!r.ok)throw Error('DeepSeek 调用失败 '+r.status);const result=await r.json();
   await budgetDb.prepare('INSERT INTO generation_usage(id,day,provider,usage) VALUES(?,?,?,?)').bind(token,shanghaiDay(),'deepseek',JSON.stringify({...result.usage,candidate:result.choices[0].message.content})).run();
   segments=validateGroup(JSON.parse(result.choices[0].message.content),job.group_id,g.words);
   await db.batch([db.prepare('UPDATE jobs SET content=?,content_hash=? WHERE day=? AND group_id=? AND lease_token=?').bind(JSON.stringify(segments),await contentHash(segments),job.day,job.group_id,token)]);
  }
  if(env.TTS_ENABLED!=='true')throw Error('正文已通过校验，云端语音尚未启用');
  // MeloTTS Chinese supports Chinese/English mixed text. One immutable audio per Group.
  const speech=segments.map(s=>s.speech_content).join('\n'),audioHash=await sha('melotts-zh-v1:'+speech);
  if(!(env.AUDIO?await hasAudio(env.AUDIO,budgetDb,audioHash):await read(db,'SELECT chunk FROM audio WHERE hash=? LIMIT 1',audioHash))){
   const result=await env.AI.run('@cf/myshell-ai/melotts',{prompt:speech,lang:'zh'});
   let bytes;if(result instanceof ReadableStream)bytes=new Uint8Array(await new Response(result).arrayBuffer());else if(result instanceof ArrayBuffer)bytes=new Uint8Array(result);else if(result.audio)bytes=b64(result.audio);else throw Error('语音返回格式异常');
   if(bytes.length<1000)throw Error('云端语音为空');if(env.AUDIO){await writeAudio(env.AUDIO,budgetDb,audioHash,bytes)}else{const stmts=[];for(let n=0;n<bytes.length;n+=200000)stmts.push(db.prepare('INSERT OR IGNORE INTO audio(hash,chunk,data) VALUES(?,?,?)').bind(audioHash,n/200000,bytes.slice(n,n+200000)));await db.batch(stmts);}
  }
  const content={generator:job.origin||'deepseek-api',segments,audio:'/api/audio/'+audioHash,signature:job.signature,active_version:1,speech_hash:await sha(speech)};
  await db.prepare("UPDATE jobs SET status='ready',content=?,content_hash=?,lease_until=0,error=NULL WHERE day=? AND group_id=? AND lease_token=?").bind(JSON.stringify(content),await contentHash(segments),job.day,job.group_id,token).run();
 }catch(e){const capped=e.message==='每日或月度模型预算已达上限';await db.prepare("UPDATE jobs SET status='retry',lease_until=?,error=?,attempts=attempts-? WHERE day=? AND group_id=? AND lease_token=?").bind(Date.now()+600000,e.message,capped?1:0,job.day,job.group_id,token).run()}
}
export default {
 async fetch(request,env,ctx){
  try{
   const url=new URL(request.url);if(url.pathname==='/health')return json({ok:true,service:'daily-listening-online',rule_version:RULE_VERSION});
   await identity(request,env);
   if(url.pathname.startsWith('/images/'))return json({ok:false,message:'在线版本不提供图片'},404);
   const db=env.DB.withSession('first-primary');
   if(url.pathname==='/api/session'&&request.method==='GET')return json(await snapshot(db,url.searchParams.get('date'),env.ENVIRONMENT||'preview',env.ENVIRONMENT!=='production'||env.FORMAL_ACTIVE==='true'));
   if(url.pathname==='/api/status'&&request.method==='GET')return json({ok:true,authority:'cloud-d1',budget:await rows(db,'SELECT * FROM budget ORDER BY day DESC LIMIT 31'),jobs:await rows(db,'SELECT day,group_id,status,error FROM jobs ORDER BY day DESC LIMIT 12')});
   if(url.pathname==='/api/export'&&request.method==='GET')return json({project:await read(db,'SELECT * FROM project'),cards:await rows(db,'SELECT * FROM cards'),states:await rows(db,'SELECT * FROM states'),sessions:await rows(db,'SELECT * FROM sessions'),review_log:await rows(db,'SELECT * FROM review_log')});
   if(url.pathname.startsWith('/api/audio/')&&request.method==='GET')return serveAudio(db,url.pathname.split('/').pop(),request,env.AUDIO,(env.BUDGET||env.DB).withSession('first-primary'));
   if(['/api/rate','/api/preview','/api/playback'].includes(url.pathname)&&request.method==='POST'){
    if(env.ENVIRONMENT==='production'&&env.FORMAL_ACTIVE!=='true')throw err('正式接管尚未启用，请继续使用现有系统',503);
    if(request.headers.get('Origin')!==url.origin)throw err('请求来源不一致',403);
    if(!request.headers.get('Content-Type')?.startsWith('application/json'))throw err('请求格式不合法');
    if(Number(request.headers.get('Content-Length'))>20000)throw err('请求过大',413);
    const body=await request.json();
    if(url.pathname==='/api/playback')return json(await progress(db,body));
    const answer=await mutate(db,body,url.pathname==='/api/rate'?'rate':'preview');if(answer.all_completed)ctx.waitUntil(produce(env));return json(answer);
   }
   if(url.pathname.startsWith('/api/'))throw err('接口不存在',404);
   const response=await env.ASSETS.fetch(request);const headers=new Headers(response.headers);headers.set('Cache-Control','private, no-cache');headers.set('X-Content-Type-Options','nosniff');headers.set('Referrer-Policy','same-origin');headers.set('Content-Security-Policy',"default-src 'self'; img-src 'self' data:; media-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'");return new Response(response.body,{status:response.status,headers});
  }catch(e){return json({ok:false,message:e.message},e.status||500)}
 },
 async scheduled(event,env,ctx){ctx.waitUntil(produce(env))}
};
