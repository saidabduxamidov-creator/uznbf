const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const test = require('node:test');
const base = path.resolve(__dirname, '..');
const storage = require(path.join(base, 'flow/storage'));
const { Worker } = require(path.join(base, 'flow/server'));
const { buildPrompt } = require(path.join(base, 'flow/prompt'));
const { validateMP4, delay } = require(path.join(base, 'flow/browser'));
fs.mkdirSync(path.join(__dirname, '.scratch'), {recursive:true});
const root = fs.mkdtempSync(path.join(__dirname, '.scratch', 'flow-test-'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfyoAAAAASUVORK5CYII=', 'base64');
const mp4 = Buffer.concat([Buffer.from([0,0,0,24]), Buffer.from('ftypisom'), Buffer.alloc(32)]);
function makeWorker(name, options = {}) {
  return new Worker({ root:path.join(root,name), temp:path.join(root,name,'temp'), downloads:path.join(root,name,'downloads'), ...options });
}
const capture = {sequenceID:'sequence-1', ticks:'254016000000', seconds:1, sequenceName:'Demo', projectPath:'C:\\demo.prproj'};
test('prompt: exact requested restrictions and literal action', () => {
  const prompt = buildPrompt('  Camera moves left.  ');
  assert(prompt.includes('Action to perform: Camera moves left.'));
  assert(prompt.includes('All branding elements, corporate logos, text graphics, and labels must remain completely sharp, unaltered, and intact.'));
  assert.equal((prompt.match(/\d\. /g)||[]).length,4);
  assert.throws(()=>buildPrompt(' ')); assert.throws(()=>buildPrompt('x'.repeat(8001)));
});
test('cookies validate domains, expiration, SameSite, malformed JSON', () => {
  const c = storage.normalizeCookies([{name:'TEST',value:'fake',domain:'.google.com',expirationDate:2000000000,sameSite:'no_restriction'}]);
  assert.equal(c[0].expires,2000000000); assert.equal(c[0].sameSite,'None');
  assert.equal(storage.normalizeCookies([{name:'TEST',value:'fake',domain:'labs.google'}]).length,1);
  for (const domain of ['google.com.evil.test','evilgoogle.com','example.com']) assert.throws(()=>storage.normalizeCookies([{name:'x',value:'x',domain}]));
  assert.throws(()=>storage.normalizeCookies('secret=abc')); assert.throws(()=>storage.normalizeCookies([]));
});
test('Flow URLs and profile paths are constrained', () => {
  assert.equal(storage.validateFlowURL('https://labs.google/fx/tools/flow/project/123'),'https://labs.google/fx/tools/flow/project/123');
  for(const url of ['http://labs.google/fx/tools/flow','https://evil.test/','https://labs.google.evil.test/fx/tools/flow','https://labs.google/fx/tools/flowing','https://x:y@labs.google/fx/tools/flow']) assert.throws(()=>storage.validateFlowURL(url));
  assert.throws(()=>storage.validateProfile('relative')); assert.throws(()=>storage.validateProfile('C:\\Users\\Test\\AppData\\Local\\Google\\Chrome\\User Data'));
});
test('Windows DPAPI round trip stores no plaintext test secret', async () => {
  const file = path.join(root,'vault.json'), fake={cookies:[{name:'TEST',value:'not-a-real-cookie-123'}]};
  await storage.saveSecret(file,fake);
  assert(!fs.readFileSync(file,'utf8').includes('not-a-real-cookie-123'));
  assert.deepEqual(await storage.readSecret(file),fake);
});
test('successful job: PNG, submit once, atomic MP4, recoverable result, import ack', async () => {
  let submits=0;
  const worker=makeWorker('success',{makeBrowser:()=>({
    open:async()=>{}, close:async()=>{},
    generate:async(frame,prompt,signal,submit)=>{assert(fs.existsSync(frame));assert(prompt.includes('FACIAL & BODY'));submit();submits++;return {src:'fixture'};},
    download:async(result,file)=>fs.writeFileSync(file,mp4)
  })});
  const job=worker.prepare();fs.writeFileSync(job.frame,png);
  const result=await worker.run({id:job.id,prompt:'Nod',capture});
  assert.equal(submits,1);assert(fs.existsSync(result.job.video));assert(!fs.existsSync(job.frame));
  assert.throws(()=>worker.prepare(),/Oldingi video/);
  const restored=makeWorker('success');assert.equal(restored.last.video,result.job.video);
  restored.imported({id:job.id});assert.equal(restored.last.stage,'imported');
});
test('submit failure never retries and preserves submitted flag', async () => {
  let attempts=0;
  const worker=makeWorker('failure',{makeBrowser:()=>({open:async()=>{},generate:async(f,p,s,submit)=>{submit();attempts++;throw new Error('Provider timeout');}})});
  const job=worker.prepare();fs.writeFileSync(job.frame,png);
  await assert.rejects(()=>worker.run({id:job.id,prompt:'Nod',capture}),/Provider timeout/);
  assert.equal(attempts,1);assert.equal(worker.last.submitted,true);assert.equal(worker.last.stage,'failed');assert(!worker.active);
});
test('cancellation and concurrent job lock', async () => {
  let started;const ready=new Promise(r=>started=r);
  const worker=makeWorker('cancel',{makeBrowser:()=>({open:async()=>{},close:async()=>{},generate:async(f,p,s,submit)=>{submit();started();await delay(30000,s);}})});
  const job=worker.prepare();fs.writeFileSync(job.frame,png);
  const run=worker.run({id:job.id,prompt:'Nod',capture}); await ready;
  assert.throws(()=>worker.prepare(),/davom/);await worker.cancel();await assert.rejects(run,/bekor/i);
  assert.equal(worker.last.stage,'cancelled');assert(!worker.active);
});
test('partial download removed; non-MP4 rejected',async()=>{
  const worker=makeWorker('partial',{makeBrowser:()=>({open:async()=>{},generate:async(f,p,s,submit)=>{submit();return{};},download:async(r,file)=>{fs.writeFileSync(file,'<html>login</html>');}})});
  const job=worker.prepare();fs.writeFileSync(job.frame,png);await assert.rejects(()=>worker.run({id:job.id,prompt:'Nod',capture}),/MP4/);
  assert.equal(fs.readdirSync(worker.downloads).length,0);
});
test('restart of pending submitted job never resubmits',()=>{
  const worker=makeWorker('restart');storage.atomicJSON(worker.jobFile,{id:'old',stage:'polling',submitted:true});
  const restored=makeWorker('restart');assert.equal(restored.last.stage,'interrupted');assert.equal(restored.last.submitted,true);
});

function hostFixture() {
  function Time(){this.seconds=1;this.ticks='254016000000';}
  function File(name){this.fsName=name;this.name=name.split(/[\\/]/).pop();this.exists=true;this.parent={exists:true};}
  const item={name:'Flow.mp4',getMediaPath:()=> 'C:/Flow.mp4',getInPoint:()=>({seconds:0,ticks:'0'}),getOutPoint:()=>({seconds:8,ticks:'2032128000000'}),createSubClip:(name,start,end,hard,video,audio)=>{assert.equal(audio,0);return item;}};
  const tracks=[];tracks.numTracks=0;
  const seq={sequenceID:'sequence-1',name:'Demo',videoTracks:tracks,getPlayerPosition:()=>new Time(),getSettings:()=>({videoFrameRate:{seconds:.04}})};
  let imports=0;
  const ctx={Time,File,app:{project:{activeSequence:seq,path:'C:\\demo.prproj',rootItem:{children:{numItems:0}},getInsertionBin:()=>({}),importFiles:()=>{imports++;return true;}},enableQE:()=>{}},qe:{project:{getActiveSequence:()=>({addTracks:(n,index,audio)=>{assert.equal(audio,0);const clips=[];clips.numItems=0;tracks.push({clips,isLocked:()=>false,overwriteClip:(it,time)=>{clips.push({projectItem:it,start:{seconds:time}});clips.numItems++;}});tracks.numTracks++;}})}}};
  vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(base,'host/host.jsx'),'utf8'),ctx);vm.runInContext(fs.readFileSync(path.join(base,'host/hostscript.jsx'),'utf8'),ctx);
  ctx.gc_findItemByPath=(root,target,result)=>{result.item=item;};
  return {ctx,seq,tracks,get imports(){return imports;}};
}
test('host: sequence mismatch blocks insertion; original position and video-only new track',()=>{
  const h=hostFixture();let r=JSON.parse(h.ctx.gc_flowImport('C:/Flow.mp4','wrong','254016000000','C:\\demo.prproj',false));assert.equal(r.ok,false);assert.equal(h.tracks.length,0);
  r=JSON.parse(h.ctx.gc_flowImport('C:/Flow.mp4','sequence-1','254016000000','C:\\demo.prproj',false));assert.equal(r.ok,true);assert.equal(r.track,1);
  r=JSON.parse(h.ctx.gc_flowImport('C:/Flow.mp4','sequence-1','254016000000','C:\\demo.prproj',false));assert.equal(r.alreadyPlaced,true);assert.equal(h.tracks.length,1);
});
