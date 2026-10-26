import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {normalizePhone,validatePublicConfig,allowedTypes,canUpdate,canView,canAcknowledge,notificationCancellationText,notificationTimingText,isNotificationRetryScheduled} from '../workflow-rules.js';
import {LiveRepository} from '../live-client.js';
import {parseStaffRoster,staffAuthFields,planRosterIdentity} from '../scripts/staff-roster.mjs';
import {manageStaff,safeAccountFailure} from '../supabase/functions/manage-staff/handler.js';
import {readLimitedBody,requireServiceRole} from '../supabase/functions/_shared/response.ts';
import {safeProviderError} from '../supabase/functions/_shared/provider.js';

test('edge request bodies are byte bounded before processing',async()=>{
 assert.equal(await readLimitedBody(new Request('https://example.test',{method:'POST',body:'ok'}),2),'ok');
 await assert.rejects(()=>readLimitedBody(new Request('https://example.test',{method:'POST',body:'€'}),2),/Request too large/);
 await assert.rejects(()=>readLimitedBody(new Request('https://example.test',{method:'POST',headers:{'content-length':'100'},body:'x'}),2),/Request too large/);
 await assert.rejects(()=>readLimitedBody(new Request('https://example.test',{method:'POST',body:new Uint8Array([255])}),2),/Invalid UTF-8/);
});

