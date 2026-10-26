const PAGE_SIZE=50;
const timestamp=value=>new Intl.DateTimeFormat('en-IN',{day:'numeric',month:'short',hour:'numeric',minute:'2-digit',timeZone:'Asia/Calcutta'}).format(new Date(value));
const compare=(a,b)=>BigInt(a.id)<BigInt(b.id)?-1:BigInt(a.id)>BigInt(b.id)?1:0;

export class TeamChat {
  constructor(repository,nameFor,doc=document) {
    this.repository=repository;this.nameFor=nameFor;this.doc=doc;this.generation=0;
    this.el=Object.fromEntries(['chatMessages','chatText','chatSend','chatForm','chatError','chatStatus','chatCount','chatOlder','chatJump','chatLength','chatAnnouncement','chatClearBtn','chatClearDialog','chatClearCancel','chatClearClose','chatClearConfirm','chatClearError'].map(id=>[id,doc.getElementById(id)]));
    this.el.chatForm.addEventListener('submit',event=>{event.preventDefault();void this.send();});
    this.el.chatText.addEventListener('input',()=>{this.el.chatLength.textContent=this.el.chatText.value.length+' / 2000';this.resizeComposer();});
    this.el.chatText.addEventListener('keydown',event=>{
      if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();if(!event.repeat)void this.send();}
    });
    this.el.chatOlder.addEventListener('click',()=>void this.older());
    this.el.chatJump.addEventListener('click',()=>this.bottom());
    this.el.chatClearBtn.addEventListener('click',()=>{this.el.chatClearError.hidden=true;this.el.chatClearDialog.showModal();});
    this.el.chatClearCancel.addEventListener('click',()=>this.el.chatClearDialog.close());
    this.el.chatClearClose.addEventListener('click',()=>this.el.chatClearDialog.close());
    this.el.chatClearConfirm.addEventListener('click',()=>void this.clearHistory());
    this.doc.addEventListener('visibilitychange',()=>{if(!this.doc.hidden&&this.user)void this.sync();});
    this.doc.defaultView?.addEventListener('focus',()=>{if(this.user)void this.sync();});
    this.doc.defaultView?.addEventListener('online',()=>{if(this.user)void this.sync();});
    // Reflow a draft when the available width changes, without observing height changes.
    const Observer=doc.defaultView?.ResizeObserver;
    if(Observer){this.composerObserver=new Observer(([entry])=>{if(entry.contentRect.width!==this.composerWidth){this.composerWidth=entry.contentRect.width;this.resizeComposer();}});this.composerObserver.observe(this.el.chatForm);}
    this.stop();
  }
  resizeComposer() {
    const input=this.el.chatText;if(!input.offsetWidth)return;
    input.style.height='auto';
    const maxHeight=parseFloat(this.doc.defaultView.getComputedStyle(input).maxHeight);
    input.style.height=Math.min(input.scrollHeight+input.offsetHeight-input.clientHeight,maxHeight)+'px';
  }
  stop() {
    this.generation++;
    if(this.unsubscribe)void Promise.resolve(this.unsubscribe()).catch(()=>{});
    this.unsubscribe=null;clearInterval(this.timer);
    this.user=null;this.messages=[];this.cursor=undefined;this.initialized=false;this.ready=false;
    this.syncing=false;this.sending=false;this.loadingOlder=false;this.visible=false;this.live=false;this.unread=0;this.pending=null;this.hasOlder=false;
    this.revision=undefined;this.clearAvailable=false;
    this.el.chatMessages.replaceChildren();this.el.chatText.value='';this.el.chatText.style.height='';this.el.chatText.readOnly=false;
    this.el.chatText.disabled=true;this.el.chatSend.disabled=true;this.el.chatSend.setAttribute('aria-label','Send message');
    this.el.chatLength.textContent='0 / 2000';this.el.chatCount.textContent='';
    this.el.chatOlder.hidden=true;this.el.chatOlder.disabled=false;this.el.chatJump.hidden=true;this.el.chatError.hidden=true;
    this.el.chatClearBtn.hidden=true;this.el.chatClearBtn.disabled=false;
    this.el.chatClearConfirm.disabled=false;this.el.chatClearError.hidden=true;
    this.el.chatStatus.textContent='Sign in to join the conversation.';this.el.chatAnnouncement.textContent='';
  }
  setUser(user) {
    if(user?.id===this.user?.id){this.user=user;if(this.visible)this.render();return;}
    this.stop();if(!user?.is_active)return;
    this.user=user;const generation=this.generation;
    this.el.chatStatus.textContent='Loading team chat…';
    this.unsubscribe=this.repository.watchChat(()=>{
      if(generation===this.generation)void this.sync();
    },status=>{
      if(generation!==this.generation)return;
      this.live=status==='SUBSCRIBED';this.status();
      if(this.live)void this.sync();
    });
    // Polling also catches missed events after reconnecting or without Realtime.
    this.timer=setInterval(()=>{if(this.user)void this.sync();},8000);
    void this.sync();
  }
  setVisible(visible) {
    const changed=visible&&!this.visible;this.visible=visible;
    if(visible){this.unread=0;this.markSeen();this.badge();if(changed){this.render();this.bottom();this.resizeComposer();}void this.sync();}
  }
  status() {
    if(this.ready)this.el.chatStatus.textContent=this.live?'Live updates · Everyone on your team':'Checking for new messages every few seconds';
  }
  badge() {
    const text=this.unread?String(Math.min(this.unread,99))+(this.unread>99?'+':''):'';
    this.el.chatCount.textContent=text;
    this.el.chatCount.setAttribute('aria-label',this.unread?(this.unread===1?'1 unread team message':text+' unread team messages'):'No unread team messages');
  }
  seenKey() {return this.user?'oak-chat-seen:'+this.user.id:null;}
  seenMessage() {
    try {return this.doc.defaultView?.localStorage.getItem(this.seenKey());} catch {return null;}
  }
  markSeen() {
    const id=this.messages.at(-1)?.id;if(!id||!this.user)return;
    try {this.doc.defaultView?.localStorage.setItem(this.seenKey(),String(id));} catch { /* The live badge still works when device storage is unavailable. */ }
  }
  afterSeen(message,seen) {
    try {return BigInt(message.id)>BigInt(seen);} catch {return false;}
  }
  bottom() {this.el.chatMessages.scrollTop=this.el.chatMessages.scrollHeight;this.el.chatJump.hidden=true;}
  nearBottom() {const list=this.el.chatMessages;return list.scrollHeight-list.scrollTop-list.clientHeight<90;}
  failure(error,sending=false) {
    let message=sending?'Could not confirm your message. Your text is kept; press Send to retry safely.':'Chat cannot connect. Retrying automatically…';
    if(['42P01','PGRST205','PGRST202','42883'].includes(error?.code))message='Team chat is being set up. Please contact Admin.';
    else if(error?.code==='42501')message='Chat access is unavailable. Please sign in again.';
    else if(error?.message==='Too many messages. Please wait a minute and try again.')message=error.message;
    this.el.chatError.textContent=message;this.el.chatError.hidden=false;
    this.el.chatStatus.textContent=sending?'Message not confirmed':'Connection unavailable';
  }
  merge(rows,{initial=false,older=false}={}) {
    const existing=new Set(this.messages.map(message=>String(message.id)));
    const added=rows.filter(message=>!existing.has(String(message.id)));
    if(!added.length&&!initial)return;
    const near=this.nearBottom(),oldHeight=this.el.chatMessages.scrollHeight,oldTop=this.el.chatMessages.scrollTop;
    this.messages=[...this.messages,...added].sort(compare);this.render();
    if(older)this.el.chatMessages.scrollTop=oldTop+this.el.chatMessages.scrollHeight-oldHeight;
    else if(initial||near)this.bottom();
    else this.el.chatJump.hidden=false;
    if(!initial&&!older){
      const others=added.filter(message=>message.sender_id!==this.user.id).length;
      if(!this.visible){this.unread+=others;this.badge();}
      else this.markSeen();
      if(others)this.el.chatAnnouncement.textContent=others===1?'New team message.':others+' new team messages.';
    }
  }
  async sync() {
    if(!this.user||this.syncing)return;
    const generation=this.generation;this.syncing=true;
    try {
      const state=await this.repository.chatRevision();if(generation!==this.generation)return;
      this.clearAvailable=Boolean(state);
      this.el.chatClearBtn.hidden=this.user.role!=='admin'||!this.clearAvailable;
      if(state&&this.revision!==undefined&&String(state.clear_revision)!==String(this.revision)){
        this.messages=[];this.cursor=0;this.hasOlder=false;this.initialized=true;this.unread=0;this.badge();
        this.el.chatMessages.replaceChildren();this.el.chatOlder.hidden=true;this.el.chatJump.hidden=true;
        if(this.visible)this.bottom();
      }
      this.revision=state?.clear_revision;
      if(!this.initialized){
        const rows=await this.repository.chatMessages();if(generation!==this.generation)return;
        const seen=this.seenMessage();
        this.hasOlder=rows.length===PAGE_SIZE;this.cursor=rows.at(-1)?.id??0;
        this.merge(rows,{initial:true});this.initialized=true;
        if(this.visible)this.markSeen();
        else if(seen===null)this.markSeen();
        else {this.unread=rows.filter(message=>message.sender_id!==this.user.id&&this.afterSeen(message,seen)).length;this.badge();}
      }else{
        for(let page=0;page<4;page++){
          const rows=await this.repository.chatMessages({after:this.cursor});if(generation!==this.generation)return;
          this.merge(rows);if(rows.length)this.cursor=rows.at(-1).id;
          if(rows.length<PAGE_SIZE)break;
        }
      }
      this.ready=true;this.el.chatText.disabled=false;this.el.chatSend.disabled=this.sending;
      if(!this.pending)this.el.chatError.hidden=true;
      this.el.chatOlder.hidden=!this.hasOlder;this.status();
    }catch(error){if(generation===this.generation){this.ready=false;this.el.chatSend.disabled=true;this.failure(error);}}
    finally{if(generation===this.generation)this.syncing=false;}
  }
  async clearHistory() {
    if(this.user?.role!=='admin'||!this.ready||this.el.chatClearConfirm.disabled)return;
    const generation=this.generation;this.el.chatClearConfirm.disabled=true;this.el.chatClearError.hidden=true;this.el.chatError.hidden=true;
    try {
      await this.repository.clearChatHistory();if(generation!==this.generation)return;
      this.el.chatClearDialog.close();
      this.messages=[];this.cursor=0;this.hasOlder=false;this.initialized=true;this.unread=0;this.badge();
      this.el.chatMessages.replaceChildren();this.el.chatOlder.hidden=true;this.el.chatJump.hidden=true;
      this.el.chatStatus.textContent='Chat history cleared for everyone.';this.el.chatAnnouncement.textContent='Team chat history cleared.';
      this.bottom();void this.sync();
    }catch(error){
      if(generation===this.generation){
        this.el.chatClearError.textContent=error?.code==='42501'?'Only an active Admin can clear team chat.':'Could not clear chat history. Please try again.';
        this.el.chatClearError.hidden=false;
      }
    }finally{if(generation===this.generation)this.el.chatClearConfirm.disabled=false;}
  }
  async older() {
    if(!this.user||!this.hasOlder||this.loadingOlder)return;
    const generation=this.generation;this.loadingOlder=true;this.el.chatOlder.disabled=true;
    try {
      const rows=await this.repository.chatMessages({before:this.messages[0].id});if(generation!==this.generation)return;
      this.hasOlder=rows.length===PAGE_SIZE;this.merge(rows,{older:true});this.el.chatOlder.hidden=!this.hasOlder;
    }catch(error){if(generation===this.generation)this.failure(error);}
    finally{if(generation===this.generation){this.loadingOlder=false;this.el.chatOlder.disabled=false;}}
  }
  async send() {
    if(!this.user||!this.ready||this.sending)return;
    const body=this.el.chatText.value.trim();if(!body)return;
    if(body.length>2000){this.el.chatError.textContent='Keep your message within 2000 characters.';this.el.chatError.hidden=false;return;}
    const generation=this.generation;
    if(this.pending?.body!==body)this.pending={id:crypto.randomUUID(),body};
    this.sending=true;this.el.chatSend.disabled=true;this.el.chatSend.setAttribute('aria-label','Sending message');this.el.chatText.readOnly=true;
    try {
      const message=await this.repository.sendChatMessage(body,this.pending.id);if(generation!==this.generation)return;
      this.merge([message]);this.bottom();this.el.chatText.value='';this.el.chatLength.textContent='0 / 2000';this.resizeComposer();
      this.pending=null;this.el.chatError.hidden=true;this.status();this.el.chatAnnouncement.textContent='Message sent.';
    }catch(error){if(generation===this.generation)this.failure(error,true);}
    finally{
      if(generation===this.generation){this.sending=false;this.el.chatSend.disabled=!this.ready;this.el.chatSend.setAttribute('aria-label','Send message');this.el.chatText.readOnly=false;if(this.visible)this.el.chatText.focus();}
    }
  }
  render() {
    const list=this.el.chatMessages,top=list.scrollTop;list.replaceChildren();
    if(!this.messages.length){
      const empty=this.doc.createElement('li');empty.className='chat-empty';empty.textContent='Start the conversation. Share a quick update or ask your team a question.';list.append(empty);return;
    }
    for(const message of this.messages){
      const own=message.sender_id===this.user?.id;
      const row=this.doc.createElement('li');row.className='chat-message'+(own?' chat-own':'');
      const bubble=this.doc.createElement('article');bubble.className='chat-bubble';
      const author=this.doc.createElement('strong');author.className='chat-author';author.textContent=own?'You':this.nameFor(message.sender_id);
      const body=this.doc.createElement('p');body.className='chat-body';body.textContent=message.body;
      const time=this.doc.createElement('time');time.dateTime=message.created_at;time.textContent=timestamp(message.created_at)+' IST';
      bubble.append(author,body,time);row.append(bubble);list.append(row);
    }
    list.scrollTop=top;
  }
}
