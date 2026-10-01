import {createClient,SupabaseClient} from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';
import {json,requireServiceRole} from '../_shared/response.ts';

type NotificationRow={id:string;ticket_id:string;recipient_id:string;kind:string;attempt_count:number};
type Ticket={id:string;note:string;type:string;status:string;assignee_id:string|null;created_by:string;next_followup_due_at:string;urgent_acknowledged_at:string|null};
type Recipient={id:string;name:string;email:string|null;notification_email:string|null};
type Subscription={id:string;endpoint:string;p256dh:string;auth_key:string};
const RETRY_MINUTES=[1,5,15];
const labels:Record<string,string>={assigned:'New assigned request',follow_up_due:'Follow-up reminder',overdue:'24-hour update due',urgent:'Urgent message',urgent_retry:'Urgent message still unacknowledged'};

const escapeHtml=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
const recordAttempt=async(client:SupabaseClient,n:NotificationRow,channel:'push'|'email',state:'accepted'|'failed',provider:string,providerId?:string,error?:unknown)=>{
  const message=error instanceof Error?error.message:error?String(error):null;
  const result=await client.from('delivery_attempts').insert({notification_id:n.id,channel,provider,state,attempt_number:n.attempt_count,provider_message_id:providerId||null,error_message:message});
  if(result.error)throw result.error;
};
const sendEmail=async(recipient:Recipient,ticket:Ticket,n:NotificationRow)=>{
  const address=recipient.notification_email||recipient.email;
  if(!address)throw new Error('Email fallback unavailable: no notification address is configured. Enable device push and monitor the in-app inbox.');
  if(!Deno.env.get('RESEND_API_KEY')||!Deno.env.get('RESEND_FROM_EMAIL'))throw new Error('Email delivery provider is not configured.');
  const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{authorization:`Bearer ${Deno.env.get('RESEND_API_KEY')}`,'content-type':'application/json','idempotency-key':`${n.id}:email`},body:JSON.stringify({
    from:Deno.env.get('RESEND_FROM_EMAIL'),to:[address],subject:`${labels[n.kind]||'Oak workflow'} - ${ticket.note.slice(0,80)}`,
    html:`<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto"><p style="color:#8a6b46;font-weight:700">OAK GALLERIE · INTERNAL</p><h2>${escapeHtml(labels[n.kind]||'Request update')}</h2><p>Assigned recipient: ${escapeHtml(recipient.name)}</p><p>${escapeHtml(ticket.note)}</p><p><a href="${Deno.env.get('APP_URL')}#request=${ticket.id}" style="display:inline-block;padding:12px 16px;background:#171715;color:white;text-decoration:none;border-radius:8px">Open request</a></p>${n.kind.startsWith('urgent')?'<p>The assigned recipient must sign in and acknowledge this urgent message in the app.</p>':''}</div>`
  })});
  const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body.message||`Resend returned ${response.status}`);return body.id as string;
};