test('notification cron accepts only unexpired gateway-verified service-role JWT claims',()=>{
 const token=claims=>`header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
 const invoke=value=>requireServiceRole(new Request('https://example.test',{headers:{authorization:`Bearer ${value}`}}));
 assert.doesNotThrow(()=>invoke(token({role:'service_role',iss:'supabase',exp:Math.floor(Date.now()/1000)+60})));
 assert.throws(()=>invoke(token({role:'anon',iss:'supabase',exp:Math.floor(Date.now()/1000)+60})),/Unauthorized/);
 assert.throws(()=>invoke(token({role:'service_role',iss:'supabase',exp:1})),/Unauthorized/);
 assert.throws(()=>invoke('not-a-jwt'),/Unauthorized/);
});

test('edge failures do not disclose backend or provider exception text',()=>{
 assert.deepEqual(safeAccountFailure(new Error('database key: private-value')),{
  message:'Account management is unavailable. Contact the operator if this continues.',status:500
 });
 assert.deepEqual(safeAccountFailure(new Error('Invalid login credentials')),{message:'Admin password could not be verified.',status:401});
 assert.deepEqual(safeAccountFailure(new Error('Only active Admin can manage accounts')),{message:'Only active Admin can manage accounts',status:403});
 assert.deepEqual(safeAccountFailure(new Error('Request too large')),{message:'Request too large',status:413});
 assert.equal(safeProviderError(new Error('Authorization: Bearer private-value')),'Provider request failed');
 assert.equal(safeProviderError(Object.assign(new Error('private-value'),{statusCode:503})),'Provider returned HTTP 503');
});

test('chat client sends only text and an idempotency ID, and pages history by ID',async()=>{
 const calls=[];
 const query={select:()=>query,lt:(key,value)=>{calls.push(['lt',key,value]);return query;},gt:(key,value)=>{calls.push(['gt',key,value]);return query;},order:(key,value)=>{calls.push(['order',key,value]);return query;},limit:async value=>{calls.push(['limit',value]);return {data:[{id:2},{id:1}]};}};
 const repo=new LiveRepository({supabaseUrl:'https://example.supabase.co',publishableKey:'sb_publishable_test'},()=>({from:name=>{assert.equal(name,'team_chat_messages');return query;},rpc:(name,args)=>{calls.push([name,args]);return {single:async()=>({data:{id:3}})};}}));
 assert.deepEqual((await repo.chatMessages()).map(row=>row.id),[1,2]);
 await repo.chatMessages({before:20});await repo.chatMessages({after:10});
 await repo.sendChatMessage('Hello','client-uuid');
 assert(calls.some(call=>call[0]==='lt'&&call[2]===20));assert(calls.some(call=>call[0]==='gt'&&call[2]===10));
 assert.deepEqual(calls.at(-1),['send_team_message',{p_body:'Hello',p_client_message_id:'client-uuid'}]);
});

test('phone-only roster keeps two distinct identities without fake email or passwords',()=>{
 const header='name,phone_e164,email,role,active\n';
 const rows=parseStaffRoster(header+'First,+919900001111,,staff,true\nSecond,+919900001112,,staff,true');
 assert.equal(rows.length,2);assert.equal(rows[0].email,null);assert.equal(rows[1].email,null);
 assert.throws(()=>parseStaffRoster(header+'Admin,+919900001111,,admin,true'),/Admin requires/);
 assert.throws(()=>parseStaffRoster(header+'First,+919900001111,,staff,true\nSecond,+919900001111,,staff,true'),/Duplicate/);
 assert.equal(parseStaffRoster('name,phone_e164,role,active\nFirst,+919900001111,staff,true')[0].email,null);
});


test('shared notification email never links Staff to one shared Auth account',()=>{
 const rows=parseStaffRoster('name,phone_e164,email,role,active\nFirst,+919900001111,shared@example.test,staff,true\nSecond,+919900001112,shared@example.test,staff,true');
 const users=[{id:'mailbox-owner',email:'shared@example.test',phone:'919900009999'},{id:'first',phone:'919900001111'},{id:'second',phone:'919900001112'}];
 const existing=[{id:'first-roster',auth_user_id:'first',phone:'+919900001111',role:'staff',email:null,notification_email:'shared@example.test'}];
 const first=planRosterIdentity(rows[0],users,existing),second=planRosterIdentity(rows[1],users,existing);
 assert.equal(first.user.id,'first');assert.equal(second.user.id,'second');assert.equal(second.roster,undefined);
 for(const row of rows){const fields=staffAuthFields(row,true);assert.equal('email' in fields,false);assert.equal('password' in fields,false);}
 assert.equal(planRosterIdentity(rows[1],[users[0]],existing).user,undefined);
 assert.throws(()=>parseStaffRoster('name,phone_e164,email,role,active\nFirst,+919900001111,same@example.test,admin,true\nSecond,+919900001112,same@example.test,admin,true'),/login email/);
});

test('shared-inbox login aliases preserve existing identities and reject email conflicts',()=>{
 const header='name,phone_e164,email,auth_email,role,active\n';
 const first='First,+919900001111,shared@example.test,shared+first@example.test,staff,true';
 const second='Second,+919900001112,shared@example.test,shared+second@example.test,staff,true';
 const rows=parseStaffRoster(header+first+'\n'+second);
 const users=[{id:'first-auth',phone:'919900001111'},{id:'second-auth',phone:'919900001112'},{id:'shared-mailbox',email:'shared@example.test'}];
 const existing=[{id:'first-roster',auth_user_id:'first-auth',phone:'+919900001111',email:null},{id:'second-roster',auth_user_id:'second-auth',phone:'+919900001112',email:null}];
 for(const [index,row] of rows.entries()){
  const plan=planRosterIdentity(row,users,existing);
  assert.equal(plan.user.id,users[index].id);assert.equal(plan.roster.id,existing[index].id);
  assert.deepEqual(staffAuthFields(row),{phone:row.phone_e164,phone_confirm:true,email:row.auth_email,email_confirm:true});
 }
 assert.throws(()=>planRosterIdentity(rows[0],[...users,{id:'another',email:rows[0].auth_email}],existing),/different Auth accounts/);
 assert.throws(()=>parseStaffRoster(header+first+'\n'+second.replace('shared+second','shared+first')),/login email/);
 assert.throws(()=>parseStaffRoster(header+first+'\nAdmin,+919900001113,shared+first@example.test,,admin,true'),/login email/);
 assert.throws(()=>parseStaffRoster(header+first.replace('shared+first@example.test','invalid')),/valid email/);
});

test('public config rejects secret keys and phone normalization is exact',()=>{
  assert.equal(normalizePhone('98318 98326'),'+919831898326');
  assert.equal(normalizePhone('+44 7700 900123'),'+447700900123');
  assert.throws(()=>normalizePhone('1234'));
  for(const key of ['sb_secret_private',Buffer.from('a').toString('base64')+'.'+Buffer.from(JSON.stringify({role:'service_role'})).toString('base64')+'.x'])
    assert.throws(()=>validatePublicConfig({supabaseUrl:'https://example.supabase.co',publishableKey:key}));
  assert.throws(()=>validatePublicConfig({supabaseUrl:'http://example.com',publishableKey:'sb_publishable_public'}));
});
test('presentation permissions respect exactly two roles',()=>{
 const staff={id:'a',auth_user_id:'auth-a',role:'staff',is_active:true},other={assignee_id:'b',created_by:'auth-b',type:'urgent_message',status:'New'};
 assert.deepEqual(allowedTypes(staff),['service','help_ticket','follow_up']);
 assert.equal(canUpdate(staff,other),false);assert.equal(canView(staff,other),false);assert.equal(canAcknowledge(staff,other),false);
 assert.equal(canUpdate({...staff,is_active:false},{...other,assignee_id:'a'}),false);
});
test('notification cards explain recorded cancellations and only show actionable schedules',()=>{
 const notification={state:'cancelled',cancellation_reason:'request_resolved',next_attempt_at:'tomorrow',attempt_count:0};
 assert.equal(notificationCancellationText(notification),'The request was marked Done. This notification will not be sent.');
 for(const reason of ['request_updated','assignment_changed','recipient_inactive','urgent_acknowledged'])
  assert.doesNotMatch(notificationCancellationText({...notification,cancellation_reason:reason}),/not recorded/);
 for(const reason of [undefined,'unknown','constructor'])
  assert.match(notificationCancellationText({...notification,cancellation_reason:reason}),/reason was not recorded/);
 assert.equal(notificationCancellationText({...notification,state:'sent'}),'');
 const format=value=>value;
 for(const state of ['cancelled','sent','acknowledged','processing'])
  assert.equal(notificationTimingText({...notification,state},format),'');
 assert.equal(notificationTimingText({...notification,state:'queued'},format),'Scheduled for: tomorrow');
 assert.equal(notificationTimingText({...notification,state:'failed',attempt_count:1},format),'Next retry: tomorrow · Delivery attempts: 1');
 assert.equal(notificationTimingText({...notification,state:'failed',attempt_count:4},format),'');
 assert.equal(notificationTimingText({...notification,state:'failed',processed_at:'today'},format),'');
});
test('retry scheduled includes pending failed attempts and excludes finished or unscheduled deliveries',()=>{
 const pending={state:'failed',attempt_count:1,processed_at:null,next_attempt_at:'2026-10-07T06:00:00Z'};
 const eligible=[pending,{...pending,attempt_count:3,next_attempt_at:'2020-01-01T00:00:00Z'}];
 const excluded=[
  ...['queued','processing','sent','cancelled','acknowledged'].map(state=>({...pending,state})),
  {...pending,attempt_count:4},
  {...pending,attempt_count:0},
  {...pending,processed_at:'2026-10-07T05:00:00Z'},
  {...pending,next_attempt_at:null,scheduled_for:pending.next_attempt_at}
 ];
 assert.equal([...eligible,...excluded].filter(isNotificationRetryScheduled).length,2);
 for(const notification of eligible)assert.match(notificationTimingText(notification,value=>value),/^Next retry:/);
 for(const notification of excluded.filter(n=>n.state==='failed'))assert.equal(notificationTimingText(notification,value=>value),'');
});
test('login uses server password verification and derives actor from verified user',async()=>{
 let submitted,signouts=0;
 const fake={auth:{signInWithPassword:async args=>{submitted=args;return {data:{}};},getUser:async()=>({data:{user:{id:'verified-auth'}}}),signOut:async()=>{signouts++;return {data:{}};}},from:()=>({select:()=>({eq:(_,id)=>{assert.equal(id,'verified-auth');return {maybeSingle:async()=>({data:{id:'staff',role:'staff',is_active:true}})};}})})};
 const repo=new LiveRepository({supabaseUrl:'https://example.supabase.co',publishableKey:'sb_publishable_public'},()=>fake);
 assert.equal((await repo.login('9831898326','test-only-user-input')).id,'staff');
 assert.equal(submitted.phone,'+919831898326');
 await repo.login('Staff@Example.test','test-only-user-input');
 assert.equal(submitted.email,'staff@example.test');assert.equal(submitted.phone,undefined);
 await repo.login(' Shared+First@Example.test ','test-only-user-input','captcha');
 assert.equal(submitted.email,'shared+first@example.test');assert.equal(submitted.options.captchaToken,'captcha');
 fake.auth.signInWithPassword=async()=>({error:new Error('Invalid login credentials')});
 await assert.rejects(()=>repo.login('shared+second@example.test','wrong'),/Invalid login/);
 fake.auth.signInWithPassword=async()=>({data:{}});
 fake.from=()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{is_active:false}})})})});
 await assert.rejects(()=>repo.profile(),/active staff roster/);
 await assert.rejects(()=>repo.login('shared+first@example.test','test-only-user-input'),/active staff roster/);assert.equal(signouts,1);
});

test('only Admin has client account actions and current-password changes',async()=>{
 let submitted,role='admin';
 const fake={auth:{getUser:async()=>({data:{user:{id:'actor'}}}),signInWithPassword:async()=>({data:{user:{id:'actor'}}}),updateUser:async args=>{submitted=args;return {data:{}};}},from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{role,is_active:true,email:'owner@example.test',auth_user_id:'actor'}})})})})};
 const repo=new LiveRepository({supabaseUrl:'https://example.supabase.co',publishableKey:'sb_publishable_public'},()=>fake);
 await assert.rejects(()=>repo.changePassword('','new-password-123'),/current password/);
 await assert.rejects(()=>repo.changePassword('old-password','short'),/at least 12/);
 await repo.changePassword('old-password','new-password-123');
 assert.deepEqual(submitted,{password:'new-password-123',current_password:'old-password'});
 submitted=null;fake.auth.signInWithPassword=async()=>({error:new Error('Invalid login credentials')});
 await assert.rejects(()=>repo.changePassword('wrong-current-password','new-password-123'),/Invalid login/);assert.equal(submitted,null);
 role='staff';submitted=null;
 await assert.rejects(()=>repo.changePassword('old-password','new-password-123'),/Only Admin/);
 await assert.rejects(()=>repo.manageStaff({action:'create'}),/Only Admin/);assert.equal(submitted,null);
 assert.equal(repo.recover,undefined);assert.equal(repo.setPassword,undefined);assert.equal(repo.requestPhoneOtp,undefined);
});

test('server account management rejects forged roles and bad Admin passwords before any Auth mutation',async()=>{
 let role='staff',active=true,reauth=0,mutations=0;
 const client={auth:{getUser:async()=>({data:{user:{id:'actor',email:'admin@example.test',user_metadata:{role:'admin'}}}}),admin:{createUser:async()=>{mutations++;return {data:{user:{id:'new-staff'}}};},deleteUser:async()=>({data:{}})}},from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{role,is_active:active}})})})}),rpc:async()=>({data:{id:'new-roster'}})};
 const reauthClient={auth:{signInWithPassword:async()=>{reauth++;return {error:new Error('Invalid login credentials')};}}};
 const input={action:'create',currentPassword:'test-admin-password',name:'New Staff',email:'new@example.test',phone:'+919900003333',password:'new-staff-test-password'};
 await assert.rejects(()=>manageStaff({client,reauthClient,token:'staff-token',input}),/Only active Admin/);assert.equal(reauth,0);
 role='admin';active=false;await assert.rejects(()=>manageStaff({client,reauthClient,token:'admin-token',input}),/Only active Admin/);
 active=true;await assert.rejects(()=>manageStaff({client,reauthClient,token:'admin-token',input}),/Invalid login/);assert.equal(mutations,0);
 reauthClient.auth.signInWithPassword=async()=>({data:{user:{id:'different-admin'}}});
 await assert.rejects(()=>manageStaff({client,reauthClient,token:'admin-token',input}),/could not be verified/);assert.equal(mutations,0);
 reauthClient.auth.signInWithPassword=async()=>({data:{user:{id:'actor'}}});
 assert.deepEqual(await manageStaff({client,reauthClient,token:'admin-token',input}),{id:'new-roster'});assert.equal(mutations,1);
});

test('account creation cleans up unlinked Auth accounts when roster persistence fails',async()=>{
 let removed;
 const client={auth:{getUser:async()=>({data:{user:{id:'actor',email:'admin@example.test'}}}),admin:{createUser:async()=>({data:{user:{id:'new-auth'}}}),deleteUser:async id=>{removed=id;return {data:{}};}}},from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{role:'admin',is_active:true}})})})}),rpc:async()=>({error:new Error('Phone conflicts with existing roster')})};
 const reauthClient={auth:{signInWithPassword:async()=>({data:{user:{id:'actor'}}})}};
 const input={action:'create',currentPassword:'test-admin-password',name:'New Staff',email:'new@example.test',phone:'+919900003333',password:'new-staff-test-password',role:'admin'};
 await assert.rejects(()=>manageStaff({client,reauthClient,token:'admin-token',input}),/Phone conflicts/);assert.equal(removed,'new-auth');
});

test('account editing preserves the linked Auth ID and ignores client-supplied privilege fields',async()=>{
 let updated,profile;
 const target={id:'00000000-0000-4000-8000-000000000005',auth_user_id:'existing-auth',role:'staff',is_active:true};
 const client={auth:{getUser:async()=>({data:{user:{id:'actor',email:'admin@example.test'}}}),admin:{updateUserById:async(id,fields)=>{updated={id,fields};return {data:{user:{id}}};}}},from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{role:'admin',is_active:true}}),single:async()=>({data:target})})})}),rpc:async(name,args)=>{profile=args;return {data:{id:target.id}};}};
 const reauthClient={auth:{signInWithPassword:async()=>({data:{user:{id:'actor'}}})}};
 const input={action:'update',id:target.id,currentPassword:'test-admin-password',name:'Staff Renamed',email:'renamed@example.test',phone:'+919900003333',role:'admin',auth_user_id:'forged'};
 assert.deepEqual(await manageStaff({client,reauthClient,token:'admin-token',input}),{id:target.id});
 assert.equal(updated.id,'existing-auth');assert.equal(updated.fields.password,undefined);assert.equal(updated.fields.role,undefined);
 assert.equal(profile.p_actor,'actor');assert.equal(profile.p_auth_user_id,'existing-auth');assert.equal(profile.p_action,'profile_updated');
});

test('request and upload RPCs return one record and never submit a forged actor',async()=>{
 const calls=[],deleted=[],storage={upload:async()=>({data:{}}),remove:async paths=>{deleted.push(...paths);return {data:[]};},createSignedUrl:async(path,seconds)=>{assert.equal(seconds,300);return {data:{signedUrl:'https://example.test/private'}};}};
 const fake={rpc:(name,args)=>{calls.push([name,args]);return {single:async()=>name==='reserve_attachment'?{data:{id:'reservation',storage_path:'ticket/file.jpg'}}:name==='finalize_attachment'?{error:new Error('Upload no longer permitted')}:{data:{id:'ticket'}}};},storage:{from:name=>{assert.equal(name,'service-photos');return storage;}}};
 const repo=new LiveRepository({supabaseUrl:'https://example.supabase.co',publishableKey:'sb_publishable_public'},()=>fake);
 assert.equal((await repo.create({type:'help_ticket',note:'Work',created_by:'forged'})).id,'ticket');
 assert.equal('p_created_by' in calls[0][1],false);
 await assert.rejects(()=>repo.upload('ticket',[{name:'file.jpg',type:'image/jpeg',size:100}]),/0 of 1 attachments saved/);
 assert.deepEqual(deleted,['ticket/file.jpg']);
 assert.equal(await repo.mediaUrl({storage_path:'ticket/file.jpg'}),'https://example.test/private');
});

test('request with images saves the description before uploading and reports partial saves',async()=>{
 const repo=new LiveRepository({supabaseUrl:'https://example.supabase.co',publishableKey:'sb_publishable_public'},()=>({}));
 const ticket={id:'saved-request',note:'Repair the cabinet'},calls=[];
 repo.create=async input=>{calls.push('create');assert.equal(input.note,ticket.note);return ticket;};
 repo.upload=async(id,files)=>{calls.push('upload');assert.equal(id,ticket.id);assert.equal(files.length,1);};
 const files=[{name:'cabinet.jpg',type:'image/jpeg',size:100}];
 assert.equal(await repo.createWithAttachments({note:ticket.note},files),ticket);
 assert.deepEqual(calls,['create','upload']);
 repo.upload=async()=>{throw new Error('Storage upload denied');};
 await assert.rejects(()=>repo.createWithAttachments({note:ticket.note},files),error=>{
  assert.equal(error.savedRequest,ticket);assert.match(error.message,/Request saved.*Storage upload denied/);return true;
 });
 repo.create=async()=>{throw new Error('Request denied');};
 await assert.rejects(()=>repo.createWithAttachments({},files),error=>{
  assert.equal(error.savedRequest,undefined);assert.equal(error.message,'Request denied');return true;
 });
});

test('reservation failures include attachment progress for a saved request',async()=>{
 const repo=new LiveRepository({supabaseUrl:'https://example.supabase.co',publishableKey:'sb_publishable_public'},()=>({rpc:()=>({single:async()=>({error:new Error('Reservation denied')})})}));
 await assert.rejects(()=>repo.upload('ticket',[{name:'file.jpg',type:'image/jpeg',size:100}]),/0 of 1 attachments saved.*Reservation denied/);
});

test('PostgreSQL enforces authorization, immutable events, clocks and attachment ownership',async t=>{
 const db=new PGlite();
 try{
  await db.exec(`
   create role anon;create role authenticated;create role service_role bypassrls;
   create schema auth;create schema storage;
   create table auth.users(id uuid primary key,email text,phone text,encrypted_password text,role text default 'authenticated',recovery_token text default '',email_change text default '',phone_change text default '',confirmation_token text default '');
   create table auth.audit_log_entries(id uuid primary key default gen_random_uuid(),payload jsonb);
   create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
   create function auth.role() returns text language sql stable as $$ select current_setting('request.jwt.claim.role',true) $$;
   grant usage on schema public,auth,storage to anon,authenticated,service_role;
   grant execute on all functions in schema auth to anon,authenticated,service_role;
   create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
   create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text,name text,owner_id text default auth.uid()::text,metadata jsonb);
   alter table storage.objects enable row level security;
   grant select,insert,delete on storage.objects to authenticated;
   grant all on storage.objects,storage.buckets to service_role;
   create function storage.foldername(text) returns text[] language sql as $$ select string_to_array($1,'/') $$;
  `);
  let schema=await readFile(new URL('../schema.sql',import.meta.url),'utf8');
  schema=schema.replace('create extension if not exists pgcrypto;','-- gen_random_uuid is built into this PostgreSQL test runtime.');
  await db.exec(schema);
  const migration=await readFile(new URL('../migrations/20260930_secure_admin_staff.sql',import.meta.url),'utf8');
  await db.exec(migration); // Existing-database upgrade remains repeatable.
  const phoneMigration=await readFile(new URL('../migrations/20260930_phone_only_staff.sql',import.meta.url),'utf8');
  await db.exec(phoneMigration);await db.exec(phoneMigration);
  const contactMigration=await readFile(new URL('../migrations/20260930_staff_notification_email.sql',import.meta.url),'utf8');
  await db.exec(contactMigration);await db.exec(contactMigration);
  const accountMigration=await readFile(new URL('../migrations/20261005_admin_managed_accounts.sql',import.meta.url),'utf8');
  await db.exec(accountMigration);await db.exec(accountMigration);
  const requestAccessMigration=await readFile(new URL('../migrations/20261006_new_staff_request_access.sql',import.meta.url),'utf8');
  await db.exec(requestAccessMigration);await db.exec(requestAccessMigration);
  const cancellationMigration=await readFile(new URL('../migrations/20261007_notification_cancellation_reasons.sql',import.meta.url),'utf8');
  await db.exec(cancellationMigration);await db.exec(cancellationMigration);
  const chatMigration=await readFile(new URL('../migrations/20261009_team_chat.sql',import.meta.url),'utf8');
  await db.exec(chatMigration);await db.exec(chatMigration);
  const ids={admin:'00000000-0000-4000-8000-000000000001',a:'00000000-0000-4000-8000-000000000002',b:'00000000-0000-4000-8000-000000000003',unknown:'00000000-0000-4000-8000-000000000004'};
  const rows=(await db.query(`insert into public.team_users(auth_user_id,name,phone,email,role) values
   ($1,'Owner','+919900000001','owner@example.test','admin'),
   ($2,'Staff A','+919900000002',null,'staff'),
   ($3,'Staff B','+919900000003',null,'staff') returning *`,[ids.admin,ids.a,ids.b])).rows;
  const [admin,a,b]=rows;
  assert.equal(a.email,null);assert.equal(b.email,null);
  await db.query('update public.team_users set notification_email=$1 where id in ($2,$3)',['shared@example.test',a.id,b.id]);
  assert.equal((await db.query('select id from public.team_users where notification_email=$1',['shared@example.test'])).rows.length,2);
  await assert.rejects(()=>db.query("insert into public.team_users(name,phone,role,email) values('No email Admin','+919900000009','admin',null)"));
  const actor=async(name,role='authenticated')=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role',$2,false)",[ids[name]||'',role]);await db.exec('set role '+role);};
  const q=async(sql,args=[])=> (await db.query(sql,args)).rows;
  const rejected=async(sql,args=[])=>assert.rejects(()=>db.query(sql,args));
  const create=async(type,note,assigned=null,reminder=null)=> (await q('select * from public.create_request($1,$2,null,$3,$4)',[type,note,assigned,reminder]))[0];
  await t.test('Auth database rejects Staff password, login and recovery changes without same-transaction Admin evidence',async()=>{
   await db.query("insert into auth.users(id,email,phone,encrypted_password) values($1,'a@example.test','919900000002','old-hash')",[ids.a]);
   await rejected("update auth.users set encrypted_password='staff-changed' where id=$1",[ids.a]);
   await rejected("update auth.users set email='new@example.test' where id=$1",[ids.a]);
   await rejected("update auth.users set phone='919900000009' where id=$1",[ids.a]);
   await rejected("update auth.users set recovery_token='reset-token' where id=$1",[ids.a]);
   await rejected("update auth.users set email_change='new@example.test' where id=$1",[ids.a]);
   await rejected("update auth.users set role='service_role' where id=$1",[ids.a]);
   await rejected("update auth.users set confirmation_token='magic-link-token' where id=$1",[ids.a]);
   let reachedAfterTokenUpdate=false;
   await assert.rejects(()=>db.transaction(async tx=>{
    await tx.query("update auth.users set recovery_token='cannot-send-this' where id=$1",[ids.a]);reachedAfterTokenUpdate=true;
   }));assert.equal(reachedAfterTokenUpdate,false);
   const audit={action:'user_modified',actor_id:'00000000-0000-0000-0000-000000000000',actor_username:'service_role',traits:{user_id:ids.a}};
   await db.query('insert into auth.audit_log_entries(payload) values($1)',[audit]);
   await rejected("update auth.users set encrypted_password='reuse-old-audit' where id=$1",[ids.a]);
   await assert.rejects(()=>db.transaction(async tx=>{
    await tx.query("update auth.users set encrypted_password='wrong-target' where id=$1",[ids.a]);
    await tx.query('insert into auth.audit_log_entries(payload) values($1)',[{...audit,traits:{user_id:ids.b}}]);
   }));
   await db.transaction(async tx=>{
    await tx.query("update auth.users set encrypted_password='admin-changed',email='a2@example.test' where id=$1",[ids.a]);
    await tx.query('insert into auth.audit_log_entries(payload) values($1)',[audit]);
   });
   assert.equal((await q('select encrypted_password from auth.users where id=$1',[ids.a]))[0].encrypted_password,'admin-changed');
   assert.equal((await q('select email from public.team_users where id=$1',[a.id]))[0].email,'a2@example.test');
   await actor('a');await rejected('insert into auth.audit_log_entries(payload) values($1)',[audit]);
   await rejected('select * from public.save_managed_staff($1,$2,$3,$4,$5,$6,$7,$8)',[ids.admin,ids.a,'Staff A','+919900000002','a2@example.test',null,'Team','profile_updated']);
   await actor('', 'service_role');
   await rejected('select * from public.save_managed_staff($1,$2,$3,$4,$5,$6,$7,$8)',[ids.a,ids.a,'Staff A','+919900000002','a2@example.test',null,'Team','profile_updated']);
   await q('select * from public.save_managed_staff($1,$2,$3,$4,$5,$6,$7,$8)',[ids.admin,ids.a,'Staff A','+919900000002','a2@example.test',null,'Team','profile_updated']);
   await rejected("update public.account_events set action='forged'");
   await actor('a');assert.equal((await q('select * from public.account_events')).length,0);
   await actor('admin');assert.equal((await q('select * from public.account_events')).length,1);
   await db.exec('reset role');
  });
  await t.test('new Admin-created accounts can send requests without a separate activation step',async()=>{
   // Verify explicit activation even if an installation has a different default.
   await db.exec('reset role; alter table public.team_users alter column is_active set default false');
   await actor('', 'service_role');
   const member=(await q('select * from public.save_managed_staff($1,$2,$3,$4,$5,$6,$7,$8)',[ids.admin,ids.unknown,'New Staff','+919900000004','new@example.test',null,'Team','created']))[0];
   assert.equal(member.role,'staff');assert.equal(member.is_active,true);
   assert.deepEqual(allowedTypes(member),['service','help_ticket','follow_up']);
   await actor('unknown');
   const request=await create('help_ticket','First request from new account');
   assert.equal(request.created_by,ids.unknown);
   assert.equal((await q('select id from public.tickets where id=$1',[request.id])).length,1);
   const chatMessage=(await q('select * from public.send_team_message($1,$2)',['Hello from a new login',crypto.randomUUID()]))[0];
   assert.equal(chatMessage.sender_id,member.id);
   assert.equal((await q('select id from public.team_chat_messages where id=$1',[chatMessage.id])).length,1);
   await actor('', 'service_role');
   await q("insert into public.notifications(ticket_id,recipient_id,kind,dedupe_key) values($1,$2,'overdue','test-deactivation')",[request.id,member.id]);
   await q('select public.set_managed_staff_access($1,$2,false)',[ids.admin,member.id]);
   assert.equal((await q("select cancellation_reason from public.notifications where dedupe_key='test-deactivation'"))[0].cancellation_reason,'recipient_inactive');
   const updated=(await q('select * from public.save_managed_staff($1,$2,$3,$4,$5,$6,$7,$8)',[ids.admin,ids.unknown,'New Staff','+919900000004','new@example.test',null,'Team','profile_updated']))[0];
   assert.equal(updated.is_active,false);
   await actor('unknown');await rejected('select * from public.create_request($1,$2)',['help_ticket','Inactive request']);
   await db.exec('reset role; alter table public.team_users alter column is_active set default true');
  });
  await t.test('only Admin adds real client projects',async()=>{
   await actor('a');await rejected('select * from public.create_project($1,$2,$3,$4)',['Client','+919900003333','Site','Kolkata']);
   await actor('admin');
   const project=(await q('select * from public.create_project($1,$2,$3,$4)',['Client','+919900003333','Site','Kolkata']))[0];
   const service=(await q('select * from public.create_request($1,$2,$3,$4,null)',['service','Service visit',project.id,a.id]))[0];
   assert.equal(service.project_id,project.id);
   await rejected('select * from public.create_project($1,$2,$3,$4)',['Client','+919900003333','Site','Kolkata']);
   await rejected('select * from public.create_project($1,$2,$3,$4)',['Client','garbage','Other site','Kolkata']);
  });
  await actor('admin');const privateB=await create('help_ticket','Private assigned work',b.id);const shared=await create('help_ticket','Shared work');const urgent=await create('urgent_message','Dispatch needs confirmation',a.id);
  await actor('a');const mine=await create('help_ticket','Own work',a.id);
  await t.test('staff cannot forge assignments, urgent creation, snapshots or history',async()=>{
   await rejected('select * from public.create_request($1,$2,null,$3,null)',['urgent_message','Forged urgent',a.id]);
   await rejected('select * from public.create_request($1,$2,null,$3,null)',['help_ticket','Assign colleague',b.id]);
   await rejected('select * from public.assign_request($1,$2)',[mine.id,b.id]);
   await rejected('select * from public.record_request_update($1,$2,$3,$4)',[privateB.id,'Resolved','Fake update',null]);
   await rejected('update public.tickets set last_status_update_at=now() where id=$1',[mine.id]);
   await rejected('update public.team_users set role=$1 where id=$2',['admin',a.id]);
   await rejected('delete from public.request_events where ticket_id=$1',[mine.id]);
   await rejected('insert into public.request_events(ticket_id,event_type) values($1,$2)',[mine.id,'resolved']);
   const visible=await q('select id from public.tickets');
   assert(visible.some(row=>row.id===shared.id));assert(!visible.some(row=>row.id===privateB.id));
   assert.equal((await q('select * from public.team_users')).length,1);
  });
  await t.test('reads and acknowledgement do not reset the clock; only recipient acknowledges',async()=>{
   const before=(await q('select * from public.tickets where id=$1',[urgent.id]))[0];
   await q('select public.mark_request_read($1)',[urgent.id]);
   await q('select * from public.acknowledge_urgent($1)',[urgent.id]);
   await q('select * from public.acknowledge_urgent($1)',[urgent.id]);
   const after=(await q('select * from public.tickets where id=$1',[urgent.id]))[0];
   assert.deepEqual(after.next_followup_due_at,before.next_followup_due_at);
   assert(after.urgent_acknowledged_at);
   assert.equal((await q("select * from public.request_events where ticket_id=$1 and event_type='acknowledged'",[urgent.id])).length,1);
   await actor('b');await rejected('select * from public.acknowledge_urgent($1)',[urgent.id]);await actor('a');
  });
  await t.test('real workflow update, early resolution, reopening and reminder cancellation',async()=>{
   await rejected('select * from public.record_request_update($1,$2,$3,$4)',[mine.id,'Scheduled','Jump ahead','Tomorrow']);
   const update=(await q('select * from public.record_request_update($1,$2,$3,$4)',[mine.id,'In Review','Inspection booked','Tomorrow']))[0];
   assert.equal(Date.parse(update.next_followup_due_at)-Date.parse(update.last_status_update_at),86400000);
   const follow=await create('follow_up','Call client',null,new Date(Date.now()+3600000).toISOString());
   assert.equal(follow.assignee_id,a.id);
   await q('select * from public.record_request_update($1,$2,$3,$4)',[follow.id,'In Review','Waiting for client','Tomorrow']);
   assert.deepEqual((await q('select state,cancellation_reason from public.notifications where ticket_id=$1',[follow.id]))[0],{state:'queued',cancellation_reason:null});
   await q('select * from public.record_request_update($1,$2,$3,$4)',[follow.id,'Resolved','Client confirmed',null]);
   assert.deepEqual((await q('select state,cancellation_reason from public.notifications where ticket_id=$1',[follow.id]))[0],{state:'cancelled',cancellation_reason:'request_resolved'});
   await q('select * from public.record_request_update($1,$2,$3,$4)',[follow.id,'In Review','Client changed requirement','Tomorrow']);
   assert.equal((await q('select state from public.notifications where ticket_id=$1',[follow.id]))[0].state,'cancelled');
   assert((await q('select reminder_cancelled_at from public.tickets where id=$1',[follow.id]))[0].reminder_cancelled_at);
   // Simulate an older record; audit history still proves resolution after reopening.
   await db.exec('reset role');
   await q('update public.notifications set cancellation_reason=null where ticket_id=$1',[follow.id]);
   await db.exec(cancellationMigration);
   assert.equal((await q('select cancellation_reason from public.notifications where ticket_id=$1',[follow.id]))[0].cancellation_reason,'request_resolved');
   await actor('a');
  });
  await t.test('cancellation reasons distinguish reassignment and overdue resets, without guessing old causes',async()=>{
   await actor('admin');
   const request=await create('help_ticket','Cancellation history',a.id);
   await q('select * from public.assign_request($1,$2)',[request.id,b.id]);
   assert.equal((await q('select cancellation_reason from public.notifications where ticket_id=$1 and recipient_id=$2',[request.id,a.id]))[0].cancellation_reason,'assignment_changed');
   await actor('', 'service_role');
   await q("insert into public.notifications(ticket_id,recipient_id,kind,dedupe_key) values($1,$2,'overdue','test-overdue-reset')",[request.id,b.id]);
   await actor('b');
   await q('select * from public.record_request_update($1,$2,$3,$4)',[request.id,'In Review','Review started','Tomorrow']);
   assert.equal((await q("select cancellation_reason from public.notifications where dedupe_key='test-overdue-reset'"))[0].cancellation_reason,'request_updated');
   await actor('admin');
   await q('select * from public.record_request_update($1,$2,$3,$4)',[request.id,'Resolved','Finished',null]);
   await db.exec('reset role');
   // A resolved request today is not proof of an unrelated earlier cancellation.
   await q("insert into public.notifications(ticket_id,recipient_id,kind,state,processed_at,dedupe_key) values($1,$2,'follow_up_due','cancelled',now()-interval '1 day','test-unknown-cause')",[request.id,b.id]);
   await db.exec(cancellationMigration);
   assert.equal((await q("select cancellation_reason from public.notifications where dedupe_key='test-unknown-cause'"))[0].cancellation_reason,null);
   await actor('a');
  });
  let reservation;
  await t.test('attachments require reserved request access and matching stored metadata',async()=>{
   await rejected('select * from public.reserve_attachment($1,$2,$3,$4)',[privateB.id,'private.jpg','image/jpeg',100]);
   await rejected('select * from public.reserve_attachment($1,$2,$3,$4)',[mine.id,'huge.jpg','image/jpeg',10485761]);
   reservation=(await q('select * from public.reserve_attachment($1,$2,$3,$4)',[mine.id,'inspection.jpg','image/jpeg',100]))[0];
   await rejected('insert into public.attachments(ticket_id,storage_path,original_name,mime_type,byte_size,uploaded_by) values($1,$2,$3,$4,$5,$6)',[mine.id,'fake','fake.jpg','image/jpeg',100,ids.b]);
   await rejected('insert into storage.objects(bucket_id,name,metadata) values($1,$2,$3)',['service-photos','unreserved/file.jpg',JSON.stringify({size:100,mimetype:'image/jpeg'})]);
   await q('insert into storage.objects(bucket_id,name,metadata) values($1,$2,$3)',['service-photos',reservation.storage_path,JSON.stringify({size:100,mimetype:'image/jpeg'})]);
   await q('select * from public.finalize_attachment($1)',[reservation.id]);
   await q('select * from public.finalize_attachment($1)',[reservation.id]);
   assert.equal((await q('select * from public.attachments where ticket_id=$1',[mine.id])).length,1);
   const clock=(await q('select next_followup_due_at from public.tickets where id=$1',[mine.id]))[0];
   await actor('admin');await q('select * from public.assign_request($1,$2)',[mine.id,b.id]);
   assert.deepEqual((await q('select next_followup_due_at from public.tickets where id=$1',[mine.id]))[0],clock);
   // Original creator still sees its request, but linked files cannot be deleted.
   await actor('a');assert.equal((await q('delete from storage.objects where name=$1 returning id',[reservation.storage_path])).length,0);
  });
  await t.test('scanner deduplicates an inactivity cycle; worker RPCs are privileged',async()=>{
   await rejected('select * from public.claim_notification_batch(25)');
   await rejected('select public.enqueue_due_notifications()');
   await db.exec('reset role');await q("update public.tickets set next_followup_due_at=now()-interval '1 minute' where id=$1",[shared.id]);
   await actor('', 'service_role');await q('select public.enqueue_due_notifications()');await q('select public.enqueue_due_notifications()');
   assert.equal((await q("select * from public.notifications where ticket_id=$1 and kind='overdue'",[shared.id])).length,1);
   assert.equal((await q("select * from public.notifications where ticket_id=$1 and kind='overdue'",[shared.id]))[0].recipient_id,admin.id);
   assert.equal((await q("select * from public.request_events where ticket_id=$1 and event_type='overdue'",[shared.id])).length,1);
   await actor('admin');await q('select * from public.assign_request($1,$2)',[shared.id,a.id]);
   await actor('', 'service_role');await q('select public.enqueue_due_notifications()');
   assert.equal((await q("select * from public.notifications where ticket_id=$1 and kind='overdue'",[shared.id])).length,1);
  });
  await t.test('push endpoints cannot target local services or replace another active device',async()=>{
   const publicKey='A'.repeat(87),authKey='B'.repeat(22);
   await actor('a');
   await rejected('select public.register_push_subscription($1,$2,$3,null)',['https://localhost/private',publicKey,authKey]);
   await rejected('select public.register_push_subscription($1,$2,$3,null)',['https://fcmXgoogleapisXcom/private',publicKey,authKey]);
   await q('select public.register_push_subscription($1,$2,$3,null)',['https://fcm.googleapis.com/fcm/send/test-device',publicKey,authKey]);
   await actor('b');await rejected('select public.register_push_subscription($1,$2,$3,null)',['https://fcm.googleapis.com/fcm/send/test-device',publicKey,authKey]);
   await actor('a');await q('select public.revoke_push_subscription($1)',['https://fcm.googleapis.com/fcm/send/test-device']);
   await actor('b');await q('select public.register_push_subscription($1,$2,$3,null)',['https://fcm.googleapis.com/fcm/send/test-device',publicKey,authKey]);
  });
  await t.test('shared chat enforces sender identity, immutable messages, input limits and send throttling',async()=>{
   await actor('a');
   const nonce=crypto.randomUUID(),body='<img src=x onerror=alert(1)> Team update';
   const first=(await q('select * from public.send_team_message($1,$2)',[body,nonce]))[0];
   assert.equal(first.sender_id,a.id);assert.equal(first.body,body);
   assert.equal((await q('select * from public.send_team_message($1,$2)',[body,nonce]))[0].id,first.id);
   await rejected('select * from public.send_team_message($1,$2)',['Changed body',nonce]);
   for(const invalid of ['', ' \n\t ',null,'x'.repeat(2001)])await rejected('select * from public.send_team_message($1,$2)',[invalid,crypto.randomUUID()]);
   await rejected('select * from public.send_team_message($1,null)',['Missing ID']);
   await rejected('insert into public.team_chat_messages(sender_id,client_message_id,body) values($1,$2,$3)',[admin.id,crypto.randomUUID(),'Forged sender']);
   await rejected('update public.team_chat_messages set body=$1 where id=$2',['Tampered',first.id]);
   await rejected('delete from public.team_chat_messages where id=$1',[first.id]);
   await actor('b');assert.equal((await q('select body from public.team_chat_messages where id=$1',[first.id]))[0].body,body);
   await actor('admin');assert.equal((await q('select id from public.team_chat_messages where id=$1',[first.id])).length,1);
   await actor('a');
   for(let i=0;i<19;i++)await q('select * from public.send_team_message($1,$2)',['Message '+i,crypto.randomUUID()]);
   await assert.rejects(()=>q('select * from public.send_team_message($1,$2)',['Too many',crypto.randomUUID()]),/Too many messages/);
   // Retrying an already accepted send still succeeds after the limit, without duplication.
   assert.equal((await q('select * from public.send_team_message($1,$2)',[body,nonce]))[0].id,first.id);
   await actor('b');await q('select * from public.send_team_message($1,$2)',['Another person can still send',crypto.randomUUID()]);
  });
  await t.test('deactivation revokes existing-token data access and unlisted users fail closed',async()=>{
   await db.exec('reset role');await q('update public.team_users set is_active=false where id=$1',[b.id]);
   await actor('b');assert.equal((await q('select * from public.tickets')).length,0);
   assert.equal((await q('select * from public.team_chat_messages')).length,0);
   await rejected('select * from public.send_team_message($1,$2)',['Inactive sender',crypto.randomUUID()]);
   await rejected('select * from public.create_request($1,$2)',['help_ticket','Deactivated']);
   await actor('unknown');assert.equal((await q('select * from public.tickets')).length,0);await rejected('select * from public.staff_directory()');
   await actor('', 'anon');await rejected('select * from public.tickets');await rejected('select * from public.create_request($1,$2)',['help_ticket','Anonymous']);
   await rejected('select * from public.team_chat_messages');
   await rejected('select * from public.send_team_message($1,$2)',['Anonymous sender',crypto.randomUUID()]);
  });
 }finally{await db.close();}
});
