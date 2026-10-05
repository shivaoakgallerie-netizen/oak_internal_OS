import {readFile} from 'node:fs/promises';
import {createClient} from '@supabase/supabase-js';
import {parseStaffRoster,staffAuthFields,planRosterIdentity,rosterLoginEmail} from './staff-roster.mjs';
try{process.loadEnvFile('.env');}catch(error){if(error.code!=='ENOENT')throw error;}
const [csvPath,...flags]=process.argv.slice(2);
if(!csvPath)throw new Error('Usage: npm run import:staff -- staff-roster.csv [--dry-run]');
if(flags.some(flag=>flag!=='--dry-run'))throw new Error('Only --dry-run is supported. Admin manages passwords in the app; setup links have been removed.');
const dry=flags.includes('--dry-run');
const url=process.env.SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY;
if(!dry&&(!url||!key||/replace|__|your-project/i.test(url+key)))throw new Error('Set the server-only SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY locally. Never add them to browser files.');
const rows=parseStaffRoster(await readFile(csvPath,'utf8'));
if(dry){console.log('Validated '+rows.length+' staff rows. No accounts or messages changed.');process.exit(0);}
const client=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
const check=result=>{if(result.error)throw result.error;return result.data;};
const users=[];for(let page=1;;page++){const list=check(await client.auth.admin.listUsers({page,perPage:1000})).users;users.push(...list);if(list.length<1000)break;}
const existingRoster=check(await client.from('team_users').select('id,auth_user_id,phone,email,role,is_active'));
// Verify the migration before creating any Auth identities.
const schemaReady=await client.from('team_users').select('notification_email').limit(0);
if(schemaReady.error)throw new Error('Apply migrations/20260930_staff_notification_email.sql before importing. No accounts changed.');
const planned=rows.map(row=>planRosterIdentity(row,users,existingRoster));
const finalAdmins=new Set(existingRoster.filter(u=>u.role==='admin'&&u.is_active).map(u=>u.id));
for(const {row,roster} of planned){if(roster)finalAdmins.delete(roster.id);if(row.active&&row.role==='admin')finalAdmins.add(roster?.id||row.phone_e164);}
if(!finalAdmins.size)throw new Error('The roster must retain an active Admin.');
// Validate all deactivations before changing any accounts.
for(const {row,roster} of planned)if(!row.active&&roster){
 const work=check(await client.from('tickets').select('id').eq('assignee_id',roster.id).neq('status','Resolved').limit(1));
 if(work.length)throw new Error(row.name+': reassign or resolve open work before deactivation');
}
for(const item of planned){
 const {row,roster}=item;let user=item.user;
 if(!user){
  user=check(await client.auth.admin.createUser(staffAuthFields(row,true))).user;
  users.push(user); // Generated password is never logged, stored in files or shared.
 }
 // Removing roster access first fails closed if a later provider call fails.
 if(!row.active&&roster)check(await client.from('team_users').update({is_active:false}).eq('id',roster.id));
 user=check(await client.auth.admin.updateUserById(user.id,{...staffAuthFields(row),ban_duration:row.active?'none':'876000h'})).user;
 const values={auth_user_id:user.id,name:row.name,phone:row.phone_e164,email:user.email||null,notification_email:row.email,role:row.role,department:row.department,is_active:row.active};
 const member=check(await client.from('team_users').upsert(roster?{...values,id:roster.id}:values,{onConflict:roster?'id':'auth_user_id'}).select('id').single());
 if(!row.active){
  check(await client.from('push_subscriptions').update({revoked_at:new Date().toISOString()}).eq('team_user_id',member.id));
  check(await client.from('notifications').update({state:'cancelled',processed_at:new Date().toISOString()}).eq('recipient_id',member.id).in('state',['queued','processing','failed']));
 }
 const loginEmail=rosterLoginEmail(row);
 console.log((row.active?'Activated ':'Deactivated ')+row.name+' ('+row.role+')'+(row.role==='staff'?' · '+(loginEmail?'email login '+loginEmail:'login email missing')+'; notification email '+(row.email||'not set'):''));
}
