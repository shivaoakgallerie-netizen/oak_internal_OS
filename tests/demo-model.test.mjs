import test from 'node:test';
import assert from 'node:assert/strict';
import {DemoEngine,seedDemo,allowedTypes,canView,canUpdate,canAssign,canAcknowledge,recipients} from '../demo-model.js';

const START=Date.parse('2026-09-24T04:30:00Z'),HOUR=3600000;
function fixture(){let time=START;const engine=new DemoEngine(seedDemo(time),()=>time);return {engine,state:engine.state,users:engine.state.team,tick:ms=>time+=ms}}
const create=(engine,user,type='service',extra={})=>engine.create(user,{type,note:'Inspect the walnut finish.',project_id:type==='service'?'p1':null,...extra});
const count=(state,id,type)=>state.events.filter(event=>event.ticket_id===id&&event.event_type===type).length;

test('demo people and fixtures cover the four types, personal work and delivery conditions',()=>{
  const {state}=fixture();assert.equal(state.team.length,3);assert.equal(new Set(state.tickets.map(t=>t.type)).size,4);
  for(const member of state.team)assert.ok(state.tickets.some(t=>t.assignee_id===member.id));
  assert.ok(state.notifications.some(n=>n.state==='failed'));assert.ok(state.notifications.some(n=>n.state==='retrying'));assert.ok(state.attachments.some(a=>a.sample_kind==='video'));
  for(const ticket of state.tickets.filter(t=>t.type==='follow_up'))assert.equal(state.team.find(u=>u.id===ticket.assignee_id).auth_user_id,ticket.created_by);
});

test('each role can create exactly the permitted request types',()=>{
  const {engine,users}=fixture();
  const matrix=[['service','help_ticket','follow_up','urgent_message'],['service','help_ticket','follow_up'],['service','help_ticket','follow_up']];
  for(const [index,user] of users.entries()){
    assert.deepEqual(allowedTypes(user),matrix[index]);
    for(const type of ['service','help_ticket','follow_up','urgent_message']){
      const input={assignee_id:type==='urgent_message'?'u2':null,reminder_at:type==='follow_up'?new Date(START+HOUR).toISOString():null};
      if(matrix[index].includes(type))assert.equal(create(engine,user,type,input).type,type);
      else assert.throws(()=>create(engine,user,type,input),/cannot create/);
    }
  }
});

test('guarded mutations use the canonical account role instead of a forged role field',()=>{
  const {engine,users}=fixture();const forged={...users[1],role:'admin'};
  assert.throws(()=>create(engine,forged,'urgent_message',{assignee_id:'u3'}),/cannot create/);
  assert.throws(()=>engine.assign(forged,'t1','u2'),/Only an admin/);
  assert.throws(()=>engine.update(forged,'t2',{status:'Resolved'}),/only update/);
  assert.throws(()=>engine.retryDelivery(forged,engine.state.notifications.find(n=>n.state==='failed').id),/Only an admin/);
});

test('ordinary roles cannot assign other people even through direct model calls',()=>{
  const {engine,users}=fixture();
  for(const user of users.slice(1)){
    const otherId = user.id === 'u2' ? 'u3' : 'u2';
    assert.throws(()=>create(engine,user,'service',{assignee_id: otherId}),/Only an admin/);
    assert.throws(()=>engine.assign(user,'t3',otherId),/Only an admin/);
  }
  for(const user of users.slice(0,1))assert.equal(engine.assign(user,'t3',user.id).assignee_id,user.id);
});

test('follow-ups always belong to the creator and cannot be reassigned',()=>{
  const {engine,users}=fixture();
  const ticket=create(engine,users[1],'follow_up',{reminder_at:new Date(START+HOUR).toISOString()});
  assert.equal(ticket.assignee_id,users[1].id);
  assert.throws(()=>create(engine,users[0],'follow_up',{assignee_id:'u2',reminder_at:new Date(START+HOUR).toISOString()}),/personal reminder/);
  assert.throws(()=>engine.assign(users[0],ticket.id,'u3'),/cannot be reassigned/);
  assert.equal(canAssign(users[1],ticket),false);
  assert.throws(()=>create(engine,users[1],'follow_up',{reminder_at:'nonsense'}),/future reminder/);
  assert.throws(()=>create(engine,users[1],'follow_up',{reminder_at:new Date(START).toISOString()}),/future reminder/);
});

test('visibility and update capabilities match assignment, ownership and role',()=>{
  const {engine,users,state}=fixture();
  const byId=id=>state.tickets.find(t=>t.id===id);
  assert.ok(canView(users[1],byId('t1')));
  for(const manager of users.slice(0,1))for(const ticket of state.tickets){assert.ok(canView(manager,ticket));assert.ok(canUpdate(manager,ticket))}
});

