// Exercise the actual Worker routes and SQLite transactions, without cloud data.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import worker from '../src/worker.mjs';
import {makeTask,shanghaiDay,addDays} from '../src/srs.mjs';
const sql=new DatabaseSync(':memory:');sql.exec(fs.readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
class Statement{constructor(text,values=[]){this.text=text;this.values=values}bind(...v){return new Statement(this.text,v)}async first(){return sql.prepare(this.text).get(...this.values)||null}async all(){return {results:sql.prepare(this.text).all(...this.values)}}async run(){const r=sql.prepare(this.text).run(...this.values);return {meta:{changes:Number(r.changes)}}}}
const db={withSession(){return this},prepare(text){return new Statement(text)},async batch(stmts){sql.exec('BEGIN');try{const result=[];for(const s of stmts)result.push(await s.run());sql.exec('COMMIT');return result}catch(e){sql.exec('ROLLBACK');throw e}}};
const day=shanghaiDay(),cards=['alpha','beta','gamma'].map((word,i)=>({word,translation:'测试',latest_source_rank:i+1})),task=await makeTask('isolated-flow',day,cards,2,'fixture');
sql.prepare('INSERT INTO project VALUES(1,0,?,?,?,?,?)').run('isolated-flow',JSON.stringify({daily_new_count:3,group_size:2,same_day_recheck_enabled:true}),day,'fixture','fixture');
sql.prepare('INSERT INTO sessions VALUES(?,?,?)').run(day,task.session_id,JSON.stringify(task));
for(const c of cards){sql.prepare('INSERT INTO cards VALUES(?,?)').run(c.word,JSON.stringify(c));sql.prepare('INSERT INTO states VALUES(?,?)').run(c.word,JSON.stringify({status:'learning',stage:0,interval_days:1,last_studied_at:addDays(day,-2)+'T08:00:00',history_count:0,due_date:day}))}
const env={DB:db,LOCAL_TEST:'true',GENERATION_ENABLED:'false'},ctx={waitUntil(p){return p}},origin='http://127.0.0.1';
async function request(path,body,override={}){const r=await worker.fetch(new Request(origin+path,{method:body?'POST':'GET',headers:body?{'Origin':origin,'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined}),{...env,...override},ctx);return {status:r.status,body:await r.json()}}
const payload=(item,rating,op_id)=>({date:day,session_id:task.session_id,item_id:item.item_id,rating,latency_ms:100,op_id});
const first=payload(task.items[0],'vague','first-rating-unique-01');assert.equal((await request('/api/rate',first)).status,200);assert.equal((await request('/api/rate',first)).body.duplicate,true);assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM review_log').get().n,1);
assert.equal((await request('/api/rate',{...first,op_id:'different-rating-unique',rating:'instant'})).status,409);
const race=await Promise.all([request('/api/rate',payload(task.items[1],'recognized','client-one-rating-unique')),request('/api/rate',payload(task.items[1],'instant','client-two-rating-unique'))]);assert.equal(race.filter(r=>r.status===200).length,1);assert.equal(race.filter(r=>r.status===409).length,1);assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM review_log').get().n,2);
assert.equal((await request('/api/rate',payload(task.items[2],'instant','third-rating-unique-01'))).status,200);assert.equal(JSON.parse(sql.prepare("SELECT body FROM states WHERE word='gamma'").get().body).status,'mastered');
assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,1,'No premature tomorrow task before recheck');
const updated=JSON.parse(sql.prepare('SELECT body FROM sessions WHERE day=?').get(day).body),recheck=updated.items.find(i=>i.is_same_day_recheck);assert.ok(recheck);const last=await request('/api/rate',payload(recheck,'recognized','recheck-rating-unique-01'));assert.equal(last.body.all_completed,true);assert.equal(last.body.next_date,addDays(day,1));assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,2);
assert.equal((await request('/api/rate',payload(recheck,'recognized','recheck-rating-unique-01'))).body.duplicate,true);assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM review_log').get().n,4);
const play={date:day,session_id:task.session_id,group_id:'G01',position:7,rate:1.2,revision:0,client_id:'client-one'};assert.equal((await request('/api/playback',play)).body.revision,1);assert.equal((await request('/api/playback',play)).body.revision,1);assert.equal((await request('/api/playback',{...play,client_id:'client-two',position:9})).status,409);assert.equal((await request('/api/playback',{...play,revision:1,position:8})).body.revision,2);
assert.equal((await request('/api/rate',first,{ENVIRONMENT:'production',FORMAL_ACTIVE:'false'})).status,503);
assert.equal((await request('/api/session')).body.task.items.filter(i=>i.completed).length,4);
assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,2);
console.log('Actual Worker/SQLite flow passed: three grades, same-day recheck, idempotent retry, concurrent conflict, last-grade tomorrow freeze, playback CAS, readonly production. No private or cloud records written.');
