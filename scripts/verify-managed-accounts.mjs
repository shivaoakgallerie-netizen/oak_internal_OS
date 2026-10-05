// Operator-only hosted smoke test. Uses disposable identities and keeps their
// passwords in memory; no real employee credentials are read or changed.
import {createClient} from '@supabase/supabase-js';
import {randomBytes} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createInterface} from 'node:readline/promises';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
process.loadEnvFile('.env');
const config={window:{}};runInNewContext(await readFile('config.js','utf8'),config);
const url=process.env.SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY;
if(url!=='https://ochtkcazmudyhtxjnjmf.supabase.co'||!key)throw Error('Expected the configured Oak Supabase project.');
const options={auth:{persistSession:false,autoRefreshToken:false}},server=createClient(url,key,options);
const publicClient=()=>createClient(url,config.window.OAK_CONFIG.publishableKey,options);
const checked=result=>{if(result.error)throw result.error;return result.data;};
if(process.argv.includes('--check-endpoint')){
 const endpoint=url+'/functions/v1/manage-staff';
 for(const origin of ['http://localhost:8080','https://cerulean-youtiao-fd7466.netlify.app']){
  const response=await fetch(endpoint,{method:'OPTIONS',headers:{origin,'access-control-request-method':'POST','access-control-request-headers':'authorization,apikey,content-type'}});
  assert.equal(response.status,204);assert.equal(response.headers.get('access-control-allow-origin'),origin);
  console.log('PASS: Browser preflight allowed for '+origin);
 }
 assert.equal((await fetch(endpoint,{method:'OPTIONS',headers:{origin:'https://unapproved.example'}})).status,403);
 assert.equal((await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
 console.log('PASS: Unapproved origins and unauthenticated calls rejected.');
 process.exit(0);
}
const password=()=>randomBytes(24).toString('base64url');
const stamp=Date.now(),fixtures=[],sessions=[];
let staff,admin,staffPassword=password(),adminPassword=password();
try{
 const tables=['team_users','clients','projects','tickets','request_events','attachments','notifications','delivery_attempts','push_subscriptions','worker_runs','attachment_uploads'];
 const snapshot={created_at:new Date().toISOString(),project:url,tables:{}};
 for(const table of tables){const rows=[];for(let from=0;;from+=500){const batch=checked(await server.from(table).select('*').order('id').range(from,from+499));rows.push(...batch);if(batch.length<500)break;}snapshot.tables[table]=rows;}
 await mkdir('backups',{recursive:true});const path='backups/before-managed-accounts-'+stamp+'.json';await writeFile(path,JSON.stringify(snapshot,null,2));
 console.log(JSON.stringify({snapshot:path,counts:Object.fromEntries(tables.map(name=>[name,snapshot.tables[name].length]))}));
 for(const [role,phone,secret] of [['staff','+12025550197',staffPassword],['admin','+12025550198',adminPassword]]){
  const email='oak-credential-test-'+role+'-'+stamp+'@example.invalid';
  const user=checked(await server.auth.admin.createUser({email,password:secret,email_confirm:true,phone,phone_confirm:true})).user;
  const fixture={user,role,phone,email};fixtures.push(fixture);
  fixture.member=checked(await server.from('team_users').insert({auth_user_id:user.id,name:'[TEMPORARY TEST] '+role,role,phone,email,department:'System verification'}).select().single());
  if(role==='staff')staff=fixture;else admin=fixture;
 }
 // Generate a real Admin audit record before installing the database guard.
 checked(await server.auth.admin.updateUserById(staff.user.id,{password:staffPassword}));
 console.log(JSON.stringify({ready:true,testStaffAuthId:staff.user.id,testAdminAuthId:admin.user.id}));
 if(process.argv.includes('--wait-for-install')){
  const input=createInterface({input:process.stdin,output:process.stdout});
  const answer=await input.question('Apply migration and deploy manage-staff, then type verify: ');input.close();
  if(answer.trim()!=='verify')throw Error('Verification cancelled.');
 }
 const staffClient=publicClient();sessions.push(staffClient);
 checked(await staffClient.auth.signInWithPassword({email:staff.email,password:staffPassword}));
 console.log('PASS: Staff password login remains available.');
 const denied=async(label,action)=>{const result=await action();assert(result.error,label+' must be rejected');console.log('PASS: '+label+' rejected.');};
 await denied('Staff password update',()=>staffClient.auth.updateUser({password:password(),current_password:staffPassword}));
 await denied('Staff email update',()=>staffClient.auth.updateUser({email:'changed-'+staff.email}));
 await denied('Staff phone update',()=>staffClient.auth.updateUser({phone:'+12025550196'}));
 await denied('Staff password recovery',()=>staffClient.auth.resetPasswordForEmail(staff.email));
 await denied('Staff account-management call',()=>staffClient.functions.invoke('manage-staff',{body:{action:'create',currentPassword:staffPassword}}));
 const newPassword=password();checked(await server.auth.admin.updateUserById(staff.user.id,{password:newPassword}));
 console.log('PASS: Auth Admin API password reset succeeds with the guard enabled.');
 const newLogin=publicClient();sessions.push(newLogin);
 checked(await newLogin.auth.signInWithPassword({email:staff.email,password:newPassword}));
 await denied('Previous password login',()=>publicClient().auth.signInWithPassword({email:staff.email,password:staffPassword}));
 const adminClient=publicClient();sessions.push(adminClient);
 checked(await adminClient.auth.signInWithPassword({email:admin.email,password:adminPassword}));
 const wrong=await adminClient.functions.invoke('manage-staff',{body:{action:'update',id:staff.member.id,currentPassword:'incorrect-admin-password'}});
 assert(wrong.error);console.log('PASS: Wrong Admin password rejected by hosted endpoint.');
 // A missing target causes no mutation. Its provider error proves successful
 // Admin role and current-password checks without creating persistent events.
 const verified=await adminClient.functions.invoke('manage-staff',{body:{action:'update',id:'00000000-0000-4000-8000-000000000999',currentPassword:adminPassword}});
 assert(verified.error);
 const body=await verified.error.context?.json();
 assert(body?.error&&!/Unauthorized|Only active Admin|Invalid login|could not be verified/i.test(body.error));
 console.log('PASS: Hosted endpoint verifies the current Admin password.');
 console.log('HOSTED ACCOUNT GUARD VERIFIED.');
}finally{
 for(const client of sessions)await client.auth.signOut({scope:'local'}).catch(()=>{});
 for(const fixture of fixtures.reverse()){
  if(fixture.member)checked(await server.from('team_users').delete().eq('id',fixture.member.id));
  checked(await server.auth.admin.deleteUser(fixture.user.id));
 }
 console.log('Temporary test accounts removed. Real staff credentials were not changed.');
}
