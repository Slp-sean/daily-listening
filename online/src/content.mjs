import {sha,key} from './srs.mjs';
const markup=/\{\{([^|{}]+)\|([^{}]*)\}\}/g;
// Keep the original Chinese scenario contract. No sentence/translation adapter.
export const CONTENT_CONTRACT='chinese-scenario-v1';
export function normalizeGeneratedGroup(raw,gid,words){
 const segments=validateGroup(raw,gid,words);
 return {group_id:gid,segments,normalizations:[]};
}
export function validateGroup(raw,gid,words){
 if(!raw||raw.group_id!==gid||!Array.isArray(raw.segments)||raw.segments.length<2||raw.segments.length>4)throw Error('Group 或段落数量不合法');
 const frozen=new Set(words.map(key)),seen=new Set();
 const patterns=[/\{\{overt\|[^}]*公开地[^}]*\}\}/i,/有些\s*\{\{bewilder\|/i,/\{\{acquaint\|[^}]*\}\}\s*自己和/i,/让我\s*\{\{astonish\|/i,/\{\{momentary\|[^}]*\}\}\s*闪/i,/\{\{apt\|[^}]*\}\}\s*漏/i,/\{\{immerse\|[^}]*\}\}\s*进/i];
 const segments=[...raw.segments].sort((a,b)=>a.segment_no-b.segment_no).map((s,i)=>{
  if(s.segment_no!==i+1||!s.title?.trim()||!s.content_markup?.trim())throw Error('段落编号、标题或正文异常');
  const text=s.content_markup.trim(),matches=[...text.matchAll(markup)];
  if(matches.length!==(text.match(/\{\{/g)||[]).length||matches.length!==(text.match(/\}\}/g)||[]).length)throw Error('标记损坏');
  const speech=text.replace(markup,(_,w)=>w);
  const context=text.replace(markup,'');
  // Reject the sentence-by-sentence English/translation format while
  // retaining the grammatical English phrases in existing Chinese scenes.
  if(!/[\u3400-\u9fff]/u.test(context)||/(?:^|[。！？\n])\s*[A-Z][A-Za-z ,;:'’"\-]+[.!?]\s*[\u3400-\u9fff]/u.test(speech))throw Error('情景正文必须以中文叙述为主体，不能使用逐句英文加中文翻译');
  if(/[{}]/.test(context))throw Error('正文含非法标记');
  if(/\{\{dubious\|[^}]*可疑[^}]*\}\}\s+about\b/i.test(text))throw Error('dubious about 的短义应表示怀疑');
  const usage=[[/\bacquaint\b/ig,/^acquaint\s+(?:myself|yourself|himself|herself|ourselves|themselves|oneself|the\s+\w+|[A-Za-z]+)\s+with\b/i,'acquaint 应带宾语及 with'],[/\bapt\b/ig,/^apt\s+to\s+[a-z]/i,'apt 应使用 be apt to do'],[/\bimmerse\b/ig,/^immerse\s+(?:myself|yourself|himself|herself|ourselves|themselves|oneself|[A-Za-z]+(?:\s+[A-Za-z]+){0,4})\s+in\b/i,'immerse 应带宾语及 in']];
  for(const [word,valid,message] of usage)for(const m of speech.matchAll(word))if(!valid.test(speech.slice(m.index)))throw Error(message);
  if(/(?:很|有些|感到|非常)\s*\{\{(?:astonish|bewilder)\|/i.test(text)||/\{\{overt\|[^}]*\}\}\s*(?:承认|说|表示)/i.test(text)||/\{\{lean\|[^}]*\}\}\s*(?:每天|拖延)/i.test(text))throw Error('动词或形容词用法异常');
  if(patterns.some(r=>r.test(text)))throw Error('词性或配价未通过校验');
  if(/https?:\/\/|[\w.+-]+@[\w.-]+\.[A-Za-z]+|(?:\/Users\/|API[_ -]?KEY|Bearer\s|gh[pousr]_)|(?<!\d)1[3-9]\d{9}(?!\d)|(?<!\d)\d{17}[\dXx](?!\w)/i.test(text+s.title))throw Error('正文包含私人信息');
  for(const m of matches){if(!frozen.has(key(m[1])))throw Error('标记词不在冻结 Group：'+m[1].slice(0,40));if(!m[2].trim()||m[2].trim().length>8||!/[\u3400-\u9fff]/u.test(m[2])||m[2].includes('|'))throw Error('标记短义异常：'+m[1].slice(0,40));seen.add(key(m[1]))}
  return {segment_no:s.segment_no,title:s.title.trim(),content_markup:text,display_content:text.replace(markup,(_,w,g)=>`${w}（${g}）`),speech_content:text.replace(markup,(_,w)=>w),covered_words:matches.map(m=>m[1].trim())};
 });
 if(seen.size!==frozen.size)throw Error('目标词覆盖不完整');return segments;
}
export function prompt(gid,cards){
 return `你正在为中国成人英语学习者生成“少文字、高密度、自然中文语境、非故事导向”的情景听读材料。
当前学习组：${gid}，严格包含 ${cards.length} 个冻结目标词。
目标词、词典释义与既有正确英文例句（例句仅供词法参考，不要逐句照搬或附译文）：${JSON.stringify(cards.map(c=>({word:c.word,translation:c.translation,example:c.example_sentence})))}

严格沿用现有情景听读原则：
1. 以真实的工作与日常生活为语境，中文叙述为主体，目标英文词自然嵌入。少文字、高密度，不写玄幻或为串词硬编的长故事，不逐词堆砌例句，不使用完整英文句子加逐句中文翻译的结构。
2. 按词义和自然搭配组织 2 到 4 个简短小场景。场景数由词组组合决定，不能固定分配词表顺序或强行合为一段。每段讲清一个真实、连贯的事情，避免冗长引入、总结和重复解释。
3. 所有目标词必须使用 {{英文词|当前语境最短准确中文含义}} 标记。英文必须保持冻结词表原形；竖线后仅写该句最短最准的中文短义，不超过8字，不罗列词典释义。覆盖全部目标词，不能标记额外目标词。
4. 必须保持英文词性、配价和搭配：动词带所需宾语、补语；形容词修饰名词或作表语。仅在必要时嵌入完整英文短语，以确保语法正确；英文短语用于服务中文语境，不能把全文变为英语例句及译文。
示例：我决定 {{immerse|使沉浸}} myself in the report，专心研究报告；忙碌时 I am {{apt|容易……的}} to miss details，所以我逐项核对。
标记左侧必须仅包含冻结单词本身，宾语、介词和其他搭配写在标记外，例如 {{acquaint|使熟悉}} herself with the process；不能写成 {{acquaint herself with|使熟悉}}。上述示例只用于解释结构，未在目标列表中的词不得加入标记。acquaint 须带宾语及 with；immerse 须带宾语及 in；apt 须使用 be apt to do。dubious about 表示“怀疑的／存疑的”。不得把 astonish、bewilder 当形容词，把 overt 当副词。
5. 在输出前必须逐词检查英文用法，以目标词给出的例句作词法参考。特别禁止“感到 {{bewilder|使迷惑}}”“{{immerse|使沉浸}} 其中”“人 {{apt|容易}} 失去判断”这种把英文原形硬塞进中文语法的写法。应写“复杂指令会 {{bewilder|使困惑}} beginners”“我决定 {{immerse|使沉浸}} myself in reading”“忙时 I am {{apt|容易}} to miss details”。astonish 必须使某人吃惊，如“这个消息可能 {{astonish|使吃惊}} the team”；overt 为形容词，例如“an {{overt|公开的}} sign of support”。必要的短语可以稍长，语法和自然语境优先，绝不能为压缩字数而误用单词。
6. 场景要符合常识：仓库不会按经度给箱子分区登记；针灸仅可作为展览或科普话题，不写针刺操作、用药或治疗建议。不为串词强行关联地点和行为，不要求各场景连成故事。逐词自查当前词义、词性、搭配、短义和场景常识。只写通用场景，不包含用户真实隐私、联系方式、凭据或医疗建议。
7. content_markup 是唯一正文。仅返回以下结构的严格 JSON，无前言、总结、display_content、speech_content、sentences、english 或 meaning 字段：
{"group_id":"${gid}","segments":[{"segment_no":1,"title":"简短中文场景标题","content_markup":"以中文为主体、自然嵌入标记目标词的简短情景段落"},{"segment_no":2,"title":"另一个简短中文场景标题","content_markup":"另一个中文情景段落"}]}`;
}
export async function contentHash(segments){return sha(JSON.stringify(segments))}

export function generationPrompt(gid,cards,feedback){
 const base=prompt(gid,cards),encoder=new TextEncoder();
 if(encoder.encode(base).length>10000)throw Error('生成输入超过预算允许长度');
 if(!feedback)return base;
 const intro='\n上一份候选未通过质量检查。以下是检查意见数据，请逐项修正词法及短义，并重新组织自然中文微场景，不要照抄失败原稿：\n';
 const allowance=10000-encoder.encode(base+intro).length;
 let clipped='';for(const c of String(feedback)){if(encoder.encode(clipped+c).length>allowance)break;clipped+=c}
 return clipped?base+intro+clipped:base;
}
