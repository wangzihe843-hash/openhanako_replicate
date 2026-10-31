import fs from "node:fs";
import vm from "node:vm";
import os from "node:os";
import ts from "typescript";
import { Hono } from "hono";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const factory=vi.hoisted(()=>vi.fn());
vi.mock("../lib/bridge/feishu-worker-adapter.ts",()=>({createFeishuWorkerAdapter:factory}));
vi.mock("../lib/debug-log.ts",()=>({debugLog:()=>null,createModuleLogger:()=>({log:vi.fn(),warn:vi.fn(),error:vi.fn()})}));
import { BridgeManager } from "../lib/bridge/bridge-manager.ts";
import { MediaDeliveryService } from "../lib/bridge/media-delivery-service.ts";
import { createBridgeRoute } from "../server/routes/bridge.ts";
const managers:BridgeManager[]=[];
function manager(){
 const agent={id:"a",config:{bridge:{feishu:{owner:"owner"},telegram:{owner:"owner"}}},updateConfig(patch:{bridge:Record<string,unknown>}){this.config.bridge={...this.config.bridge,...patch.bridge}}};
 const engine={hanakoHome:os.tmpdir(),currentAgentId:"a",getAgent:()=>agent,getBridgeIndex:()=>({"fs_dm_owner@a":{userId:"owner",chatId:"chat"}})};
 const bm=new BridgeManager({engine,hub:{eventBus:{emit:vi.fn()}}});managers.push(bm);return {bm,agent,engine};
}
const unknown=()=>Object.assign(new Error("synthetic platform response lost"),{deliveryUnknown:true});
function binding(bm:BridgeManager,platform:string,sendReply:(...args:unknown[])=>Promise<unknown>){const adapter={sendReply,stop:vi.fn()};bm._platforms.set(platform+":a",{platform,agentId:"a",status:"connected",adapter});return adapter}
beforeEach(()=>{factory.mockReset();factory.mockImplementation(()=>({stop:vi.fn()}))});
afterEach(async()=>{for(const bm of managers.splice(0))await bm.stopAll().catch(()=>{})});

it("RED proactive unknown must not fall through to another platform",async()=>{
 const {bm}=manager();const first=vi.fn().mockRejectedValue(unknown()),second=vi.fn().mockResolvedValue(undefined);
 binding(bm,"feishu",first);binding(bm,"telegram",second);
 const result=await bm.sendProactive("notification","a",{contextPolicy:"none"});
 expect(first).toHaveBeenCalledOnce();
 expect(second,"unknown Feishu delivery must not trigger alternate-platform fallback").not.toHaveBeenCalled();
 expect(result).toMatchObject({ok:false,deliveryUnknown:true});
});
it("CONTROL proactive known rejection preserves alternate-platform fallback",async()=>{
 const {bm}=manager();const first=vi.fn().mockRejectedValue(Object.assign(new Error("confirmed rejected"),{code:230001})),second=vi.fn().mockResolvedValue(undefined);
 binding(bm,"feishu",first);binding(bm,"telegram",second);
 expect(await bm.sendProactive("notification","a",{contextPolicy:"none"})).toMatchObject({platform:"telegram"});
 expect(second).toHaveBeenCalledOnce();
});
it("RED proactive idempotency key must retain unknown outcome against automatic retry",async()=>{
 const {bm}=manager();const send=vi.fn().mockRejectedValueOnce(unknown()).mockResolvedValue(undefined);
 binding(bm,"feishu",send);
 const opts={idempotencyKey:"independent-id",contextPolicy:"none",deliveryTarget:{platform:"feishu",agentId:"a",userId:"owner",chatId:"chat",sessionKey:"fs_dm_owner@a"}};
 const result=await bm.sendProactive("once","a",opts);await bm.sendProactive("once","a",opts);
 expect(send,"same operation key was attempted again despite unknown first delivery").toHaveBeenCalledOnce();
 expect(result).toMatchObject({deliveryUnknown:true});
});
it("CONTROL successful proactive idempotency key does suppress a repeat",async()=>{
 const {bm}=manager();const send=vi.fn().mockResolvedValue(undefined);binding(bm,"feishu",send);
 const opts={idempotencyKey:"success",contextPolicy:"none",deliveryTarget:{platform:"feishu",agentId:"a",userId:"owner",chatId:"chat",sessionKey:"fs_dm_owner@a"}};
 await bm.sendProactive("once","a",opts);const result=await bm.sendProactive("once","a",opts);
 expect(send).toHaveBeenCalledOnce();expect(result).toMatchObject({skipped:true});
});
it("RED outer media failure notification must respect deliveryUnknown",async()=>{
 const service=new MediaDeliveryService();const adapter={sendReply:vi.fn().mockResolvedValue(undefined)};
 await service.sendFailureNotice(adapter,"chat",unknown());
 expect(adapter.sendReply,"unknown accepted media must not produce a false failure write").not.toHaveBeenCalled();
});
it("CONTROL explicitly rejected media keeps the useful failure notification",async()=>{
 const service=new MediaDeliveryService();const adapter={sendReply:vi.fn().mockResolvedValue(undefined)};
 await service.sendFailureNotice(adapter,"chat",new Error("known rejected"));
 expect(adapter.sendReply).toHaveBeenCalledOnce();
});

