// Run after npm run build. Uses Playwright if installed or PLAYWRIGHT_MODULE_PATH.
// All requests are local; the repository is replaced with an explicit test fixture.
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const root=resolve('dist'),fixture=(await readFile('tests/fixtures/team-chat-repository.js','utf8')).replace('tickets:[],clients:[],projects:[]',`tickets:[{id:'request-a',type:'service',note:'Send updated kitchen drawings',project_id:'project-a',assignee_id:'staff-a',created_by:'auth-a',status:'In Review',created_at:'2026-10-21T10:00:00Z',next_followup_due_at:'2026-10-22T10:00:00Z'}],clients:[{id:'client-a',name:'Oak client'}],projects:[{id:'project-a',client_id:'client-a',name:'Bandra Loft Apartment',site_address:'Bandra West, Mumbai'}]`);
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
try {
 browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
 const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
 await context.route('**/*',r=>r.request().url().startsWith(origin)?r.continue():r.abort());
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin);await page.locator('#workspace').waitFor({state:'visible'});
 await mkdir('output/mobile-preview',{recursive:true});
 for(const width of [320,390,768,1360]){
  await page.setViewportSize({width,height:844});
  await page.locator('[data-view="requests"]').click();
  await page.locator('[data-request="request-a"]').waitFor();
  assert.equal(await page.locator('[data-request="request-a"] .ticket-type-icon').evaluate(icon=>getComputedStyle(icon).backgroundColor),'rgb(23, 45, 66)');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  if(width===390)await page.screenshot({path:'output/mobile-preview/today.png'});
  await page.locator('[data-view="projects"]').click();
  assert.equal(await page.locator('.project-card').count(),1);
  assert.match(await page.locator('.project-card').textContent(),/1 open/);
  await page.locator('#projectSearch').fill('missing');assert.equal(await page.locator('.project-card').count(),0);
  await page.locator('#projectSearch').fill('Bandra');
  if(width===390)await page.screenshot({path:'output/mobile-preview/projects.png'});
  await page.locator('.project-card').click();assert.equal(await page.locator('#projectFilter').inputValue(),'project-a');
  await page.locator('#newTicketBtn').click();await page.locator('#ticketNote').fill('A site update');
  assert(await page.locator('#newTicketDialog').evaluate(el=>el.scrollWidth<=el.clientWidth));
  if(width===390)await page.screenshot({path:'output/mobile-preview/new-request.png'});
  await page.locator('[data-close="newTicketDialog"]').first().click();
  await page.locator('[data-view="chat"]').click();await page.waitForFunction(()=>!document.querySelector('#chatSend').disabled);
  if(width===390)await page.screenshot({path:'output/mobile-preview/chat.png'});
  await page.locator('[data-view="inbox"]').click();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 }
 await page.locator('.account-menu > summary').click();
 assert(await page.locator('.account-menu').evaluate(menu=>menu.open));
 await page.locator('#pageTitle').click();
 assert.equal(await page.locator('.account-menu').evaluate(menu=>menu.open),false);
 await page.locator('.account-menu > summary').click();
 assert.equal(await page.locator('[data-view="staff"]').isVisible(),false);
 await page.locator('#logout').click();await page.locator('#login').waitFor({state:'visible'});
 await page.locator('#adminLoginMode').click();await page.locator('#loginPhone').fill('admin@example.test');await page.locator('#loginPassword').fill('fixture-password');await page.locator('#loginBtn').click();
 await page.locator('#workspace').waitFor({state:'visible'});await page.locator('.account-menu > summary').click();
 await page.locator('[data-view="staff"]').click();assert.equal(await page.locator('.staff-card').count(),3);
 await page.locator('[data-view="projects"]').click();assert(await page.locator('#newProjectBtn').isVisible());
 await page.locator('#newProjectBtn').click();await page.locator('#projectDialog').waitFor({state:'visible'});await page.locator('[data-close="projectDialog"]').first().click();
 await page.locator('[data-view="chat"]').click();assert(await page.locator('#chatClearBtn').isVisible());
 assert.deepEqual(errors,[]);console.log('PASS: Mobile/desktop navigation, project search/counts/filtering, request form fit, Staff restrictions and Admin account/project/chat access. No live backend calls.');
}finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
