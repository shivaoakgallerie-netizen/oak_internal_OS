import {createClient,SupabaseClient} from 'npm:@supabase/supabase-js@2';
import {json,requireServiceRole} from '../_shared/response.ts';

Deno.serve(async request=>{
  const startedAt=new Date().toISOString();let client:SupabaseClient|undefined;
  try{
    requireServiceRole(request);
    client=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}});
    const {data,error}=await client.rpc('enqueue_due_notifications');
    if(error)throw error;
    await client.from('worker_runs').insert({worker:'notification-scan',status:'succeeded',processed_count:data||0,started_at:startedAt});
    await client.from('worker_runs').delete().lt('finished_at',new Date(Date.now()-30*86400000).toISOString());
    return json({queued:data,scannedAt:new Date().toISOString()});
  }catch(error){if(client)await client.from('worker_runs').insert({worker:'notification-scan',status:'failed',error_message:error instanceof Error?error.message:String(error),started_at:startedAt});return json({error:error instanceof Error?error.message:String(error)},error instanceof Error&&error.message==='Unauthorized'?401:500)}
});
