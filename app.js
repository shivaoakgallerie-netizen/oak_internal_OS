import { TYPE_LABEL, ROLE_LABEL, ROLE_DESCRIPTION, allowedTypes, canManage, canView, canUpdate, canAssign, canAcknowledge, canAttach, recipients, normalizePhone, notificationCancellationText, notificationTimingText, isNotificationRetryScheduled } from './workflow-rules.js';
import { LiveRepository } from './live-client.js';
import { scrubLegacyCredentials } from './legacy-cleanup.js';
import { TeamChat } from './team-chat.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const fmt = value => value ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Calcutta' }).format(new Date(value)) : '—';
const initials = name => name.split(' ').map(part => part[0]).join('').slice(0, 2);
const STATUS_LABEL = Object.freeze({New:'New','In Review':'In progress',Scheduled:'Planned',Resolved:'Done'});
const displayStatus = status => STATUS_LABEL[status] || status;
const deliveryStateLabel = state => ({queued:'Waiting to send',retrying:'Trying again',sent:'Sent',failed:'Needs attention',cancelled:'Not sent'})[state] || state;
const EVENT_LABEL = { created: 'Request added', assigned: 'Person assigned', status_updated: 'Progress updated', resolved: 'Marked done', reopened: 'Reopened', reminder_due: 'Personal reminder due', reminder_cancelled: 'Personal reminder stopped', overdue: 'Update needed', urgent_repeat: 'Urgent reminder repeated', notification_queued: 'Message waiting to send', notification_sent: 'Message sent', notification_failed: 'Message could not be sent', notification_cancelled: 'Message not sent', notification_retried: 'Message tried again', read: 'Request opened', acknowledged: 'Urgent message confirmed', attachment_added: 'Photo or video added' };
const KIND_LABEL = { assigned: 'Work assigned to you', urgent: 'Urgent message for you', urgent_retry: 'Please confirm urgent message', overdue: 'Request needs an update', follow_up_due: 'Your reminder is due' };
let repository, chat, workspace = {clients:[],team:[],projects:[],tickets:[],events:[],attachments:[],notifications:[],deliveries:[]};
let currentUser=null,currentTicketId=null,currentView='requests',busy=false,connected=false,authGeneration=0,captchaWidget;
let mediaURLs=[],previewURLs=[],mediaVersion=0;
let loginMode='staff';
let accountAction='create',accountId=null,accountCaptchaWidget,changeCaptchaWidget;
const state=()=>workspace;
const userById = id => state().team.find(user => user.id === id);
const actorName = authId => state().team.find(user => user.auth_user_id === authId)?.name || 'System';
const projectName = id => state().projects.find(project => project.id === id)?.name || 'No project';
const ticketById = id => state().tickets.find(ticket => ticket.id === id);
const isDue = t => t.status !== 'Resolved' && t.next_followup_due_at && Date.parse(t.next_followup_due_at) <= Date.now();
const isUrgent = t => t.type === 'urgent_message' && t.status !== 'Resolved' && !t.urgent_acknowledged_at;
const isReminderDue = t => t.type === 'follow_up' && t.status !== 'Resolved' && !t.reminder_cancelled_at && Date.parse(t.reminder_at) <= Date.now();
const visibleTickets = () => state().tickets.filter(ticket => canView(currentUser, ticket));
const toast = (message, error = false) => { const el = $('toast'); el.textContent = message; el.style.background = error ? '#943a31' : '#2b231b'; el.classList.remove('hidden'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.add('hidden'), 5000) };
const options = (items, label) => items.map(value => '<option value="' + esc(value) + '">' + esc(label(value)) + '</option>').join('');
const show = (id, visible) => $(id).classList.toggle('hidden', !visible);
const badge = (text, kind = '') => '<span class="badge ' + kind + '">' + esc(text) + '</span>';
const metric = (label, value, detail = '') => '<article class="card report-card"><span class="eyebrow">' + esc(label) + '</span><strong class="report-number">' + value + '</strong><p class="hint">' + esc(detail) + '</p></article>';
function revokeURLs(list) { for (const url of list) URL.revokeObjectURL(url); list.length=0; }
function closeDetail() { if ($('ticketDialog').open) $('ticketDialog').close(); currentTicketId=null; mediaVersion++; revokeURLs(mediaURLs); if(location.hash.startsWith('#request='))history.replaceState(null,'',location.pathname+location.search); }
function reportError(error) { toast(error.message||'Unable to complete this action.',true); }
function clearWorkspace() {
  chat?.stop();
  authGeneration++;currentUser=null;connected=false;workspace={clients:[],team:[],projects:[],tickets:[],events:[],attachments:[],notifications:[],deliveries:[]};
  closeDetail();for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();revokeURLs(previewURLs);
  for(const id of ['projectList','ticketList','inboxList','staffList','reportSummary','typeReport','workloadReport','resolvedReport','deliveryList','deliverySummary','detailTimeline','detailDelivery','detailMedia'])$(id).replaceChildren();
  $('staffAccountForm').reset();$('changePasswordForm').reset();accountId=null;
  show('workspace',false);show('login',true);$('loginForm').reset();setLoginMode(loginMode);
}
function setLoginMode(mode) {
  loginMode=mode;$('loginPassword').value='';setLoginPasswordVisible(false);
  $('loginTitle').textContent=mode==='staff'?'Team member sign in':'Admin sign in';
  $('loginHint').textContent=mode==='staff'?'Use your work email and password.':'Use your Admin email and password.';
  $('loginPhone').placeholder=mode==='staff'?'Your work email':'Admin email';
  show('loginModes',true);show('loginForm',true);
  show('loginError',false);
  for(const [id,selected] of [['staffLoginMode',mode==='staff'],['adminLoginMode',mode==='admin']]){
    $(id).classList.toggle('primary',selected);$(id).setAttribute('aria-pressed',String(selected));
  }
}
function setLoginPasswordVisible(visible) {
  $('loginPassword').type=visible?'text':'password';
  $('loginPasswordToggle').setAttribute('aria-pressed',String(visible));
  $('loginPasswordToggle').setAttribute('aria-label',visible?'Hide password':'Show password');
}
async function refresh() {
  const generation=authGeneration;
  try {
    const loaded=await repository.load();
    if(generation!==authGeneration)return;
    workspace=loaded.state;currentUser=loaded.currentUser;connected=true;
    $('projectFilter').innerHTML='<option value="">All projects</option>'+options(state().projects.map(p=>p.id),projectName);
    renderAll();
  } catch(error) { connected=false;clearWorkspace();throw error; }
}
async function change(action) {
  if(!currentUser||!connected)throw new Error('Sign in and reconnect before making a change.');
  const result=await action();
  try { await refresh(); } catch { throw new Error('The change may have saved, but the workspace could not reload. Sign in again and check the trail before retrying.'); }
  return result;
}
async function run(button,action) {
  if(busy)return;
  busy=true;const original=button?.innerHTML;if(button){button.disabled=true;button.textContent='Please wait…';}
  try {await action();}catch(error){reportError(error);}finally{busy=false;if(button){button.disabled=false;button.innerHTML=original;}}
}
function captchaToken(widget=captchaWidget) {return widget===undefined?undefined:globalThis.turnstile?.getResponse(widget);}
function resetCaptcha(widget=captchaWidget) {if(widget!==undefined)globalThis.turnstile?.reset(widget);}
function mountCaptcha(container,widget) {
  const siteKey=window.OAK_CONFIG?.captchaSiteKey;
  if(!siteKey||siteKey.includes('__'))return widget;
  if(!window.turnstile)throw new Error('Security verification is still loading. Reopen the form shortly.');
  if(widget===undefined)return window.turnstile.render('#'+container,{sitekey:siteKey});
  resetCaptcha(widget);return widget;
}
async function enterWorkspace() {
  await refresh();
  show('login',false);show('workspace',true);
  $('search').value='';$('scopeFilter').value='relevant';$('typeFilter').value='';$('statusFilter').value='';
  switchView('requests');
  // Allow the read RPC when restoring a request link inside the login action.
  const wasBusy=busy;busy=false;try{await handleDeepLink();}finally{busy=wasBusy;}
}
async function loginByCredentials(phone,password) {
  if(!repository)throw new Error('Supabase is not configured.');
  try {await repository.login(phone,password,captchaToken());await enterWorkspace();}
  catch(error){clearWorkspace();await repository.logout().catch(()=>{});throw error;}
  finally{$('loginPassword').value='';resetCaptcha();}
}
async function logout() {
  if(busy)return;
  const registration=await navigator.serviceWorker?.getRegistration().catch(()=>null);
  const subscription=await registration?.pushManager.getSubscription().catch(()=>null);
  if(subscription&&repository&&currentUser)await repository.rpc('revoke_push_subscription',{p_endpoint:subscription.endpoint}).catch(()=>{});
  clearWorkspace();if(repository)await repository.logout().catch(reportError);
}
function viewAllowed(view) { return Boolean(currentUser?.is_active) && (['requests','projects','inbox','chat'].includes(view) || view === 'staff' && currentUser.role === 'admin' || ['reports', 'deliveries'].includes(view) && canManage(currentUser)) }
function switchView(view) {
  if (!viewAllowed(view)) { toast('This page is not available for your role.', true); return }
  currentView = view;
  $('workspace').dataset.screen=view;
  document.querySelector('.account-menu').open=false;
  for (const name of ['requests', 'projects', 'inbox', 'chat', 'staff', 'reports', 'deliveries']) show(name + 'View', view === name);
  document.querySelectorAll('[data-view]').forEach(button => { button.classList.toggle('active', button.dataset.view === view); button.setAttribute('aria-current', button.dataset.view === view ? 'page' : 'false') });
  const titles = { requests: 'Hello, '+currentUser.name.split(' ')[0], projects: 'Projects', inbox: 'Alerts', chat:'Team chat', staff: 'Team members', reports: 'Team overview', deliveries: 'Message delivery' };
  const descriptions = { requests: 'Here’s what needs your attention.', projects: 'All your project work, together.', inbox: 'Reminders and important messages sent to you.', chat:'One shared conversation for everyone at Oak Gallerie.', staff: 'People who can sign in and help with requests.', reports: 'A quick look at open and completed work.', deliveries: 'Check whether important messages were sent.' };
  $('pageIcon').querySelector('use').setAttribute('href','#icon-'+({requests:'clipboard',projects:'folder',inbox:'clock',chat:'chat',staff:'people',reports:'chart',deliveries:'truck'}[view]));
  $('pageTitle').textContent = titles[view]; $('pageDescription').textContent = descriptions[view]; show('newTicketBtn', view === 'requests');
  renderAll();
}
function renderAll() {
  if (!currentUser) return;
  chat?.setUser(currentUser);chat?.setVisible(currentView==='chat');
  $('userName').textContent = currentUser.name; $('userRole').textContent = ROLE_LABEL[currentUser.role]; $('workspaceEyebrow').textContent = currentUser.department;
  $('roleGuidance').textContent = ROLE_DESCRIPTION[currentUser.role];
  $('workspace').dataset.screen=currentView;
  $('demoTime').textContent = fmt(Date.now()); $('storageStatus').textContent = connected ? 'All changes saved' : 'Connection problem — ask your Admin';
  document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('hidden', !viewAllowed(button.dataset.view)));
  show('chatClearBtn',canManage(currentUser)&&currentView==='chat');
  show('newProjectBtn',canManage(currentUser)&&currentView==='projects');
  show('changePasswordBtn',canManage(currentUser));
  $('scopeFilter').options[0].textContent = canManage(currentUser) ? 'All team work' : 'My work';
  renderProjects();
  renderTickets(); renderInbox(); if (currentUser.role === 'admin') renderStaff(); else $('staffList').innerHTML = '';
  if (canManage(currentUser)) { renderReports(); renderDeliveries() } else for (const id of ['reportSummary', 'typeReport', 'workloadReport', 'resolvedReport', 'deliverySummary', 'deliveryList']) $(id).innerHTML = '';
}
function filteredTickets() {
  const query = $('search').value.trim().toLowerCase(), scope = $('scopeFilter').value, type = $('typeFilter').value, status = $('statusFilter').value, project = $('projectFilter').value;
  return visibleTickets().filter(t => {
    const hay = [t.note, TYPE_LABEL[t.type], projectName(t.project_id), userById(t.assignee_id)?.name, actorName(t.created_by)].join(' ').toLowerCase();
    return (!query || hay.includes(query)) && (!type || t.type === type) && (!project || t.project_id === project) && (status === 'all' || (status ? t.status === status : t.status !== 'Resolved')) && (scope === 'relevant' || scope === 'assigned' && t.assignee_id === currentUser.id || scope === 'created' && t.created_by === currentUser.auth_user_id || scope === 'shared' && !t.assignee_id);
  }).sort((a, b) => { const rank = t => isUrgent(t) ? 0 : isDue(t) ? 1 : isReminderDue(t) ? 2 : t.status === 'Resolved' ? 4 : 3; return rank(a) - rank(b) || Date.parse(a.created_at) - Date.parse(b.created_at) });
}
const REQUEST_ICON = Object.freeze({service:'service',help_ticket:'help',follow_up:'clock',urgent_message:'bell'});
function requestTiming(ticket) {
  if(ticket.status==='Resolved')return ticket.resolved_at?'Done '+fmt(ticket.resolved_at):'Done';
  if(ticket.type==='urgent_message')return 'Waiting for confirmation';
  if(ticket.type==='follow_up')return (isReminderDue(ticket)?'Reminder due ':'Reminder set for ')+fmt(ticket.reminder_at);
  return ticket.next_followup_due_at?(isDue(ticket)?'Update overdue since ':'Next update due ')+fmt(ticket.next_followup_due_at):'';
}
function renderTickets() {
  const tickets=filteredTickets(),relevant=visibleTickets();
  document.querySelectorAll('[data-queue]').forEach(button=>{const selected=button.dataset.queue===($('statusFilter').value==='Resolved'?'done':$('scopeFilter').value==='assigned'?'mine':$('scopeFilter').value==='relevant'?'team':'');button.classList.toggle('active',selected);button.setAttribute('aria-pressed',String(selected));});
  $('ticketList').innerHTML=tickets.length?tickets.map(t=>{
    const priority=isUrgent(t)?'critical':isDue(t)?'overdue':'';
    const icon=REQUEST_ICON[t.type]||'clipboard';
    const assignee=t.assignee_id?'With '+(userById(t.assignee_id)?.name||'a team member'):'Waiting for someone to take this';
    return '<button class="ticket '+priority+'" data-request="'+esc(t.id)+'"><span class="ticket-main"><span class="ticket-heading"><span class="ticket-type-icon" aria-hidden="true"><svg class="ui-icon" focusable="false"><use href="#icon-'+icon+'"/></svg></span><span class="ticket-title-group"><span class="ticket-type">'+esc(TYPE_LABEL[t.type]||t.type)+'</span>'+(t.project_id?'<span class="ticket-project">'+esc(projectName(t.project_id))+'</span>':'')+'</span></span><span class="ticket-description">'+esc(t.note)+'</span><span class="meta"><span>'+esc(assignee)+'</span><span>Added by '+esc(actorName(t.created_by))+'</span></span></span><span class="ticket-flags">'+badge(displayStatus(t.status),t.status==='Resolved'?'resolved':'')+(priority?badge(isUrgent(t)?'Needs confirmation':'Update needed',isUrgent(t)?'urgent':'due'):'')+'<span class="ticket-timing">'+esc(requestTiming(t))+'</span></span></button>';
  }).join(''):(()=>{
    const noRequests=!relevant.length;
    const allResolved=!noRequests&&relevant.every(t=>t.status==='Resolved')&&$('statusFilter').value==='';
    const title=noRequests?'Nothing here yet':allResolved?'You’re all caught up':'No matching requests';
    const detail=noRequests?'Start with a request. Add a short note and choose who should handle it.':allResolved?'Everything is done. You can still view completed requests.':'Try another search or change the filters to see more requests.';
    const action=noRequests?'Create a request':allResolved?'View completed work':'Clear filters';
    const kind=noRequests?'create':allResolved?'all':'clear';
    return '<div class="request-empty"><span class="request-empty-icon" aria-hidden="true"><svg class="ui-icon" focusable="false"><use href="#icon-'+(allResolved?'check':'clipboard')+'"/></svg></span><strong>'+title+'</strong><p>'+detail+'</p><button type="button" class="btn" data-empty-action="'+kind+'">'+action+'</button></div>';
  })();
  $('urgentCount').textContent=relevant.filter(isUrgent).length;
  $('dueCount').textContent=relevant.filter(isDue).length;
  $('openCount').textContent=relevant.filter(t=>t.status!=='Resolved').length;
}

