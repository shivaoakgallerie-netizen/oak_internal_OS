// Trusted local operator utility. Generates setup links without sending email.
// Links are credentials: keep the private backups file off the public host.
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createClient} from '@supabase/supabase-js';
import {parseStaffRoster,rosterLoginEmail} from './staff-roster.mjs';
try{process.loadEnvFile('.env');}catch(error){if(error.code!=='ENOENT')throw error;}
const [csvPath,...args]=process.argv.slice(2);
if(!csvPath)throw new Error('Usage: npm run setup:staff-passwords -- staff-roster.csv --app-url http://localhost:8080/');
const index=args.indexOf('--app-url');
const appUrl=new URL(index>=0?args[index+1]:process.env.APP_URL);
if(appUrl.protocol!=='https:'&&!(appUrl.protocol==='http:'&&['localhost','127.0.0.1'].includes(appUrl.hostname)))throw new Error('Use HTTPS or a local development URL.');
if(appUrl.hostname.includes('YOUR-')||appUrl.username||appUrl.password)throw new Error('Set the actual app URL without credentials.');
const redirectTo=new URL('?setup=1',appUrl).href;
const url=process.env.SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY;
if(!url||!key)throw new Error('Set server-only Supabase credentials locally.');
const client=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
const check=result=>{if(result.error)throw result.error;return result.data;};
const rows=parseStaffRoster(await readFile(csvPath,'utf8')).filter(row=>row.role==='staff'&&row.active&&rosterLoginEmail(row));
if(!rows.length)throw new Error('No active Staff email logins in the roster.');
// Preflight every identity before generating a credential for any account.
const members=check(await client.from('team_users').select('id,auth_user_id,name,phone,email,role,is_active'));
const planned=[];
for(const row of rows){
 const email=rosterLoginEmail(row);
 const member=members.find(user=>user.phone===row.phone_e164);
 if(!member?.is_active||member.role!=='staff'||member.email!==email||!member.auth_user_id)throw new Error(row.name+': import the email-enabled Staff account first.');
 const user=check(await client.auth.admin.getUserById(member.auth_user_id)).user;
 if(user.email!==email||user.phone?.replace(/^\+/,'')!==row.phone_e164.slice(1))throw new Error(row.name+': Auth and roster identities do not match.');
 planned.push({row,member,email});
}
const directory=resolve('backups');await mkdir(directory,{recursive:true});
const file=resolve(directory,'staff-password-links-'+Date.now()+'.secret');
const output=[];
for(const {row,member,email} of planned){
 const data=check(await client.auth.admin.generateLink({type:'recovery',email,options:{redirectTo}}));
 if(data.user?.id!==member.auth_user_id||!data.properties?.action_link)throw new Error(row.name+': unexpected setup-link identity.');
 const link=new URL(data.properties.action_link);
 if(link.origin!==new URL(url).origin||link.searchParams.get('redirect_to')!==redirectTo)throw new Error('Add the exact password setup URL to Supabase Auth redirects before generating links.');
 output.push({name:row.name,email,auth_user_id:member.auth_user_id,url:link.href});
 // Persist partial progress privately if a subsequent provider call fails.
 await writeFile(file,JSON.stringify({created_at:new Date().toISOString(),redirectTo,links:output},null,2),{mode:0o600});
}
console.log('Generated '+output.length+' private Staff setup links. No email sent.');
console.log('Private file: '+file);
