// One target invocation. No test, install, or CI retry is implemented.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const source=path.resolve(process.argv[2]),out=path.resolve(process.argv[3]);
if(process.platform!=='win32'||process.version!=='v24.15.0'||process.env.CI!=='true')throw Error('Windows/Node/CI identity mismatch');
fs.writeFileSync(path.join(out,'target-once.lock'),'one target invocation only\n',{flag:'wx'});
const preload=path.join(__dirname,'observe.cjs').replaceAll('\\','/');
const env={...process.env,MERGE_DIAG_OUT:out,NODE_OPTIONS:(process.env.NODE_OPTIONS||'')+' --require="'+preload+'"'};
const identity=JSON.parse(fs.readFileSync(path.join(out,'identity.json'),'utf8'));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
if(hash(fs.readFileSync(path.join(source,'tests/merge-audit.test.ts')))!==identity.observedTestSha256)throw Error('Observed source changed');
if(hash(fs.readFileSync(path.join(source,'vitest.config.js')))!==identity.configSha256)throw Error('Original budget/config changed');
const session={supervisorPid:process.pid,startedAt:Date.now(),identity,probe:null,cli:null,timedOut:false,treeKill:null};
const save=()=>fs.writeFileSync(path.join(out,'session.json'),JSON.stringify(session,null,2));save();
function managed(args,childEnv,tee=false){
 return new Promise(resolve=>{
  const child=cp.spawn(process.execPath,args,{cwd:source,env:childEnv,stdio:['ignore','pipe','pipe']});
  const info={pid:child.pid??null,args,spawnObserved:false,exitObserved:false,closeObserved:false,code:null,signal:null};
  if(tee){session.cli=info;save();}
  const stdout=tee?fs.openSync(path.join(out,'cli.stdout.log'),'w'):null,stderr=tee?fs.openSync(path.join(out,'cli.stderr.log'),'w'):null;
  child.stdout.on('data',b=>{if(stdout!==null)fs.writeSync(stdout,b);process.stdout.write(b);});
  child.stderr.on('data',b=>{if(stderr!==null)fs.writeSync(stderr,b);process.stderr.write(b);});
  child.once('spawn',()=>{info.spawnObserved=true;if(tee)save();});
  child.once('error',()=>{info.spawnError=true;if(tee)save();});
  child.once('exit',(code,signal)=>{Object.assign(info,{exitObserved:true,code,signal,exitedAt:Date.now()});if(tee)save();});
  child.once('close',(code,signal)=>{Object.assign(info,{closeObserved:true,closeCode:code,closeSignal:signal,closedAt:Date.now()});if(stdout!==null)fs.closeSync(stdout);if(stderr!==null)fs.closeSync(stderr);if(tee)save();resolve(info);});
 });
}
(async()=>{
 // Synthetic observation preflight, not the repository test: validate both sync APIs without replacing them.
 const probeCode='const c=require("node:child_process"),a=require("node:assert/strict");const r=c.spawnSync(process.execPath,["-e","process.exit(7)"]);a.equal(r.status,7);a.ok(r.pid>0);a.throws(()=>c.execFileSync(process.execPath,["-e","process.exit(8)"],{stdio:"pipe"}),e=>e.status===8);';
 session.probe=await managed(['-e',probeCode],{...env,MERGE_DIAG_ROLE:'probe'});save();
 if(session.probe.code!==0||!session.probe.closeObserved)throw Error('Observation preflight failed; target not launched');
 const probeRows=readRows().filter(r=>r.role==='probe'&&r.event==='sync:end');
 if(![7,8].every(s=>probeRows.some(r=>r.status===s&&r.childPid>0)))throw Error('Real sync PID/status capture unavailable; target not launched');
 let closed=false;
 const timer=setTimeout(()=>{
  if(closed)return;session.timedOut=true;save();
  // Only this supervisor's actual spawned CLI PID is targeted; never enumerate or guess PIDs.
  const killer=cp.spawn('taskkill',['/PID',String(session.cli.pid),'/T','/F'],{stdio:'ignore'});
  session.treeKill={pid:killer.pid??null,targetPid:session.cli.pid,exitObserved:false,closeObserved:false};save();
  killer.once('exit',(code,signal)=>{Object.assign(session.treeKill,{exitObserved:true,code,signal});save();});
  killer.once('close',(code,signal)=>{Object.assign(session.treeKill,{closeObserved:true,closeCode:code,closeSignal:signal});save();});
  setTimeout(()=>{if(!closed){fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({complete:false,timedOut:true,cliClosureUnknown:true,session},null,2));process.exit(124);}},10000).unref();
 },180000);
 session.cli=await managed([path.join(source,'node_modules/vitest/vitest.mjs'),'run','tests/merge-audit.test.ts','--reporter=verbose','--reporter=json','--outputFile.json='+path.join(out,'vitest.json')],env,true);
 closed=true;clearTimeout(timer);save();
 const rows=readRows(),issues=[];
 if(fs.readdirSync(out).some(n=>n.startsWith('observer-error-')))issues.push('observer-write-failure');
 const starts=rows.filter(r=>r.event==='sync:start');
 for(const s of starts){const end=rows.filter(r=>r.pid===s.pid&&r.tid===s.tid&&r.id===s.id&&r.event==='sync:end');if(end.length!==1||!(end[0].childPid>0)||end[0].status===null||end[0].error!==null)issues.push('sync-state-incomplete');}
 for(const s of rows.filter(r=>r.event==='phase:start'))if(rows.filter(r=>r.pid===s.pid&&r.tid===s.tid&&r.id===s.id&&r.event==='phase:end').length!==1)issues.push('phase-end-missing');
 const forks=rows.filter(r=>r.event==='fork:created').map(c=>{
  const a=rows.filter(r=>r.pid===c.pid&&r.id===c.id&&r.event.startsWith('fork:'));
  const exit=a.find(r=>r.event==='fork:exit'),close=a.find(r=>r.event==='fork:close');
  const closed=!!exit&&!!close&&exit.code===close.code&&exit.signal===close.signal;
  const normalZero=closed&&exit.code===0&&exit.signal===null;
  const stopped=a.find(r=>r.event==='fork:stopped'),request=a.find(r=>r.event==='fork:kill-request'&&r.signal==='SIGTERM'),accepted=a.find(r=>r.event==='fork:kill-result'&&r.accepted===true);
  const explainedStop=closed&&exit.code===null&&exit.signal==='SIGTERM'&&stopped&&request&&accepted&&stopped.seq<request.seq&&request.seq<accepted.seq&&accepted.seq<exit.seq;
  if(!closed||!(normalZero||explainedStop))issues.push('unexpected-or-unconfirmed-fork-termination');
  return {pid:c.childPid,exit,close,closed,expectedTermination:!!(normalZero||explainedStop)};
 });
 const asyncChildren=rows.filter(r=>r.event==='async:created').map(c=>{const a=rows.filter(r=>r.pid===c.pid&&r.id===c.id&&r.event.startsWith('async:'));const exit=a.find(r=>r.event==='async:exit'),close=a.find(r=>r.event==='async:close');const closed=!!exit&&!!close&&exit.code===close.code&&exit.signal===close.signal;if(!closed||exit.code!==0||exit.signal!==null)issues.push('async-child-unexpected-or-unconfirmed');return {pid:c.childPid,executable:c.executable,exit,close,closed};});
 let tests=null;try{tests=JSON.parse(fs.readFileSync(path.join(out,'vitest.json'),'utf8'));}catch{issues.push('test-json-missing');}
 const assertions=tests?.testResults?.flatMap(r=>r.assertionResults)||[];
 if(assertions.length!==5||assertions.some(r=>!['passed','failed'].includes(r.status)))issues.push('five-cases-not-settled');
 for(let n=1;n<=5;n++){
  if(rows.filter(r=>r.event==='phase:start'&&r.kind==='case-body'&&r.case===n).length!==1)issues.push('case-start-missing');
  if(rows.filter(r=>r.event==='phase:start'&&r.kind==='cleanup'&&r.case===n).length!==1)issues.push('cleanup-start-missing');
 }
 const probes=rows.filter(r=>r.role==='probe').length;
 const result={sourceCommit:identity.sourceCommit,oneTargetInvocation:true,testTimeout:10000,fullCiGateUnchanged:true,complete:issues.length===0,issues:[...new Set(issues)],tests:assertions.map(t=>({fullName:t.fullName,status:t.status,duration:t.duration,failureMessages:t.failureMessages})),cli:session.cli,forks,asyncChildren,syncOperations:starts.length,probeEvents:probes,timedOut:session.timedOut,originalAuditExitOneIsExpected:true,doesNotCertifyFullCi:true};
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 process.exitCode=session.timedOut?124:session.cli.code!==0?(session.cli.code||1):result.complete&&assertions.every(t=>t.status==='passed')?0:86;
})().catch(e=>{save();fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({complete:false,preflightOrSupervisorFailure:String(e.message),session},null,2));console.error(e);process.exitCode=1;}).finally(()=>{
 try{const original=fs.readFileSync(path.join(out,'original-test.ts'));if(hash(original)!==identity.sourceTestSha256)throw Error('Original test recovery bytes changed');fs.writeFileSync(path.join(source,'tests/merge-audit.test.ts'),original);session.sourceRestored=hash(fs.readFileSync(path.join(source,'tests/merge-audit.test.ts')))===identity.sourceTestSha256;session.configPreserved=hash(fs.readFileSync(path.join(source,'vitest.config.js')))===identity.configSha256;session.lockPreserved=hash(fs.readFileSync(path.join(source,'package-lock.json')))===identity.lockSha256;session.auditPreserved=hash(fs.readFileSync(path.join(source,'scripts/merge-audit.mjs')))===identity.auditSha256;if(!session.sourceRestored||!session.configPreserved||!session.lockPreserved||!session.auditPreserved)throw Error('Final source identity changed');save();}catch(e){session.restorationFailure=true;save();console.error(e);process.exitCode=1;}
});
function readRows(){return fs.readdirSync(out).filter(n=>/^events-\d+-\d+\.jsonl$/.test(n)).flatMap(n=>fs.readFileSync(path.join(out,n),'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)));}
