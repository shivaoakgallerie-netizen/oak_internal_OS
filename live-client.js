import {normalizePhone,validatePublicConfig} from './workflow-rules.js';

function checked(result) { if(result.error)throw result.error; return result.data; }
export class LiveRepository {
  constructor(config,createClient=globalThis.supabase?.createClient) {
    const {url,key}=validatePublicConfig(config);
    if (!createClient) throw new Error('The authentication library could not load. Reload the application.');
    this.client=createClient(url,key,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true,storage:globalThis.sessionStorage,storageKey:'oak-auth-session'}});
  }
  async login(phone,password,captchaToken) {
    if(!password)throw new Error('Enter your password.');
    const identity=String(phone||'').includes('@')?{email:String(phone).trim().toLowerCase()}:{phone:normalizePhone(phone)};
    checked(await this.client.auth.signInWithPassword({...identity,password,options:captchaToken?{captchaToken}:undefined}));
    try {return await this.profile();}
    catch(error){await this.logout().catch(()=>{});throw error;}
  }
  async profile() {
    const auth=checked(await this.client.auth.getUser());
    if(!auth?.user)throw new Error('Sign in to continue.');
    const user=checked(await this.client.from('team_users').select('*').eq('auth_user_id',auth.user.id).maybeSingle());
    if(!user?.is_active || !['admin','staff'].includes(user.role))throw new Error('Your account is not on the active staff roster. Contact the administrator.');
    return user;
  }
  async load() {
    const currentUser=await this.profile();
    const names=['clients','projects','tickets','request_events','attachments','notifications','delivery_attempts'];
    // Pagination avoids silently hiding requests at Supabase's default 1,000-row limit.
    const paged=async table=>{const rows=[];for(let page=0;;page++){const data=checked(await this.client.from(table).select('*').order('id').range(page*500,page*500+499));rows.push(...data);if(data.length<500)return rows;}};
    const [directory,...rows]=await Promise.all([this.rpc('staff_directory'),...names.map(paged)]);
    const values=Object.fromEntries(names.map((name,index)=>[name,rows[index]]));
    let team=directory;
    if(currentUser.role==='admin')team=await paged('team_users');
    else team=team.map(person=>person.id===currentUser.id?{...person,...currentUser}:person);
    const workerRuns=currentUser.role==='admin'?checked(await this.client.from('worker_runs').select('*').order('started_at',{ascending:false}).limit(50)):[];
    return {currentUser,state:{clients:values.clients,team,projects:values.projects,tickets:values.tickets,events:values.request_events,attachments:values.attachments,notifications:values.notifications,deliveries:values.delivery_attempts,workerRuns}};
  }
  async rpc(name,args={}) { return checked(await this.client.rpc(name,args)); }
  async record(name,args) {return checked(await this.client.rpc(name,args).single());}
  async chatMessages({before,after}={}) {
    let query=this.client.from('team_chat_messages').select('id,sender_id,body,created_at');
    if(before!==undefined)query=query.lt('id',before);
    if(after!==undefined)query=query.gt('id',after);
    const rows=checked(await query.order('id',{ascending:after!==undefined}).limit(50));
    return after!==undefined?rows:rows.reverse();
  }
  sendChatMessage(body,clientMessageId) {
    return this.record('send_team_message',{p_body:body,p_client_message_id:clientMessageId});
  }
  chatRevision() {
    return this.client.from('team_chat_state').select('clear_revision').eq('id',1).maybeSingle().then(result=>{
      if(['42P01','PGRST205'].includes(result.error?.code))return null;
      return checked(result);
    });
  }
  clearChatHistory() {
    return this.rpc('clear_team_chat');
  }
  watchChat(onChange,onStatus) {
    const channel=this.client.channel('oak-team-chat')
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'team_chat_messages'},onChange)
      .on('postgres_changes',{event:'UPDATE',schema:'public',table:'team_chat_state'},onChange)
      .subscribe(onStatus);
    return ()=>this.client.removeChannel(channel);
  }
  create(input) {return this.record('create_request',{p_type:input.type,p_note:input.note,p_project_id:input.project_id,p_assignee_id:input.assignee_id,p_reminder_at:input.reminder_at});}
  async createWithAttachments(input,files=[],onProgress=()=>{}) {
    const ticket=await this.create(input);
    try {if(files.length)await this.upload(ticket.id,files,onProgress);}
    catch(error) {
      const failure=new Error('Request saved (ID: '+ticket.id+'), but its attachments could not all be saved. '+(error.message||'Upload failed.'));
      failure.savedRequest=ticket;
      throw failure;
    }
    return ticket;
  }
  update(id,input) {return this.record('record_request_update',{p_ticket_id:id,p_new_status:input.status,p_note:input.note||null,p_expected_timeline:input.expected_timeline||null});}
  assign(id,assigneeId) {return this.record('assign_request',{p_ticket_id:id,p_assignee_id:assigneeId});}
  acknowledge(id) {return this.record('acknowledge_urgent',{p_ticket_id:id});}
  read(id) {return this.rpc('mark_request_read',{p_ticket_id:id});}
  async manageStaff(input) {
    if((await this.profile()).role!=='admin')throw new Error('Only Admin can manage accounts.');
    const result=await this.client.functions.invoke('manage-staff',{body:input});
    if(result.error){
      const details=await result.error.context?.json().catch(()=>null);
      throw new Error(details?.error||result.error.message||'Account management is unavailable.');
    }
    if(result.data?.error)throw new Error(result.data.error);
    return result.data;
  }
  retryDelivery(id) {return this.rpc('retry_notification',{p_notification_id:id});}
  createProject(input) {return this.record('create_project',{p_client_name:input.clientName,p_client_phone:normalizePhone(input.clientPhone),p_project_name:input.projectName,p_site_address:input.address||null});}
  async upload(id,files,onProgress=()=>{}) {
    let completed=0;
    for(const file of files) {
      let reservation,uploaded=false;
      try {
        reservation=await this.record('reserve_attachment',{p_ticket_id:id,p_original_name:file.name,p_mime_type:file.type,p_byte_size:file.size});
        checked(await this.client.storage.from('service-photos').upload(reservation.storage_path,file,{contentType:file.type,upsert:false}));uploaded=true;
        await this.record('finalize_attachment',{p_upload_id:reservation.id});
        completed++;onProgress(completed,files.length);
      } catch(error) {
        // A finalization error can occur after a committed response was lost. Only
        // the database's orphan policy permits deletion of unlinked owned files.
        if(uploaded)await this.client.storage.from('service-photos').remove([reservation.storage_path]).catch(()=>{});
        throw new Error(completed+' of '+files.length+' attachments saved. '+(error.message||'Upload failed.')+' Reopen the request and retry the remaining files.');
      }
    }
  }
  async mediaUrl(attachment) {return checked(await this.client.storage.from('service-photos').createSignedUrl(attachment.storage_path,300)).signedUrl;}
  async logout() {
    try {checked(await this.client.auth.signOut({scope:'local'}));}
    finally {globalThis.sessionStorage?.removeItem('oak-auth-session');globalThis.sessionStorage?.removeItem('oak-auth-session-code-verifier');}
  }
  async changePassword(currentPassword,password,captchaToken) {
    const admin=await this.profile();
    if(admin.role!=='admin')throw new Error('Only Admin can change passwords. Contact your administrator.');
    if(!currentPassword)throw new Error('Enter your current password.');
    if(!password||password.length<12)throw new Error('Use a new password with at least 12 characters.');
    const verified=checked(await this.client.auth.signInWithPassword({email:admin.email,password:currentPassword,options:captchaToken?{captchaToken}:undefined}));
    if(verified?.user?.id!==admin.auth_user_id)throw new Error('Admin password could not be verified.');
    checked(await this.client.auth.updateUser({password,current_password:currentPassword}));
  }
}
