const fs = require('fs'), path = require('path'), http = require('http'), assert = require('assert');
const {chromium} = require('playwright-core');
const root=path.resolve(__dirname,'../client');
const server=http.createServer((req,res)=>{
  const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  const file=path.resolve(root,'.'+(name==='/'?'/index.html':name));
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}
  res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.css':'text/css','.js':'application/javascript'})[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(()=>{
      const dirs=new Set(),files={};
      const fakeFS={mkdirSync:p=>dirs.add(p),readdirSync:p=>[...dirs].filter(d=>d.startsWith(p+'/')&&!d.slice(p.length+1).includes('/')).map(d=>d.slice(p.length+1)),statSync:p=>({isDirectory:()=>dirs.has(p)}),existsSync:p=>Object.prototype.hasOwnProperty.call(files,p),readFileSync:p=>files[p],writeFileSync:(p,v)=>files[p]=v};
      const fakePath={join:(...p)=>p.join('/'),extname:p=>'.'+p.split('.').pop(),basename:p=>p.split('/').pop()};
      window.require=name=>({fs:fakeFS,path:fakePath,os:{homedir:()=>'/demo'},child_process:{},url:{pathToFileURL:p=>({href:'file:///'+p})}}[name]);
    });
    await page.goto('http://127.0.0.1:'+server.address().port);
    for(const width of [340,420,800,1100]){
      await page.setViewportSize({width,height:950});
      for(const section of ['subs','edit','sounds','flow','notes','settings']){
        await page.locator('[data-tab="'+section+'"]').click();
        assert(await page.locator('#view-'+section).isVisible());
        const over=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
        assert(!over,'Horizontal page overflow: '+width+' '+section);
        const clipped=await page.locator('#view-'+section).evaluate(v=>v.scrollWidth>v.clientWidth+2);
        if(clipped) console.log(await page.locator('#view-'+section).evaluate(v=>[...v.querySelectorAll('*')].filter(e=>e.getBoundingClientRect().right>v.getBoundingClientRect().right+2).map(e=>({tag:e.tagName,id:e.id,cls:e.className,width:e.getBoundingClientRect().width})))); assert(!clipped,'Content overflow: '+width+' '+section);
      }
    }
    await page.locator('[data-tab="sounds"]').click();
    await page.locator('#soundFolderName').fill('My test folder');await page.locator('#newSoundFolder').click();
    assert(await page.getByRole('button',{name:'▸ My test folder',exact:true}).isVisible());
    await page.locator('[data-tab="notes"]').click();await page.locator('#notesText').fill('Senariy test');assert((await page.locator('#notesStatus').textContent()).includes('saqlandi'));
    await page.locator('[data-tab="flow"]').click();await page.locator('#flowMode').selectOption('cookies');assert(await page.locator('#flowCookies').isVisible());assert(!(await page.locator('#flowProfileWrap').isVisible()));
    await page.locator('#flowMode').selectOption('profile');
    await page.setViewportSize({width:950,height:1370});
    await page.locator('#banner').evaluate(el=>el.hidden=true);
    await page.screenshot({path:path.join(__dirname,'ui-wide.png')});
    await page.setViewportSize({width:420,height:900});await page.screenshot({path:path.join(__dirname,'ui-narrow.png')});
    assert.deepEqual(errors,[]);console.log('PASS: 24 responsive tab views, no overflow/errors, folder creation, notes autosave, auth mode switch.');
  }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