function renderProjects() {
  const query=$('projectSearch').value.trim().toLowerCase();
  const projects=state().projects.filter(p=>[p.name,p.site_address,state().clients.find(c=>c.id===p.client_id)?.name].join(' ').toLowerCase().includes(query));
  $('projectList').innerHTML=projects.map(p=>{
    const client=state().clients.find(c=>c.id===p.client_id);
    const open=visibleTickets().filter(t=>t.project_id===p.id&&t.status!=='Resolved').length;
    return '<button class="project-card" data-project="'+esc(p.id)+'"><span class="project-symbol"><svg class="ui-icon" aria-hidden="true"><use href="#icon-folder"/></svg></span><span class="project-details"><strong>'+esc(p.name)+'</strong><span>'+esc([client?.name,p.site_address].filter(Boolean).join(' · ')||'Project workspace')+'</span>'+badge(open+' open')+'</span><span class="project-chevron" aria-hidden="true">›</span></button>';
  }).join('')||'<div class="card empty">'+(query?'No matching projects.':'No projects yet. Your Admin can add the first project.')+'</div>';
}

function renderInbox() {
  const list = state().notifications.filter(n => n.recipient_id === currentUser.id && canView(currentUser, ticketById(n.ticket_id))).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  $('inboxCount').textContent = list.filter(n => n.state !== 'cancelled' && ticketById(n.ticket_id)?.status !== 'Resolved').length || '';
  $('inboxList').innerHTML = list.length ? list.map(n => '<button class="notification-card" data-request="' + esc(n.ticket_id) + '"><span class="eyebrow">' + esc(KIND_LABEL[n.kind] || n.kind) + '</span><strong>' + esc(ticketById(n.ticket_id)?.note) + '</strong><span class="meta">' + badge(deliveryStateLabel(n.state), ['failed', 'retrying'].includes(n.state) ? 'due' : '') + '<span>' + esc(fmt(n.created_at)) + '</span></span>' + (n.state==='cancelled'?'<p class="hint">'+esc(notificationCancellationText(n))+'</p>':'') + '</button>').join('') : '<div class="card empty">Nothing for you right now. Reminders and important messages will show here.</div>';
}
function renderStaff() {
  if (currentUser.role !== 'admin') return;
  $('staffList').innerHTML = state().team.map(user => {
    const assigned = state().tickets.filter(t => t.assignee_id === user.id && t.status !== 'Resolved'), blocked = assigned.length || user.id === currentUser.id;
    const actions=user.role==='staff'?'<button class="btn compact" data-account="'+esc(user.id)+'">Manage account</button><button class="btn compact" data-staff="'+esc(user.id)+'" '+(user.is_active&&blocked?'disabled':'')+'>'+(user.is_active?'Deactivate login':'Activate login')+'</button>':'';
    return '<article class="card staff-card"><div class="staff-heading"><span class="staff-avatar">' + esc(initials(user.name)) + '</span><div class="staff-details"><h2>' + esc(user.name) + '</h2><span>' + esc(ROLE_LABEL[user.role]) + '</span></div>' + badge(user.is_active ? 'Active' : 'Inactive', user.is_active ? 'resolved' : '') + '</div><div class="staff-meta"><p>' + esc(user.department) + '</p><p>' + esc(user.email?'Login: '+user.email:'Login email not configured') + '<br>' + esc('Notifications: '+(user.notification_email||user.email||'not configured')) + '<br>' + esc(user.phone) + '</p><p><strong>' + assigned.length + '</strong> open assigned · ' + assigned.filter(isDue).length + ' overdue</p></div><div class="staff-actions">'+actions+'<span class="hint">' + (user.id === currentUser.id ? 'Your own login stays active.' : assigned.length ? 'Resolve or reassign open work before deactivating.' : 'Deactivation immediately blocks database access.') + '</span></div></article>';
  }).join('');
}
function openStaffAccount(action,id=null) {
  if(busy||!canManage(currentUser))return;
  const member=id?userById(id):null;if(id&&member?.role!=='staff')throw new Error('Select a Staff account.');
  accountAction=action;accountId=id;$('staffAccountForm').reset();
  $('accountFields').disabled=action==='access';show('accountFields',action!=='access');
  $('accountPassword').required=action==='create';$('accountPasswordRepeat').required=action==='create';
  $('staffAccountTitle').lastChild.textContent=action==='create'?'Create staff login':action==='access'?(member.is_active?'Deactivate':'Activate')+' '+member.name:'Manage '+member.name;
  $('accountActionHint').textContent=action==='create'?'Add the person’s name, work email and password. They can sign in as soon as you save.':action==='access'?'Enter your Admin password to change this person’s access.':'Change the details you need. Leave the password blank to keep it as it is.';
  if(member){$('accountName').value=member.name;$('accountDepartment').value=member.department;$('accountEmail').value=member.email||'';$('accountPhone').value=member.phone;$('accountNotificationEmail').value=member.notification_email||'';}
  $('staffAccountDialog').showModal();
  accountCaptchaWidget=mountCaptcha('accountCaptcha',accountCaptchaWidget);
}
async function saveStaffAccount(event) {
  event.preventDefault();await run($('saveStaffAccount'),async()=>{
    if(!canManage(currentUser))throw new Error('Only Admin can manage accounts.');
    const password=$('accountPassword').value;
    if(password!==$('accountPasswordRepeat').value)throw new Error('Enter the same staff password twice.');
    const input={action:accountAction,id:accountId,currentPassword:$('accountAdminPassword').value,captchaToken:captchaToken(accountCaptchaWidget)};
    if(accountAction==='access')input.active=!userById(accountId).is_active;
    else Object.assign(input,{name:$('accountName').value,department:$('accountDepartment').value,email:$('accountEmail').value,phone:normalizePhone($('accountPhone').value),notificationEmail:$('accountNotificationEmail').value,password:password||undefined});
    try{await change(()=>repository.manageStaff(input));$('staffAccountForm').reset();$('staffAccountDialog').close();toast('Staff account saved.');}
    finally{$('accountAdminPassword').value='';$('accountPassword').value='';$('accountPasswordRepeat').value='';resetCaptcha(accountCaptchaWidget);}
  });
}
function bars(rows) {
  const max = Math.max(1, ...rows.map(row => row[1]));
  return rows.map(([label, value]) => '<div class="bar-row"><span>' + esc(label) + '</span><strong>' + value + '</strong><div class="bar-track"><i style="width:' + Math.round(value / max * 100) + '%"></i></div></div>').join('');
}
function renderReports() {
  const tickets = state().tickets, open = tickets.filter(t => t.status !== 'Resolved'), resolved = tickets.filter(t => t.status === 'Resolved');
  $('reportSummary').innerHTML = metric('In progress', open.length) + metric('Updates overdue', open.filter(isDue).length) + metric('Urgent to confirm', open.filter(isUrgent).length) + metric('Done', resolved.length);
  $('typeReport').innerHTML = bars(Object.entries(TYPE_LABEL).map(([type, label]) => [label, open.filter(t => t.type === type).length]));
  $('workloadReport').innerHTML = bars(state().team.map(user => [user.name, open.filter(t => t.assignee_id === user.id).length]).concat([['Shared queue', open.filter(t => !t.assignee_id).length]]));
  $('resolvedReport').innerHTML = resolved.length ? '<table class="data-table"><thead><tr><th>Request</th><th>With</th><th>Done on</th></tr></thead><tbody>' + resolved.sort((a, b) => Date.parse(b.resolved_at) - Date.parse(a.resolved_at)).map(t => '<tr><td><button class="btn compact" data-request="' + esc(t.id) + '">' + esc(t.note) + '</button></td><td>' + esc(userById(t.assignee_id)?.name || 'Team queue') + '</td><td>' + esc(fmt(t.resolved_at)) + '</td></tr>').join('') + '</tbody></table>' : '<p class="hint">Finished requests will appear here.</p>';
}
function deliveryMarkup(notification, allowRetry = false) {
  const attempts = state().deliveries.filter(d => d.notification_id === notification.id).sort((a, b) => Date.parse(a.attempted_at) - Date.parse(b.attempted_at));
  const cancellation=notificationCancellationText(notification),timing=notificationTimingText(notification,fmt);
  return '<article class="card delivery-card"><div class="delivery-top"><div><span class="eyebrow">' + esc(KIND_LABEL[notification.kind] || notification.kind) + '</span><h3>' + esc(ticketById(notification.ticket_id)?.note) + '</h3><p class="hint">To ' + esc(userById(notification.recipient_id)?.name) + ' · ' + esc(fmt(notification.created_at)) + '</p></div>' + badge(deliveryStateLabel(notification.state), notification.state === 'failed' ? 'urgent' : notification.state === 'retrying' ? 'due' : '') + '</div><div class="attempt-list">' + attempts.map(d => '<div class="attempt-row"><strong>' + esc(d.channel) + '</strong>' + badge(deliveryStateLabel(d.state), d.state === 'failed' || d.state === 'bounced' ? 'due' : 'resolved') + '<span class="hint">' + esc(fmt(d.attempted_at)) + ' · ' + esc(d.error_message || 'Message ' + deliveryStateLabel(d.state).toLowerCase()) + '</span></div>').join('') + '</div>' + (cancellation?'<p class="hint">'+esc(cancellation)+'</p>':'') + (timing?'<p class="hint">'+esc(timing)+'</p>':'') + (allowRetry && notification.state === 'failed' && ticketById(notification.ticket_id)?.status !== 'Resolved' ? '<button class="btn compact" data-retry="' + esc(notification.id) + '">Try sending again</button>' : '') + '</article>';
}
function renderDeliveries() {
  const list = [...state().notifications].sort((a, b) => { const order = { failed: 0, retrying: 1, queued: 2, sent: 3, cancelled: 4 }; return order[a.state] - order[b.state] || Date.parse(b.created_at) - Date.parse(a.created_at) });
  $('deliverySummary').innerHTML = metric('Needs attention', list.filter(n => n.state === 'failed').length, 'Messages that could not be sent') + metric('Trying again', list.filter(isNotificationRetryScheduled).length, 'Messages scheduled to send again') + metric('Sent', list.filter(n => n.state === 'sent').length, 'Accepted for delivery') + metric('Not sent', list.filter(n => n.state === 'cancelled').length, 'No message was sent');
  $('deliveryList').innerHTML = list.map(n => deliveryMarkup(n, true)).join('') || '<div class="empty">No messages to show yet.</div>';
  if(state().workerRuns?.length)$('deliveryList').insertAdjacentHTML('afterbegin','<article class="card report-card"><h2>Recent system checks</h2>'+state().workerRuns.slice(0,10).map(run=>'<p>'+esc(run.worker)+' · '+esc(run.status)+' · '+esc(fmt(run.finished_at))+(run.error_message?' · '+esc(run.error_message):'')+'</p>').join('')+'</article>');
}

