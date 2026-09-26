// Local prototype rules. Production authorization must be enforced in the database.
export const TYPE_LABEL = Object.freeze({service:'Service',help_ticket:'Help ticket',follow_up:'Follow-up',urgent_message:'Urgent message'});
export const ROLE_LABEL = Object.freeze({admin:'Admin / Owner',manager:'Manager / Team Lead',staff:'Staff Member',technician:'Service Technician',support:'Support / Back-office'});
export const ROLE_DESCRIPTION = Object.freeze({
  admin:'View all requests, staff, reports, delivery issues; create, assign, update, resolve, and reopen any request.',
  manager:'Create, assign, update, resolve, and monitor every request; access delivery health and operational reports.',
  staff:'Create Service, Help ticket, and Follow-up requests; update only requests assigned to you; upload attachments; acknowledge assigned urgent messages.',
  technician:'Create Service and Follow-up requests; receive and update/resolve assigned Service requests; upload site photos/videos; acknowledge assigned urgent messages.',
  support:'Create Help ticket and Follow-up requests; receive and update/resolve assigned Help tickets and Follow-ups; upload attachments; acknowledge assigned urgent messages.'
});
const HOUR=3600000, DAY=24*HOUR, STATUSES=['New','In Review','Scheduled','Resolved'];
const TYPE_ACCESS={admin:Object.keys(TYPE_LABEL),manager:Object.keys(TYPE_LABEL),staff:['service','help_ticket','follow_up'],technician:['service','follow_up'],support:['help_ticket','follow_up']};
const active=user=>Boolean(user?.is_active&&ROLE_LABEL[user.role]);
export const canManage=user=>active(user)&&['admin','manager'].includes(user.role);
export const allowedTypes=user=>active(user)?[...TYPE_ACCESS[user.role]]:[];
export function canView(user,ticket){
  if(!active(user)||!ticket)return false;
  if(canManage(user)||ticket.assignee_id===user.id||ticket.created_by===user.auth_user_id)return true;
  return !ticket.assignee_id&&(user.role==='staff'?['service','help_ticket'].includes(ticket.type):user.role==='technician'?ticket.type==='service':user.role==='support'&&ticket.type==='help_ticket');
}
export function canUpdate(user,ticket){
  if(!active(user)||!ticket)return false;
  if(canManage(user))return true;
  if(ticket.assignee_id!==user.id)return false;
  return user.role==='staff'||(user.role==='technician'&&['service','follow_up'].includes(ticket.type))||(user.role==='support'&&['help_ticket','follow_up'].includes(ticket.type));
}
export const canAssign=(user,ticket)=>canManage(user)&&Boolean(ticket)&&ticket.type!=='follow_up';
export const canAcknowledge=(user,ticket)=>active(user)&&ticket?.type==='urgent_message'&&ticket.status!=='Resolved'&&ticket.assignee_id===user.id&&!ticket.urgent_acknowledged_at;
export const canAttach=(user,ticket)=>active(user)&&canView(user,ticket)&&ticket.status!=='Resolved'&&(canUpdate(user,ticket)||ticket.created_by===user.auth_user_id);
export function recipients(state,type){
  const roles=type==='service'?['admin','manager','staff','technician']:type==='help_ticket'?['admin','manager','staff','support']:type==='urgent_message'?Object.keys(ROLE_LABEL):[];
  return state.team.filter(user=>active(user)&&roles.includes(user.role));
}
const iso=ms=>new Date(ms).toISOString();
const newId=prefix=>`${prefix}-${globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
const requireRule=(value,message)=>{if(!value)throw new Error(message)};
const clean=value=>String(value??'').trim();

export class DemoEngine {
  constructor(state=seedDemo(),clock=()=>Date.now()){
    this.state=state;this.clock=clock;
    requireRule(state.version===3,'This saved demo uses an older format. Start a fresh demo.');
  }
  now(){return this.clock()+(this.state.clockOffsetMs||0)}
  _actor(user){
    const member=this.state.team.find(person=>person.id===user?.id&&person.auth_user_id===user?.auth_user_id);
    requireRule(active(member),'This demo account is inactive or unavailable. Choose an active staff login.');
    return member;
  }
  _ticket(id){const ticket=this.state.tickets.find(item=>item.id===id);requireRule(ticket,'Request not found.');return ticket}
  _event(ticket,type,user=null,extra={},at=this.now()){
    const event={id:newId('e'),ticket_id:ticket.id,event_type:type,actor_user_id:user?.auth_user_id||null,created_at:iso(at),metadata:{},...extra};
    this.state.events.push(event);return event;
  }
  _recipient(type,id){
    if(!id){requireRule(type!=='urgent_message','Select an active person for this urgent message.');return null}
    const person=recipients(this.state,type).find(user=>user.id===id);
    requireRule(person,'Choose an active recipient who can handle this request type.');return person;
  }
  create(user,input){
    user=this._actor(user);
    requireRule(allowedTypes(user).includes(input.type),'Your role cannot create this request type.');
    const note=clean(input.note);requireRule(note,'Describe what needs to be done.');
    const projectId=input.project_id||null;
    requireRule(!projectId||this.state.projects.some(project=>project.id===projectId),'Select a valid project.');
    requireRule(input.type!=='service'||projectId,'A service request needs a project.');
    let assigneeId=input.assignee_id||null,reminderAt=null;
    if(input.type==='follow_up'){
      requireRule(!assigneeId||assigneeId===user.id,'A follow-up is a personal reminder and must belong to its creator.');
      assigneeId=user.id;
      const reminderMs=Date.parse(input.reminder_at);requireRule(Number.isFinite(reminderMs)&&reminderMs>this.now(),'Choose a future reminder date and time.');reminderAt=iso(reminderMs);
    }else{
      requireRule(canManage(user)||!assigneeId||assigneeId===user.id,'Only an admin or manager can assign a request to another person.');
      this._recipient(input.type,assigneeId);
      requireRule(!input.reminder_at,'Only follow-up requests have a personal reminder.');
    }
    const at=this.now();
    const ticket={id:newId('t'),type:input.type,note,project_id:projectId,assignee_id:assigneeId,reminder_at:reminderAt,status:'New',created_by:user.auth_user_id,created_at:iso(at),last_status_update_at:iso(at),next_followup_due_at:iso(at+DAY),resolved_at:null,urgent_read_at:null,urgent_acknowledged_at:null,urgent_acknowledged_by:null,inactivity_cycle:1,urgent_assignment_cycle:1,urgent_assigned_at:input.type==='urgent_message'?iso(at):null};
    this.state.tickets.push(ticket);
    const event=this._event(ticket,'created',user,{new_status:'New',note,metadata:{type:ticket.type,assignee_id:assigneeId}});
    if(assigneeId&&ticket.type!=='follow_up')this._notify(ticket,event,ticket.type==='urgent_message'?'urgent':'assigned',assigneeId);
    return ticket;
  }
  update(user,id,{status,note,expected_timeline}={}){
    user=this._actor(user);const ticket=this._ticket(id);requireRule(canUpdate(user,ticket),'You can only update work assigned to you within your role.');
    requireRule(STATUSES.includes(status),'Choose a valid workflow status.');
    const before=ticket.status,changed=before!==status,body=clean(note),timeline=clean(expected_timeline);
    requireRule(before!=='Resolved'||status==='In Review','A resolved request must explicitly reopen to In Review.');
    if(changed&&before!=='Resolved')requireRule(status==='Resolved'||STATUSES.indexOf(status)===STATUSES.indexOf(before)+1,'Move to the next workflow stage, or resolve the request.');
    requireRule(changed||body||timeline,'Add a work update or change the status before saving.');
    const at=this.now();ticket.status=status;ticket.last_status_update_at=iso(at);ticket.next_followup_due_at=status==='Resolved'?null:iso(at+DAY);ticket.resolved_at=status==='Resolved'?iso(at):null;ticket.inactivity_cycle=(ticket.inactivity_cycle||1)+1;
    if(timeline)ticket.expected_timeline=timeline;
    const type=before==='Resolved'?'reopened':status==='Resolved'?'resolved':'status_updated';
    this._event(ticket,type,user,{old_status:before,new_status:status,note:body||null,expected_timeline:timeline||null});
    this._cancelPending(ticket,status==='Resolved'?'Request resolved':'A new workflow update started a new inactivity cycle',status==='Resolved'?null:['overdue']);
    if(status==='Resolved'&&ticket.type==='follow_up'&&!ticket.reminder_sent_at&&!ticket.reminder_cancelled_at){ticket.reminder_cancelled_at=iso(at);this._event(ticket,'reminder_cancelled',user,{note:'The request resolved before its personal reminder.'})}
    if(before==='Resolved'&&ticket.type==='urgent_message'&&!ticket.urgent_acknowledged_at){ticket.urgent_assignment_cycle++;ticket.urgent_assigned_at=iso(at);ticket.urgent_repeat_sent_at=null}
    return ticket;
  }
  assign(user,id,assigneeId){
    user=this._actor(user);const ticket=this._ticket(id);requireRule(canAssign(user,ticket),'Only an admin or manager can assign work. Personal follow-ups cannot be reassigned.');
    assigneeId=assigneeId||null;this._recipient(ticket.type,assigneeId);requireRule(ticket.assignee_id!==assigneeId,'Choose a different recipient.');
    const oldId=ticket.assignee_id;ticket.assignee_id=assigneeId;
    this._cancelPending(ticket,'The recipient changed');
    if(ticket.type==='urgent_message'){ticket.urgent_read_at=null;ticket.urgent_acknowledged_at=null;ticket.urgent_acknowledged_by=null;ticket.urgent_repeat_sent_at=null;ticket.urgent_assignment_cycle=(ticket.urgent_assignment_cycle||1)+1;ticket.urgent_assigned_at=iso(this.now())}
    const event=this._event(ticket,'assigned',user,{metadata:{old_assignee_id:oldId,new_assignee_id:assigneeId,assignee_id:assigneeId}});
    if(assigneeId&&ticket.status!=='Resolved')this._notify(ticket,event,ticket.type==='urgent_message'?'urgent':'assigned',assigneeId);
    return ticket;
  }
  acknowledge(user,id){
    user=this._actor(user);const ticket=this._ticket(id);requireRule(canAcknowledge(user,ticket),'Only the named recipient can acknowledge an open, unacknowledged urgent message.');
    ticket.urgent_acknowledged_at=iso(this.now());ticket.urgent_acknowledged_by=user.id;
    this._event(ticket,'acknowledged',user);this._cancelPending(ticket,'The recipient acknowledged the urgent message',['urgent','urgent_repeat']);return ticket;
  }
  read(user,id){
    user=this._actor(user);const ticket=this._ticket(id);requireRule(canView(user,ticket),'This request is outside your workspace.');
    const cycle=ticket.urgent_assignment_cycle||1;
    if(!this.state.events.some(event=>event.ticket_id===id&&event.event_type==='read'&&event.actor_user_id===user.auth_user_id&&event.metadata?.receipt_cycle===cycle))this._event(ticket,'read',user,{metadata:{receipt_cycle:cycle}});
    if(ticket.type==='urgent_message'&&ticket.assignee_id===user.id&&!ticket.urgent_read_at)ticket.urgent_read_at=iso(this.now());return ticket;
  }
  addAttachment(user,id,metadata){
    user=this._actor(user);const ticket=this._ticket(id);requireRule(canAttach(user,ticket),'You can upload media to your own open requests or assigned work.');
    const formats=['image/jpeg','image/png','image/webp','video/mp4','video/quicktime','video/webm'];
    requireRule(formats.includes(metadata.mime_type),'Choose a JPEG, PNG, WebP, MP4, QuickTime or WebM file.');
    const limit=metadata.mime_type.startsWith('image/')?10*1024*1024:50*1024*1024;
    requireRule(Number.isFinite(metadata.byte_size)&&metadata.byte_size>0&&metadata.byte_size<=limit,`This file exceeds the ${limit/1024/1024} MB limit or is empty.`);
    requireRule(clean(metadata.original_name),'The attachment needs a filename.');
    const attachment={id:newId('a'),ticket_id:id,original_name:clean(metadata.original_name),mime_type:metadata.mime_type,byte_size:metadata.byte_size,uploaded_by:user.auth_user_id,uploaded_at:iso(this.now()),blob_key:metadata.blob_key||null,sample_kind:metadata.sample_kind||null};
    this.state.attachments.push(attachment);this._event(ticket,'attachment_added',user,{metadata:{attachment_id:attachment.id,original_name:attachment.original_name}});return attachment;
  }
  _cancelPending(ticket,reason,kinds=null){
    for(const notification of this.state.notifications.filter(item=>item.ticket_id===ticket.id&&['queued','retrying','failed'].includes(item.state)&&(!kinds||kinds.includes(item.kind)))){notification.state='cancelled';notification.next_attempt_at=null;notification.cancelled_at=iso(this.now());this._event(ticket,'notification_cancelled',null,{note:reason,metadata:{notification_id:notification.id}})}
  }
  _notify(ticket,event,kind,recipientId,{both=false,mode=null}={}){
    const dedupe=`${event.id}:${recipientId}:${kind}`;
    if(this.state.notifications.some(item=>item.dedupe_key===dedupe))return;
    const notification={id:newId('n'),ticket_id:ticket.id,event_id:event.id,recipient_id:recipientId,kind,state:'queued',created_at:iso(this.now()),dedupe_key:dedupe,retry_count:0,next_attempt_at:null,channels:both?['push','email']:['push'],demo_mode:mode||ticket.demo_delivery_mode||'success'};
    this.state.notifications.push(notification);this._event(ticket,'notification_queued',null,{metadata:{notification_id:notification.id,kind,recipient_id:recipientId}});this._deliver(notification);return notification;
  }
  _attempt(notification,channel,success,error=null){
    const attempted=iso(this.now()),delivery={id:newId('d'),notification_id:notification.id,channel,state:success?(channel==='push'?'accepted':'delivered'):'failed',provider:channel==='push'?'Demo Web Push':'Demo Email',provider_message_id:success?newId('demo'):null,attempted_at:attempted,accepted_at:success?attempted:null,delivered_at:success&&channel==='email'?attempted:null,error_message:error,retry_count:notification.retry_count};
    // Delivery timestamps are simulated provider outcomes; acknowledgement is recorded separately.
    this.state.deliveries.push(delivery);this._event(this._ticket(notification.ticket_id),success?'notification_sent':'notification_failed',null,{note:success?`Simulated ${channel} ${channel==='push'?'provider acceptance':'delivery'}`:`Simulated ${channel}: ${error}`,metadata:{notification_id:notification.id,delivery_id:delivery.id,channel,state:delivery.state}});return delivery;
  }
  _deliver(notification,forceSuccess=false){
    const ticket=this._ticket(notification.ticket_id),person=this.state.team.find(user=>user.id===notification.recipient_id);
    if(ticket.status==='Resolved'||!active(person)){notification.state='cancelled';notification.next_attempt_at=null;return}
    const mode=forceSuccess?'success':notification.demo_mode;
    if(mode==='retry'&&notification.retry_count<3){
      this._attempt(notification,'push',false,'Temporary provider outage; automatic retry scheduled.');notification.state='retrying';notification.next_attempt_at=iso(this.now()+[1,5,15][notification.retry_count]*60000);return;
    }
    if(mode==='failure'){
      this._attempt(notification,'push',false,'Demo push endpoint expired.');this._attempt(notification,'email',false,'Demo email bounced; operator action required.');notification.state='failed';notification.next_attempt_at=null;return;
    }
    const noPush=person.demo_push_available===false;
    if(noPush){this._attempt(notification,'push',false,'No active demo push device. Email fallback used.');this._attempt(notification,'email',true)}
    else for(const channel of notification.channels)this._attempt(notification,channel,true);
    notification.state='sent';notification.sent_at=iso(this.now());notification.next_attempt_at=null;
  }
  scan(){
    const started=this.now();let processed=0;
    for(const ticket of this.state.tickets){
      if(ticket.status==='Resolved')continue;
      const cycle=ticket.inactivity_cycle||1;
      if(Date.parse(ticket.next_followup_due_at)<=started&&ticket.overdue_notified_cycle!==cycle){
        const recipientId=ticket.assignee_id||this.state.team.find(user=>user.auth_user_id===ticket.created_by)?.id;
        const event=this._event(ticket,'overdue',null,{note:'No recorded workflow update for 24 hours.',metadata:{inactivity_cycle:cycle,recipient_id:recipientId}});
        ticket.overdue_notified_cycle=cycle;if(recipientId)this._notify(ticket,event,'overdue',recipientId);processed++;
      }
      if(ticket.type==='follow_up'&&ticket.reminder_at&&!ticket.reminder_sent_at&&!ticket.reminder_cancelled_at&&Date.parse(ticket.reminder_at)<=started){
        const event=this._event(ticket,'reminder_due',null,{note:'Your personal follow-up reminder is due.'});ticket.reminder_sent_at=iso(started);this._notify(ticket,event,'follow_up',ticket.assignee_id);processed++;
      }
      if(ticket.type==='urgent_message'&&!ticket.urgent_acknowledged_at&&!ticket.urgent_repeat_sent_at&&Date.parse(ticket.urgent_assigned_at||ticket.created_at)+15*60000<=started){
        const event=this._event(ticket,'urgent_repeat',null,{note:'Still unacknowledged after 15 minutes: repeat push and email.'});ticket.urgent_repeat_sent_at=iso(started);this._notify(ticket,event,'urgent_repeat',ticket.assignee_id,{both:true});processed++;
      }
    }
    for(const notification of this.state.notifications.filter(item=>item.state==='retrying'&&Date.parse(item.next_attempt_at)<=started)){notification.retry_count++;this._deliver(notification);processed++}
    this.state.workerRuns.push({id:newId('run'),worker:'notification-scan',status:'succeeded',processed_count:processed,started_at:iso(started),finished_at:iso(this.now())});
    if(this.state.workerRuns.length>40)this.state.workerRuns.splice(0,this.state.workerRuns.length-40);
    return processed;
  }
  retryDelivery(user,notificationId){
    user=this._actor(user);requireRule(canManage(user),'Only an admin or manager can retry delivery.');
    const notification=this.state.notifications.find(item=>item.id===notificationId);requireRule(notification,'Notification not found.');requireRule(['failed','retrying'].includes(notification.state),'This notification does not need a retry.');
    const ticket=this._ticket(notification.ticket_id);requireRule(ticket.status!=='Resolved','This request is already resolved; no reminder is needed.');
    notification.retry_count++;this._event(ticket,'notification_retried',user,{metadata:{notification_id:notification.id}});this._deliver(notification,true);return notification;
  }
  advanceHours(user,hours){
    user=this._actor(user);requireRule(canManage(user),'Only an admin or manager can advance the demo clock.');requireRule(Number.isFinite(hours)&&hours>0&&hours<=168,'Advance the demo by more than zero and up to 168 hours.');this.state.clockOffsetMs+=hours*HOUR;this.scan();return this.now();
  }
  setStaffActive(user,id,isActive){
    user=this._actor(user);requireRule(user.role==='admin','Only the admin can manage demo staff access.');requireRule(typeof isActive==='boolean','Choose an active or inactive account state.');
    const member=this.state.team.find(person=>person.id===id);requireRule(member,'Staff member not found.');requireRule(member.id!==user.id||isActive,'You cannot deactivate your own admin login.');requireRule(isActive||!this.state.tickets.some(ticket=>ticket.assignee_id===id&&ticket.status!=='Resolved'),'Reassign or resolve this person’s open work before deactivating their login.');member.is_active=isActive;return member;
  }
}

export function seedDemo(at=Date.now()){
  const names=[
    ['Aditya Nahata','admin','Management','9831898326','12345678'],
    ['Shibani','staff','Showroom & Sales','8100302122','12345678'],
    ['Rohit','staff','Operations & Service','8100302022','12345678']
  ];
  const state={version:3,clockOffsetMs:0,team:names.map(([name,role,department,phone,password],index)=>({id:`u${index+1}`,auth_user_id:`demo-auth-${index+1}`,name,role,department,phone,password,email:`user${index+1}@example.com`,is_active:true,demo_push_available:index!==2})),clients:[{id:'c1',name:'Alipore Residence'},{id:'c2',name:'Ballygunge Residence'},{id:'c3',name:'The Meridian Suite'}],projects:[{id:'p1',client_id:'c1',name:'Alipore Residence',site_address:'Alipore, Kolkata'},{id:'p2',client_id:'c2',name:'Ballygunge Residence',site_address:'Ballygunge, Kolkata'},{id:'p3',client_id:'c3',name:'The Meridian Suite',site_address:'Park Street, Kolkata'}],tickets:[],events:[],attachments:[],notifications:[],deliveries:[],workerRuns:[]};
  const fixtures=[
    ['service','Tighten the loose arm on the walnut dining chair.','p1','u2','u3',30,'New'],
    ['service','Inspect the marble console edge before final installation.','p3','u3','u2',8,'In Review'],
    ['service','Arrange a velvet sofa upholstery inspection.','p2',null,'u3',26,'New'],
    ['help_ticket','Prepare the final invoice for the Alipore dining collection.','p1','u2','u3',28,'In Review'],
    ['help_ticket','Confirm two ivory bouclé swatches are in showroom stock.',null,'u3','u2',5,'New'],
    ['help_ticket','Share the approved console dimensions with the factory.','p3',null,'u2',10,'New'],
    ['follow_up','Call the client to confirm their fabric selection.','p2','u3','u3',13,'New'],
    ['follow_up','Confirm tomorrow’s polish touch-up visit.','p1','u2','u2',3,'Scheduled'],
    ['follow_up','Check whether the final payment receipt has arrived.','p1','u3','u3',6,'In Review'],
    ['urgent_message','Hold the dining-table dispatch: the client changed the delivery entrance.','p3','u3','u2',0.1,'New'],
    ['urgent_message','Please meet the client at the showroom entrance now.',null,'u2','u1',0.12,'New'],
    ['urgent_message','Confirm the installation team has reached the VIP residence.','p1','u3','u2',1,'In Review'],
    ['service','Complete the brass handle alignment on the credenza.','p2','u2','u3',72,'Resolved'],
    ['follow_up','Review this week’s open installation commitments.',null,'u1','u1',25,'New'],
    ['follow_up','Check the Meridian delivery access approval.','p3','u2','u2',12,'New'],
    ['follow_up','Pack the approved polish kit for the Ballygunge visit.','p2','u3','u3',4,'New']
  ];
  fixtures.forEach(([type,note,project_id,assignee_id,creator,age,status],index)=>{
    const created=at-age*HOUR,last=status==='New'?created:created+Math.min(age/4,2)*HOUR;
    const ticket={id:`t${index+1}`,type,note,project_id,assignee_id,created_by:state.team.find(user=>user.id===creator).auth_user_id,status,created_at:iso(created),last_status_update_at:iso(last),next_followup_due_at:status==='Resolved'?null:iso(last+DAY),resolved_at:status==='Resolved'?iso(last):null,reminder_at:type==='follow_up'?iso(at+([6,13,14].includes(index)?-0.25:4)*HOUR):null,urgent_read_at:null,urgent_acknowledged_at:null,urgent_acknowledged_by:null,inactivity_cycle:status==='New'?1:2,urgent_assignment_cycle:1,urgent_assigned_at:type==='urgent_message'?iso(created):null};
    state.tickets.push(ticket);state.events.push({id:`seed-created-${ticket.id}`,ticket_id:ticket.id,event_type:'created',actor_user_id:ticket.created_by,new_status:'New',note,metadata:{type,assignee_id},created_at:ticket.created_at});
    if(status!=='New'){
      if(status==='Scheduled')state.events.push({id:`seed-review-${ticket.id}`,ticket_id:ticket.id,event_type:'status_updated',actor_user_id:state.team.find(user=>user.id===assignee_id).auth_user_id,old_status:'New',new_status:'In Review',note:'Visit details confirmed.',metadata:{},created_at:iso(created+(last-created)/2)});
      state.events.push({id:`seed-update-${ticket.id}`,ticket_id:ticket.id,event_type:status==='Resolved'?'resolved':'status_updated',actor_user_id:state.team.find(user=>user.id===(type==='urgent_message'?'u2':assignee_id)).auth_user_id,old_status:status==='Scheduled'?'In Review':'New',new_status:status,note:status==='Resolved'?'Alignment checked and client confirmed completion.':'Reviewed the requirement and confirmed the next action.',expected_timeline:status==='Resolved'?null:'Next working day',metadata:{},created_at:iso(last)});
    }
  });
  const engine=new DemoEngine(state,()=>at);
  const acknowledged=state.tickets.find(ticket=>ticket.id==='t12');acknowledged.urgent_read_at=iso(at-45*60000);acknowledged.urgent_acknowledged_at=iso(at-43*60000);acknowledged.urgent_acknowledged_by='u3';
  engine._event(acknowledged,'read',state.team[2],{metadata:{receipt_cycle:1}},at-45*60000);engine._event(acknowledged,'acknowledged',state.team[2],{},at-43*60000);
  const readUrgent=state.tickets.find(ticket=>ticket.id==='t11');readUrgent.urgent_read_at=iso(at-3*60000);engine._event(readUrgent,'read',state.team[1],{metadata:{receipt_cycle:1}},at-3*60000);
  state.tickets.find(ticket=>ticket.id==='t10').demo_delivery_mode='failure';state.tickets.find(ticket=>ticket.id==='t5').demo_delivery_mode='retry';
  for(const ticket of state.tickets.filter(ticket=>ticket.assignee_id&&ticket.type!=='follow_up'&&ticket.status!=='Resolved')){
    const notification=engine._notify(ticket,state.events.find(event=>event.ticket_id===ticket.id&&event.event_type==='created'),ticket.type==='urgent_message'?'urgent':'assigned',ticket.assignee_id);
    if(notification)notification.created_at=ticket.created_at;
  }
  // Named examples provide photo/video previews without pretending that stock media is a real upload.
  for(const [id,ticketId,kind,name,mime] of [['a1','t1','photo','Walnut chair inspection.jpg','image/jpeg'],['a2','t2','video','Console inspection.mp4','video/mp4'],['a3','t13','photo','Finished brass handles.jpg','image/jpeg']]){
    const ticket=state.tickets.find(item=>item.id===ticketId),uploaded=Date.parse(ticket.created_at)+5*60000;
    state.attachments.push({id,ticket_id:ticketId,original_name:name,mime_type:mime,byte_size:kind==='photo'?420000:8400000,sample_kind:kind,uploaded_by:ticket.created_by,uploaded_at:iso(uploaded)});engine._event(ticket,'attachment_added',state.team.find(user=>user.auth_user_id===ticket.created_by),{metadata:{attachment_id:id,original_name:name}},uploaded);
  }
  engine.scan();return state;
}
