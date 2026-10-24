const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const {createRequire}=require('node:module');
const SOURCE='8a2599b4a25e83ce746e855bbb1ea7d124ca67c3';
const TREE='b257bf2205cc107310561d6d40ab1734307f1db4';
const TEST_SHA='eb1bad86f24d8b3ab734e8c2c535ecf5bb27b9f5fe1ac27a13837aa7a5dc4bf2';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function instrument(text,ts){
 if(text.includes('__mergeAuditTiming'))throw Error('Source already observed');
 const source=ts.createSourceFile('merge-audit.test.ts',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 if(source.parseDiagnostics.length)throw Error('Original parse error');
 const edits=[];let cases=0,assertions=0,cleanup=0;const caseNames=[];
 function wrap(body,kind,meta){
  const id='__md_'+body.pos;const a=`const ${id}=globalThis.__mergeAuditTiming.begin(${JSON.stringify(kind)},${meta});try{`;
  const b=`}finally{globalThis.__mergeAuditTiming.end(${id});}`;
  edits.push({at:body.getStart(source)+1,text:a},{at:body.end-1,text:b});
 }
 function visit(n){
  if(ts.isFunctionDeclaration(n)&&n.body){
   const name=n.name.text;wrap(n.body,'function:'+name,name==='git'?'{op:String(args[0])}':'{}');
  }
  if(ts.isCallExpression(n)&&ts.isIdentifier(n.expression)&&['it','afterEach'].includes(n.expression.text)){
   const cb=n.arguments.find(x=>ts.isArrowFunction(x)||ts.isFunctionExpression(x));
   if(!cb||!ts.isBlock(cb.body))throw Error('Unexpected callback');
   if(n.expression.text==='it'){cases++;caseNames.push(n.arguments[0].text);wrap(cb.body,'case-body',JSON.stringify({case:cases}));}
   else {cleanup++;wrap(cb.body,'cleanup','{}');}
  }
  if(ts.isExpressionStatement(n)&&n.getText(source).startsWith('expect(')){
   assertions++;const id='__md_assert_'+n.pos;const line=source.getLineAndCharacterOfPosition(n.getStart(source)).line+1;
   edits.push({at:n.getStart(source),text:`{const ${id}=globalThis.__mergeAuditTiming.begin("assert",{line:${line}});try{`},{at:n.end,text:`}finally{globalThis.__mergeAuditTiming.end(${id});}}`});
  }
  ts.forEachChild(n,visit);
 }
 visit(source);if(cases!==5||cleanup!==1)throw Error('Fixed test shape changed');
 edits.sort((a,b)=>b.at-a.at);let observed=text;for(const e of edits)observed=observed.slice(0,e.at)+e.text+observed.slice(e.at);
 let restored=observed;for(const e of edits){if(restored.split(e.text).length!==2)throw Error('Ambiguous insertion');restored=restored.replace(e.text,'');}
 if(restored!==text)throw Error('Original statements not preserved');
 const parsed=ts.createSourceFile('observed.ts',observed,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);if(parsed.parseDiagnostics.length)throw Error('Observed parse error');
 return {observed,edits,cases,caseNames,assertions,restorationExact:true};
}
module.exports={instrument};
if(require.main===module){
 const source=path.resolve(process.argv[2]),out=path.resolve(process.argv[3]);fs.mkdirSync(out,{recursive:true});
 const git=(...a)=>cp.execFileSync('git',a,{cwd:source,encoding:'utf8'}).trim();
 if(git('rev-parse','HEAD')!==SOURCE||git('rev-parse','HEAD^{tree}')!==TREE)throw Error('Fixed source identity mismatch');
 if(git('diff','--name-only')!=='')throw Error('Tracked source changed before observation');
 const file=path.join(source,'tests/merge-audit.test.ts');const original=fs.readFileSync(file);
 fs.writeFileSync(path.join(out,'original-test.ts'),original,{flag:'wx'});
 if(hash(original)!==TEST_SHA)throw Error('Test bytes mismatch');
 const config=fs.readFileSync(path.join(source,'vitest.config.js'),'utf8');if(!config.includes('testTimeout: 10_000'))throw Error('Original 10s budget missing');
 const ts=createRequire(path.join(source,'package.json'))('typescript');const transformed=instrument(original.toString('utf8'),ts);
 const identity={sourceCommit:SOURCE,sourceTree:TREE,sourceTestSha256:hash(original),observedTestSha256:hash(transformed.observed),lockSha256:hash(fs.readFileSync(path.join(source,'package-lock.json'))),configSha256:hash(config),auditSha256:hash(fs.readFileSync(path.join(source,'scripts/merge-audit.mjs'))),cases:transformed.caseNames,assertions:transformed.assertions,restorationExact:transformed.restorationExact,testTimeout:10000,onlyTargetTestWillRun:true};
 fs.writeFileSync(path.join(out,'identity.json'),JSON.stringify(identity,null,2));fs.writeFileSync(path.join(out,'overlay.json'),JSON.stringify(transformed.edits,null,2));
 fs.writeFileSync(file,transformed.observed);console.log(JSON.stringify(identity));
}
