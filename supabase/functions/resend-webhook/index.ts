import {createClient} from 'npm:@supabase/supabase-js@2.117.2';
import {Webhook} from 'npm:svix@1.38.0';
import {json,readLimitedBody} from '../_shared/response.ts';

Deno.serve(async request=>{
  if(request.method!=='POST')return json({error:'Method not allowed'},405);
  try{
    const body=await readLimitedBody(request,65536),secret=Deno.env.get('RESEND_WEBHOOK_SECRET');
    if(!secret)return json({error:'Webhook is unavailable'},503);
    const payload=new Webhook(secret).verify(body,{
      'svix-id':request.headers.get('svix-id')||'',
      'svix-timestamp':request.headers.get('svix-timestamp')||'',
      'svix-signature':request.headers.get('svix-signature')||''
    }) as {type:string;data:{email_id?:string}};
    const providerId=payload.data.email_id;
    if(!providerId)return json({ignored:true});
    const states:Record<string,string>={'email.delivered':'delivered','email.bounced':'bounced','email.failed':'failed'};
    const state=states[payload.type];if(!state)return json({ignored:true,type:payload.type});
    const client=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}});
    const {error}=await client.from('delivery_attempts').update({state,updated_at:new Date().toISOString()}).eq('provider_message_id',providerId);
    if(error)throw error;return json({ok:true});
  }catch(error){return json({error:error instanceof Error&&error.message==='Request too large'?'Request too large':'Invalid webhook'},error instanceof Error&&error.message==='Request too large'?413:400)}
});