function fillProjects() {
  const client=$('clientSelect').value,service=$('ticketType').value==='service';
  const projects=state().projects.filter(p=>!service||p.client_id===client);
  $('projectSelect').required=service;
  $('clientSelect').required=service;
  $('projectSelect').innerHTML=(service?(projects.length?'':'<option value="">No projects for this client</option>'):'<option value="">No project</option>')+options(projects.map(p=>p.id),projectName);
  $('projectHint').textContent=service?(projects.length?'Choose which project this is about.':'No projects are listed for this client yet. Ask your Admin to add one.'):'You can skip this if it does not apply.';
}
function openNew() {
  if (busy) return; $('newTicketForm').reset(); revokeURLs(previewURLs); $('filePreview').innerHTML = '';
  $('ticketType').innerHTML = options(allowedTypes(currentUser), type => TYPE_LABEL[type]); $('clientSelect').innerHTML = options(state().clients.map(c => c.id), id => state().clients.find(c => c.id === id).name); fillProjects(); updateTypeFields(); $('newTicketDialog').showModal();
}
function recipientOptions(type, { detail = false } = {}) {
  let people = recipients(state(), type); if (!canManage(currentUser)) people = people.filter(user => user.id === currentUser.id);
  return '<option value="">' + (type === 'urgent_message' ? 'Choose a person' : 'Let the team choose') + '</option>' + options(people.map(user => user.id), id => userById(id).name + (id === currentUser.id ? ' (you)' : ''));
}
function updateTypeFields() {
  const type = $('ticketType').value, follow = type === 'follow_up';
  show('clientField', type === 'service'); show('projectField', true); show('reminderField', follow); show('customReminderField', follow && $('reminderPreset').value === 'custom'); show('assigneeField', !follow);
  const oldProject = $('projectSelect').value; fillProjects(); if ([...$('projectSelect').options].some(option => option.value === oldProject)) $('projectSelect').value = oldProject;
  const previous = $('assigneeSelect').value; $('assigneeSelect').innerHTML = recipientOptions(type); if ([...$('assigneeSelect').options].some(option => option.value === previous)) $('assigneeSelect').value = previous;
  $('typeHint').textContent = ({service:'For work connected to a client or project.',help_ticket:'For help from your team, such as drawings, materials, or a repair.',follow_up:'A private reminder for yourself. Example: Call the client tomorrow.',urgent_message:'Send a message to one person that needs their confirmation.'})[type] || 'Choose the option that best matches what you need.';
  $('ticketNote').placeholder = ({service:'Example: Please measure the kitchen cabinets during the site visit.',help_ticket:'Example: Please send the latest design drawings for review.',follow_up:'Example: Call the client about the meeting time.',urgent_message:'Example: Please call me about today’s delivery.'})[type] || 'Briefly tell us what you need.';
  $('routingHint').textContent = follow ? 'Only you can see this personal reminder.' : type === 'urgent_message' ? 'Choose one person. They will be asked to confirm they saw your message.' : canManage(currentUser) ? 'Choose a person, or leave this for the team to pick up.' : 'Choose yourself or leave this for the team to pick up. An Admin can assign it later.';
}
const FORMATS = new Set(['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm']);
function validateFiles(files) {
  for (const file of files) { if (!FORMATS.has(file.type)) throw new Error(file.name + ': choose JPEG, PNG, WebP, MP4, QuickTime or WebM.'); const max = file.type.startsWith('image/') ? 10 : 50; if (!file.size || file.size > max * 1048576) throw new Error(file.name + ': file must be non-empty and at most ' + max + ' MB.') }
}
function previewFiles() {
  revokeURLs(previewURLs); $('filePreview').innerHTML = '';
  try { const files = [...$('ticketFiles').files]; validateFiles(files); for (const file of files) { const url = URL.createObjectURL(file); previewURLs.push(url); const figure = document.createElement('figure'); figure.className = 'attachment-card'; const media = document.createElement(file.type.startsWith('image/') ? 'img' : 'video'); media.src = url; if (media.tagName === 'VIDEO') { media.controls = true; media.preload = 'metadata' } else media.alt = file.name; const caption = document.createElement('figcaption'); caption.textContent = file.name; figure.append(media, caption); $('filePreview').append(figure) } } catch (error) { $('ticketFiles').value = ''; reportError(error) }
}
function reminderValue() {
  if ($('reminderPreset').value === 'custom') { const value = $('customReminder').value; if (!value) throw new Error('Choose a reminder date and time.'); const ms = Date.parse(value + ':00+05:30'); if (!Number.isFinite(ms) || ms <= Date.now()) throw new Error('Choose a date after the current time (IST).'); return new Date(ms).toISOString() }
  return new Date(Date.now() + Number($('reminderPreset').value) * 3600000).toISOString();
}
async function createRequest(event) {
  event.preventDefault(); await run($('submitTicket'), async () => {
    const files = [...$('ticketFiles').files]; validateFiles(files); const type = $('ticketType').value;
    const input = {type,note:$('ticketNote').value,project_id:$('projectSelect').value||null,assignee_id:type==='follow_up'?null:$('assigneeSelect').value||null,reminder_at:type==='follow_up'?reminderValue():null};
    if(type==='service'&&!input.project_id)throw new Error('Choose a client and project for this request. If the project is missing, ask your Admin to add it.');
    if(!currentUser||!connected)throw new Error('Sign in and reconnect before making a change.');
    let ticket,uploadError;
    show('uploadProgress',files.length>0);
    try {
      // Capture the committed request before any workspace reload can fail.
      try {
        ticket=await repository.createWithAttachments(input,files,(done,total)=>{
          $('uploadProgress').querySelector('span').style.width=Math.round(done/total*100)+'%';
        });
      } catch(error) {
        if(!error.savedRequest)throw error;
        ticket=error.savedRequest;uploadError=error;
      }
      $('newTicketDialog').close();revokeURLs(previewURLs);$('filePreview').innerHTML='';$('newTicketForm').reset();
      // Clear filters so a saved request is visible in the workspace.
      $('search').value='';$('scopeFilter').value='relevant';$('typeFilter').value='';$('statusFilter').value='';
      try {await refresh();}
      catch {throw new Error('Request saved (ID: '+ticket.id+'), but the workspace could not reload. '+(uploadError?uploadError.message+' ':'')+'Sign in again to view it. Do not submit it again.');}
      if(uploadError)throw uploadError;
      toast('Request sent.');
    } finally{show('uploadProgress',false);$('uploadProgress').querySelector('span').style.width='0%';}
  });
}

