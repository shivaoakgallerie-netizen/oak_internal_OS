import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {safeProviderError} from '../supabase/functions/_shared/provider.js';

const source=stripTypeScriptTypes((await readFile(new URL('../supabase/functions/notification-worker/index.ts',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,''));
function harness({pushError,emailConfigured=false}={}){
  const writes=[],pushes=[],emails=[];
  const env={APP_URL:'http://localhost:8080',...(emailConfigured?{RESEND_API_KEY:'test',RESEND_FROM_EMAIL:'sender@example.com'}:{})};
  const client={from(table){
    let op='select',value;
    const filters=[];
    const result=()=>{
      if(op!=='select')writes.push({table,op,value:structuredClone(value),filters:[...filters]});
      return {error:null,data:op==='select'?{state:'processing',recipient_id:'recipient'}:null};
    };
    const query={select(){return query},update(v){op='update';value=v;return query},insert(v){op='insert';value=v;return query},eq(k,v){filters.push([k,v]);return query},single(){return Promise.resolve(result())},then(resolve,reject){return Promise.resolve(result()).then(resolve,reject)}};
    return query;
  }};
  const context={Deno:{env:{get:name=>env[name]},serve(){}},safeProviderError,webpush:{async sendNotification(...args){pushes.push(args);if(pushError)throw pushError}},fetch:async(...args)=>{emails.push(args);return {ok:true,json:async()=>({id:'email-1'})}},AbortSignal};
  const processOne=runInNewContext(source+'\nprocessOne;',context);
  const notification={id:'notification',ticket_id:'request',recipient_id:'recipient',kind:'assigned',attempt_count:1};
  const ticket={id:'request',note:'Test request',status:'New',type:'help_ticket',assignee_id:'recipient'};
  const recipient={id:'recipient',name:'Test person',email:'person@example.com'};
  const subscription={id:'device',endpoint:'https://push.example.test/send',p256dh:'test',auth_key:'test'};
  return {writes,pushes,emails,notification,ticket,recipient,subscription,run:subscriptions=>processOne(client,notification,ticket,recipient,subscriptions)};
}
test('browser-only delivery waits for opt-in without spending attempts or reporting sent',async()=>{
  const h=harness();await h.run([]);
  assert.equal(h.pushes.length,0);assert.equal(h.emails.length,0);
  assert.equal(h.writes.length,1);
  const change=h.writes[0];assert.equal(change.table,'notifications');
  assert.equal(change.value.state,'queued');assert.equal(change.value.attempt_count,0);
  assert.match(change.value.last_error,/enable browser alerts/);
  assert.ok(Date.parse(change.value.next_attempt_at)>Date.now());
  assert.deepEqual(change.filters,[['id','notification'],['state','processing']]);
});
test('browser provider acceptance is required to mark a push-only message sent',async()=>{
  const h=harness();await h.run([h.subscription]);
  assert.equal(h.pushes.length,1);assert.equal(h.emails.length,0);
  assert.equal(h.writes.find(w=>w.table==='delivery_attempts').value.state,'accepted');
  assert.equal(h.writes.find(w=>w.table==='notifications').value.state,'sent');
});
test('a real push failure remains retryable and does not invoke unconfigured email',async()=>{
  const h=harness({pushError:{statusCode:503,message:'sensitive provider response'}});await h.run([h.subscription]);
  assert.equal(h.emails.length,0);
  const change=h.writes.find(w=>w.table==='notifications').value;
  assert.equal(change.state,'failed');assert.equal(change.processed_at,null);
  assert.equal(change.last_error,'Provider returned HTTP 503');
});
test('configured email fallback still sends when no browser is registered',async()=>{
  const h=harness({emailConfigured:true});await h.run([]);
  assert.equal(h.emails.length,1);
  assert.equal(h.writes.find(w=>w.table==='notifications').value.state,'sent');
});
test('finished work is cancelled before waiting for alerts or sending',async()=>{
  const h=harness();h.ticket.status='Resolved';await h.run([h.subscription]);
  assert.equal(h.pushes.length,0);assert.equal(h.emails.length,0);
  assert.equal(h.writes[0].value.state,'cancelled');
  assert.equal(h.writes[0].value.cancellation_reason,'request_resolved');
});
