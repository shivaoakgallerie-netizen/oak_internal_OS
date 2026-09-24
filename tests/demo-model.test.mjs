import test from 'node:test';
import assert from 'node:assert/strict';
import {DemoEngine,seedDemo,allowedTypes,canView,canUpdate,canAssign,canAcknowledge,recipients} from '../demo-model.js';

const START=Date.parse('2026-09-24T04:30:00Z'),HOUR=3600000;
function fixture(){let time=START;const engine=new DemoEngine(seedDemo(time),()=>time);return {engine,state:engine.state,users:engine.state.team,tick:ms=>time+=ms}}
const create=(engine,user,type='service',extra={})=>engine.create(user,{type,note:'Inspect the walnut finish.',project_id:type==='service'?'p1':null,...extra});
const count=(state,id,type)=>state.events.filter(event=>event.ticket_id===id&&event.event_type===type).length;

test('six demo people and fixtures cover the four types, personal work and delivery conditions',()=>{
  const {state}=fixture();assert.equal(state.team.length,6);assert.equal(new Set(state.tickets.map(t=>t.type)).size,4);
  for(const member of state.team)assert.ok(state.tickets.some(t=>t.assignee_id===member.id));
  assert.ok(state.notifications.some(n=>n.state==='failed'));assert.ok(state.notifications.some(n=>n.state==='retrying'));assert.ok(state.attachments.some(a=>a.sample_kind==='video'));
  for(const ticket of state.tickets.filter(t=>t.type==='follow_up'))assert.equal(state.team.find(u=>u.id===ticket.assignee_id).auth_user_id,ticket.created_by);
});

test('each role can create exactly the permitted request types',()=>{
  const {engine,users}=fixture();
  const matrix=[['service','help_ticket','follow_up','urgent_message'],['service','help_ticket','follow_up','urgent_message'],['service','help_ticket','follow_up'],['service','follow_up'],['service','follow_up'],['help_ticket','follow_up']];
  for(const [index,user] of users.entries()){
    assert.deepEqual(allowedTypes(user),matrix[index]);
    for(const type of ['service','help_ticket','follow_up','urgent_message']){
      const input={assignee_id:type==='urgent_message'?'u3':null,reminder_at:type==='follow_up'?new Date(START+HOUR).toISOString():null};
      if(matrix[index].includes(type))assert.equal(create(engine,user,type,input).type,type);
      else assert.throws(()=>create(engine,user,type,input),/cannot create/);
    }
  }
});

test('guarded mutations use the canonical account role instead of a forged role field',()=>{
  const {engine,users}=fixture();const forged={...users[2],role:'admin'};
  assert.throws(()=>create(engine,forged,'urgent_message',{assignee_id:'u4'}),/cannot create/);
  assert.throws(()=>engine.assign(forged,'t1','u5'),/Only an admin/);
  assert.throws(()=>engine.update(forged,'t2',{status:'Resolved'}),/only update/);
  assert.throws(()=>engine.retryDelivery(forged,engine.state.notifications.find(n=>n.state==='failed').id),/Only an admin/);
});

test('ordinary roles cannot assign other people even through direct model calls',()=>{
  const {engine,users}=fixture();
  for(const user of users.slice(2)){
    assert.throws(()=>create(engine,user,user.role==='support'?'help_ticket':'service',{assignee_id:'u2'}),/Only an admin/);
    assert.throws(()=>engine.assign(user,'t3',user.id),/Only an admin/);
  }
  for(const user of users.slice(0,2))assert.equal(engine.assign(user,'t3',user.id).assignee_id,user.id);
  assert.ok(!recipients(engine.state,'service').some(u=>u.role==='support'));
  assert.ok(!recipients(engine.state,'help_ticket').some(u=>u.role==='technician'));
  assert.throws(()=>engine.assign(users[0],'t1','u6'),/can handle/);
});

