import {createClient} from 'npm:@supabase/supabase-js@2';
import {manageStaff} from './handler.js';

Deno.serve(async request=>{
 const origin=request.headers.get('origin')||'';
 const allowed=(Deno.env.get('ACCOUNT_ALLOWED_ORIGINS')||Deno.env.get('APP_URL')||'').split(',').filter(Boolean).map(value=>new URL(value.trim()).origin);
 const headers={'content-type':'application/json','cache-control':'no-store','access-control-allow-origin':allowed.includes(origin)?origin:'','access-control-allow-headers':'authorization,apikey,content-type,x-client-info','access-control-allow-methods':'POST,OPTIONS','vary':'Origin'};
 const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers});
 if(origin&&!allowed.includes(origin))return response({error:'Origin is not allowed'},403);
 if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
 if(request.method!=='POST')return response({error:'Method not allowed'},405);
 const token=request.headers.get('authorization')?.replace(/^Bearer\s+/i,'');
 if(!token)return response({error:'Unauthorized'},401);
 try {
  if(Number(request.headers.get('content-length')||0)>8192)return response({error:'Request too large'},413);
  const body=await request.text();if(body.length>8192)return response({error:'Request too large'},413);
  const url=Deno.env.get('SUPABASE_URL')!,key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const options={auth:{persistSession:false,autoRefreshToken:false}};
  const client=createClient(url,key,options),reauthClient=createClient(url,Deno.env.get('SUPABASE_ANON_KEY')!,options);
  try{return response(await manageStaff({client,reauthClient,token,input:JSON.parse(body)}));}
  finally{await reauthClient.auth.signOut({scope:'local'}).catch(()=>{});}
 }catch(error){
  const message=error instanceof Error?error.message:'Unable to manage account';
  return response({error:message},/Unauthorized/.test(message)?401:/Only active Admin/.test(message)?403:400);
 }
});
