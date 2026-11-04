import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const fake=String.raw`#!/usr/bin/env node
import {createInterface} from 'node:readline';import {randomUUID} from 'node:crypto';import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
const provider=process.argv[1].match(/fake-([^.]+)/)[1];const args=process.argv.slice(2);const write=v=>process.stdout.write(JSON.stringify(v)+'\n');
if(args.includes('--version')){console.log(provider+' 0.200.0');process.exit()}
if(args.includes('--help')){console.log('--input-format --output-format --disable-slash-commands --resume');process.exit()}
if(args[0]==='models'){console.log('fake-model\tFake model\nfake-small\tFake compressor');process.exit()}
if(args.includes('/usage')){console.log(JSON.stringify({status:'SUCCESS',command:{data:{groups:[{name:'Gemini',buckets:[{window:'5h',remaining_fraction:.75,reset_time:'2030-01-01T00:00:00Z'},{window:'weekly',remaining_fraction:.5}]}]}}}));process.exit()}
const blocked=provider==='claude'?['ANTHROPIC_API_KEY']:provider==='codex'?['OPENAI_API_KEY','CODEX_API_KEY']:['GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_APPLICATION_CREDENTIALS'];
if(blocked.some(k=>process.env[k])){console.error('API credentials leaked into subscription CLI');process.exit(8)}
const resumeFlag=['--resume','--conversation'].find(flag=>args.includes(flag));
let sid=args.find(a=>a.startsWith('--resume='))?.slice(9)||(resumeFlag?args[args.indexOf(resumeFlag)+1]:null)||randomUUID();let turn=0,pending=null,threadInputs=new Map();const goals=new Map();
const answer=(id,result)=>write({id,result});const control=(id,response)=>write({type:'control_response',response:{subtype:'success',request_id:id,response}});
const activeTurns=new Map(),teamCalls=new Map(),teamTimers=new Map();let teamSeq=2000;
const steering=new Map();
function promptText(raw,tid){
 fs.appendFileSync(fileURLToPath(new URL('./context-inputs.jsonl',import.meta.url)),JSON.stringify({provider,tid,text:raw,args})+'\n');
 let text=raw.replace(/^<duet_context_commands>[\s\S]*?<\/duet_context_commands>\s*/,'');
 const match=/^<duet_context_packet bytes="(\d+)">\n/.exec(text);
 if(match){const bytes=Buffer.from(text.slice(match[0].length));text=bytes.subarray(Number(match[1])).toString().replace(/^\n<\/duet_context_packet>\n\n/,'');}
 return text;
}
function agyEnd(text){write({event:'step_update',step_update:{step_index:1,step_type:'agent_response',text_delta:text,state:'DONE'}});write({event:'result',result:{status:'SUCCESS',response:text}});}
function contextInput(tid,text){
 const end=output=>provider==='claude'?claudeEnd(output):provider==='codex'?codexEnd(tid,output):agyEnd(output);
 if(text.includes('Create a compact factual record')){if(text.includes('CTX_COMPRESSION_FAIL')){if(provider==='claude')write({type:'result',is_error:true,result:'Synthetic compression failure'});else end('');return true;}const id=/"id":"([^"]+)"/.exec(text)?.[1]||'source';const done=()=>end('Facts: KEEP_FACT Rust core is confirmed. Checks: tests passed. Unfinished: continue the task. Source: '+id);if(text.includes('CTX_DELAY'))setTimeout(done,15000);else done();return true;}
 if(text.startsWith('CTX_SEED_LOG')){
  const result='CONTEXT_OBSOLETE_CANARY '+text.slice('CTX_SEED_LOG'.length)+' '+('old diagnostic line\n'.repeat(600));
  if(provider==='claude'){write({type:'assistant',uuid:randomUUID(),message:{content:[{type:'text',text:'Inspecting diagnostics.'},{type:'tool_use',id:'context-log-'+turn,name:'Bash',input:{command:'synthetic-test'}}]}});write({type:'user',message:{content:[{type:'tool_result',tool_use_id:'context-log-'+turn,content:result}]}});write({type:'stream_event',event:{type:'message_start',message:{id:'context-answer-'+turn}}});write({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'text',text:''}}});}
  else if(provider==='codex')write({method:'item/completed',params:{threadId:tid,item:{type:'commandExecution',id:'context-log-'+turn,command:'synthetic-test',aggregatedOutput:result,exitCode:0,status:'completed'}}});
  else{write({event:'step_update',step_update:{step_index:2,step_type:'tool',tool_info:{name:'run_command',parameters:{command:'synthetic-test'},output:result},state:'DONE'}});}
  end('KEEP_FACT native Rust is confirmed.');return true;
 }
 if(!text.startsWith('CONTEXT '))return false;
 const call=JSON.parse(text.slice(8)),id=++teamSeq;
 if(provider==='claude'){teamCalls.set(String(id),{label:'CONTEXT_RESULT'});write({type:'control_request',request_id:id,request:{subtype:'mcp_message',server_name:'desk-context',message:{jsonrpc:'2.0',id,method:'tools/call',params:{name:call.name,arguments:call.args||{}}}}});}
 else if(provider==='codex'){teamCalls.set(String(id),{tid,label:'CONTEXT_RESULT'});write({id,method:'item/tool/call',params:{threadId:tid,callId:'ctx-'+id,tool:call.name,namespace:'desk-context',arguments:call.args||{}}});}
 else{const trace=fs.readFileSync(fileURLToPath(new URL('./context-inputs.jsonl',import.meta.url)),'utf8').trim().split('\n').map(JSON.parse).at(-1);const endpoint=/--context-client '(http[^']+)'/.exec(trace.text)?.[1];void fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:call.name,...call.args})}).then(r=>r.json()).then(result=>end('CONTEXT_RESULT '+JSON.stringify(result.result??{tool_error:result.error})));}
 return true;
}
function steeringHold(tid,text){
 if(!text.startsWith('STEER_HOLD'))return false;
 const notes=[],entry={notes,mode:text,turnId:activeTurns.get(tid)};steering.set(tid,entry);
 entry.timer=setTimeout(()=>{steering.delete(tid);const result='STEER_HOLD_DONE '+notes.join(' | ');provider==='claude'?claudeEnd(result):codexEnd(tid,result);},1500);
 return true;
}
function teamCall(tid,operation,label='TEAM_RESULT'){
 const id=++teamSeq;teamCalls.set(String(id),{tid,label});
 if(provider==='claude')write({type:'control_request',request_id:String(id),request:{subtype:'mcp_message',server_name:'desk-agents',message:{jsonrpc:'2.0',id,method:'tools/call',params:{name:operation.name,arguments:operation.args||{},_meta:{'claudecode/toolUseId':'team-tool-'+id}}}}});
 else write({id,method:'item/tool/call',params:{threadId:tid,namespace:'desk-agents',tool:operation.name,arguments:operation.args||{},callId:'team-tool-'+id}});
 if(operation.cancel)setTimeout(()=>provider==='claude'?write({type:'control_cancel_request',request_id:String(id)}):write({method:'serverRequest/resolved',params:{threadId:tid,requestId:id}}),50);
}
function teamInput(tid,text){
 if(text.startsWith('TEAM ')){teamCall(tid,JSON.parse(text.slice(5)));return true;}
 if(text==='TEAM_CHILD_MESSAGE'){teamCall(tid,{name:'message_agent',args:{run_id:'parent',message:'CHILD_TO_PARENT_OK'}},'TEAM_CHILD_DONE');return true;}
 if(text==='TEAM_CHILD_TO_ROOT'){teamCall(tid,{name:'message_agent',args:{run_id:'root',message:'GRANDCHILD_TO_ROOT_OK'}},'TEAM_GRANDCHILD_DONE');return true;}
 if(text==='TEAM_NEST'){teamCall(tid,{name:'run_agent',args:{agent:provider==='claude'?'codex':'claude',task:'TEAM_CHILD_TO_ROOT'}},'TEAM_NEST_DONE');return true;}
 if(text.startsWith('TEAM_HOLD')){
   if(provider==='codex'){
    write({method:'turn/plan/updated',params:{threadId:tid,explanation:'CHILD_PLAN_OK',plan:[{step:'Wait for messages',status:'inProgress'}]}});
    write({method:'item/started',params:{threadId:tid,item:{type:'commandExecution',id:'team-command-'+teamSeq,command:'fixture-only',cwd:process.cwd(),status:'inProgress'}}});
    write({method:'item/commandExecution/outputDelta',params:{threadId:tid,itemId:'team-command-'+teamSeq,delta:'CHILD_OUTPUT_OK'}});
   }
   teamTimers.set(tid,setTimeout(()=>provider==='claude'?claudeEnd('TEAM_HOLD_DONE'):codexEnd(tid,'TEAM_HOLD_DONE'),text.includes('LONG')?30000:4000));return true;
 }
 return false;
}
function claudeEnd(text){write({type:'assistant',uuid:randomUUID(),message:{id:'message-'+turn,content:[{type:'text',text}]}});write({type:'result',subtype:'success',result:text,session_id:sid,is_error:false,duration_ms:1,num_turns:turn,modelUsage:{'fake-model':{inputTokens:turn*10,outputTokens:turn*2,costUSD:turn*.01}}});}
function codexEnd(tid,text){const id=activeTurns.get(tid)||'turn-'+turn;write({method:'item/completed',params:{threadId:tid,turnId:id,item:{type:'agentMessage',id:'answer-'+id,text}}});write({method:'turn/completed',params:{threadId:tid,turn:{id,status:'completed'}}});}
if(provider==='gemini'){let content='';for await(const chunk of process.stdin)content+=chunk;write({type:'init',session_id:sid});write({type:'message',role:'assistant',content:'Gemini: '+content.trim(),delta:true});write({type:'result',status:'success'});process.exit()}
for await(const line of createInterface({input:process.stdin})){let m;try{m=JSON.parse(line)}catch{continue}
 if(provider==='codex'&&['thread/start','thread/resume','turn/start'].includes(m.method)){const p=m.params;fs.appendFileSync(fileURLToPath(new URL('./codex-launch-trace.jsonl',import.meta.url)),JSON.stringify({method:m.method,params:{threadId:p.threadId,sandbox:p.sandbox,sandboxPolicy:p.sandboxPolicy,approvalPolicy:p.approvalPolicy,config:p.config}})+'\n');}
 if(provider==='claude'){
  if(m.type==='control_request'){const q=m.request;control(m.request_id,q.subtype==='initialize'?{claude_code_version:'fake',models:[{value:'fake-model',displayName:'Fake model'},{value:'fake-small',displayName:'Fake compressor'}],account:{subscriptionType:'max',apiKeySource:'none'},commands:[]}:q.subtype==='get_usage'?{subscription_type:'max',rate_limits_available:true,rate_limits:{five_hour:{utilization:25}}}:q.subtype==='get_context_usage'?{totalTokens:10,maxTokens:100,percentage:10,categories:[]}:{});}
  else if(m.type==='user'){turn++;const content=m.message.content;const text=promptText(typeof content==='string'?content:content.filter(c=>c.type==='text').map(c=>c.text).join('\n'),sid);write({type:'system',subtype:'init',session_id:sid,model:'fake-model'});write({type:'stream_event',event:{type:'message_start',message:{id:'message-'+turn}}});write({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'text',text:''}}});
   if(contextInput(sid,text))continue;
   if(steering.has(sid)){steering.get(sid).notes.push(text);continue;}
   if(steeringHold(sid,text)){}
   else if(teamInput(sid,text)){}
   else if(text==='approve'){pending={text};write({type:'control_request',request_id:'permission-1',request:{subtype:'can_use_tool',tool_name:'Bash',tool_use_id:'bash-1',input:{command:'fixture-only'},permission_suggestions:[{type:'addRules'}]}})}
   else if(text==='delegate'){pending={text};write({type:'control_request',request_id:'tool-1',request:{subtype:'mcp_message',server_name:'desk-agents',message:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'run_agent',arguments:{agent:'codex',task:'child task'},_meta:{'claudecode/toolUseId':'delegate-1'}}}}})}
   else{write({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Claude: '+text}}});claudeEnd('Claude: '+text)}
  }else if(m.type==='control_response'&&teamCalls.has(String(m.response.request_id))){const call=teamCalls.get(String(m.response.request_id));teamCalls.delete(String(m.response.request_id));const result=m.response.response?.mcp_response?.result;claudeEnd(call.label+' '+(result?.content?.[0]?.text||JSON.stringify(m.response)));}
  else if(m.type==='control_response'&&pending){const p=pending;pending=null;if(p.text==='approve')claudeEnd('Permission: '+m.response.response.behavior);else claudeEnd('Delegated: '+m.response.response.mcp_response.result.content[0].text);}
 }else if(provider==='codex'){
  if(m.method==='turn/steer'){
   const tid=m.params.threadId,held=steering.get(tid),text=m.params.input.filter(i=>i.type==='text').map(i=>i.text).join('\n');
   if(text==='STEER_REJECT'){write({id:m.id,error:{code:-32602,message:'Fixture rejected follow-up'}});continue;}
   if(!held){write({id:m.id,error:{code:-32602,message:'No active turn'}});continue;}
   if(m.params.expectedTurnId!==held.turnId){write({id:m.id,error:{code:-32602,message:'Active turn id does not match expectedTurnId'}});continue;}
   if(held.mode.includes('RACE')){clearTimeout(held.timer);steering.delete(tid);write({id:m.id,error:{code:-32602,message:'No active turn'}});setTimeout(()=>write({method:'turn/completed',params:{threadId:tid,turn:{id:held.turnId,status:'completed'}}}),100);continue;}
   held.notes.push(text);answer(m.id,{turnId:held.turnId});continue;
  }
  if(m.method==='turn/interrupt'||m.method==='thread/unsubscribe'){fs.appendFileSync(fileURLToPath(new URL('./codex-control-trace.jsonl',import.meta.url)),JSON.stringify({method:m.method,params:m.params})+'\n');if(m.method==='turn/interrupt')clearTimeout(teamTimers.get(m.params.threadId));answer(m.id,{});continue;}
  if(m.method==='initialize')answer(m.id,{userAgent:'codex/0.200.0'});
  else if(m.method==='account/read')answer(m.id,{account:{type:'chatgpt',email:'fixture@example.invalid',planType:'pro'}});
  else if(m.method==='model/list')answer(m.id,{data:[{id:'fake-model',displayName:'Fake model',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'ultra'}],serviceTiers:[{id:'default',name:'Standard'},{id:'fast',name:'Fast'}]},{id:'fake-small',displayName:'Fake compressor',supportedReasoningEfforts:[]}]});
  else if(m.method==='config/read')answer(m.id,{config:{model:'fake-model'}});
  else if(m.method==='account/rateLimits/read')answer(m.id,{rateLimits:{planType:'pro',primary:{usedPercent:25,windowDurationMins:300}}});
  else if(m.method==='skills/list')answer(m.id,{data:[{cwd:m.params.cwds?.[0],skills:[{name:'native-skill',description:'Fixture skill',path:fileURLToPath(new URL('./native-skill/SKILL.md',import.meta.url)),scope:'user',enabled:true}]}]});
  else if(m.method==='app/list')answer(m.id,{data:[{id:'fixture-app',name:'Fixture app',description:'Subscription connection',isEnabled:true,isAccessible:true,installUrl:'https://example.invalid/install'}],nextCursor:null});
  else if(m.method==='hooks/list')answer(m.id,{data:[{cwd:m.params.cwds[0],hooks:[{key:'fixture-hook',eventName:'SessionStart',handlerType:'command',command:'fixture',sourcePath:'/fixture/hooks.json',enabled:true}]}]});
  else if(m.method==='skills/config/write'){if(typeof m.params.enabled!=='boolean'||!m.params.path)throw Error('Invalid skill configuration');answer(m.id,{effectiveEnabled:m.params.enabled});}
  else if(m.method==='mcpServerStatus/list')answer(m.id,{data:[{name:'fixture-mcp',authStatus:'notLoggedIn',tools:{echo:{description:'Fixture tool'}}}],nextCursor:null});
  else if(m.method==='mcpServer/oauth/login')answer(m.id,{authorizationUrl:'https://example.invalid/fixture-oauth'});
  else if(m.method==='thread/goal/get')answer(m.id,{goal:goals.get(m.params.threadId)||null});
  else if(m.method==='thread/goal/set'){if(m.params.origin!=='user')throw Error('Missing explicit goal origin');const goal={threadId:m.params.threadId,objective:'',status:'active',tokenBudget:null,tokensUsed:0,timeUsedSeconds:0,...goals.get(m.params.threadId),...m.params};goals.set(m.params.threadId,goal);answer(m.id,{goal});write({method:'thread/goal/updated',params:{threadId:m.params.threadId,goal}});}
  else if(m.method==='thread/goal/clear'){goals.delete(m.params.threadId);answer(m.id,{});write({method:'thread/goal/cleared',params:{threadId:m.params.threadId}});}
  else if(m.method==='thread/compact/start'){answer(m.id,{});setTimeout(()=>{write({method:'turn/started',params:{threadId:m.params.threadId,turn:{id:'compact-turn'}}});write({method:'item/completed',params:{threadId:m.params.threadId,item:{type:'contextCompaction',id:'compact-1'}}});write({method:'turn/completed',params:{threadId:m.params.threadId,turn:{id:'compact-turn',status:'completed'}}})},20);}
  else if(m.method==='review/start'){answer(m.id,{turn:{id:'review-1'},reviewThreadId:m.params.threadId});setTimeout(()=>{write({method:'item/started',params:{threadId:m.params.threadId,turnId:'review-1',item:{type:'enteredReviewMode',id:'review-entry',review:'Fixture review'}}});write({method:'turn/started',params:{threadId:m.params.threadId,turn:{id:'review-worker'}}});write({method:'item/completed',params:{threadId:m.params.threadId,item:{type:'exitedReviewMode',id:'review-output',review:'Review complete: [fixture](fixture.rs:3)'}}});write({method:'turn/completed',params:{threadId:m.params.threadId,turn:{id:'review-1',status:'completed'}}})},20);}
  else if(m.method==='turn/start'&&m.params.input.some(i=>i.type==='text'&&(i.text.startsWith('codex-')||i.text.includes('$native-skill')))){
    turn++;const tid=m.params.threadId,text=m.params.input.find(i=>i.type==='text').text;activeTurns.set(tid,'turn-'+turn);answer(m.id,{turn:{id:'turn-'+turn,status:'inProgress'}});write({method:'turn/started',params:{threadId:tid,turn:{id:'turn-'+turn}}});pending={tid,structured:true};
    if(text==='codex-permissions')write({id:900,method:'item/permissions/requestApproval',params:{threadId:tid,itemId:'permissions-1',cwd:process.cwd(),permissions:{network:{enabled:true},fileSystem:{read:[process.cwd()],write:null}}}});
    else if(text==='codex-form')write({id:900,method:'mcpServer/elicitation/request',params:{threadId:tid,mode:'form',serverName:'fixture-mcp',message:'Provide fixture values',requestedSchema:{type:'object',required:['label','count'],properties:{label:{type:'string'},count:{type:'integer',minimum:1}}}}});
    else if(text==='codex-questions')write({id:900,method:'item/tool/requestUserInput',params:{threadId:tid,itemId:'questions-1',questions:[{id:'q1',question:'Choose',header:'First',isSecret:false,isOther:true,options:[{label:'One, two',description:'Keep commas'}]},{id:'q2',question:'Choose',header:'Second',isSecret:true,isOther:true,options:null}]}});
    else if(text==='codex-legacy')write({id:900,method:'execCommandApproval',params:{conversationId:tid,callId:'legacy-1',command:['fixture-only'],cwd:process.cwd(),reason:'Legacy fixture'}});
    else{if(!m.params.input.some(i=>i.type==='skill'&&i.name==='native-skill'))throw Error('Missing native skill input');pending=null;codexEnd(tid,'Native skill selected');}
  }
  else if(m.method==='thread/start'||m.method==='thread/resume'||m.method==='thread/fork'){sid=m.params.threadId||randomUUID();if(sid==='00000000-0000-4000-8000-000000000040'){process.stdout.write('{"result":{"thread":{"turns":[{"text":"');const chunk='x'.repeat(1024*1024);for(let i=0;i<40;i++)process.stdout.write(chunk);process.stdout.write('"}],"id":'+JSON.stringify(sid)+'},"model":"fake-model"},"id":'+JSON.stringify(m.id)+'}'+String.fromCharCode(10));}else answer(m.id,{thread:{id:sid},model:'fake-model'});}
  else if(m.method==='turn/start'){turn++;const tid=m.params.threadId;activeTurns.set(tid,'turn-'+turn);const text=promptText(m.params.input.filter(i=>i.type==='text').map(i=>i.text).join('\n'),tid);const currentTurn='turn-'+turn;const begin=()=>{answer(m.id,{turn:{id:currentTurn,status:'inProgress'}});const started=()=>write({method:'turn/started',params:{threadId:tid,turn:{id:currentTurn}}});if(text.includes('DELAY'))setTimeout(started,100);else started();if(contextInput(tid,text)){}else if(steeringHold(tid,text)){}else if(teamInput(tid,text)){}else if(text==='approve'){pending={tid};write({id:900,method:'item/commandExecution/requestApproval',params:{threadId:tid,itemId:'cmd-1',command:'fixture-only'}})}else if(text==='approve-patch'){pending={tid};write({method:'item/started',params:{threadId:tid,item:{type:'fileChange',id:'patch-1',changes:[{path:'fixture.rs',kind:{type:'update'},diff:'-old\n+new'}]}}});write({id:900,method:'item/fileChange/requestApproval',params:{threadId:tid,itemId:'patch-1',reason:'Fixture edit'}})}else setTimeout(()=>codexEnd(tid,'Codex: '+text),20);};if(text==='TEAM_HOLD_LONG'){const release=fileURLToPath(new URL('./codex-start-release-'+tid,import.meta.url));fs.appendFileSync(fileURLToPath(new URL('./codex-control-trace.jsonl',import.meta.url)),JSON.stringify({method:'fixture/start-pending',params:{threadId:tid}})+'\n');const poll=setInterval(()=>{if(fs.existsSync(release)){clearInterval(poll);begin();}},5);poll.unref();}else begin();}
  else if(teamCalls.has(String(m.id))){const call=teamCalls.get(String(m.id));teamCalls.delete(String(m.id));codexEnd(call.tid,call.label+' '+(m.result?.contentItems?.[0]?.text||JSON.stringify(m)));}
  else if(m.id===900&&pending){codexEnd(pending.tid,pending.structured?JSON.stringify(m.result):'Permission: '+m.result.decision);pending=null}
  else if(m.method&&m.id)answer(m.id,{});
 }else if(provider==='antigravity'&&m.event==='user'){turn++;const text=promptText(m.message.content,sid);write({event:'init',conversation_id:sid});if(contextInput(sid,text))continue;agyEnd('Antigravity: '+text);}
}
`;
export function createNativeFixtures(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'duet-rust-core-'));fs.mkdirSync(path.join(root,'home'),{recursive:true});fs.mkdirSync(path.join(root,'data'),{recursive:true});
const env={...process.env,KIMI_CODE_HOME:path.join(root,'kimi-home'),DUET_DRIVER_EVENTS:'1',CLAUDE_CONFIG_DIR:path.join(root,'home','.claude'),CODEX_HOME:path.join(root,'home','.codex')};
for(const id of ['claude','codex','antigravity','gemini']){const file=path.join(root,'fake-'+id+'.mjs');fs.writeFileSync(file,fake);fs.chmodSync(file,0o755);let bin=file;if(process.platform==='win32'&&id!=='gemini'){bin=path.join(root,'fake-'+id+'.cmd');fs.writeFileSync(bin,`@echo off\r\n"${process.execPath}" "%dp0%\\fake-${id}.mjs" %*\r\n`)}env['DUET_'+id.toUpperCase()+'_BIN']=bin;}
const kimiSource=fs.readFileSync(new URL('./fixture-kimi.mjs',import.meta.url),'utf8').replace("from 'ws'",'from '+JSON.stringify(new URL('../node_modules/ws/wrapper.mjs',import.meta.url).href));
const kimiFile=path.join(root,'fake-kimi.mjs');fs.writeFileSync(kimiFile,kimiSource);fs.chmodSync(kimiFile,0o755);
let kimiBin=kimiFile;if(process.platform==='win32'){kimiBin=path.join(root,'fake-kimi.cmd');fs.writeFileSync(kimiBin,`@echo off\r\n"${process.execPath}" "%dp0%\\fake-kimi.mjs" %*\r\n`);}env.DUET_KIMI_BIN=kimiBin;
// A CLI must never accidentally inherit a billable API credential from the desktop shell.
for(const key of ['ANTHROPIC_API_KEY','OPENAI_API_KEY','CODEX_API_KEY','GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_APPLICATION_CREDENTIALS','KIMI_API_KEY','MOONSHOT_API_KEY','KIMI_MODEL_API_KEY'])env[key]='fixture-must-be-removed';
return {root,env};
}