test('follow-ups always belong to the creator and cannot be reassigned',()=>{
  const {engine,users}=fixture();
  const ticket=create(engine,users[3],'follow_up',{reminder_at:new Date(START+HOUR).toISOString()});
  assert.equal(ticket.assignee_id,users[3].id);
  assert.throws(()=>create(engine,users[0],'follow_up',{assignee_id:'u4',reminder_at:new Date(START+HOUR).toISOString()}),/personal reminder/);
  assert.throws(()=>engine.assign(users[0],ticket.id,'u5'),/cannot be reassigned/);
  assert.equal(canAssign(users[1],ticket),false);
  assert.throws(()=>create(engine,users[3],'follow_up',{reminder_at:'nonsense'}),/future reminder/);
  assert.throws(()=>create(engine,users[3],'follow_up',{reminder_at:new Date(START).toISOString()}),/future reminder/);
});

test('visibility and update capabilities match assignment, ownership and role',()=>{
  const {engine,users,state}=fixture();
  const byId=id=>state.tickets.find(t=>t.id===id);
  assert.ok(canView(users[2],byId('t1')));assert.ok(!canUpdate(users[2],byId('t1'))); // Creator may observe technician work.
  assert.ok(canView(users[3],byId('t3')));assert.ok(!canUpdate(users[3],byId('t3'))); // Shared service queue.
  assert.ok(!canView(users[3],byId('t4')));assert.throws(()=>engine.read(users[3],'t4'),/outside/);
  assert.ok(canUpdate(users[3],byId('t1')));assert.ok(canUpdate(users[5],byId('t4')));
  assert.ok(!canUpdate(users[3],byId('t12')));assert.ok(!canUpdate(users[4],byId('t10')));
  for(const manager of users.slice(0,2))for(const ticket of state.tickets){assert.ok(canView(manager,ticket));assert.ok(canUpdate(manager,ticket))}
  engine.update(users[3],'t1',{status:'Resolved'});engine.update(users[5],'t4',{status:'Resolved'});
  assert.throws(()=>engine.update(users[4],'t10',{status:'Resolved'}),/only update/);
});

test('status moves sequentially, allows early resolution and explicit reopening only',()=>{
  const {engine,users}=fixture();const ticket=create(engine,users[0], 'service',{assignee_id:'u4'});
  assert.throws(()=>engine.update(users[0],ticket.id,{status:'Scheduled'}),/next workflow/);
  assert.throws(()=>engine.update(users[0],ticket.id,{status:'New',note:'  '}),/Add a work update/);
  engine.update(users[3],ticket.id,{status:'In Review',note:'Checked the joint.'});engine.update(users[3],ticket.id,{status:'Scheduled',expected_timeline:'Tomorrow at 11 AM'});engine.update(users[3],ticket.id,{status:'Resolved'});
  assert.equal(ticket.next_followup_due_at,null);
  assert.throws(()=>engine.update(users[0],ticket.id,{status:'New'}),/explicitly reopen/);
  engine.update(users[0],ticket.id,{status:'In Review',note:'Client requested a second inspection.'});assert.equal(ticket.resolved_at,null);assert.equal(count(engine.state,ticket.id,'reopened'),1);
  const early=create(engine,users[0]);engine.update(users[0],early.id,{status:'Resolved'});assert.equal(early.status,'Resolved');
});

test('24-hour warning respects the exact boundary, deduplicates, and targets owner or creator',()=>{
  const {engine,users,state,tick}=fixture();const assigned=create(engine,users[0],'service',{assignee_id:'u4'}),shared=create(engine,users[2]);
  tick(24*HOUR-1);engine.scan();assert.equal(count(state,assigned.id,'overdue'),0);
  tick(1);engine.scan();engine.scan();assert.equal(count(state,assigned.id,'overdue'),1);assert.equal(count(state,shared.id,'overdue'),1);
  assert.equal(state.notifications.find(n=>n.ticket_id===assigned.id&&n.kind==='overdue').recipient_id,'u4');
  assert.equal(state.notifications.find(n=>n.ticket_id===shared.id&&n.kind==='overdue').recipient_id,'u3');
  engine.update(users[3],assigned.id,{status:'New',note:'Waiting for the matching part.'});tick(24*HOUR);engine.scan();assert.equal(count(state,assigned.id,'overdue'),2);
});

