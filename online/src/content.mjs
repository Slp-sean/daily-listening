import {sha,key} from './srs.mjs';
const markup=/\{\{([^|{}]+)\|([^{}]*)\}\}/g;
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
export function prompt(gid,cards){return `为中国成人英语学习者生成中文为主体、英语自然嵌入的每日情景听读。仅用一般工作、学习与生活场景，不得引入任何真实人员、单位、私密事实或联系方式。\nGroup: ${gid}\n目标词及词义：${JSON.stringify(cards.map(c=>({word:c.word,translation:c.translation})))}\n分成2至4个中文叙述为主体的自然场景；目标词放入语法完整的简短英语句子或固定短语，再接中文说明。不要把英语动词当中文形容词或副词使用，不能写“很 astonish”“overt 承认”“lean 每天”。acquaint 必须写 acquaint oneself/himself/herself with，immerse 必须写 immerse oneself/himself/herself in，apt 必须接 to + 动词原形。允许短英语句子中有非目标词，但非目标词不可标注。每组英文用法应先自行检查再返回。全部目标词必须且仅用 {{英文词|当前语境短义}} 标注，短义不超过8字。标记内英文须逐字保留给定词形，不能改成过去式、复数或派生词；需要变化时改写句子，使用原形，如 modal + 原形或 to + 原形。保持词性配价：及物动词带宾语，形容词修饰名词，apt 使用 be apt to do，acquaint 使用 acquaint oneself with，immerse 带宾语和 in。覆盖率100%，不得额外标注其他词。只返回JSON {"group_id":"${gid}","segments":[{"segment_no":1,"title":"场景标题","content_markup":"正文"}]}`}
export async function contentHash(segments){return sha(JSON.stringify(segments))}
