// The Python StudyManager contract is checked by tests/parity.py.
export const RULE_VERSION='study-python-20261007-v1';
export const key=w=>w.trim().toLowerCase();
export function addDays(day,n){return new Date(Date.parse(day+'T12:00:00Z')+n*86400000).toISOString().slice(0,10)}
export function shanghaiDay(now=new Date()){return new Date(now.getTime()+8*3600000).toISOString().slice(0,10)}
export function applyRating(previous,task,item,rating,latency,now){
 if(!['vague','recognized','instant'].includes(rating))throw Error('评级无效');
 if(latency!==null&&(!Number.isInteger(latency)||latency<0))throw Error('反应时间无效');
 const s={...previous},day=task.date;
 const cross=!!(s.last_studied_at&&s.last_studied_at.split('T')[0]!==day&&['learning','studied','mastered'].includes(s.status));
 const preview=(task.previewed_words||[]).map(key).includes(key(item.word));
 let status='learning',stage=0,interval=1,due=addDays(day,1),cold=false,mastered=s.mastered_at??null;
 if(rating==='recognized'&&cross){stage=Math.min((s.stage||0)+1,4);interval=[1,3,7,14,30][stage];due=addDays(day,interval)}
 if(rating==='instant'&&cross&&!preview&&!item.is_same_day_recheck){status='mastered';stage=s.stage||0;interval=s.interval_days||1;due=null;cold=true;mastered=now}
 return {...s,status,stage,interval_days:interval,due_date:due,cold_review_passed:cold,mastered_at:mastered,last_studied_at:now,last_rating:rating,last_latency_ms:latency,history_count:(s.history_count||0)+1};
}
export function insertRecheck(task,item){
 if(task.items.some(i=>key(i.word)===key(item.word)&&i.is_same_day_recheck))return false;
 const unfinished=task.items.map((i,n)=>i.completed?null:n).filter(n=>n!==null);
 task.items.splice(unfinished.length>15?unfinished[15]:task.items.length,0,{word:item.word,item_id:task.session_id+':recheck:'+key(item.word),is_new:false,is_due_review:false,group_id:item.group_id,completed:false,rating:null,latency_ms:null,is_same_day_recheck:true,rated_at:null});
 task.items.forEach((i,n)=>i.sequence=n+1);return true;
}
export function selectWords(cards,states,day,count){
 const rank=c=>c.latest_source_rank||c.last_known_rank||99999,active=c=>c.source_active===false?1:0;
 const due=[],fresh=[],other=[];
 for(const c of cards){const s=states[key(c.word)]||{};if(s.status==='learning'&&s.due_date&&s.due_date<=day)due.push(c);else if((s.status||'unstudied')==='unstudied')fresh.push(c);else other.push(c)}
 const cmp=(a,b)=>a<b?-1:a>b?1:0;
 due.sort((a,b)=>cmp(states[key(a.word)].due_date,states[key(b.word)].due_date)||active(a)-active(b)||rank(a)-rank(b));
 fresh.sort((a,b)=>active(a)-active(b)||rank(a)-rank(b));
 other.sort((a,b)=>cmp(states[key(a.word)]?.last_studied_at||'',states[key(b.word)]?.last_studied_at||'')||rank(a)-rank(b));
 const out=[],seen=new Set();for(const [list,isNew] of [[due,false],[fresh,true],[other,false]])for(const c of list){if(out.length<count&&!seen.has(key(c.word))){seen.add(key(c.word));out.push({...c,is_new:isNew,is_due_review:!isNew})}}return out;
}
export async function sha(text){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('')}
export async function groupSignature(project,day,gid,words){return `sig_${day}_${gid.toLowerCase()}_${(await sha(`${project}:${day}:${gid}:`+words.map(key).join(','))).slice(0,16)}`}
export async function makeTask(project,day,cards,size,parent){
 const id=`${project}_${day}_${(await sha(parent)).slice(0,8)}`;
 const task={date:day,session_id:id,project_id:project,created_at:new Date().toISOString(),daily_new_count:cards.length,new_words:cards.map(c=>c.word),groups:[],items:[],previewed_words:[]};
 for(let n=0;n<cards.length;n+=size){const words=cards.slice(n,n+size).map(c=>c.word),group_id=n/size+1,gid='G'+String(group_id).padStart(2,'0');task.groups.push({group_id,name:'Group '+group_id,words,group_signature:await groupSignature(project,day,gid,words)});
 cards.slice(n,n+size).forEach((c,k)=>task.items.push({word:c.word,item_id:id+':'+(n+k+1),is_new:c.is_new,is_due_review:c.is_due_review,group_id,sequence:n+k+1,completed:false,rating:null,latency_ms:null,is_same_day_recheck:false,rated_at:null}));}
 return task;
}