const source=fs.readFileSync(new URL("../server/index.ts",import.meta.url),"utf8");
const parsed=ts.createSourceFile("index.ts",source,ts.ScriptTarget.Latest,true);let code="";
function find(node:ts.Node){if(ts.isFunctionDeclaration(node)&&node.name?.text==="gracefulShutdown")code=node.getText(parsed);ts.forEachChild(node,find)}find(parsed);
const shutdown=ts.transpileModule(code.replace('await import("../lib/browser/browser-manager.ts")',"browserModule"),{compilerOptions:{target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.ESNext}}).outputText;
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes});return {promise,resolve}}
function appWithRef(bm:BridgeManager,engine:ReturnType<typeof manager>["engine"],closing:{value:boolean}){
 const ensure=vi.fn(()=>closing.value?null:bm);
 const app=new Hono();app.route("/api",createBridgeRoute(engine,{get:()=>bm,ensureReady:ensure,getState:()=>({ready:true})}));
 return {app,ensure};
}
it("RED an accepted configuration request resuming during server shutdown must not restart a binding",async()=>{
 const {bm,engine}=manager();const closing={value:false};const {app,ensure}=appWithRef(bm,engine,closing);
 let body!:ReadableStreamDefaultController<Uint8Array>;const stream=new ReadableStream<Uint8Array>({start(c){body=c}});
 const request=app.request(new Request("http://local/api/bridge/config?agentId=a",{method:"POST",headers:{"Content-Type":"application/json"},body:stream,duplex:"half"} as RequestInit & {duplex:"half"}));
 await new Promise(r=>setImmediate(r));
 const browser=deferred();const exit=vi.fn();
 const context=vm.createContext({_shutting:false,get bridgeStopping(){return closing.value},set bridgeStopping(v){closing.value=v},
   bridgeManager:bm,bridgeManagerInitPromise:null,setTimeout,clearTimeout,Date,
   log:{log:vi.fn(),error:vi.fn(),warn:vi.fn()},dlog:{log:vi.fn(),error:vi.fn()},
   server:{close:vi.fn()},process:{exit},browserModule:{BrowserManager:{instance:()=>({runningSessions:["synthetic"],suspendForSession:()=>browser.promise})}},
   engine:{deferredResults:{dispose:vi.fn()}},workflowActivityStore:{flush:vi.fn()},hub:{dispose:vi.fn()},fs:{unlinkSync:vi.fn()},path:{join:()=>"synthetic"},hanakoHome:"synthetic"});
 vm.runInContext(shutdown,context);const stopping=context.gracefulShutdown();
 expect(closing.value).toBe(true);
 body.enqueue(new TextEncoder().encode(JSON.stringify({platform:"feishu",enabled:true,credentials:{appId:"synthetic",appSecret:"synthetic"}})));body.close();
 const response=await request;
 const observed={httpStatus:response.status,factoryCalls:factory.mock.calls.length,status:bm.getStatus("a"),ensureCalls:ensure.mock.calls.length};
 console.log("U15_SHUTDOWN_ROUTE_OBSERVATION",JSON.stringify(observed));
 browser.resolve();await stopping;
 expect(observed.factoryCalls,"configuration route started a new binding after shutdown stopAll snapshot").toBe(0);
 expect(observed.httpStatus).toBe(503);
});
it("CONTROL configuration route still starts an enabled binding before shutdown",async()=>{
 const {bm,engine}=manager();const {app}=appWithRef(bm,engine,{value:false});
 const response=await app.request("/api/bridge/config?agentId=a",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({platform:"feishu",enabled:true,credentials:{appId:"synthetic",appSecret:"synthetic"}})});
 expect(response.status).toBe(200);expect(factory).toHaveBeenCalledOnce();
});

it.each(["edit_message","cardkit_stream"])("CONTROL %s suppresses stream fallback after unknown result and releases handle",async mode=>{
 const {bm}=manager();const state={messageId:"om",cardId:"card"};
 const start=vi.fn().mockResolvedValue(state),update=vi.fn().mockRejectedValue(unknown()),finish=vi.fn(),reply=vi.fn(),release=vi.fn();
 const adapter={startStreamReply:start,startRichStreamReply:start,updateStreamReply:update,updateRichStreamReply:update,finishStreamReply:finish,finishRichStreamReply:finish,sendReply:reply,releaseStreamReply:release};
 const input={platform:"feishu",adapter,chatId:"chat",context:{},capability:{minIntervalMs:0}};
 const delivery=mode==="edit_message"?bm._createEditMessageStreamDelivery(input):bm._createCardKitStreamDelivery(input);
 await delivery.startReceipt("working");delivery.onDelta("partial","partial");
 await expect(delivery.finish("final")).rejects.toMatchObject({deliveryUnknown:true});
 expect(reply).not.toHaveBeenCalled();expect(finish).not.toHaveBeenCalled();expect(release).toHaveBeenCalledWith(state);
});
