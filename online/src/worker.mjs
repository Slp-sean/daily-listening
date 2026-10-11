import {hasAudio,writeAudio,readAudio,reserveStorage,reserveTts,speechParts,joinWaves} from './audio-store.mjs';
import {RULE_VERSION,key,addDays,shanghaiDay,applyRating,insertRecheck,selectWords,makeTask,sha,groupSignature} from './srs.mjs';
import {validateGroup,normalizeGeneratedGroup,generationPrompt,contentHash,CONTENT_CONTRACT} from './content.mjs';
import {ensureQuality,QUALITY_POLICY} from './quality.mjs';
const json=(x,status=200)=>new Response(JSON.stringify(x),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const err=(message,status=400)=>Object.assign(Error(message),{status});
const canWrite=(env,url)=>env.ENVIRONMENT!=='production'||(env.FORMAL_ACTIVE==='true'&&url.hostname==='listen.zhaocaijinbao.top');
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
  const today=shanghaiDay();
  if(m.current_date<today){
   let next=await taskFor(db,today);const rev=m.revision,stmts=[];
   if(!next){const settings=JSON.parse(m.settings),cards=(await rows(db,'SELECT body FROM cards')).map(parse),states=await allStates(db);
    next=await makeTask(m.project_id,today,selectWords(cards,states,today,settings.daily_new_count),settings.group_size,current?.session_id||m.project_id);
    stmts.push(db.prepare('INSERT INTO sessions(day,session_id,body) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM project WHERE revision=?) ON CONFLICT(day) DO NOTHING').bind(today,next.session_id,JSON.stringify(next),rev));
   }
   stmts.push(...await queueStatements(db,next,rev),db.prepare('UPDATE project SET current_date=?,revision=revision+1 WHERE revision=? AND id=1').bind(today,rev));
   await db.batch(stmts);if((await read(db,'SELECT current_date FROM project WHERE id=1')).current_date===today)return;continue;
  }
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
 const completed=task.items.length>0&&task.items.every(i=>i.completed),nextDate=addDays(task.date,1),nextTask=completed?await taskFor(db,nextDate):null;
 const nextJobs=nextTask?await rows(db,'SELECT group_id,status FROM jobs WHERE day=?',nextDate):[];
 const nextDay={frozen:!!nextTask,date:nextDate,word_count:nextTask?.new_words.length||0,group_count:nextTask?.groups.length||0,ready_count:nextJobs.filter(j=>j.status==='ready').length};
 return {ok:true,environment,writable,authority:'cloud-d1',rule_version:RULE_VERSION,revision:m.revision,current_date:m.current_date,next_day:nextDay,task,cards:await cardsFor(db,task),listening:jobs.map(j=>({...j,content:j.content?JSON.parse(j.content):null})),playback:playback.map(p=>({...p,body:JSON.parse(p.body)})),dates:(await rows(db,'SELECT day FROM sessions ORDER BY day DESC')).map(r=>r.day)};
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
async function pronunciation(db,env,request,ctx){
 const url=new URL(request.url),word=key(url.searchParams.get('word')||''),sentence=url.searchParams.get('sentence')==='1';
 if(!word||word.length>80)throw err('发音词条不合法');
 const card=parse(await read(db,'SELECT body FROM cards WHERE word=?',word));if(!card)throw err('词条不存在',404);
 const text=sentence?card.example_sentence:card.word;
 if(!text||text.length>400)throw err('该词条没有可用的发音文本');
 if(!env.AUDIO||!env.AI)throw err('云端发音尚未配置',503);
 const storageDb=(env.BUDGET||env.DB).withSession('first-primary'),hash=await sha('melotts-en-v1:'+text);
 if(!await hasAudio(env.AUDIO,storageDb,hash)){
  const generate=async()=>{
   await reserveStorage(storageDb,'voice_tts_calls',1,200,new Date().toISOString().slice(0,10));
   await reserveTts(storageDb,text);
   const result=await env.AI.run('@cf/myshell-ai/melotts',{prompt:text,lang:'en'});
   const bytes=result instanceof ReadableStream?new Uint8Array(await new Response(result).arrayBuffer()):result instanceof ArrayBuffer?new Uint8Array(result):result.audio?b64(result.audio):null;
   if(!bytes||bytes.length<1000)throw err('云端发音生产失败，请重试',503);
   await writeAudio(env.AUDIO,storageDb,hash,bytes);
  };
  const work=generate();ctx.waitUntil(work.catch(()=>{}));await work;
 }
 return serveAudio(db,hash,request,env.AUDIO,storageDb);
}
function dailyCallLimit(env,day){
 const extra=Number(env.GENERATION_EXTRA_CALLS);
 return 4+(env.GENERATION_EXTRA_DAY===day&&Number.isInteger(extra)&&extra>0&&extra<=8?extra:0);
}
async function reserve(db,env){
 const day=shanghaiDay(),month=day.slice(0,7);
 // <=10k UTF-8 input bytes and <=7k total output tokens cost <=0.076 RMB
 // at the peak tariff; the 0.08 reserve also covers message framing.
 const r=await db.prepare("INSERT INTO budget(day,calls,reserved_fen) SELECT ?,1,8 WHERE COALESCE((SELECT SUM(reserved_fen) FROM budget WHERE day LIKE ?),0)+8<=1000 ON CONFLICT(day) DO UPDATE SET calls=calls+1,reserved_fen=reserved_fen+8 WHERE calls<? AND COALESCE((SELECT SUM(reserved_fen) FROM budget WHERE day LIKE ?),0)+8<=1000").bind(day,month+'%',dailyCallLimit(env,day),month+'%').run();return !!r.meta.changes;
}
async function reuseVerifiedContent(db,storageDb,env,job,group,token){
 const history=await rows(db,"SELECT * FROM jobs WHERE status='ready' AND day<? AND group_id=? ORDER BY day DESC LIMIT 30",job.day,job.group_id);
 for(const source of history){
  const task=await taskFor(db,source.day),g=task?.groups.find(g=>'G'+String(g.group_id).padStart(2,'0')===source.group_id);
  if(!g||JSON.stringify(g.words.map(key))!==JSON.stringify(group.words.map(key)))continue;
  try{
   if(source.signature!==await groupSignature(task.project_id,task.date,source.group_id,g.words))continue;
   const original=JSON.parse(source.content);if(original.generator?.startsWith('deepseek-api')&&!original.quality_review?.approved)continue;const segments=validateGroup({group_id:job.group_id,segments:original.segments},job.group_id,group.words);
   const hash=await contentHash(segments),speechHash=await sha(segments.map(s=>s.speech_content).join('\n'));
   if(hash!==source.content_hash||speechHash!==original.speech_hash)continue;
   const audioHash=original.audio?.match(/^\/api\/audio\/([a-f0-9]{64})$/)?.[1];
   if(!audioHash||!(env.AUDIO?await hasAudio(env.AUDIO,storageDb,audioHash):await read(db,'SELECT chunk FROM audio WHERE hash=? LIMIT 1',audioHash)))continue;
   const content={...original,contract:CONTENT_CONTRACT,generator:'reused-verified',signature:job.signature,reused_from:{day:source.day,signature:source.signature,generator:original.generator}};
   const r=await db.prepare("UPDATE jobs SET status='ready',origin='reused-verified',content=?,content_hash=?,lease_until=0,error=NULL WHERE day=? AND group_id=? AND lease_token=?").bind(JSON.stringify(content),hash,job.day,job.group_id,token).run();
   if(r.meta.changes)return true;
  }catch{/* Reuse requires the same complete content and audio checks. */}
 }
 return false;
}
async function produce(env,allowGeneration=true){
 if(env.GENERATION_ENABLED!=='true'||!env.DEEPSEEK_KEY)return;
 const db=env.DB.withSession('first-primary');
 await advance(db);
 const budgetDb=(env.BUDGET||env.DB).withSession('first-primary');
 // Retries remain eligible after a new day starts; the shared daily/monthly
 // budget below limits paid calls, while the lease prevents concurrent work.
 const job=await read(db,"SELECT * FROM jobs WHERE status IN ('pending','retry','generating') AND lease_until<? ORDER BY day,group_id LIMIT 1",Date.now());if(!job)return;
 const token=crypto.randomUUID();const lease=await db.prepare("UPDATE jobs SET status='generating',error=NULL,lease_until=?,lease_token=?,attempts=attempts+CASE WHEN content IS NULL THEN 1 ELSE 0 END WHERE day=? AND group_id=? AND lease_until<?").bind(Date.now()+1200000,token,job.day,job.group_id,Date.now()).run();if(!lease.meta.changes)return;
 try{
  const task=await taskFor(db,job.day),g=task.groups.find(g=>'G'+String(g.group_id).padStart(2,'0')===job.group_id);if(!g||await groupSignature(task.project_id,task.date,job.group_id,g.words)!==job.signature)throw Error('冻结 Group 签名不匹配');
  const cards=(await cardsFor(db,task)).filter(c=>g.words.map(key).includes(key(c.word)));
  const savedContent=job.content?JSON.parse(job.content):null;
  let segments=savedContent?validateGroup({group_id:job.group_id,segments:savedContent.segments||savedContent},job.group_id,g.words):null,normalizations=savedContent?.normalizations||[],candidateId=savedContent?.candidate_id||null;
  if(!segments&&job.origin!=='api-contract-acceptance'&&await reuseVerifiedContent(db,budgetDb,env,job,g,token))return;
  if(!segments){
   const environment=env.ENVIRONMENT||'preview';
   const candidates=await rows(budgetDb,"SELECT id,usage FROM generation_usage WHERE provider='deepseek' AND json_extract(usage,'$.signature')=? AND json_extract(usage,'$.environment')=? AND json_extract(usage,'$.format')=? AND json_extract(usage,'$.contract_rejected') IS NULL AND COALESCE(json_extract(usage,'$.quality_rejected_policy'),'')!=? ORDER BY rowid DESC LIMIT 8",job.signature,environment,CONTENT_CONTRACT,QUALITY_POLICY);
   for(const candidate of candidates){try{
    const saved=JSON.parse(candidate.usage),normalized=normalizeGeneratedGroup(JSON.parse(saved.candidate),job.group_id,g.words);
    segments=validateGroup(normalized,job.group_id,g.words);normalizations=normalized.normalizations;candidateId=candidate.id;break;
   }catch{/* A cached candidate must still pass the current task's complete validation. */}}
  }
  if(!allowGeneration){await db.prepare("UPDATE jobs SET status='pending',lease_until=0 WHERE day=? AND group_id=? AND lease_token=?").bind(job.day,job.group_id,token).run();return;}
  if(!segments){
   const rejected=await read(budgetDb,"SELECT usage FROM generation_usage WHERE provider='deepseek' AND json_extract(usage,'$.signature')=? AND json_extract(usage,'$.environment')=? AND json_extract(usage,'$.format')=? ORDER BY rowid DESC LIMIT 1",job.signature,env.ENVIRONMENT||'preview',CONTENT_CONTRACT);
   const prior=rejected?JSON.parse(rejected.usage):null,feedback=prior?.quality_rejected||prior?.validation_error||'',input=generationPrompt(job.group_id,cards,feedback);
   const free=await read(budgetDb,"SELECT amount FROM storage_budget WHERE metric='tts_neurons' AND period=?",new Date().toISOString().slice(0,10));
   if((free?.amount||0)+850>9000)throw Error('今日免费内容复核额度不足，暂停新的付费生成，额度恢复后自动继续');
   if(!await reserve(budgetDb,env))throw Error('每日或月度模型预算已达上限');
   const r=await fetch('https://api.deepseek.com/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+env.DEEPSEEK_KEY,'Content-Type':'application/json'},body:JSON.stringify({model:'deepseek-flash',thinking:{type:'enabled'},reasoning_effort:'low',messages:[{role:'user',content:input}],response_format:{type:'json_object'},max_tokens:7000,temperature:.4}),signal:AbortSignal.timeout(120000)});
   if(!r.ok)throw Error('DeepSeek 调用失败 '+r.status);const result=await r.json();
   await budgetDb.prepare('INSERT INTO generation_usage(id,day,provider,usage) VALUES(?,?,?,?)').bind(token,shanghaiDay(),'deepseek',JSON.stringify({...result.usage,model:result.model,completed_at:new Date().toISOString(),format:CONTENT_CONTRACT,signature:job.signature,group_id:job.group_id,environment:env.ENVIRONMENT||'preview',request_reason:job.origin,quality_feedback:feedback,input_bytes:new TextEncoder().encode(input).length,candidate:result.choices[0].message.content})).run();
   candidateId=token;try{if(result.choices[0].finish_reason==='length')throw Error('模型输出截断，不能发布');const normalized=normalizeGeneratedGroup(JSON.parse(result.choices[0].message.content),job.group_id,g.words);segments=validateGroup(normalized,job.group_id,g.words);normalizations=normalized.normalizations}catch(e){await budgetDb.prepare("UPDATE generation_usage SET usage=json_set(usage,'$.validation_error',?) WHERE id=?").bind(e.message,token).run();throw e}
  }
  if(candidateId){
   await budgetDb.prepare("UPDATE generation_usage SET usage=json_set(usage,'$.validated_signature',?,'$.normalizations',json(?)) WHERE id=?").bind(job.signature,JSON.stringify(normalizations),candidateId).run();
   await db.prepare('UPDATE jobs SET content=?,content_hash=? WHERE day=? AND group_id=? AND lease_token=?').bind(JSON.stringify({segments,candidate_id:candidateId,normalizations}),await contentHash(segments),job.day,job.group_id,token).run();
  }
  let quality;try{quality=await ensureQuality(env,budgetDb,job,cards,segments,savedContent?.quality_review)}catch(e){if(e.quality_rejected){if(candidateId)await budgetDb.prepare("UPDATE generation_usage SET usage=json_set(usage,'$.quality_rejected',?,'$.quality_rejected_policy',?) WHERE id=?").bind(e.message,QUALITY_POLICY,candidateId).run();await db.prepare('UPDATE jobs SET content=NULL,content_hash=NULL WHERE day=? AND group_id=? AND lease_token=?').bind(job.day,job.group_id,token).run()}throw e}segments=quality.segments;
  await db.prepare('UPDATE jobs SET content=?,content_hash=? WHERE day=? AND group_id=? AND lease_token=?').bind(JSON.stringify({segments,candidate_id:candidateId,normalizations,quality_review:quality.review}),await contentHash(segments),job.day,job.group_id,token).run();
  if(env.TTS_ENABLED!=='true')throw Error('正文已通过校验，云端语音尚未启用');
  // MeloTTS Chinese supports Chinese/English mixed text. One immutable audio per Group.
  const speech=segments.map(s=>s.speech_content).join('\n'),audioHash=await sha('melotts-zh-v2:'+speech),pieceHashes=[];
  if(!(env.AUDIO?await hasAudio(env.AUDIO,budgetDb,audioHash):await read(db,'SELECT chunk FROM audio WHERE hash=? LIMIT 1',audioHash))){
   const parts=[];let index=0;for(const text of speechParts(speech)){
    const owner=await read(db,'SELECT lease_token FROM jobs WHERE day=? AND group_id=?',job.day,job.group_id);if(owner?.lease_token!==token)throw Error('音频任务已由新版本接管');
    const hash=await sha(audioHash+':piece:'+index++);pieceHashes.push(hash);let bytes;
    if(env.AUDIO&&await hasAudio(env.AUDIO,budgetDb,hash)){await reserveStorage(budgetDb,'read_ops',1,100000,new Date().toISOString().slice(0,7));const object=await env.AUDIO.get(hash);if(!object)throw Error('音频片段待恢复');bytes=new Uint8Array(await object.arrayBuffer())}
    else{await reserveTts(budgetDb,text);const result=await env.AI.run('@cf/myshell-ai/melotts',{prompt:text,lang:'zh'});
     if(result instanceof ReadableStream)bytes=new Uint8Array(await new Response(result).arrayBuffer());else if(result instanceof ArrayBuffer)bytes=new Uint8Array(result);else if(result.audio)bytes=b64(result.audio);else throw Error('语音返回格式异常');
     if(bytes.length<1000)throw Error('云端语音为空');if(env.AUDIO)await writeAudio(env.AUDIO,budgetDb,hash,bytes);
    }
    parts.push(bytes);
   }
   const bytes=joinWaves(parts);if(env.AUDIO){await writeAudio(env.AUDIO,budgetDb,audioHash,bytes)}else{const stmts=[];for(let n=0;n<bytes.length;n+=200000)stmts.push(db.prepare('INSERT OR IGNORE INTO audio(hash,chunk,data) VALUES(?,?,?)').bind(audioHash,n/200000,bytes.slice(n,n+200000)));await db.batch(stmts);}
  }
  const content={contract:CONTENT_CONTRACT,generator:quality.revised?'deepseek-api+cloudflare-quality-revision':job.origin==='api-contract-acceptance'?'deepseek-api':(job.origin||'deepseek-api'),candidate_id:candidateId,normalizations,quality_review:quality.review,segments,audio:'/api/audio/'+audioHash,signature:job.signature,active_version:1,speech_hash:await sha(speech)};
  await db.prepare("UPDATE jobs SET status='ready',content=?,content_hash=?,lease_until=0,error=NULL WHERE day=? AND group_id=? AND lease_token=?").bind(JSON.stringify(content),await contentHash(segments),job.day,job.group_id,token).run();
  // Only temporary pieces are removed after the complete published audio exists.
  if(env.AUDIO)for(const hash of pieceHashes){try{await env.AUDIO.delete(hash);await budgetDb.prepare('DELETE FROM audio_objects WHERE hash=?').bind(hash).run()}catch{/* Keep an unfinished cleanup safely accounted for. */}}
 }catch(e){const capped=e.message==='每日或月度模型预算已达上限';await db.prepare("UPDATE jobs SET status='retry',lease_until=?,error=?,attempts=attempts-? WHERE day=? AND group_id=? AND lease_token=?").bind(Date.now()+600000,e.message,capped?1:0,job.day,job.group_id,token).run()}
}
export default {
 async fetch(request,env,ctx){
  try{
   const url=new URL(request.url);if(url.pathname==='/health')return json({ok:true,service:'daily-listening-online',rule_version:RULE_VERSION});
   await identity(request,env);
   if(env.ENVIRONMENT==='production'&&env.FORMAL_ACTIVE==='true'&&url.pathname==='/'&&url.hostname!=='listen.zhaocaijinbao.top')return Response.redirect('https://listen.zhaocaijinbao.top/',302);
   if(url.pathname.startsWith('/images/'))return json({ok:false,message:'在线版本不提供图片'},404);
   const db=env.DB.withSession('first-primary');
   if(url.pathname==='/api/session'&&request.method==='GET'){const data=await snapshot(db,url.searchParams.get('date'),env.ENVIRONMENT||'preview',canWrite(env,url));if(data.listening.some(j=>j.status!=='ready'))ctx.waitUntil(produce(env,false));return json(data)}
   if(url.pathname==='/latest'||url.pathname==='/latest/')return Response.redirect(url.origin+'/',302);
   if(url.pathname==='/api/pronunciation'&&request.method==='GET')return await pronunciation(db,env,request,ctx);
   if(url.pathname==='/api/status'&&request.method==='GET')return json({ok:true,authority:'cloud-d1',budget:await rows((env.BUDGET||env.DB).withSession('first-primary'),'SELECT * FROM budget ORDER BY day DESC LIMIT 31'),jobs:await rows(db,'SELECT day,group_id,status,error FROM jobs ORDER BY day DESC LIMIT 12')});
   if(url.pathname==='/api/export'&&request.method==='GET')return json({project:await read(db,'SELECT * FROM project'),cards:await rows(db,'SELECT * FROM cards'),states:await rows(db,'SELECT * FROM states'),sessions:await rows(db,'SELECT * FROM sessions'),review_log:await rows(db,'SELECT * FROM review_log')});
   if(url.pathname.startsWith('/api/audio/')&&request.method==='GET')return await serveAudio(db,url.pathname.split('/').pop(),request,env.AUDIO,(env.BUDGET||env.DB).withSession('first-primary'));
   if(['/api/rate','/api/preview','/api/playback'].includes(url.pathname)&&request.method==='POST'){
    if(!canWrite(env,url))throw err('正式接管尚未启用，请继续使用现有系统',503);
    if(request.headers.get('Origin')!==url.origin)throw err('请求来源不一致',403);
    if(!request.headers.get('Content-Type')?.startsWith('application/json'))throw err('请求格式不合法');
    if(Number(request.headers.get('Content-Length'))>20000)throw err('请求过大',413);
    const body=await request.json();
    if(url.pathname==='/api/playback')return json(await progress(db,body));
    const answer=await mutate(db,body,url.pathname==='/api/rate'?'rate':'preview');if(answer.all_completed)ctx.waitUntil(produce(env,false));return json(answer);
   }
   if(url.pathname.startsWith('/api/'))throw err('接口不存在',404);
   const response=await env.ASSETS.fetch(request);const headers=new Headers(response.headers);headers.set('Cache-Control','private, no-cache');headers.set('X-Content-Type-Options','nosniff');headers.set('Referrer-Policy','same-origin');headers.set('Content-Security-Policy',"default-src 'self'; img-src 'self' data:; media-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'");return new Response(response.body,{status:response.status,headers});
  }catch(e){return json({ok:false,message:e.message},e.status||500)}
 },
 async scheduled(event,env,ctx){await produce(env)}
};
