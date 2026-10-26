// Run after npm run build. Uses Playwright if installed or PLAYWRIGHT_MODULE_PATH.
// All requests are local; the repository is replaced with an explicit test fixture.
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const root=resolve('dist'),fixture=await readFile('tests/fixtures/team-chat-repository.js','utf8');
const server=createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/live-client.js'){res.setHeader('content-type','text/javascript');res.end(fixture);return;}
  if(url.pathname==='/config.js'){res.setHeader('content-type','text/javascript');res.end('window.OAK_CONFIG={};');return;}
  const path=resolve(root,'.'+(url.pathname==='/'?'/index.html':url.pathname));
  if(!path.startsWith(root+sep))throw Error('Outside build');
  res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'})[extname(path)]||'application/octet-stream');
  res.end(await readFile(path));
 }catch{res.statusCode=404;res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
let browser;
try{
 browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
 const context=await browser.newContext({viewport:{width:1360,height:1100},serviceWorkers:'block'});
 await context.addInitScript(()=>localStorage.setItem('oak-chat-seen:staff-a','1'));
 await context.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(origin);await page.locator('#workspace').waitFor({state:'visible'});
 await page.waitForFunction(()=>document.querySelector('#chatCount').textContent==='1');
 await mkdir('output/chat-preview',{recursive:true});
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:'output/chat-preview/unread-badge.png'});
 await page.locator('.workspace-nav [data-view="chat"]').click();
 await page.waitForFunction(()=>!document.querySelector('#chatSend').disabled);
 assert.equal(await page.locator('.chat-message').count(),3);
 // The compact composer stays touch-friendly and bounded at phone/tablet/desktop widths.
  for(const width of [320,390,768,1024,1360]){
  await page.setViewportSize({width,height:width<600?844:1100});
  await page.locator('#chatText').fill('');
  const compact=await page.locator('#chatText').boundingBox();
  assert(compact.height>=28&&compact.height<=30,`Compact height at ${width}px: ${compact.height}`);
  assert(await page.evaluate(()=>{
   const panel=document.querySelector('.chat-panel'),view=document.querySelector('#chatView');
   const composer=getComputedStyle(document.querySelector('#chatForm'));
   const messages=getComputedStyle(document.querySelector('#chatMessages'));
   const input=getComputedStyle(document.querySelector('#chatText'));
   return panel.getBoundingClientRect().width<=view.getBoundingClientRect().width
    &&composer.backgroundColor===messages.backgroundColor&&composer.borderTopWidth==='0px'
    &&input.borderTopWidth==='0px';
  }),`One continuous chat surface at ${width}px`);
  assert.equal(await page.getByRole('textbox',{name:'Message your team',exact:true}).count(),1);
  await page.locator('#chatText').fill(Array(15).fill('A longer team update.').join('\n'));
  const expanded=await page.locator('#chatText').boundingBox();
  assert(expanded.height>compact.height&&expanded.height<=132,`Bounded expansion at ${width}px`);
  assert(await page.locator('#chatText').evaluate(el=>el.scrollHeight>el.clientHeight));
  const send=await page.locator('#chatSend').boundingBox();
  assert(send.height>=32&&send.height<=34&&send.x>=expanded.x+expanded.width&&send.x+send.width<=width,`Compact Send fits at ${width}px`);
  const inputBar=await page.locator('.chat-input-row').boundingBox();
  assert(expanded.x>=inputBar.x&&send.x+send.width<=inputBar.x+inputBar.width,`Input and Send share one bar at ${width}px`);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`No horizontal overflow at ${width}px`);
  await page.locator('#chatText').fill('');
  assert((await page.locator('#chatText').boundingBox()).height<=30);
  if(width===390){
   await page.locator('#chatView').screenshot({path:'output/chat-preview/compact-mobile.png'});
   await page.locator('#chatView').screenshot({path:'output/chat-preview/integrated-mobile.png'});
   await page.locator('#chatForm').screenshot({path:'output/chat-preview/compact-composer.png'});
  }
 }
 // Width changes reflow an existing draft without another keystroke.
 await page.locator('#chatText').fill('Client meeting confirmed. '.repeat(12));
 const wideDraft=await page.locator('#chatText').boundingBox();
 await page.setViewportSize({width:390,height:844});
 await page.waitForFunction(height=>document.querySelector('#chatText').offsetHeight>height,wideDraft.height);
 await page.setViewportSize({width:1360,height:1100});
 await page.waitForFunction(height=>document.querySelector('#chatText').offsetHeight<=height,wideDraft.height);
 await page.locator('#chatText').fill('');
 await page.locator('#chatView').screenshot({path:'output/chat-preview/desktop.png'});
 await page.locator('#chatView').screenshot({path:'output/chat-preview/integrated-desktop.png'});
 await page.locator('#chatText').fill('Message using Enter');await page.locator('#chatText').press('Enter');
 await page.waitForFunction(()=>document.querySelector('#chatText').value==='');
 assert((await page.locator('#chatText').boundingBox()).height<=46);
 assert.equal(await page.locator('.chat-body').filter({hasText:'Message using Enter'}).count(),1);
 await page.locator('#chatText').fill('First line');await page.locator('#chatText').press('Shift+Enter');await page.locator('#chatText').press('x');
 assert.equal(await page.locator('#chatText').inputValue(),'First line\nx');
 await page.locator('#chatText').fill('<img src=x onerror="window.chatXss=true">');await page.locator('#chatSend').click();
 await page.waitForFunction(()=>document.querySelector('#chatText').value==='');
 assert.equal(await page.locator('#chatMessages img').count(),0);assert.equal(await page.evaluate(()=>window.chatXss),undefined);
 await page.evaluate(()=>{chatFixture.failAfterSave=true;});
 await page.locator('#chatText').fill('Retry me once');await page.locator('#chatSend').click();
 await page.locator('#chatError').waitFor({state:'visible'});assert.equal(await page.locator('#chatText').inputValue(),'Retry me once');
 await page.locator('#chatSend').click();await page.waitForFunction(()=>document.querySelector('#chatText').value==='');
 assert.equal(await page.locator('.chat-body').filter({hasText:'Retry me once'}).count(),1);
 assert(await page.evaluate(()=>chatFixture.sent.at(-1).id===chatFixture.sent.at(-2).id));
 await page.locator('.workspace-nav [data-view="requests"]').click();
 await page.evaluate(()=>chatFixture.append('New update while away'));
 await page.waitForFunction(()=>document.querySelector('#chatCount').textContent==='1');
 await page.locator('.workspace-nav [data-view="chat"]').click();assert.equal(await page.locator('#chatCount').textContent(),'');
 await page.setViewportSize({width:390,height:844});
 await page.locator('#chatView').screenshot({path:'output/chat-preview/mobile.png'});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.evaluate(()=>{chatFixture.hold=true;});await page.locator('#chatText').fill('Pending at logout');await page.locator('#chatSend').click();
 await page.waitForFunction(()=>Boolean(chatFixture.release));await page.locator('.account-menu > summary').click();await page.locator('#logout').click();
 await page.locator('#login').waitFor({state:'visible'});await page.evaluate(()=>chatFixture.release());
 assert.equal(await page.locator('#chatMessages').textContent(),'');assert.equal(await page.locator('#chatText').inputValue(),'');
 await page.evaluate(()=>{chatFixture.hold=false;});
 await page.locator('#adminLoginMode').click();await page.locator('#loginPhone').fill('admin@example.test');await page.locator('#loginPassword').fill('test-only-password');await page.locator('#loginBtn').click();
 await page.locator('#workspace').waitFor({state:'visible'});await page.locator('.workspace-nav [data-view="chat"]').click();
 await page.waitForFunction(()=>!document.querySelector('#chatSend').disabled);
 await page.locator('#chatText').fill('Hello from Admin');await page.locator('#chatSend').click();await page.waitForFunction(()=>document.querySelector('#chatText').value==='');
 assert.equal(await page.locator('.chat-own .chat-body').filter({hasText:'Hello from Admin'}).count(),1);
 assert.deepEqual(errors,[]);
 console.log('PASS: Integrated chat surface and compact composer at 320/390/768/1024/1360px, draft reflow, Staff and Admin chat, Enter/newline, safe text rendering, idempotent retry, unread badge, and logout during a pending send.');
}finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
