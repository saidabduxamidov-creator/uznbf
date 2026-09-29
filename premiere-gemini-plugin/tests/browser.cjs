const assert=require('assert'),fs=require('fs'),path=require('path');
const {chromium}=require('playwright-core');
const {FlowBrowser,validateMP4}=require('../flow/browser');
const {buildPrompt}=require('../flow/prompt');
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const fixture=`<!doctype html><html><body><textarea aria-label="Prompt"></textarea><button id="start" onclick="document.getElementById('file').click()">Add start frame</button><input id="file" type="file" hidden onchange="const img=document.createElement('img');img.src=window.URL.createObjectURL(this.files[0]);document.body.append(img);"/><button onclick="generate()">Generate</button><div id="old"><video src="blob:old"></video></div><script>
window.calls=0;
function generate(){window.calls++;for(let i=0;i<(window.multi?2:1);i++){
 const card=document.createElement('article'), video=document.createElement('video');
 const bytes=new Uint8Array(48);bytes.set([0,0,0,24,102,116,121,112,105,115,111,109]);
 const url=URL.createObjectURL(new Blob([bytes],{type:'video/mp4'}));
 Object.defineProperty(video,'currentSrc',{value:url});Object.defineProperty(video,'readyState',{value:4});Object.defineProperty(video,'duration',{value:8});
 const button=document.createElement('button');button.textContent='Download';button.onclick=()=>{const a=document.createElement('a');a.href=url;a.download='video.mp4';document.body.append(a);a.click();a.remove();};
 video.style='width:120px;height:80px';card.append(video,button);document.body.append(card);
}}
</script></body></html>`;
fs.mkdirSync(path.join(__dirname,'.scratch'),{recursive:true});
const temp=fs.mkdtempSync(path.join(__dirname,'.scratch','browser-test-')), frame=path.join(temp,'frame.png');fs.writeFileSync(frame,Buffer.from(png,'base64'));
const driver={launch:async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 const original=browser.newContext.bind(browser);
 browser.newContext=async options=>{const context=await original(options);context.on('page',p=>p.on('pageerror',e=>console.log('FIXTURE ERROR',e.message)));await context.route('https://labs.google/**',route=>route.fulfill({contentType:'text/html',body:fixture}));return context;};return browser;
}};
(async()=>{
 const events=[], adapter=new FlowBrowser({mode:'cookies',projectURL:'https://labs.google/fx/tools/flow'},null,{},(stage,msg)=>{events.push(stage);console.log(stage,msg);},driver);
 let watchdog;
 try {
  const controller=new AbortController(); watchdog=setTimeout(()=>{controller.abort();adapter.close();},90000); const signal=controller.signal;let submits=0;
  const result=await adapter.generate(frame,buildPrompt('Nod gently'),signal,()=>submits++);
  assert.equal(submits,1);assert.equal(await adapter.page.evaluate(()=>window.calls),1);
  assert(result.src.startsWith('blob:'));const target=path.join(temp,'out.mp4');console.log('Download test begins');await adapter.download(result,target,signal);console.log('Downloaded');validateMP4(target);
  assert.deepEqual(events.slice(0,2),['upload','polling']);
  await adapter.page.reload();await adapter.page.evaluate(()=>window.multi=true);
  await assert.rejects(()=>adapter.generate(frame,buildPrompt('Nod'),signal,()=>{}),/Bir nechta yangi video/);
  assert.equal(await adapter.page.evaluate(()=>window.calls),1);
  console.log('PASS: real browser fixture — first-frame file upload, exact prompt fill, one submit, 5s polling, matching card MP4 download, ambiguous results rejected. No Google account or live generation used.');
 }finally{clearTimeout(watchdog);await adapter.close();process.exitCode=process.exitCode||0;}
})().catch(e=>{console.error(e);process.exitCode=1;});