async function processOne(client:SupabaseClient,n:NotificationRow,ticket:Ticket,recipient:Recipient,subscriptions:Subscription[]){
  // A job can be cancelled or reassigned after the worker claims its batch.
  const latest=await client.from('notifications').select('state,recipient_id').eq('id',n.id).single();
  if(latest.error)throw latest.error;
  if(latest.data.state!=='processing'||latest.data.recipient_id!==n.recipient_id)return;
  if(ticket.status==='Resolved'||(['assigned','urgent','urgent_retry'].includes(n.kind)&&ticket.assignee_id!==n.recipient_id)||(n.kind==='overdue'&&new Date(ticket.next_followup_due_at)>new Date())||(n.kind.startsWith('urgent')&&ticket.urgent_acknowledged_at)){
    await client.from('notifications').update({state:'cancelled',processed_at:new Date().toISOString()}).eq('id',n.id).eq('state','processing');return;
  }
  const title=labels[n.kind]||'Oak Gallerie workflow',url=`${Deno.env.get('APP_URL')}#request=${ticket.id}`;
  let pushAccepted=false,pushAttempted=false,lastError:unknown;
  for(const subscription of subscriptions){
    pushAttempted=true;
    try{
      await webpush.sendNotification({endpoint:subscription.endpoint,keys:{p256dh:subscription.p256dh,auth:subscription.auth_key}},JSON.stringify({title,body:'Sign in to view your workflow notification.',url,tag:`oak-${ticket.id}`}));
      pushAccepted=true;await recordAttempt(client,n,'push','accepted','web-push');
    }catch(error){
      lastError=error;await recordAttempt(client,n,'push','failed','web-push',undefined,error);
      const status=(error as {statusCode?:number}).statusCode;if(status===404||status===410)await client.from('push_subscriptions').update({revoked_at:new Date().toISOString()}).eq('id',subscription.id);
    }
  }
  const mustEmail=n.kind==='urgent_retry'||!pushAttempted||!pushAccepted;
  let emailAccepted=false;
  if(mustEmail){
    try{const id=await sendEmail(recipient,ticket,n);emailAccepted=true;await recordAttempt(client,n,'email','accepted','resend',id)}catch(error){lastError=error;await recordAttempt(client,n,'email','failed',(recipient.notification_email||recipient.email)?'resend':'unavailable',undefined,error)}
  }
  const accepted=pushAccepted||emailAccepted;
  if(accepted){
    await client.from('notifications').update({state:'sent',processed_at:new Date().toISOString(),last_error:null}).eq('id',n.id).eq('state','processing');
    await client.from('request_events').insert({ticket_id:ticket.id,event_type:'notification_sent',metadata:{notification_id:n.id,kind:n.kind,push_accepted:pushAccepted,email_accepted:emailAccepted}});
    return;
  }
  const terminal=n.attempt_count>=4,delay=RETRY_MINUTES[Math.min(n.attempt_count-1,RETRY_MINUTES.length-1)];
  await client.from('notifications').update({state:'failed',last_error:lastError instanceof Error?lastError.message:String(lastError||'No channel accepted the message'),next_attempt_at:new Date(Date.now()+delay*60000).toISOString(),processed_at:terminal?new Date().toISOString():null}).eq('id',n.id).eq('state','processing');
  await client.from('request_events').insert({ticket_id:ticket.id,event_type:'notification_failed',metadata:{notification_id:n.id,kind:n.kind,terminal,error:lastError instanceof Error?lastError.message:String(lastError)}});
}

Deno.serve(async request=>{
  const startedAt=new Date().toISOString();let client:SupabaseClient|undefined;
  try{
    requireServiceRole(request);
    const required=['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','VAPID_PUBLIC_KEY','VAPID_PRIVATE_KEY','VAPID_SUBJECT','APP_URL'];
    const missing=required.filter(name=>!Deno.env.get(name));if(missing.length)throw new Error(`Missing secrets: ${missing.join(', ')}`);
    webpush.setVapidDetails(Deno.env.get('VAPID_SUBJECT')!,Deno.env.get('VAPID_PUBLIC_KEY')!,Deno.env.get('VAPID_PRIVATE_KEY')!);
    client=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}});
    const claimed=await client.rpc('claim_notification_batch',{p_limit:25});if(claimed.error)throw claimed.error;
    const rows=(claimed.data||[]) as NotificationRow[];let processed=0;
    for(const n of rows){
      const [ticketResult,recipientResult,subscriptionResult]=await Promise.all([
        client.from('tickets').select('id,note,type,status,assignee_id,created_by,next_followup_due_at,urgent_acknowledged_at').eq('id',n.ticket_id).single(),
        client.from('team_users').select('id,name,email,notification_email').eq('id',n.recipient_id).eq('is_active',true).single(),
        client.from('push_subscriptions').select('id,endpoint,p256dh,auth_key').eq('team_user_id',n.recipient_id).is('revoked_at',null)
      ]);
      if(ticketResult.error||recipientResult.error){
        await client.from('notifications').update({state:'failed',last_error:ticketResult.error?.message||recipientResult.error?.message||'Missing request or recipient',processed_at:new Date().toISOString()}).eq('id',n.id);continue;
      }
      if(subscriptionResult.error)throw subscriptionResult.error;
      await processOne(client,n,ticketResult.data as Ticket,recipientResult.data as Recipient,(subscriptionResult.data||[]) as Subscription[]);processed++;
    }
    await client.from('worker_runs').insert({worker:'notification-worker',status:'succeeded',processed_count:processed,started_at:startedAt});
    return json({claimed:rows.length,processed,finishedAt:new Date().toISOString()});
  }catch(error){if(client)await client.from('worker_runs').insert({worker:'notification-worker',status:'failed',error_message:error instanceof Error?error.message:String(error),started_at:startedAt});return json({error:error instanceof Error?error.message:String(error)},error instanceof Error&&error.message==='Unauthorized'?401:500)}
});