test('read, assignment, acknowledgement, attachment and delivery do not reset inactivity',()=>{
  const {engine,users,tick}=fixture();const ticket=create(engine,users[0],'urgent_message',{assignee_id:'u3'}),initial=ticket.next_followup_due_at;
  tick(HOUR);engine.read(users[2],ticket.id);engine.acknowledge(users[2],ticket.id);engine.addAttachment(users[2],ticket.id,{original_name:'site.jpg',mime_type:'image/jpeg',byte_size:1024});engine.assign(users[0],ticket.id,'u4');engine.scan();
  assert.equal(ticket.next_followup_due_at,initial);assert.equal(ticket.last_status_update_at,ticket.created_at);
  engine.update(users[0],ticket.id,{status:'In Review',note:'Dispatch held pending confirmation.'});assert.equal(Date.parse(ticket.next_followup_due_at),engine.now()+24*HOUR);
});

test('a workflow update immediately before the deadline prevents the old overdue warning',()=>{
  const {engine,users,state,tick}=fixture();const ticket=create(engine,users[0]);tick(24*HOUR-1);engine.update(users[0],ticket.id,{status:'New',expected_timeline:'Client visit tomorrow.'});tick(1);engine.scan();assert.equal(count(state,ticket.id,'overdue'),0);
});

test('urgent receipt belongs to the recipient and repeats push plus email once after 15 minutes',()=>{
  const {engine,users,state,tick}=fixture();const ticket=create(engine,users[0],'urgent_message',{assignee_id:'u3'});
  assert.equal(canAcknowledge(users[0],ticket),false);assert.throws(()=>engine.acknowledge(users[0],ticket.id),/named recipient/);
  engine.read(users[2],ticket.id);assert.ok(ticket.urgent_read_at);assert.equal(ticket.urgent_acknowledged_at,null);
  tick(15*60000-1);engine.scan();assert.equal(count(state,ticket.id,'urgent_repeat'),0);tick(1);engine.scan();engine.scan();
  const repeat=state.notifications.filter(n=>n.ticket_id===ticket.id&&n.kind==='urgent_repeat');assert.equal(repeat.length,1);
  assert.deepEqual(state.deliveries.filter(d=>d.notification_id===repeat[0].id).map(d=>d.channel),['push','email']);
  engine.acknowledge(users[2],ticket.id);assert.ok(ticket.urgent_acknowledged_at);assert.throws(()=>engine.acknowledge(users[2],ticket.id),/unacknowledged/);
  engine.assign(users[1],ticket.id,'u4');assert.equal(ticket.urgent_read_at,null);assert.equal(ticket.urgent_acknowledged_at,null);
  assert.throws(()=>engine.acknowledge(users[2],ticket.id),/named recipient/);engine.acknowledge(users[3],ticket.id);
});

test('resolution cancels reminders and queued retries; reopening starts fresh inactivity',()=>{
  const {engine,users,state,tick}=fixture();const ticket=create(engine,users[2],'follow_up',{reminder_at:new Date(START+HOUR).toISOString()});
  const pending=state.notifications.find(n=>n.state==='retrying');engine.update(users[0],pending.ticket_id,{status:'Resolved'});assert.equal(pending.state,'cancelled');
  engine.update(users[2],ticket.id,{status:'Resolved'});assert.ok(ticket.reminder_cancelled_at);tick(25*HOUR);engine.scan();assert.equal(count(state,ticket.id,'reminder_due'),0);assert.equal(count(state,ticket.id,'overdue'),0);
  engine.update(users[2],ticket.id,{status:'In Review',note:'Resume client contact.'});engine.scan();assert.equal(count(state,ticket.id,'reminder_due'),0);tick(24*HOUR);engine.scan();assert.equal(count(state,ticket.id,'overdue'),1);
});

test('acknowledgement and new workflow cycles cancel obsolete failed notifications',()=>{
  const {engine,users,state,tick}=fixture();const urgent=state.notifications.find(n=>n.ticket_id==='t10'&&n.state==='failed');engine.acknowledge(users[4],'t10');assert.equal(urgent.state,'cancelled');assert.throws(()=>engine.retryDelivery(users[0],urgent.id),/does not need/);
  const ticket=create(engine,users[0],'service',{assignee_id:'u4'});ticket.demo_delivery_mode='failure';tick(24*HOUR);engine.scan();const overdue=state.notifications.find(n=>n.ticket_id===ticket.id&&n.kind==='overdue');assert.equal(overdue.state,'failed');engine.update(users[3],ticket.id,{status:'New',note:'Client visit confirmed.'});assert.equal(overdue.state,'cancelled');assert.throws(()=>engine.retryDelivery(users[0],overdue.id),/does not need/);
  assert.ok(state.deliveries.some(d=>d.notification_id===overdue.id&&d.state==='failed'));
});

