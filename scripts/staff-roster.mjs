import {randomBytes} from 'node:crypto';
// Staff email is a notification address. Optional auth_email is a unique login
// address (including a shared-inbox alias), never inferred from notifications.
export const rosterLoginEmail=row=>row.role==='admin'?row.email:row.auth_email||null;
export function parseStaffRoster(csv) {
 const parseLine=line=>{const values=[];let value='',quoted=false;for(let i=0;i<line.length;i++){const ch=line[i];if(ch==='"'&&quoted&&line[i+1]==='"'){value+='"';i++;}else if(ch==='"')quoted=!quoted;else if(ch===','&&!quoted){values.push(value.trim());value='';}else value+=ch;}if(quoted)throw new Error('Unclosed CSV quote. Multiline fields are not supported.');values.push(value.trim());return values;};
 const lines=csv.replace(/^\uFEFF/,'').split(/\r?\n/).filter(line=>line.trim());
 const headers=parseLine(lines.shift()||'').map(v=>v.toLowerCase());
 for(const field of ['name','phone_e164','role','active'])if(!headers.includes(field))throw new Error('CSV is missing '+field);
 if(new Set(headers).size!==headers.length)throw new Error('Duplicate roster column');
 if(headers.some(field=>/password|secret|token/i.test(field)))throw new Error('Do not put passwords or secrets in the staff roster.');
 const phones=new Set(),loginEmails=new Set();
 return lines.map((line,index)=>{
  const values=parseLine(line);if(values.length!==headers.length)throw new Error('Row '+(index+2)+': incorrect field count');
  const row=Object.fromEntries(headers.map((h,i)=>[h,values[i]]));row.email=row.email?.toLowerCase()||null;row.auth_email=row.auth_email?.toLowerCase()||null;
  if(!row.name||!/^\+[1-9]\d{7,14}$/.test(row.phone_e164)||[row.email,row.auth_email].some(email=>email&&!/^\S+@\S+\.\S+$/.test(email)))throw new Error('Row '+(index+2)+': name, E.164 phone and valid email when supplied required');
  if(!['admin','staff'].includes(row.role)||!/^(true|false|1|0|yes|no)$/i.test(row.active))throw new Error('Row '+(index+2)+': invalid role or active value');
  const active=/^(true|1|yes)$/i.test(row.active);
  if(row.role==='admin'&&active&&!row.email)throw new Error('Active Admin requires an email for password recovery');
  if(row.role==='admin'&&row.auth_email&&row.auth_email!==row.email)throw new Error('Admin auth_email must match email or be left blank');
  const loginEmail=rosterLoginEmail(row);
  if(phones.has(row.phone_e164)||(loginEmail&&loginEmails.has(loginEmail)))throw new Error('Duplicate phone or Admin/Staff login email in roster');
  phones.add(row.phone_e164);if(loginEmail)loginEmails.add(loginEmail);
  return {...row,active,department:row.department||'Team'};
 });
}

export function staffAuthFields(row,newAccount=false) {
 const email=rosterLoginEmail(row);
 return {phone:row.phone_e164,phone_confirm:true,...(email?{email,email_confirm:true,...(newAccount?{password:randomBytes(48).toString('base64url')}:{})}:{})};
}

export function planRosterIdentity(row,users,existingRoster) {
 const byPhone=users.find(u=>u.phone?.replace(/^\+/,'')===row.phone_e164.slice(1));
 const email=rosterLoginEmail(row);
 const byEmail=email?users.find(u=>u.email?.toLowerCase()===email):undefined;
 if(byPhone&&byEmail&&byPhone.id!==byEmail.id)throw new Error(row.name+': phone and email belong to different Auth accounts. Resolve this before importing.');
 const user=byPhone||byEmail;
 const rosterByPhone=existingRoster.find(u=>u.phone===row.phone_e164);
 const rosterByEmail=email?existingRoster.find(u=>u.email?.toLowerCase()===email):undefined;
 if(rosterByPhone&&rosterByEmail&&rosterByPhone.id!==rosterByEmail.id)throw new Error(row.name+': phone and email belong to different roster records');
 const roster=rosterByPhone||rosterByEmail;
 if(roster?.auth_user_id&&!users.some(u=>u.id===roster.auth_user_id))throw new Error(row.name+': the linked Auth account is missing. Resolve its identity before importing.');
 if(roster&&user&&roster.auth_user_id&&roster.auth_user_id!==user.id)throw new Error(row.name+': roster/Auth identity conflict');
 return {row,user,roster};
}