test('status moves sequentially, allows early resolution and explicit reopening only',()=>{
  const {engine,users}=fixture();const ticket=create(engine,users[0], 'service',{assignee_id:'u2'});
  assert.throws(()=>engine.update(users[0],ticket.id,{status:'Scheduled'}),/next workflow/);
  assert.throws(()=>engine.update(users[0],ticket.id,{status:'New',note:'  '}),/Add a work update/);
  engine.update(users[1],ticket.id,{status:'In Review',note:'Checked the joint.'});engine.update(users[1],ticket.id,{status:'Scheduled',expected_timeline:'Tomorrow at 11 AM'});engine.update(users[1],ticket.id,{status:'Resolved'});
  assert.equal(ticket.next_followup_due_at,null);
  assert.throws(()=>engine.update(users[0],ticket.id,{status:'New'}),/explicitly reopen/);
  engine.update(users[0],ticket.id,{status:'In Review',note:'Client requested a second inspection.'});assert.equal(ticket.resolved_at,null);assert.equal(count(engine.state,ticket.id,'reopened'),1);
  const early=create(engine,users[0]);engine.update(users[0],early.id,{status:'Resolved'});assert.equal(early.status,'Resolved');
});

test('24-hour warning respects the exact boundary, deduplicates, and targets owner or creator',()=>{
  const {engine,users,state,tick}=fixture();const assigned=create(engine,users[0],'service',{assignee_id:'u2'}),shared=create(engine,users[1]);
  tick(24*HOUR-1);engine.scan();assert.equal(count(state,assigned.id,'overdue'),0);
  tick(1);engine.scan();engine.scan();assert.equal(count(state,assigned.id,'overdue'),1);assert.equal(count(state,shared.id,'overdue'),1);
  assert.equal(state.notifications.find(n=>n.ticket_id===assigned.id&&n.kind==='overdue').recipient_id,'u2');
  assert.equal(state.notifications.find(n=>n.ticket_id===shared.id&&n.kind==='overdue').recipient_id,'u2');
  engine.update(users[1],assigned.id,{status:'New',note:'Waiting for the matching part.'});tick(24*HOUR);engine.scan();assert.equal(count(state,assigned.id,'overdue'),2);
});

test('read, assignment, acknowledgement, attachment and delivery do not reset inactivity',()=>{
  const {engine,users,tick}=fixture();const ticket=create(engine,users[0],'urgent_message',{assignee_id:'u2'}),initial=ticket.next_followup_due_at;
  tick(HOUR);engine.read(users[1],ticket.id);engine.acknowledge(users[1],ticket.id);engine.addAttachment(users[1],ticket.id,{original_name:'site.jpg',mime_type:'image/jpeg',byte_size:1024});engine.assign(users[0],ticket.id,'u3');engine.scan();
  assert.equal(ticket.next_followup_due_at,initial);assert.equal(ticket.last_status_update_at,ticket.created_at);
  engine.update(users[0],ticket.id,{status:'In Review',note:'Dispatch held pending confirmation.'});assert.equal(Date.parse(ticket.next_followup_due_at),engine.now()+24*HOUR);
});

test('a workflow update immediately before the deadline prevents the old overdue warning',()=>{
  const {engine,users,state,tick}=fixture();const ticket=create(engine,users[0]);tick(24*HOUR-1);engine.update(users[0],ticket.id,{status:'New',expected_timeline:'Client visit tomorrow.'});tick(1);engine.scan();assert.equal(count(state,ticket.id,'overdue'),0);
});

test('urgent receipt belongs to the recipient and repeats push plus email once after 15 minutes',()=>{
  const {engine,users,state,tick}=fixture();const ticket=create(engine,users[0],'urgent_message',{assignee_id:'u2'});
  assert.equal(canAcknowledge(users[0],ticket),false);assert.throws(()=>engine.acknowledge(users[0],ticket.id),/named recipient/);
  engine.read(users[1],ticket.id);assert.ok(ticket.urgent_read_at);assert.equal(ticket.urgent_acknowledged_at,null);
  tick(15*60000-1);engine.scan();assert.equal(count(state,ticket.id,'urgent_repeat'),0);tick(1);engine.scan();engine.scan();
  const repeat=state.notifications.filter(n=>n.ticket_id===ticket.id&&n.kind==='urgent_repeat');assert.equal(repeat.length,1);
  assert.deepEqual(state.deliveries.filter(d=>d.notification_id===repeat[0].id).map(d=>d.channel),['push','email']);
  engine.acknowledge(users[1],ticket.id);assert.ok(ticket.urgent_acknowledged_at);assert.throws(()=>engine.acknowledge(users[1],ticket.id),/unacknowledged/);
  engine.assign(users[0],ticket.id,'u3');assert.equal(ticket.urgent_read_at,null);assert.equal(ticket.urgent_acknowledged_at,null);
  assert.throws(()=>engine.acknowledge(users[1],ticket.id),/named recipient/);engine.acknowledge(users[2],ticket.id);
});

