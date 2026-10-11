import {sha,key} from './srs.mjs';
const markup=/\{\{([^|{}]+)\|([^{}]*)\}\}/g;
// The model supplies complete English sentences and Chinese explanations.
// Only this adapter inserts study markup; target spellings come from the task.
export function normalizeGeneratedGroup(raw,gid,words){
 if(raw?.group_id!==gid||!Array.isArray(raw.segments)||raw.segments.length<2||raw.segments.length>4)throw Error('生成场景结构不合法');
 const frozen=new Map(words.map(w=>[key(w),w])),seen=new Set();
 const clean=(value,max)=>{if(typeof value!=='string'||!value.trim()||value.length>max||/[{}|]/.test(value))throw Error('生成文本格式不合法');return value.trim()};
 const segments=raw.segments.map((s,i)=>{
  if(s.segment_no!==i+1||!Array.isArray(s.sentences)||!s.sentences.length)throw Error('生成场景句子结构不合法');
  const title=clean(s.title,60),intro=clean(s.intro,200);
  const sentences=s.sentences.map(row=>{
   const word=frozen.get(key(clean(row.word,80)));if(!word||seen.has(key(word)))throw Error('生成句子词条不属于任务或重复');
   const english=clean(row.english,500),meaning=clean(row.meaning,200),gloss=clean(row.gloss,8);
   if(/[\u3400-\u9fff]/u.test(english)||english.split(/\s+/).length<4||!/[.!?]["']?$/.test(english))throw Error('目标词必须放在完整英文句子中');
   if(!/[\u3400-\u9fff]/u.test(meaning)||!/[\u3400-\u9fff]/u.test(gloss))throw Error('中文说明或短义缺失');
   const escaped=word.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),match=new RegExp('\\b'+escaped+'\\b','i');
   if(!match.test(english))throw Error('英文句子未保留目标词原形：'+word);
   seen.add(key(word));return english.replace(match,()=>`{{${word}|${gloss}}}`)+' '+meaning;
  });
  return {segment_no:i+1,title,content_markup:intro+' '+sentences.join(' ')};
 });
 if(seen.size!==frozen.size)throw Error('生成句子目标词覆盖不完整');
 return {group_id:gid,segments};
}
export function validateGroup(raw,gid,words){
 if(!raw||raw.group_id!==gid||!Array.isArray(raw.segments)||!raw.segments.length||raw.segments.length>5)throw Error('Group 或段落数量不合法');
 const frozen=new Set(words.map(key)),seen=new Set();
 const patterns=[/\{\{overt\|[^}]*公开地[^}]*\}\}/i,/有些\s*\{\{bewilder\|/i,/\{\{acquaint\|[^}]*\}\}\s*自己和/i,/让我\s*\{\{astonish\|/i,/\{\{momentary\|[^}]*\}\}\s*闪/i,/\{\{apt\|[^}]*\}\}\s*漏/i,/\{\{immerse\|[^}]*\}\}\s*进/i];
 const segments=[...raw.segments].sort((a,b)=>a.segment_no-b.segment_no).map((s,i)=>{
  if(s.segment_no!==i+1||!s.title?.trim()||!s.content_markup?.trim())throw Error('段落编号、标题或正文异常');
  const text=s.content_markup.trim(),matches=[...text.matchAll(markup)];
  if(matches.length!==(text.match(/\{\{/g)||[]).length||matches.length!==(text.match(/\}\}/g)||[]).length)throw Error('标记损坏');
  const speech=text.replace(markup,(_,w)=>w);
  const usage=[[/\bacquaint\b/ig,/^acquaint\s+(?:myself|yourself|himself|herself|ourselves|themselves|oneself|the\s+\w+|[A-Za-z]+)\s+with\b/i,'acquaint 应带宾语及 with'],[/\bapt\b/ig,/^apt\s+to\s+[a-z]/i,'apt 应使用 be apt to do'],[/\bimmerse\b/ig,/^immerse\s+(?:myself|yourself|himself|herself|ourselves|themselves|oneself|[A-Za-z]+(?:\s+[A-Za-z]+){0,4})\s+in\b/i,'immerse 应带宾语及 in']];
  for(const [word,valid,message] of usage)for(const m of speech.matchAll(word))if(!valid.test(speech.slice(m.index)))throw Error(message);
  if(/(?:很|有些|感到|非常)\s*\{\{(?:astonish|bewilder)\|/i.test(text)||/\{\{overt\|[^}]*\}\}\s*(?:承认|说|表示)/i.test(text)||/\{\{lean\|[^}]*\}\}\s*(?:每天|拖延)/i.test(text))throw Error('动词或形容词用法异常');
  if(patterns.some(r=>r.test(text)))throw Error('词性或配价未通过校验');
  if(/https?:\/\/|[\w.+-]+@[\w.-]+\.[A-Za-z]+|(?:\/Users\/|API[_ -]?KEY|Bearer\s|gh[pousr]_)|(?<!\d)1[3-9]\d{9}(?!\d)|(?<!\d)\d{17}[\dXx](?!\w)/i.test(text+s.title))throw Error('正文包含私人信息');
  for(const m of matches){if(!frozen.has(key(m[1])))throw Error('标记词不在冻结 Group：'+m[1].slice(0,40));if(!m[2].trim()||m[2].trim().length>20||m[2].includes('|'))throw Error('标记短义异常：'+m[1].slice(0,40));seen.add(key(m[1]))}
  return {segment_no:s.segment_no,title:s.title.trim(),content_markup:text,display_content:text.replace(markup,(_,w,g)=>`${w}（${g}）`),speech_content:text.replace(markup,(_,w)=>w),covered_words:matches.map(m=>m[1].trim())};
 });
 if(seen.size!==frozen.size)throw Error('目标词覆盖不完整');return segments;
}
export function prompt(gid,cards){
 const size=Math.ceil(cards.length/3),layout=Array.from({length:3},(_,i)=>({segment_no:i+1,title:'填中文场景标题',intro:'填简短中文场景引入。',sentences:cards.slice(i*size,(i+1)*size).map(c=>({word:c.word,english:'',meaning:'',gloss:''}))})).filter(s=>s.sentences.length);
 return `Write a bilingual listening story for an adult English learner. Return JSON only.
Group: ${gid}
Exact target words and their dictionary meanings: ${JSON.stringify(cards.map(c=>({word:c.word,translation:c.translation})))}
Complete the THREE separate scenes in the JSON template below. Preserve every scene number, every word spelling and every sentence entry in its assigned scene. Do NOT merge the scenes into one. Use connected everyday scenes about study, work or ordinary life. Each scene has a Chinese title and a brief Chinese intro. The entries in each scene must form a coherent small story, not unrelated definitions.
For each entry: word MUST equal the supplied target spelling; english MUST be a complete grammatical English sentence of about 6 to 18 words using that exact uninflected word; meaning is its natural Chinese translation; gloss is the target's Chinese meaning in that sentence, at most 8 Chinese characters. english contains English only, never Chinese. Do NOT put English words into Chinese grammar. Do NOT output braces, study markup or vertical bars in text fields; our program inserts markup.
Use modal verbs or infinitives when needed to preserve verb spelling. Check verb objects and adjective usage. If present: use "I am apt to ...", "I immerse myself in ...", "Please acquaint yourself with ...", "The surprise may astonish ...", "Complex instructions can bewilder ...". Use "indifference" as a noun, "overt" as an adjective, and "momentary" before a noun. Do not rename the target word to a phrase such as "be apt to" or "immerse oneself".
Use fictional generic people only. No real personal facts, institutions, contacts, addresses, URLs, credentials or medical advice. Only entries for supplied target words; examples above are guidance, not extra words to include.
Before returning, check the English sentence contains the exact word as a separate word. Plurals, past forms and derivatives do NOT count: for target "installment", use "an installment", not "installments". Fill all empty text fields. Return the complete template, with all three scenes and all entries:
${JSON.stringify({group_id:gid,segments:layout})}`}
export async function contentHash(segments){return sha(JSON.stringify(segments))}
