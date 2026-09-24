-- Run against a disposable Supabase database after applying schema.sql:
-- supabase test db --file tests/workflow.sql
begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(12);

insert into public.team_users(id,auth_user_id,name,phone,email) values
 ('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','Test Creator','+919800000001','creator@example.test'),
 ('10000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000002','Test Recipient','+919800000002','recipient@example.test');
insert into public.clients(id,name,phone) values('30000000-0000-0000-0000-000000000001','Test Client','+919800000003');
insert into public.projects(id,client_id,name) values('40000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','Test Project');
select set_config('request.jwt.claims','{"sub":"20000000-0000-0000-0000-000000000001","role":"authenticated"}',true);

select extensions.throws_ok(
 $$select public.create_request('service','Missing project')$$,
 'Service requests require a project',
 'service requires a project'
);
select extensions.lives_ok(
 $$select public.create_request('service','Repair chair','40000000-0000-0000-0000-000000000001')$$,
 'service request can be created'
);
select extensions.is((select type::text from public.tickets where note='Repair chair'),'service','service type is stored');

select extensions.throws_ok(
 $$select public.create_request('urgent_message','Call now')$$,
 'Urgent messages require a recipient',
 'urgent requires a recipient'
);
select extensions.lives_ok(
 $$select public.create_request('urgent_message','Call now',null,'10000000-0000-0000-0000-000000000002')$$,
 'urgent request can target active staff'
);
select extensions.is((select count(*)::integer from public.notifications where kind='urgent'),1,'urgent request queues one notification');

select extensions.lives_ok(
 $$select public.create_request('follow_up','Check tomorrow',null,null,now()+interval '24 hours')$$,
 'follow-up can be scheduled'
);
select extensions.is(
 (select assignee_id::text from public.tickets where note='Check tomorrow'),
 '10000000-0000-0000-0000-000000000001',
 'follow-up is assigned to its creator'
);

select extensions.lives_ok(
 $$select public.record_request_update((select id from public.tickets where note='Repair chair'),'In Review','Inspection booked','Tomorrow at 3 PM')$$,
 'open workflow update records timeline and resets clock'
);
select extensions.ok(
 (select next_followup_due_at>now()+interval '23 hours 59 minutes' from public.tickets where note='Repair chair'),
 'workflow update resets the 24-hour clock'
);

select set_config('request.jwt.claims','{"sub":"20000000-0000-0000-0000-000000000001","role":"authenticated"}',true);
select extensions.throws_ok(
 $$select public.acknowledge_urgent((select id from public.tickets where note='Call now'))$$,
 'Only the urgent message recipient can acknowledge it',
 'non-recipient cannot acknowledge urgent message'
);
select set_config('request.jwt.claims','{"sub":"20000000-0000-0000-0000-000000000002","role":"authenticated"}',true);
select extensions.lives_ok(
 $$select public.acknowledge_urgent((select id from public.tickets where note='Call now'))$$,
 'recipient can acknowledge urgent message'
);

select * from extensions.finish();
rollback;
