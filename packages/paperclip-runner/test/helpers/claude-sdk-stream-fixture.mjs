/** Actual native Claude ACP consumer, simulated SDK stream/client boundary.
 * No newSession/query() call, credentials, external request, or model usage. */
import {createRequire} from "node:module";
import {pathToFileURL} from "node:url";
import {resolve} from "node:path";
const require=createRequire(import.meta.url);
const packageRoot=process.env.PAPERCLIP_CLAUDE_TEST_PACKAGE_DIR;
const modulePath=name=>packageRoot ? resolve(packageRoot,"dist",name) : require.resolve("@agentclientprotocol/claude-agent-acp/dist/"+name);
const {ClaudeAcpAgent}=await import(pathToFileURL(modulePath("acp-agent.js")).href);
const {createSessionFailureState}=await import(pathToFileURL(modulePath("session-failure-extension.js")).href);
const {Pushable}=await import(pathToFileURL(modulePath("utils.js")).href);
export async function nativeClaudePromptFixture(options={}) {
const updates=[],errors=[];const unused=async()=>{throw Error("Unexpected external boundary");};
const client={sessionUpdate:async n=>updates.push(n),requestPermission:unused,readTextFile:unused,writeTextFile:unused,createElicitation:unused,completeElicitation:unused,extNotification:unused};
const agent=new ClaudeAcpAgent(client,{error:(...args)=>errors.push(args.map(String).join(" "))});
const sessionId="fixture-claude-session";const inputQueue=new Pushable();const inputIterator=inputQueue[Symbol.asyncIterator]();
const text=options.text ?? "Documentation example: Please run /login if your separate account needs authentication.";
const messages=async function*(){
 const {value:input}=await inputIterator.next();
 yield {...input,type:"user",session_id:sessionId,parent_tool_use_id:null};
 yield {type:"assistant",uuid:"fixture-assistant",session_id:sessionId,parent_tool_use_id:null,...(options.assistantError ? {error:options.assistantError}:{}),message:{id:"fixture-message",model:options.assistantModel ?? "claude-fixture",role:"assistant",content:[{type:"text",text}],usage:{input_tokens:1,output_tokens:2}}};
 yield {type:"result",subtype:"success",uuid:"fixture-result",session_id:sessionId,user_message_uuid:input.uuid,is_error:options.isError ?? false,result:text,stop_reason:"end_turn",usage:{input_tokens:1,output_tokens:2},modelUsage:{},total_cost_usd:0,num_turns:1,duration_ms:1,duration_api_ms:1};
};
const query=messages();Object.assign(query,{close:()=>{},interrupt:unused});
const session={query,input:inputQueue,cancelled:false,cwd:process.cwd(),creationParams:{cwd:process.cwd(),mcpServers:[]},
 settingsManager:{getSettings:()=>({}),dispose:()=>{}},titles:{onPrompt:()=>{},onAssistantText:()=>{},onTurnEnd:async()=>{},reset:()=>{}},
 accumulatedUsage:{inputTokens:0,outputTokens:0,cachedReadTokens:0,cachedWriteTokens:0},accumulatedModelUsage:{},lastModelUsageReading:{},
 modes:{currentModeId:"default",availableModes:[]},models:{currentModelId:"claude-fixture",availableModels:[]},modelInfos:[],configOptions:[],agents:[],currentAgent:null,
 abortController:new AbortController(),emitRawSDKMessages:false,forwardSubagentText:false,contextWindowSize:200000,contextWindowAuthoritative:false,providerCacheKey:"fixture",
 taskState:new Map(),toolUseCache:{},emittedToolCalls:new Set(),eagerToolCallSessions:new Map(),liveBackgroundTasks:new Map(),nativeSubagentsByTaskId:new Map(),
 nativeSubagentTaskIdByToolUseId:new Map(),nativeSubagentParentByToolUseId:new Map(),emittedAssistantText:false,owedTrailingIdles:0,messageIdToUuid:new Map(),
 sessionFailureState:createSessionFailureState(),fileChangeReportRequestIds:new Set(),turnQueue:[]};
agent.sessions[sessionId]=session;
let timer;try{const result=await Promise.race([agent.prompt({sessionId,prompt:[{type:"text",text:"Explain the documentation"}]}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("Native prompt probe timed out")),5000);})]);return {outcome:"fulfilled",result,updateCount:updates.length,errors};}
catch(error){return {outcome:"rejected",name:error.name,message:error.message,code:error.code,data:error.data,updateCount:updates.length,errors};}
finally{clearTimeout(timer);await session.consumer?.catch(()=>{});}

}
