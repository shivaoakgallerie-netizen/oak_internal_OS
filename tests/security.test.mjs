import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {normalizePhone,validatePublicConfig,allowedTypes,canUpdate,canView,canAcknowledge} from '../workflow-rules.js';
import {LiveRepository} from '../live-client.js';
import {parseStaffRoster,staffAuthFields,planRosterIdentity} from '../scripts/staff-roster.mjs';

test('phone-only roster keeps two distinct identities without fake email or passwords',()=>{
 const header='name,phone_e164,email,role,active\n';
 const rows=parseStaffRoster(header+'First,+919900001111,,staff,true\nSecond,+919900001112,,staff,true');
 assert.equal(rows.length,2);assert.equal(rows[0].email,null);assert.equal(rows[1].email,null);
 assert.throws(()=>parseStaffRoster(header+'Admin,+919900001111,,admin,true'),/Admin requires/);
 assert.throws(()=>parseStaffRoster(header+'First,+919900001111,,staff,true\nSecond,+919900001111,,staff,true'),/Duplicate/);
 assert.equal(parseStaffRoster('name,phone_e164,role,active\nFirst,+919900001111,staff,true')[0].email,null);
});

test('phone OTP never self-registers and rejects unlisted or inactive verified identities',async()=>{
 const calls=[];let allowed=true,logoutCount=0;
 const fake={auth:{signInWithOtp:async args=>{calls.push(args);return {data:{}};},verifyOtp:async args=>{calls.push(args);return {data:{}};},getUser:async()=>({data:{user:{id:'verified-auth'}}}),signOut:async()=>{logoutCount++;return {data:{}};}},from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:allowed?{id:'staff',role:'staff',is_active:true,email:null}:null})})})})};
 const repo=new LiveRepository({supabaseUrl:'https://example.supabase.co',publishableKey:'sb_publishable_public'},()=>fake);
 assert.equal(await repo.requestPhoneOtp('9900001111','captcha-test'),'+919900001111');
 assert.equal(calls[0].options.shouldCreateUser,false);assert.equal(calls[0].options.channel,'sms');assert.equal(calls[0].options.captchaToken,'captcha-test');assert.equal('email' in calls[0],false);
 await assert.rejects(()=>repo.verifyPhoneOtp('9900001111','bad'),/numeric code/);
 assert.equal((await repo.verifyPhoneOtp('9900001111','123456')).email,null);
 assert.equal(calls[1].type,'sms');
 allowed=false;await assert.rejects(()=>repo.verifyPhoneOtp('9900001111','123456'),/active staff roster/);assert.equal(logoutCount,1);
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

test('an authenticated user changes their own password only after supplying the current password',async()=>{
 let submitted;
 const fake={auth:{updateUser:async args=>{submitted=args;return {data:{}};}}};
 const repo=new LiveRepository({supabaseUrl:'https://example.supabase.co',publishableKey:'sb_publishable_public'},()=>fake);
 await assert.rejects(()=>repo.changePassword('','new-password-123'),/current password/);
 await assert.rejects(()=>repo.changePassword('old-password','short'),/at least 12/);
 await repo.changePassword('old-password','new-password-123');
 assert.deepEqual(submitted,{password:'new-password-123',current_password:'old-password'});
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

test('PostgreSQL enforces authorization, immutable events, clocks and attachment ownership',async t=>{
 const db=new PGlite();
 try{
  await db.exec(`
   create role anon;create role authenticated;create role service_role bypassrls;
   create schema auth;create schema storage;
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
   await q('select * from public.record_request_update($1,$2,$3,$4)',[follow.id,'Resolved','Client confirmed',null]);
   assert.equal((await q('select state from public.notifications where ticket_id=$1',[follow.id]))[0].state,'cancelled');
   await q('select * from public.record_request_update($1,$2,$3,$4)',[follow.id,'In Review','Client changed requirement','Tomorrow']);
   assert.equal((await q('select state from public.notifications where ticket_id=$1',[follow.id]))[0].state,'cancelled');
   assert((await q('select reminder_cancelled_at from public.tickets where id=$1',[follow.id]))[0].reminder_cancelled_at);
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
  await t.test('deactivation revokes existing-token data access and unlisted users fail closed',async()=>{
   await db.exec('reset role');await q('update public.team_users set is_active=false where id=$1',[b.id]);
   await actor('b');assert.equal((await q('select * from public.tickets')).length,0);
   await rejected('select * from public.create_request($1,$2)',['help_ticket','Deactivated']);
   await actor('unknown');assert.equal((await q('select * from public.tickets')).length,0);await rejected('select * from public.staff_directory()');
   await actor('', 'anon');await rejected('select * from public.tickets');await rejected('select * from public.create_request($1,$2)',['help_ticket','Anonymous']);
  });
 }finally{await db.close();}
});
