export const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
export async function readLimitedBody(request:Request,maxBytes:number):Promise<string>{
  const length=request.headers.get('content-length');
  if(length!==null&&Number(length)>maxBytes)throw new Error('Request too large');
  const reader=request.body?.getReader();
  if(!reader)return '';
  const chunks:Uint8Array[]=[];let size=0;
  try{
    for(;;){
      const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;
      if(size>maxBytes)throw new Error('Request too large');
      chunks.push(value);
    }
  }catch(error){await reader.cancel().catch(()=>{});throw error;}
  const bytes=new Uint8Array(size);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
  catch{throw new SyntaxError('Invalid UTF-8 request body');}
}
export const requireServiceRole=(request:Request)=>{
  // Supabase's Edge gateway verifies the JWT signature when verify_jwt=true.
  // Check the signed claim here because the default service-role key available
  // inside Edge Functions may use a different key format than the legacy JWT
  // used by pg_cron to invoke this function.
  const token=request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  const payload=token?.split('.')[1];
  if(!payload)throw new Error('Unauthorized');
  try{
    const base64=payload.replace(/-/g,'+').replace(/_/g,'/');
    const claims=JSON.parse(atob(base64+'='.repeat((4-base64.length%4)%4)));
    if(claims.role!=='service_role'||claims.iss!=='supabase'||!Number.isFinite(claims.exp)||claims.exp<=Date.now()/1000)throw new Error('Unauthorized');
  }catch{throw new Error('Unauthorized');}
};
