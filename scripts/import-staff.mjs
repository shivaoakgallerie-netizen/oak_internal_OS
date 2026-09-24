import {readFile} from 'node:fs/promises';
import {createClient} from '@supabase/supabase-js';

const [csvPath]=process.argv.slice(2);
if(!csvPath)throw new Error('Usage: npm run import:staff -- path/to/staff-roster.csv');
const url=process.env.SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY;
if(!url||!key)throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the process environment.');
const client=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
const parseLine=line=>{const values=[];let value='',quoted=false;for(let i=0;i<line.length;i++){const char=line[i];if(char==='"'&&line[i+1]==='"'){value+='"';i++}else if(char==='"')quoted=!quoted;else if(char===','&&!quoted){values.push(value.trim());value=''}else value+=char}values.push(value.trim());return values};
const lines=(await readFile(csvPath,'utf8')).replace(/^\uFEFF/,'').split(/\r?\n/).filter(Boolean);
const headers=parseLine(lines.shift()).map(value=>value.toLowerCase());
const required=['name','phone_e164','email','active'];for(const field of required)if(!headers.includes(field))throw new Error(`CSV is missing ${field}`);
const rows=lines.map((line,index)=>Object.fromEntries(headers.map((header,column)=>[header,parseLine(line)[column]??'']))).map((row,index)=>{
  if(!row.name)throw new Error(`Row ${index+2}: name is required`);if(!/^\+[1-9]\d{7,14}$/.test(row.phone_e164))throw new Error(`Row ${index+2}: invalid E.164 phone`);if(!/^\S+@\S+\.\S+$/.test(row.email))throw new Error(`Row ${index+2}: invalid email`);return {...row,active:/^(true|1|yes)$/i.test(row.active)};
});
const users=[];for(let page=1;;page++){const result=await client.auth.admin.listUsers({page,perPage:1000});if(result.error)throw result.error;users.push(...result.data.users);if(result.data.users.length<1000)break}
for(const row of rows){
  let authUser=users.find(user=>user.phone===row.phone_e164||user.email?.toLowerCase()===row.email.toLowerCase());
  if(!authUser){const created=await client.auth.admin.createUser({phone:row.phone_e164,email:row.email,phone_confirm:true,email_confirm:true,user_metadata:{name:row.name}});if(created.error)throw created.error;authUser=created.data.user}
  const updated=await client.auth.admin.updateUserById(authUser.id,{phone:row.phone_e164,email:row.email,phone_confirm:true,email_confirm:true,user_metadata:{...authUser.user_metadata,name:row.name},ban_duration:row.active?'none':'876000h'});if(updated.error)throw updated.error;
  const roster=await client.from('team_users').upsert({auth_user_id:authUser.id,name:row.name,phone:row.phone_e164,email:row.email,is_active:row.active},{onConflict:'phone'});if(roster.error)throw roster.error;
  if(!row.active){const staff=await client.from('team_users').select('id').eq('phone',row.phone_e164).single();if(staff.data)await client.from('push_subscriptions').update({revoked_at:new Date().toISOString()}).eq('team_user_id',staff.data.id)}
  console.log(`${row.active?'Activated':'Deactivated'} ${row.name} (${row.phone_e164})`);
}