test('due follow-up fires once and successful operator retry preserves failed attempts',()=>{
  const {engine,users,state,tick}=fixture();const ticket=create(engine,users[5],'follow_up',{reminder_at:new Date(START+HOUR).toISOString()});tick(HOUR);engine.scan();engine.scan();assert.equal(count(state,ticket.id,'reminder_due'),1);
  const follow=state.notifications.find(n=>n.ticket_id===ticket.id);assert.ok(state.deliveries.some(d=>d.notification_id===follow.id&&d.channel==='email'&&d.state==='delivered'));
  const failed=state.notifications.find(n=>n.state==='failed'),before=state.deliveries.filter(d=>d.notification_id===failed.id&&d.state==='failed').length;engine.retryDelivery(users[1],failed.id);assert.equal(failed.state,'sent');assert.equal(state.deliveries.filter(d=>d.notification_id===failed.id&&d.state==='failed').length,before);
});

test('temporary delivery failures retry at 1, 5 and 15 minutes then succeed',()=>{
  const {engine,state,tick}=fixture();const retry=state.notifications.find(n=>n.state==='retrying');
  tick(60000-1);engine.scan();assert.equal(retry.retry_count,0);tick(1);engine.scan();assert.equal(retry.retry_count,1);
  tick(5*60000);engine.scan();assert.equal(retry.retry_count,2);assert.equal(retry.state,'retrying');tick(15*60000);engine.scan();assert.equal(retry.retry_count,3);assert.equal(retry.state,'sent');
});

test('inactive accounts cannot access or mutate workflow; deactivation protects open work',()=>{
  const {engine,users,state}=fixture();assert.throws(()=>engine.setStaffActive(users[0],'u1',false),/own admin/);assert.throws(()=>engine.setStaffActive(users[1],'u3',false),/Only the admin/);assert.throws(()=>engine.setStaffActive(users[0],'u4',false),/open work/);
  for(const ticket of state.tickets.filter(t=>t.assignee_id==='u6'&&t.status!=='Resolved'))engine.update(users[0],ticket.id,{status:'Resolved'});
  engine.setStaffActive(users[0],'u6',false);assert.deepEqual(allowedTypes(users[5]),[]);assert.equal(canView(users[5],state.tickets[0]),false);
  for(const operation of [()=>create(engine,users[5],'help_ticket'),()=>engine.read(users[5],'t4'),()=>engine.update(users[5],'t4',{status:'In Review'}),()=>engine.acknowledge(users[5],'t10'),()=>engine.assign(users[5],'t4','u3'),()=>engine.addAttachment(users[5],'t4',{})])assert.throws(operation,/inactive/);
  assert.throws(()=>engine.assign(users[0],'t6','u6'),/active recipient/);engine.setStaffActive(users[0],'u6',true);assert.ok(users[5].is_active);
});

test('media validation and documented trail are preserved through later actions',()=>{
  const {engine,users,state}=fixture();const ticket=create(engine,users[2]);const original=JSON.stringify(state.events.filter(e=>e.ticket_id===ticket.id));
  assert.throws(()=>engine.addAttachment(users[2],ticket.id,{original_name:'document.pdf',mime_type:'application/pdf',byte_size:10}),/Choose a JPEG/);
  assert.throws(()=>engine.addAttachment(users[2],ticket.id,{original_name:'large.jpg',mime_type:'image/jpeg',byte_size:11*1024*1024}),/10 MB/);
  engine.addAttachment(users[2],ticket.id,{original_name:'chair.mp4',mime_type:'video/mp4',byte_size:1024,blob_key:'fixture-key'});engine.read(users[2],ticket.id);
  assert.equal(JSON.stringify(state.events.filter(e=>e.ticket_id===ticket.id&&e.event_type==='created')),original);assert.equal(count(state,ticket.id,'attachment_added'),1);
});
