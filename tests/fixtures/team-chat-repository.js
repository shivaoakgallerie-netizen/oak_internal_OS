// Browser-test fixture only. Never copied into dist or used for live authentication.
const staff={id:'staff-a',auth_user_id:'auth-a',name:'Rohit Ghosh',role:'staff',department:'Interior design',is_active:true};
const other={id:'staff-b',auth_user_id:'auth-b',name:'Shibani',role:'staff',is_active:true};
const admin={id:'admin',auth_user_id:'auth-admin',name:'Aditya',role:'admin',department:'Management',is_active:true};
const fixture=globalThis.chatFixture={
 clearRevision:0,
 messages:[
  {id:1,sender_id:'staff-b',body:'Good morning, team! Please share today’s site updates here.',created_at:'2026-10-09T03:30:00Z'},
  {id:2,sender_id:'staff-a',body:'The client has confirmed the meeting for 3 PM.',created_at:'2026-10-09T03:32:00Z'},
  {id:3,sender_id:'staff-b',body:'Thanks! I will bring the latest design drawings.',created_at:'2026-10-09T03:34:00Z'}
 ],sent:[],dedupe:new Map(),sequence:3,
 append(body,sender_id='staff-b') {const row={id:++this.sequence,sender_id,body,created_at:new Date().toISOString()};this.messages.push(row);this.changed?.();return row;}
};
export class LiveRepository {
 constructor(){this.user=staff;this.client={auth:{getSession:async()=>({data:{session:{}}}),onAuthStateChange:()=>{}}};}
 async load(){return {currentUser:this.user,state:{team:[staff,other,admin],tickets:[],clients:[],projects:[],events:[],attachments:[],notifications:[],deliveries:[],workerRuns:[]}};}
 async login(email){this.user=email.startsWith('admin')?admin:staff;return this.user;}
 async logout(){}
 async chatMessages({before,after}={}){let rows=fixture.messages.filter(row=>(before===undefined||row.id<before)&&(after===undefined||row.id>after));return after===undefined?rows.slice(-50):rows.slice(0,50);}
 async chatRevision(){return {clear_revision:fixture.clearRevision};}
 async clearChatHistory(){if(this.user.role!=='admin')throw Object.assign(new Error('Only active Admin'),{code:'42501'});const deleted=fixture.messages.length;fixture.messages.length=0;fixture.clearRevision++;fixture.changed?.();return deleted;}
 async sendChatMessage(body,id){
  const sender=this.user.id;fixture.sent.push({body,id});
  if(fixture.hold)await new Promise(resolve=>{fixture.release=resolve;});
  const key=sender+id;let row=fixture.dedupe.get(key);
  if(!row){row=fixture.append(body,sender);fixture.dedupe.set(key,row);}
  if(fixture.failAfterSave){fixture.failAfterSave=false;throw new Error('Simulated lost response');}
  return row;
 }
 watchChat(change,status){fixture.changed=change;queueMicrotask(()=>status('SUBSCRIBED'));return ()=>{fixture.changed=null;};}
}
