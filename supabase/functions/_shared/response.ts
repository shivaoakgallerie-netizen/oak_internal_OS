export const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
export const requireServiceRole=(request:Request)=>{
  const expected=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const received=request.headers.get('authorization')?.replace(/^Bearer\s+/i,'');
  if(!expected||received!==expected)throw new Error('Unauthorized');
};