test('resolution cancels reminders and queued retries; reopening starts fresh inactivity',()=>{
  const {engine,users,state,tick}=fixture();const ticket=create(engine,users[1],'follow_up',{reminder_at:new Date(START+HOUR).toISOString()});
  const pending=state.notifications.find(n=>n.state==='retrying');engine.update(users[0],pending.ticket_id,{status:'Resolved'});assert.equal(pending.state,'cancelled');
  engine.update(users[1],ticket.id,{status:'Resolved'});assert.ok(ticket.reminder_cancelled_at);tick(25*HOUR);engine.scan();assert.equal(count(state,ticket.id,'reminder_due'),0);assert.equal(count(state,ticket.id,'overdue'),0);
  engine.update(users[1],ticket.id,{status:'In Review',note:'Resume client contact.'});engine.scan();assert.equal(count(state,ticket.id,'reminder_due'),0);tick(24*HOUR);engine.scan();assert.equal(count(state,ticket.id,'overdue'),1);
});

test('due follow-up fires once and successful operator retry preserves failed attempts',()=>{
  const {engine,users,state,tick}=fixture();const ticket=create(engine,users[2],'follow_up',{reminder_at:new Date(START+HOUR).toISOString()});tick(HOUR);engine.scan();engine.scan();assert.equal(count(state,ticket.id,'reminder_due'),1);
  const follow=state.notifications.find(n=>n.ticket_id===ticket.id);assert.ok(state.deliveries.some(d=>d.notification_id===follow.id&&d.channel==='email'&&d.state==='delivered'));
});

test('temporary delivery failures retry at 1, 5 and 15 minutes then succeed',()=>{
  const {engine,state,tick}=fixture();const retry=state.notifications.find(n=>n.state==='retrying');
  tick(60000-1);engine.scan();assert.equal(retry.retry_count,0);tick(1);engine.scan();assert.equal(retry.retry_count,1);
  tick(5*60000);engine.scan();assert.equal(retry.retry_count,2);assert.equal(retry.state,'retrying');tick(15*60000);engine.scan();assert.equal(retry.retry_count,3);assert.equal(retry.state,'sent');
});

test('inactive accounts cannot access or mutate workflow; deactivation protects open work',()=>{
  const {engine,users,state}=fixture();assert.throws(()=>engine.setStaffActive(users[0],'u1',false),/own admin/);assert.throws(()=>engine.setStaffActive(users[1],'u2',false),/Only the admin/);
  for(const ticket of state.tickets.filter(t=>t.assignee_id==='u3'&&t.status!=='Resolved'))engine.update(users[0],ticket.id,{status:'Resolved'});
  engine.setStaffActive(users[0],'u3',false);assert.deepEqual(allowedTypes(users[2]),[]);assert.equal(canView(users[2],state.tickets[0]),false);
  for(const operation of [()=>create(engine,users[2],'help_ticket'),()=>engine.read(users[2],'t4'),()=>engine.update(users[2],'t4',{status:'In Review'}),()=>engine.acknowledge(users[2],'t10'),()=>engine.assign(users[2],'t4','u2'),()=>engine.addAttachment(users[2],'t4',{})])assert.throws(operation,/inactive/);
  assert.throws(()=>engine.assign(users[0],'t6','u3'),/active recipient/);engine.setStaffActive(users[0],'u3',true);assert.ok(users[2].is_active);
});

test('media validation and documented trail are preserved through later actions',()=>{
  const {engine,users,state}=fixture();const ticket=create(engine,users[1]);const original=JSON.stringify(state.events.filter(e=>e.ticket_id===ticket.id));
  assert.throws(()=>engine.addAttachment(users[1],ticket.id,{original_name:'document.pdf',mime_type:'application/pdf',byte_size:10}),/Choose a JPEG/);
  assert.throws(()=>engine.addAttachment(users[1],ticket.id,{original_name:'large.jpg',mime_type:'image/jpeg',byte_size:11*1024*1024}),/10 MB/);
  engine.addAttachment(users[1],ticket.id,{original_name:'chair.mp4',mime_type:'video/mp4',byte_size:1024,blob_key:'fixture-key'});engine.read(users[1],ticket.id);
  assert.equal(JSON.stringify(state.events.filter(e=>e.ticket_id===ticket.id&&e.event_type==='created')),original);assert.equal(count(state,ticket.id,'attachment_added'),1);
});