async function openTicket(id, { recordRead = true } = {}) {
  if (busy) return; const ticket = ticketById(id); if (!canView(currentUser, ticket)) { toast('This request is outside your workspace.', true); return }
  if (recordRead) {busy=true;try{await change(()=>repository.read(id));}finally{busy=false;}}
  currentTicketId = id; const t = ticketById(id), creator = actorName(t.created_by), assignee = userById(t.assignee_id);
  $('detailProject').textContent = TYPE_LABEL[t.type] + (t.project_id ? ' · ' + projectName(t.project_id) : ''); $('detailTitle').lastChild.textContent = t.note;
  $('detailBadges').innerHTML = badge(displayStatus(t.status), t.status === 'Resolved' ? 'resolved' : '') + (isUrgent(t) ? badge('Needs your confirmation', 'urgent') : t.urgent_acknowledged_at ? badge('Seen by ' + userById(t.urgent_acknowledged_by)?.name, 'resolved') : '') + (isDue(t) ? badge('Update needed', 'due') : '');
  $('detailSummary').textContent = 'Added by ' + creator + '. ' + (assignee ? 'With ' + assignee.name + '.' : t.type === 'follow_up' ? 'Only you can see this reminder.' : 'Waiting for someone to take this.') + (t.status === 'Resolved' ? ' Marked done ' + fmt(t.resolved_at) + '.' : t.next_followup_due_at ? ' ' + (isDue(t) ? 'An update was due ' : 'Next update due ') + fmt(t.next_followup_due_at) + '.' : '') + (t.type === 'follow_up' ? ' Reminder: ' + fmt(t.reminder_at) + (t.reminder_cancelled_at ? ' (stopped)' : '') + '.' : '') + (t.expected_timeline ? ' Ready by: ' + t.expected_timeline + '.' : '') + (t.urgent_read_at ? ' Opened ' + fmt(t.urgent_read_at) + '.' : '');
  show('ackWrap', canAcknowledge(currentUser, t)); show('assignmentControls', canAssign(currentUser, t)); show('updateForm', canUpdate(currentUser, t)); show('attachmentForm', canAttach(currentUser, t));
  $('detailAssignee').innerHTML = recipientOptions(t.type); $('detailAssignee').value = t.assignee_id || '';
  const allowed = t.status === 'Resolved' ? ['In Review'] : t.status === 'New' ? ['New', 'In Review', 'Resolved'] : t.status === 'In Review' ? ['In Review', 'Scheduled', 'Resolved'] : ['Scheduled', 'Resolved'];
  $('detailStatus').innerHTML = options(allowed, displayStatus); $('detailStatus').value = t.status === 'Resolved' ? 'In Review' : t.status;
  $('saveUpdate').textContent = t.status === 'Resolved' ? 'Reopen and save' : 'Save update'; $('internalNote').value = ''; $('expectedTimeline').value = ''; $('detailFiles').value = '';
  $('accessNote').textContent = canUpdate(currentUser, t) ? 'Add a short note so your team knows what changed. Saving it starts a fresh 24-hour wait for the next reminder.' : canAcknowledge(currentUser, t) ? 'Confirm when you have seen this urgent message. An Admin can update its progress.' : 'Only the assigned person or an Admin can update this request.';
  renderTimeline(t);
  $('detailDelivery').innerHTML = state().notifications.filter(n => n.ticket_id === id).map(n => '<p>' + esc(KIND_LABEL[n.kind] || n.kind) + ' → ' + esc(userById(n.recipient_id)?.name) + ' · ' + esc(deliveryStateLabel(n.state)) + ' · ' + esc(fmt(n.created_at)) + (n.state==='cancelled'?'<br>'+esc(notificationCancellationText(n)):'') + '</p>').join('') || '<p>No messages have been sent yet.</p>';
  if (!$('ticketDialog').open) $('ticketDialog').showModal(); history.replaceState(null, '', '#request=' + encodeURIComponent(id)); await renderMedia(t);
}
function renderTimeline(ticket) {
  $('detailTimeline').innerHTML = state().events.filter(e => e.ticket_id === ticket.id).map((event, index) => ({ ...event, order: index })).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.order - a.order).map(e => {
    const details = e.event_type === 'assigned' ? 'From ' + (userById(e.metadata?.old_assignee_id)?.name || 'Team') + ' to ' + (userById(e.metadata?.new_assignee_id || e.metadata?.assignee_id)?.name || 'Team') : e.event_type === 'attachment_added' ? e.metadata?.original_name || e.metadata?.name || '' : e.old_status ? displayStatus(e.old_status) + ' → ' + displayStatus(e.new_status) : '';
    return '<div class="event"><strong>' + esc(EVENT_LABEL[e.event_type] || e.event_type) + '</strong><p>' + esc(actorName(e.actor_user_id)) + ' · ' + esc(fmt(e.created_at)) + '</p>' + (details ? '<p>' + esc(details) + '</p>' : '') + (e.note ? '<p>' + esc(e.note) + '</p>' : '') + (e.expected_timeline ? '<p>Ready by: ' + esc(e.expected_timeline) + '</p>' : '') + '</div>';
  }).join('');
}
async function renderMedia(ticket) {
  const version=++mediaVersion;$('detailMedia').replaceChildren();
  for(const item of state().attachments.filter(a=>a.ticket_id===ticket.id)) {
    const figure=document.createElement('figure');figure.className='attachment-card';
    try {
      const url=await repository.mediaUrl(item);if(version!==mediaVersion||!currentUser)return;
      const media=document.createElement(item.mime_type.startsWith('video/')?'video':'img');media.src=url;
      if(media.tagName==='VIDEO'){media.controls=true;media.preload='metadata';}else media.alt=item.original_name;
      const link=document.createElement('a');link.href=url;link.target='_blank';link.rel='noopener';link.textContent=item.original_name;
      figure.append(media,link);
    }catch{figure.textContent=item.original_name+' · Unable to load this file. Reopen to renew access.';}
    if(version!==mediaVersion)return;$('detailMedia').append(figure);
  }
}
async function updateRequest(event) {
  event.preventDefault(); const id = currentTicketId; await run($('saveUpdate'), async () => { await change(()=>repository.update(id,{status:$('detailStatus').value,note:$('internalNote').value,expected_timeline:$('expectedTimeline').value})); closeDetail(); toast('Update saved.'); });
}
async function assignRequest() {
  const id = currentTicketId; await run($('saveAssignee'), async () => { await change(()=>repository.assign(id,$('detailAssignee').value||null)); closeDetail(); toast('Person updated.'); });
}
async function acknowledge() {
  const id = currentTicketId; await run($('acknowledgeBtn'), async () => { await change(()=>repository.acknowledge(id)); closeDetail(); toast('Your confirmation was saved.'); });
}
async function uploadMore(event) {
  event.preventDefault(); const id = currentTicketId; await run($('saveAttachments'), async () => {
    const files = [...$('detailFiles').files]; if (!files.length) throw new Error('Choose at least one photo or video.'); validateFiles(files);
    await change(()=>repository.upload(id,files)); closeDetail(); toast('Attachments saved. The 24-hour deadline is unchanged.');
  });
}
async function handleDeepLink() {
  const match = location.hash.match(/^#request=([a-zA-Z0-9-]+)$/); if (match && currentUser) await openTicket(match[1]);
}
function bind() {
  $('loginPasswordToggle').onclick=()=>setLoginPasswordVisible($('loginPassword').type==='password');
  $('loginPassword').addEventListener('keydown',event=>{
    if(event.key!=='Enter'||event.isComposing||event.repeat)return;
    event.preventDefault();
    if(!busy)$('loginForm').requestSubmit($('loginBtn'));
  });
  if ($('loginForm')) {
    $('loginForm').onsubmit = event => {
      event.preventDefault();
      run($('loginBtn'), async () => {
        show('loginError', false);
        try {
          await loginByCredentials($('loginPhone').value, $('loginPassword').value);
        } catch (err) {
          $('loginError').textContent = err.message;
          show('loginError', true);
        }
      });
    };
  }
  $('projectSearch').addEventListener('input',renderProjects);
  $('logout').onclick = logout; $('newTicketBtn').onclick = openNew; $('ticketType').onchange = updateTypeFields; $('reminderPreset').onchange = updateTypeFields; $('clientSelect').onchange = fillProjects; $('ticketFiles').onchange = previewFiles;
  $('newStaffBtn').onclick=()=>openStaffAccount('create');$('staffAccountForm').onsubmit=saveStaffAccount;
  $('staffAccountDialog').addEventListener('close',()=>{$('staffAccountForm').reset();accountId=null;});
  $('changePasswordDialog').addEventListener('close',()=>{$('changePasswordForm').reset();});
  $('changePasswordBtn').onclick=()=>{if(!busy&&canManage(currentUser)){$('changePasswordForm').reset();$('changePasswordDialog').showModal();$('currentPassword').focus();try{changeCaptchaWidget=mountCaptcha('changeCaptcha',changeCaptchaWidget);}catch(error){reportError(error);}}};
  $('changePasswordForm').onsubmit=event=>{event.preventDefault();run($('saveChangedPassword'),async()=>{
    const password=$('changedPassword').value;
    if(password!==$('repeatChangedPassword').value)throw new Error('Enter the same new password twice.');
    try{await repository.changePassword($('currentPassword').value,password,captchaToken(changeCaptchaWidget));}finally{resetCaptcha(changeCaptchaWidget);}
    $('changePasswordForm').reset();$('changePasswordDialog').close();toast('Your password has been changed.');
  });};
  $('newProjectBtn').onclick=()=>{if(canManage(currentUser)&&!busy){$('projectForm').reset();$('projectDialog').showModal();}};
  $('projectForm').onsubmit=event=>{event.preventDefault();run($('saveProject'),async()=>{
    await change(()=>repository.createProject({clientName:$('projectClientName').value,clientPhone:$('projectClientPhone').value,projectName:$('newProjectName').value,address:$('newProjectAddress').value}));
    $('projectDialog').close();toast('Client and project saved.');
  });};
  $('newTicketForm').onsubmit = createRequest; $('updateForm').onsubmit = updateRequest; $('attachmentForm').onsubmit = uploadMore; $('saveAssignee').onclick = assignRequest; $('acknowledgeBtn').onclick = acknowledge;
  ['search', 'scopeFilter', 'typeFilter', 'statusFilter', 'projectFilter'].forEach(id => $(id).addEventListener(id === 'search' ? 'input' : 'change', renderTickets));
  document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => { if (!busy) switchView(button.dataset.view) });
  document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => { if (!busy) { if (button.dataset.close === 'ticketDialog') closeDetail(); else $(button.dataset.close).close() } });
  $('ticketDialog').addEventListener('close', () => { currentTicketId = null; mediaVersion++; revokeURLs(mediaURLs); if (location.hash.startsWith('#request=')) history.replaceState(null, '', location.pathname + location.search) });
  $('newTicketDialog').addEventListener('close', () => revokeURLs(previewURLs));
  document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('cancel', event => { if (busy) event.preventDefault() }));
  document.addEventListener('click', event => {
    const accountMenu=document.querySelector('.account-menu');
    if(accountMenu?.open&&!accountMenu.contains(event.target))accountMenu.open=false;
    const queue=event.target.closest('[data-queue]');if(queue){$('scopeFilter').value=queue.dataset.queue==='mine'?'assigned':'relevant';$('statusFilter').value=queue.dataset.queue==='done'?'Resolved':'';renderTickets();}
    const project=event.target.closest('[data-project]');if(project){$('projectFilter').value=project.dataset.project;$('search').value='';$('scopeFilter').value='relevant';$('statusFilter').value='';switchView('requests');}
    const request = event.target.closest('[data-request]'); if (request) openTicket(request.dataset.request).catch(reportError);
    const emptyAction=event.target.closest('[data-empty-action]');if(emptyAction){if(emptyAction.dataset.emptyAction==='create'){openNew();}else{$('search').value='';$('scopeFilter').value='relevant';$('typeFilter').value='';$('statusFilter').value='all';$('projectFilter').value='';renderTickets();}}
    const retry = event.target.closest('[data-retry]'); if (retry) run(retry, async () => { await change(()=>repository.retryDelivery(retry.dataset.retry));toast('Delivery queued for the worker.'); });
    const account=event.target.closest('[data-account]');if(account)openStaffAccount('update',account.dataset.account);
    const staff = event.target.closest('[data-staff]'); if (staff) openStaffAccount('access',staff.dataset.staff);
  });
  window.addEventListener('hashchange', () => handleDeepLink().catch(reportError));
}
async function enablePush() {
  if(!('serviceWorker' in navigator)||!('PushManager' in window)||!('Notification' in window))throw new Error('Push notifications are unavailable in this browser.');
  const key=window.OAK_CONFIG?.vapidPublicKey;if(!key||key.includes('__'))throw new Error('The administrator must configure Web Push before enabling alerts.');
  if(await Notification.requestPermission()!=='granted')throw new Error((currentUser?.notification_email||currentUser?.email)?'Notification permission was not granted. Email remains the fallback when delivery is configured.':'Notification permission was not granted. Check My reminders in the app; this phone-only account has no email fallback.');
  const registration=await navigator.serviceWorker.getRegistration();
  if(!registration?.active)throw new Error('Reload the app to finish installing it before enabling alerts.');
  const subscription=await registration.pushManager.getSubscription()||await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:Uint8Array.from(atob(key.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0))});
  const json=subscription.toJSON();
  await repository.rpc('register_push_subscription',{p_endpoint:json.endpoint,p_p256dh:json.keys.p256dh,p_auth_key:json.keys.auth,p_device_label:navigator.userAgent.slice(0,200)});
  toast('This device is registered for alerts.');
}
async function start() {
  bind();await scrubLegacyCredentials();
  $('staffLoginMode').onclick=()=>{if(!busy)setLoginMode('staff');};
  $('adminLoginMode').onclick=()=>{if(!busy)setLoginMode('admin');};
  $('refreshBtn').onclick=()=>run($('refreshBtn'),()=>refresh());
  $('pushBtn').onclick=()=>run($('pushBtn'),enablePush);
  repository=new LiveRepository(window.OAK_CONFIG);
  chat=new TeamChat(repository,id=>userById(id)?.name||'Team member');
  if('serviceWorker' in navigator)navigator.serviceWorker.register('service-worker.js').catch(reportError);
  const siteKey=window.OAK_CONFIG?.captchaSiteKey;
  if(siteKey&&!siteKey.includes('__')){
    const script=document.createElement('script');script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.onload=()=>{captchaWidget=window.turnstile.render('#captcha',{sitekey:siteKey});};document.head.append(script);
  }
  repository.client.auth.onAuthStateChange((event,session)=>{
    if(event==='SIGNED_OUT')clearWorkspace();
  });
  try {
    const {data,error}=await repository.client.auth.getSession();if(error)throw error;
    if(data.session)await enterWorkspace();
  }catch(error){
    clearWorkspace();await repository.logout().catch(()=>{});
    $('loginError').textContent=error.message;show('loginError',true);
  }
  setInterval(()=>{if(currentUser&&!busy&&!document.querySelector('dialog[open]'))run(null,()=>refresh());},30000);
}
start().catch(error=>{$('loginError').textContent=error.message;show('loginError',true);$('loginBtn').disabled=true;});
