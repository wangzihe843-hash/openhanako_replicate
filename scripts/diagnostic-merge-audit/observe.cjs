// Passive timing only: original functions, arguments, return objects and throws are preserved.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { threadId } = require('node:worker_threads');
const { syncBuiltinESMExports } = require('node:module');
const { errorMonitor } = require('node:events');
let seq = 0, span = 0, currentCase = 0;
const role = process.env.MERGE_DIAG_ROLE || (String(process.argv[1]).replaceAll('\\','/').endsWith('/merge-audit.mjs') ? 'audit' : 'vitest');
const file = path.join(process.env.MERGE_DIAG_OUT, `events-${process.pid}-${threadId}.jsonl`);
function mark(event, detail = {}) {
  try {
    fs.appendFileSync(file, JSON.stringify({ event, pid:process.pid, ppid:process.ppid, tid:threadId, role, seq:++seq,
      wall:Date.now(), mono:process.hrtime.bigint().toString(), case:currentCase, ...detail })+'\n');
  } catch {
    try { fs.writeFileSync(path.join(process.env.MERGE_DIAG_OUT, `observer-error-${process.pid}-${threadId}.flag`),'incomplete\n'); } catch {}
    try { process.stderr.write('[merge-audit timing] observation incomplete\n'); } catch {}
  }
}
function begin(kind, meta={}) { if(kind==='case-body') currentCase=meta.case; const id=++span; mark('phase:start',{id,kind,...meta}); return id; }
function end(id) { mark('phase:end',{id}); }
Object.defineProperty(globalThis,'__mergeAuditTiming',{value:Object.freeze({begin,end}),configurable:false});
mark('process:bootstrap');
process.on('exit',code=>mark('process:exit',{code}));
process.on('uncaughtExceptionMonitor',(_e,origin)=>mark('process:uncaught-monitor',{origin}));
// Node 24's native synchronous spawn result contains the real PID/status. No sync API is reimplemented.
const binding=process.binding('spawn_sync');
const originalSync=binding.spawn;
if(typeof originalSync!=='function') throw new Error('Native sync-spawn observation unavailable');
binding.spawn=function(...args){
 const id=++span;const opts=args[0];const executable=path.basename(String(opts?.file||''));
 const argv=Array.isArray(opts?.args)?opts.args:[];
 const command=executable.toLowerCase().startsWith('git') ? String(argv[1]||'') : executable.toLowerCase().startsWith('node') ? 'node' : 'other';
 mark('sync:start',{id,executable,command});
 try {const result=Reflect.apply(originalSync,this,args);mark('sync:end',{id,childPid:result.pid??null,status:result.status??null,signal:result.signal??null,error:result.error??null});return result;}
 catch(error){mark('sync:throw',{id});throw error;}
};
let forkId=0;
const originalFork=cp.fork;
cp.fork=function(...args){
 const child=Reflect.apply(originalFork,this,args);const id=++forkId;
 const identity=()=>({id,childPid:child.pid??null});
 mark('fork:created',identity());
 child.once('spawn',()=>mark('fork:spawn',identity()));
 child.once('exit',(code,signal)=>mark('fork:exit',{...identity(),code,signal}));
 child.once('close',(code,signal)=>mark('fork:close',{...identity(),code,signal}));
 child.on(errorMonitor,()=>mark('fork:error',identity()));
 child.on('message',m=>{if(m?.__vitest_worker_response__&&['started','stopped'].includes(m.type))mark('fork:'+m.type,identity());});
 const kill=child.kill;
 child.kill=function(signal){mark('fork:kill-request',{...identity(),signal:signal??'SIGTERM'});const accepted=Reflect.apply(kill,this,arguments);mark('fork:kill-result',{...identity(),accepted});return accepted;};
 return child;
};
syncBuiltinESMExports();
let asyncId=0;
const originalSpawn=cp.spawn;
cp.spawn=function(...args){
 const child=Reflect.apply(originalSpawn,this,args);const id=++asyncId;const executable=path.basename(String(args[0]||''));
 const identity=()=>({id,childPid:child.pid??null,executable});
 mark('async:created',identity());
 child.once('spawn',()=>mark('async:spawn',identity()));
 child.once('exit',(code,signal)=>mark('async:exit',{...identity(),code,signal}));
 child.once('close',(code,signal)=>mark('async:close',{...identity(),code,signal}));
 child.on(errorMonitor,()=>mark('async:error',identity()));
 return child;
};
syncBuiltinESMExports();
