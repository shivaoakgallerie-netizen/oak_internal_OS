// Auth Admin calls stay on the server. Never log request bodies or passwords.
const check=result=>{if(result.error)throw result.error;return result.data;};
const validEmail=value=>typeof value==='string'&&value.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const safeMessages=new Set([
 'Unauthorized','Only active Admin can manage accounts','Invalid account action',
 'Enter your current Admin password.','Admin password could not be verified.',
 'Select a valid staff account.','Select a registered Staff account.',
 'Choose active or inactive.','Enter a staff name, valid login email and phone with country code.',
 'Choose the initial staff password.','Use a password with at least 12 characters and at most 72 UTF-8 bytes.',
 'Database access was updated, but Auth login access could not be synchronized. Ask the operator to retry the same access setting.',
 'Account setup did not complete. Contact the operator to remove an unlinked Auth account before retrying.',
 'Login changes saved, but staff details could not be saved. Refresh and check the account before retrying.'
]);
export function safeAccountFailure(error){
 const message=error instanceof Error?error.message:'';
 if(message==='Request too large')return {message,status:413};
 if(error instanceof SyntaxError)return {message:'Invalid request body.',status:400};
 if(message==='Invalid login credentials'||message==='Email not confirmed')return {message:'Admin password could not be verified.',status:401};
 if(!safeMessages.has(message))return {message:'Account management is unavailable. Contact the operator if this continues.',status:500};
 return {message,status:message==='Unauthorized'||message==='Admin password could not be verified.'?401:message==='Only active Admin can manage accounts'?403:400};
}
export async function manageStaff({client,reauthClient,token,input}) {
 const actor=check(await client.auth.getUser(token))?.user;
 if(!actor)throw new Error('Unauthorized');
 const admin=check(await client.from('team_users').select('id,role,is_active').eq('auth_user_id',actor.id).maybeSingle());
 if(!admin?.is_active||admin.role!=='admin')throw new Error('Only active Admin can manage accounts');
 if(!['create','update','access'].includes(input?.action))throw new Error('Invalid account action');
 if(!input.currentPassword||typeof input.currentPassword!=='string')throw new Error('Enter your current Admin password.');
 const verified=check(await reauthClient.auth.signInWithPassword({email:actor.email,password:input.currentPassword,options:input.captchaToken?{captchaToken:input.captchaToken}:undefined}))?.user;
 if(verified?.id!==actor.id)throw new Error('Admin password could not be verified.');
 let target;
 if(input.action!=='create'){
  if(typeof input.id!=='string'||!/^([0-9a-f]{8}-)([0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(input.id))throw new Error('Select a valid staff account.');
  target=check(await client.from('team_users').select('*').eq('id',input.id).single());
  if(target.role!=='staff'||!target.auth_user_id)throw new Error('Select a registered Staff account.');
 }
 if(input.action==='access'){
  if(typeof input.active!=='boolean')throw new Error('Choose active or inactive.');
  // This RPC rechecks actor and open assignments under a database lock.
  check(await client.rpc('set_managed_staff_access',{p_actor:actor.id,p_team_user_id:target.id,p_active:input.active}));
  const ban=await client.auth.admin.updateUserById(target.auth_user_id,{ban_duration:input.active?'none':'876000h'});
  if(ban.error)throw new Error('Database access was updated, but Auth login access could not be synchronized. Ask the operator to retry the same access setting.');
  return {id:target.id};
 }
 const email=String(input.email||'').trim().toLowerCase(),phone=String(input.phone||'').trim();
 const name=String(input.name||'').trim(),department=String(input.department||'Team').trim();
 const notificationEmail=String(input.notificationEmail||'').trim().toLowerCase();
 if(!name||name.length>200||department.length>200||!validEmail(email)||!/^\+[1-9]\d{7,14}$/.test(phone)||notificationEmail&&!validEmail(notificationEmail))throw new Error('Enter a staff name, valid login email and phone with country code.');
 const password=input.password;
 if(input.action==='create'&&!password)throw new Error('Choose the initial staff password.');
 if(password&&(typeof password!=='string'||password.length<12||new TextEncoder().encode(password).length>72))throw new Error('Use a password with at least 12 characters and at most 72 UTF-8 bytes.');
 const fields={email,phone,email_confirm:true,phone_confirm:true,...(password?{password}:{})};
 let authUser;
 if(input.action==='create')authUser=check(await client.auth.admin.createUser(fields)).user;
 else authUser=check(await client.auth.admin.updateUserById(target.auth_user_id,fields)).user;
 try {
  const result=check(await client.rpc('save_managed_staff',{p_actor:actor.id,p_auth_user_id:authUser.id,p_name:name,p_phone:phone,p_email:email,p_notification_email:notificationEmail||null,p_department:department,p_action:input.action==='create'?'created':password?'password_reset':'profile_updated'}));
  return {id:result.id};
 } catch(error) {
  if(input.action==='create'){
   const removed=await client.auth.admin.deleteUser(authUser.id);
   if(removed.error)throw new Error('Account setup did not complete. Contact the operator to remove an unlinked Auth account before retrying.');
   throw error;
  }
  throw new Error('Login changes saved, but staff details could not be saved. Refresh and check the account before retrying.');
 }
}
