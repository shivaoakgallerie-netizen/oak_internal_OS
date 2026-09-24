import { DemoEngine, seedDemo, TYPE_LABEL, ROLE_LABEL, ROLE_DESCRIPTION, allowedTypes, canManage, canView, canUpdate, canAssign, canAcknowledge, canAttach, recipients } from './demo-model.js';
import { loadDemo, saveDemo, getAttachmentBlob, resetDemo } from './demo-storage.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const fmt = value => value ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Calcutta' }).format(new Date(value)) : '—';
const initials = name => name.split(' ').map(part => part[0]).join('').slice(0, 2);
const EVENT_LABEL = { created: 'Request created', assigned: 'Assignment changed', status_updated: 'Workflow updated', resolved: 'Resolved', reopened: 'Reopened', reminder_due: 'Personal reminder due', reminder_cancelled: 'Personal reminder cancelled', overdue: '24-hour update overdue', urgent_repeat: 'Urgent reminder repeated', notification_queued: 'Notification queued', notification_sent: 'Simulated delivery', notification_failed: 'Simulated delivery failed', notification_cancelled: 'Notification cancelled', notification_retried: 'Delivery retried', read: 'Request opened', acknowledged: 'Urgent message acknowledged', attachment_added: 'Attachment added' };
const KIND_LABEL = { assigned: 'New assigned work', urgent: 'Urgent message', urgent_repeat: 'Urgent acknowledgement reminder', overdue: '24-hour update reminder', follow_up: 'Personal follow-up reminder' };
const SESSION_KEY = 'oak-demo-account-v3';
let engine, currentUser = null, currentTicketId = null, currentView = 'requests', busy = false, memoryOnly = false, deferredInstall = null;
let mediaURLs = [], previewURLs = [], mediaVersion = 0;
const memoryMedia = new Map();
const state = () => engine.state;
const userById = id => state().team.find(user => user.id === id);
const actorName = authId => state().team.find(user => user.auth_user_id === authId)?.name || 'System';
const projectName = id => state().projects.find(project => project.id === id)?.name || 'No project';
const ticketById = id => state().tickets.find(ticket => ticket.id === id);
const isDue = t => t.status !== 'Resolved' && t.next_followup_due_at && Date.parse(t.next_followup_due_at) <= engine.now();
const isUrgent = t => t.type === 'urgent_message' && t.status !== 'Resolved' && !t.urgent_acknowledged_at;
const isReminderDue = t => t.type === 'follow_up' && t.status !== 'Resolved' && !t.reminder_cancelled_at && Date.parse(t.reminder_at) <= engine.now();
const visibleTickets = () => state().tickets.filter(ticket => canView(currentUser, ticket));
const toast = (message, error = false) => { const el = $('toast'); el.textContent = message; el.style.background = error ? '#943a31' : '#2b231b'; el.classList.remove('hidden'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.add('hidden'), 5000) };
const options = (items, label) => items.map(value => '<option value="' + esc(value) + '">' + esc(label(value)) + '</option>').join('');
const show = (id, visible) => $(id).classList.toggle('hidden', !visible);
const badge = (text, kind = '') => '<span class="badge ' + kind + '">' + esc(text) + '</span>';
const metric = (label, value, detail = '') => '<article class="card report-card"><span class="eyebrow">' + esc(label) + '</span><strong class="report-number">' + value + '</strong><p class="hint">' + esc(detail) + '</p></article>';
function setSession(id) { try { if (id) sessionStorage.setItem(SESSION_KEY, id); else sessionStorage.removeItem(SESSION_KEY) } catch {/* Session restoration is optional. */ } }
function savedSession() { try { return sessionStorage.getItem(SESSION_KEY) } catch { return null } }
function revokeURLs(list) { for (const url of list) URL.revokeObjectURL(url); list.length = 0 }
function closeDetail() { if ($('ticketDialog').open) $('ticketDialog').close(); currentTicketId = null; mediaVersion++; revokeURLs(mediaURLs); if (location.hash.startsWith('#request=')) history.replaceState(null, '', location.pathname + location.search) }
function reportError(error) { toast(error.message || 'Unable to save this change.', true) }
async function change(mutator, { blobs = [], reset = false } = {}) {
  if (busy) throw new Error('Please wait for the current change to finish.');
  busy = true; const actorId = currentUser?.id, draft = new DemoEngine(structuredClone(state()));
  try {
    const result = mutator(draft);
    if (!memoryOnly) { if (reset) await resetDemo(draft.state); else await saveDemo(draft.state, blobs) }
    else { if (reset) memoryMedia.clear(); for (const item of blobs) memoryMedia.set(item.id, item.blob) }
    engine = draft; if (actorId) currentUser = userById(actorId); renderAll(); return result;
  } finally { busy = false }
}
async function run(button, action) {
  if (busy) return;
  const original = button?.textContent; if (button) { button.disabled = true; button.textContent = 'Saving…' }
  try { await action() } catch (error) { reportError(error) } finally { if (button) { button.disabled = false; button.textContent = original } }
}

function authenticate(phone, password) {
  const cleanPhone = String(phone || '').replace(/\D/g, '').slice(-10);
  return state().team.find(user => {
    const userPhone = String(user.phone || '').replace(/\D/g, '').slice(-10);
    return userPhone === cleanPhone && user.password === password;
  });
}
async function loginByCredentials(phone, password) {
  const user = authenticate(phone, password);
  if (!user) throw new Error('Invalid phone number or password.');
  if (!user.is_active) throw new Error('This account is inactive.');
  await login(user.id);
}
async function login(id) {
  if (busy) return; const user = userById(id); if (!user?.is_active) { toast('This demo account is inactive.', true); return }
  await change(draft => draft.scan());
  currentUser = userById(id); setSession(id);
  show('login', false); show('workspace', true); $('search').value = ''; $('scopeFilter').value = 'relevant'; $('typeFilter').value = ''; $('statusFilter').value = '';
  $('projectFilter').innerHTML = '<option value="">All projects</option>' + options(state().projects.map(project => project.id), projectName);
  switchView('requests'); await handleDeepLink();
}
function logout() {
  if (busy) return; closeDetail(); for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  revokeURLs(previewURLs); setSession(null); currentUser = null; show('workspace', false); show('login', true);
  if ($('loginForm')) $('loginForm').reset();
}
function viewAllowed(view) { return Boolean(currentUser?.is_active) && (view === 'requests' || view === 'inbox' || view === 'staff' && currentUser.role === 'admin' || ['reports', 'deliveries'].includes(view) && canManage(currentUser)) }
function switchView(view) {
  if (!viewAllowed(view)) { toast('This page is not available for your role.', true); return }
  currentView = view;
  for (const name of ['requests', 'inbox', 'staff', 'reports', 'deliveries']) show(name + 'View', view === name);
  document.querySelectorAll('[data-view]').forEach(button => { button.classList.toggle('active', button.dataset.view === view); button.setAttribute('aria-current', button.dataset.view === view ? 'page' : 'false') });
  const titles = { requests: canManage(currentUser) ? 'Team requests' : 'My workspace', inbox: 'My reminders', staff: 'People behind the details', reports: 'A clear view of the work', deliveries: 'Delivery health' };
  const descriptions = { requests: canManage(currentUser) ? 'Assign the right person. Keep every commitment visible.' : 'Your assigned work, your requests, and the shared queue for your team.', inbox: 'Your assigned work, personal reminders and urgent messages.', staff: 'Six demo accounts. Every person, role and current workload.', reports: 'Live totals from the current demo workspace, including your latest changes.', deliveries: 'Trace simulated push and email outcomes, failures and retries.' };
  $('pageTitle').textContent = titles[view]; $('pageDescription').textContent = descriptions[view]; show('newTicketBtn', view === 'requests');
  renderAll();
}
function renderAll() {
  if (!currentUser) return;
  $('userName').textContent = currentUser.name; $('userRole').textContent = ROLE_LABEL[currentUser.role]; $('workspaceEyebrow').textContent = currentUser.department;
  $('roleGuidance').textContent = ROLE_DESCRIPTION[currentUser.role];
  $('demoTime').textContent = fmt(engine.now()); $('storageStatus').textContent = memoryOnly ? 'Temporary session · changes disappear on refresh' : 'Saved in this browser';
  document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('hidden', !viewAllowed(button.dataset.view)));
  show('demoControls', canManage(currentUser)); $('scopeFilter').options[0].textContent = canManage(currentUser) ? 'All team requests' : 'My workspace';
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
function renderTickets() {
  const tickets = filteredTickets();
  $('ticketList').innerHTML = tickets.length ? tickets.map(t => '<button class="ticket ' + (isUrgent(t) ? 'critical' : isDue(t) ? 'overdue' : '') + '" data-request="' + esc(t.id) + '"><span class="ticket-main"><h3>' + esc(TYPE_LABEL[t.type]) + (t.project_id ? ' · ' + esc(projectName(t.project_id)) : '') + '</h3><span class="ticket-description">' + esc(t.note) + '</span><span class="meta"><span>' + esc(t.assignee_id ? 'Assigned: ' + userById(t.assignee_id)?.name : 'Shared queue · awaiting assignment') + '</span><span>Created by ' + esc(actorName(t.created_by)) + '</span></span></span><span class="ticket-flags">' + badge(t.status, t.status === 'Resolved' ? 'resolved' : '') + (isUrgent(t) ? badge('Acknowledgement due', 'urgent') : isDue(t) ? badge('24h update overdue', 'due') : isReminderDue(t) ? badge('Personal reminder due', 'due') : '') + '</span></button>').join('') : '<div class="empty">No requests match this view.</div>';
  const relevant = visibleTickets(); $('urgentCount').textContent = relevant.filter(isUrgent).length; $('dueCount').textContent = relevant.filter(isDue).length; $('openCount').textContent = relevant.filter(t => t.status !== 'Resolved').length;
}
function renderInbox() {
  const list = state().notifications.filter(n => n.recipient_id === currentUser.id && canView(currentUser, ticketById(n.ticket_id))).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  $('inboxCount').textContent = list.filter(n => n.state !== 'cancelled' && ticketById(n.ticket_id)?.status !== 'Resolved').length || '';
  $('inboxList').innerHTML = list.length ? list.map(n => '<button class="notification-card" data-request="' + esc(n.ticket_id) + '"><span class="eyebrow">' + esc(KIND_LABEL[n.kind] || n.kind) + '</span><strong>' + esc(ticketById(n.ticket_id)?.note) + '</strong><span class="meta">' + badge(n.state, ['failed', 'retrying'].includes(n.state) ? 'due' : '') + '<span>' + esc(fmt(n.created_at)) + '</span><span>For ' + esc(currentUser.name) + '</span></span></button>').join('') : '<div class="card empty">No reminders or notifications for you yet.</div>';
}
function renderStaff() {
  if (currentUser.role !== 'admin') return;
  $('staffList').innerHTML = state().team.map(user => {
    const assigned = state().tickets.filter(t => t.assignee_id === user.id && t.status !== 'Resolved'), blocked = assigned.length || user.id === currentUser.id;
    return '<article class="card staff-card"><div class="staff-heading"><span class="staff-avatar">' + esc(initials(user.name)) + '</span><div class="staff-details"><h2>' + esc(user.name) + '</h2><span>' + esc(ROLE_LABEL[user.role]) + '</span></div>' + badge(user.is_active ? 'Active' : 'Inactive', user.is_active ? 'resolved' : '') + '</div><div class="staff-meta"><p>' + esc(user.department) + '</p><p>' + esc(user.email) + '<br>' + esc(user.phone) + '</p><p><strong>' + assigned.length + '</strong> open assigned · ' + assigned.filter(isDue).length + ' overdue</p></div><div class="staff-actions"><button class="btn compact" data-staff="' + esc(user.id) + '" ' + (user.is_active && blocked ? 'disabled' : '') + '>' + (user.is_active ? 'Deactivate login' : 'Activate login') + '</button><span class="hint">' + (user.id === currentUser.id ? 'Your own login stays active.' : assigned.length ? 'Resolve or reassign open work before deactivating.' : 'Access changes apply to this demo.') + '</span></div></article>';
  }).join('');
}
function bars(rows) {
  const max = Math.max(1, ...rows.map(row => row[1]));
  return rows.map(([label, value]) => '<div class="bar-row"><span>' + esc(label) + '</span><strong>' + value + '</strong><div class="bar-track"><i style="width:' + Math.round(value / max * 100) + '%"></i></div></div>').join('');
}
function renderReports() {
  const tickets = state().tickets, open = tickets.filter(t => t.status !== 'Resolved'), resolved = tickets.filter(t => t.status === 'Resolved');
  $('reportSummary').innerHTML = metric('Open requests', open.length) + metric('24h overdue', open.filter(isDue).length) + metric('Unacknowledged urgent', open.filter(isUrgent).length) + metric('Resolved requests', resolved.length);
  $('typeReport').innerHTML = bars(Object.entries(TYPE_LABEL).map(([type, label]) => [label, open.filter(t => t.type === type).length]));
  $('workloadReport').innerHTML = bars(state().team.map(user => [user.name, open.filter(t => t.assignee_id === user.id).length]).concat([['Shared queue', open.filter(t => !t.assignee_id).length]]));
  $('resolvedReport').innerHTML = resolved.length ? '<table class="data-table"><thead><tr><th>Request</th><th>Assigned person</th><th>Resolved (IST)</th></tr></thead><tbody>' + resolved.sort((a, b) => Date.parse(b.resolved_at) - Date.parse(a.resolved_at)).map(t => '<tr><td><button class="btn compact" data-request="' + esc(t.id) + '">' + esc(t.note) + '</button></td><td>' + esc(userById(t.assignee_id)?.name || 'Shared queue') + '</td><td>' + esc(fmt(t.resolved_at)) + '</td></tr>').join('') + '</tbody></table>' : '<p class="hint">Resolved work will appear here.</p>';
}
function deliveryMarkup(notification, allowRetry = false) {
  const attempts = state().deliveries.filter(d => d.notification_id === notification.id).sort((a, b) => Date.parse(a.attempted_at) - Date.parse(b.attempted_at));
  return '<article class="card delivery-card"><div class="delivery-top"><div><span class="eyebrow">' + esc(KIND_LABEL[notification.kind] || notification.kind) + '</span><h3>' + esc(ticketById(notification.ticket_id)?.note) + '</h3><p class="hint">To ' + esc(userById(notification.recipient_id)?.name) + ' · ' + esc(fmt(notification.created_at)) + '</p></div>' + badge(notification.state, notification.state === 'failed' ? 'urgent' : notification.state === 'retrying' ? 'due' : '') + '</div><div class="attempt-list">' + attempts.map(d => '<div class="attempt-row"><strong>' + esc(d.channel) + '</strong>' + badge(d.state, d.state === 'failed' || d.state === 'bounced' ? 'due' : 'resolved') + '<span class="hint">' + esc(fmt(d.attempted_at)) + ' · ' + esc(d.error_message || 'Simulated provider ' + d.state) + '</span></div>').join('') + '</div>' + (notification.next_attempt_at ? '<p class="hint">Next retry: ' + esc(fmt(notification.next_attempt_at)) + ' · Retry count: ' + notification.retry_count + '</p>' : '') + (allowRetry && ['failed', 'retrying'].includes(notification.state) && ticketById(notification.ticket_id)?.status !== 'Resolved' ? '<button class="btn compact" data-retry="' + esc(notification.id) + '">Simulate successful retry</button>' : '') + '</article>';
}
function renderDeliveries() {
  const list = [...state().notifications].sort((a, b) => { const order = { failed: 0, retrying: 1, queued: 2, sent: 3, cancelled: 4 }; return order[a.state] - order[b.state] || Date.parse(b.created_at) - Date.parse(a.created_at) });
  $('deliverySummary').innerHTML = metric('Needs attention', list.filter(n => n.state === 'failed').length, 'Unresolved failed notifications') + metric('Retry scheduled', list.filter(n => n.state === 'retrying').length) + metric('Sent', list.filter(n => n.state === 'sent').length, 'Simulated provider results') + metric('Cancelled', list.filter(n => n.state === 'cancelled').length);
  $('deliveryList').innerHTML = list.map(n => deliveryMarkup(n, true)).join('') || '<div class="empty">No delivery activity yet.</div>';
}

function fillProjects() { const client = $('clientSelect').value, service = $('ticketType').value === 'service'; $('projectSelect').innerHTML = (service ? '' : '<option value="">No project</option>') + options(state().projects.filter(p => !service || p.client_id === client).map(p => p.id), projectName) }
function openNew() {
  if (busy) return; $('newTicketForm').reset(); revokeURLs(previewURLs); $('filePreview').innerHTML = '';
  $('ticketType').innerHTML = options(allowedTypes(currentUser), type => TYPE_LABEL[type]); $('clientSelect').innerHTML = options(state().clients.map(c => c.id), id => state().clients.find(c => c.id === id).name); fillProjects(); updateTypeFields(); $('newTicketDialog').showModal();
}
function recipientOptions(type, { detail = false } = {}) {
  let people = recipients(state(), type); if (!canManage(currentUser)) people = people.filter(user => user.id === currentUser.id);
  return '<option value="">' + (type === 'urgent_message' ? 'Choose a recipient' : 'Shared queue') + '</option>' + options(people.map(user => user.id), id => userById(id).name + ' · ' + ROLE_LABEL[userById(id).role] + (id === currentUser.id ? ' (me)' : ''));
}
function updateTypeFields() {
  const type = $('ticketType').value, follow = type === 'follow_up';
  show('clientField', type === 'service'); show('projectField', true); show('reminderField', follow); show('customReminderField', follow && $('reminderPreset').value === 'custom'); show('assigneeField', !follow);
  const oldProject = $('projectSelect').value; fillProjects(); if ([...$('projectSelect').options].some(option => option.value === oldProject)) $('projectSelect').value = oldProject;
  const previous = $('assigneeSelect').value; $('assigneeSelect').innerHTML = recipientOptions(type); if ([...$('assigneeSelect').options].some(option => option.value === previous)) $('assigneeSelect').value = previous;
  $('routingHint').textContent = follow ? 'This is your personal reminder. It stays assigned to you.' : type === 'urgent_message' ? 'Choose one active recipient. They must explicitly acknowledge this message.' : canManage(currentUser) ? 'Assign to an eligible colleague or leave it in the shared queue.' : 'Choose yourself or the shared queue. A manager can assign it to a colleague.';
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
  if ($('reminderPreset').value === 'custom') { const value = $('customReminder').value; if (!value) throw new Error('Choose a reminder date and time.'); const ms = Date.parse(value + ':00+05:30'); if (!Number.isFinite(ms) || ms <= engine.now()) throw new Error('Choose a date after the current demo time (IST).'); return new Date(ms).toISOString() }
  return new Date(engine.now() + Number($('reminderPreset').value) * 3600000).toISOString();
}
function addFiles(draft, user, id, files, blobs) {
  for (const file of files) { const attachment = draft.addAttachment(user, id, { original_name: file.name, mime_type: file.type, byte_size: file.size }); blobs.push({ id: attachment.id, blob: file }) }
}
async function createRequest(event) {
  event.preventDefault(); await run($('submitTicket'), async () => {
    const files = [...$('ticketFiles').files]; validateFiles(files); const type = $('ticketType').value;
    const input = { type, note: $('ticketNote').value, project_id: $('projectSelect').value || null, assignee_id: type === 'follow_up' ? currentUser.id : $('assigneeSelect').value || null, reminder_at: type === 'follow_up' ? reminderValue() : null }, blobs = [];
    show('uploadProgress', files.length > 0); $('uploadProgress').querySelector('span').style.width = '15%';
    try {
      await change(draft => { const ticket = draft.create(currentUser, input); addFiles(draft, currentUser, ticket.id, files, blobs); return ticket }, { blobs });
      $('uploadProgress').querySelector('span').style.width = '100%'; $('newTicketDialog').close(); revokeURLs(previewURLs); $('filePreview').innerHTML = ''; $('newTicketForm').reset(); toast('Request created and recorded in the trail.');
    } finally { show('uploadProgress', false) }
  });
}
async function openTicket(id, { recordRead = true } = {}) {
  if (busy) return; const ticket = ticketById(id); if (!canView(currentUser, ticket)) { toast('This request is outside your workspace.', true); return }
  if (recordRead) await change(draft => draft.read(currentUser, id));
  currentTicketId = id; const t = ticketById(id), creator = actorName(t.created_by), assignee = userById(t.assignee_id);
  $('detailProject').textContent = TYPE_LABEL[t.type] + (t.project_id ? ' · ' + projectName(t.project_id) : ''); $('detailTitle').textContent = t.note;
  $('detailBadges').innerHTML = badge(t.status, t.status === 'Resolved' ? 'resolved' : '') + (isUrgent(t) ? badge('Acknowledgement due', 'urgent') : t.urgent_acknowledged_at ? badge('Acknowledged by ' + userById(t.urgent_acknowledged_by)?.name, 'resolved') : '') + (isDue(t) ? badge('24-hour update overdue', 'due') : '');
  $('detailSummary').textContent = 'Created by ' + creator + ' · Assigned to ' + (assignee?.name || 'shared queue') + '. ' + (t.status === 'Resolved' ? 'Resolved ' + fmt(t.resolved_at) + '.' : 'Next workflow update due ' + fmt(t.next_followup_due_at) + '.') + (t.type === 'follow_up' ? ' Personal reminder: ' + fmt(t.reminder_at) + (t.reminder_cancelled_at ? ' (cancelled)' : '') + '.' : '') + (t.expected_timeline ? ' Expected: ' + t.expected_timeline + '.' : '') + (t.urgent_read_at ? ' Recipient opened: ' + fmt(t.urgent_read_at) + '.' : '');
  show('ackWrap', canAcknowledge(currentUser, t)); show('assignmentControls', canAssign(currentUser, t)); show('updateForm', canUpdate(currentUser, t)); show('attachmentForm', canAttach(currentUser, t));
  $('detailAssignee').innerHTML = recipientOptions(t.type); $('detailAssignee').value = t.assignee_id || '';
  const allowed = t.status === 'Resolved' ? ['In Review'] : t.status === 'New' ? ['New', 'In Review', 'Resolved'] : t.status === 'In Review' ? ['In Review', 'Scheduled', 'Resolved'] : ['Scheduled', 'Resolved'];
  $('detailStatus').innerHTML = options(allowed, status => status); $('detailStatus').value = t.status === 'Resolved' ? 'In Review' : t.status;
  $('saveUpdate').textContent = t.status === 'Resolved' ? 'Reopen to In Review' : 'Record update'; $('internalNote').value = ''; $('expectedTimeline').value = ''; $('detailFiles').value = '';
  $('accessNote').textContent = canUpdate(currentUser, t) ? 'Record a work update to restart the 24-hour clock. Assignment, attachments and acknowledgement do not restart it.' : canAcknowledge(currentUser, t) ? 'You can acknowledge this urgent message. A manager manages its workflow status.' : 'You can view this request and its trail. Only its eligible assignee or a manager can change the workflow.';
  renderTimeline(t);
  $('detailDelivery').innerHTML = state().notifications.filter(n => n.ticket_id === id).map(n => '<p>' + esc(KIND_LABEL[n.kind] || n.kind) + ' → ' + esc(userById(n.recipient_id)?.name) + ' · ' + esc(n.state) + ' · ' + esc(fmt(n.created_at)) + '</p>').join('') || '<p>No notification has been queued yet.</p>';
  if (!$('ticketDialog').open) $('ticketDialog').showModal(); history.replaceState(null, '', '#request=' + encodeURIComponent(id)); await renderMedia(t);
}
function renderTimeline(ticket) {
  $('detailTimeline').innerHTML = state().events.filter(e => e.ticket_id === ticket.id).map((event, index) => ({ ...event, order: index })).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.order - a.order).map(e => {
    const details = e.event_type === 'assigned' ? 'From ' + (userById(e.metadata?.old_assignee_id)?.name || 'Shared queue') + ' to ' + (userById(e.metadata?.new_assignee_id || e.metadata?.assignee_id)?.name || 'Shared queue') : e.event_type === 'attachment_added' ? e.metadata?.original_name || '' : e.old_status ? e.old_status + ' → ' + e.new_status : '';
    return '<div class="event"><strong>' + esc(EVENT_LABEL[e.event_type] || e.event_type) + '</strong><p>' + esc(actorName(e.actor_user_id)) + ' · ' + esc(fmt(e.created_at)) + '</p>' + (details ? '<p>' + esc(details) + '</p>' : '') + (e.note ? '<p>' + esc(e.note) + '</p>' : '') + (e.expected_timeline ? '<p>Expected: ' + esc(e.expected_timeline) + '</p>' : '') + '</div>';
  }).join('');
}
async function renderMedia(ticket) {
  const version = ++mediaVersion; revokeURLs(mediaURLs); $('detailMedia').innerHTML = '';
  for (const item of state().attachments.filter(a => a.ticket_id === ticket.id)) {
    const figure = document.createElement('figure'); figure.className = 'attachment-card';
    if (item.sample_kind) {
      figure.innerHTML = '<div class="sample-media"><div class="sample-art" aria-hidden="true"></div><span class="sample-caption">' + (item.sample_kind === 'video' ? 'Sample video placeholder' : 'Sample photo placeholder') + '</span></div><figcaption>' + esc(item.original_name) + '</figcaption><small>Illustration only · upload your own media to test playback.</small>';
    } else {
      const blob = memoryOnly ? memoryMedia.get(item.id) : await getAttachmentBlob(item.id);
      if (version !== mediaVersion) return;
      if (blob) {
        const url = URL.createObjectURL(blob); mediaURLs.push(url); const media = document.createElement(item.mime_type.startsWith('video/') ? 'video' : 'img'); media.src = url;
        if (media.tagName === 'VIDEO') { media.controls = true; media.preload = 'metadata' } else media.alt = item.original_name;
        const link = document.createElement('a'); link.href = url; link.download = item.original_name; link.textContent = item.original_name;
        figure.append(media, link); if (item.mime_type === 'video/quicktime') { const note = document.createElement('small'); note.textContent = 'MOV playback depends on your browser. Download to play if needed.'; figure.append(note) }
      } else figure.textContent = item.original_name + ' · File unavailable in this browser.';
    }
    if (version !== mediaVersion) return; $('detailMedia').append(figure);
  }
}
async function updateRequest(event) {
  event.preventDefault(); const id = currentTicketId; await run($('saveUpdate'), async () => { await change(draft => draft.update(currentUser, id, { status: $('detailStatus').value, note: $('internalNote').value, expected_timeline: $('expectedTimeline').value })); closeDetail(); toast('Workflow update recorded.'); });
}
async function assignRequest() {
  const id = currentTicketId; await run($('saveAssignee'), async () => { await change(draft => draft.assign(currentUser, id, $('detailAssignee').value || null)); closeDetail(); toast('Assignment recorded. The 24-hour deadline is unchanged.'); });
}
async function acknowledge() {
  const id = currentTicketId; await run($('acknowledgeBtn'), async () => { await change(draft => draft.acknowledge(currentUser, id)); closeDetail(); toast('Acknowledged. Your receipt is recorded.'); });
}
async function uploadMore(event) {
  event.preventDefault(); const id = currentTicketId; await run($('saveAttachments'), async () => {
    const files = [...$('detailFiles').files]; if (!files.length) throw new Error('Choose at least one photo or video.'); validateFiles(files); const blobs = [];
    await change(draft => addFiles(draft, currentUser, id, files, blobs), { blobs }); await openTicket(id, { recordRead: false }); toast('Attachments saved. The 24-hour deadline is unchanged.');
  });
}
async function handleDeepLink() {
  const match = location.hash.match(/^#request=([a-zA-Z0-9-]+)$/); if (match && currentUser) await openTicket(match[1]);
}
function bind() {
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
  $('logout').onclick = logout; $('newTicketBtn').onclick = openNew; $('ticketType').onchange = updateTypeFields; $('reminderPreset').onchange = updateTypeFields; $('clientSelect').onchange = fillProjects; $('ticketFiles').onchange = previewFiles;
  $('newTicketForm').onsubmit = createRequest; $('updateForm').onsubmit = updateRequest; $('attachmentForm').onsubmit = uploadMore; $('saveAssignee').onclick = assignRequest; $('acknowledgeBtn').onclick = acknowledge;
  ['search', 'scopeFilter', 'typeFilter', 'statusFilter', 'projectFilter'].forEach(id => $(id).addEventListener(id === 'search' ? 'input' : 'change', renderTickets));
  document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => { if (!busy) switchView(button.dataset.view) });
  document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => { if (!busy) { if (button.dataset.close === 'ticketDialog') closeDetail(); else $(button.dataset.close).close() } });
  $('ticketDialog').addEventListener('close', () => { currentTicketId = null; mediaVersion++; revokeURLs(mediaURLs); if (location.hash.startsWith('#request=')) history.replaceState(null, '', location.pathname + location.search) });
  $('newTicketDialog').addEventListener('close', () => revokeURLs(previewURLs));
  document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('cancel', event => { if (busy) event.preventDefault() }));
  document.querySelectorAll('[data-advance]').forEach(button => button.onclick = () => run(button, async () => { await change(draft => draft.advanceHours(currentUser, Number(button.dataset.advance))); toast('Demo clock advanced. Check My reminders in each account.'); }));
  $('resetDemo').onclick = () => { if (canManage(currentUser)) $('resetDialog').showModal() };
  $('resetForm').onsubmit = event => { event.preventDefault(); run(event.submitter, async () => { if (!canManage(currentUser)) throw new Error('Only Admin or Manager can reset the demo.'); await change(draft => { draft.state = seedDemo() }, { reset: true }); $('resetDialog').close(); switchView('requests'); toast('Sample workspace restored.'); }) };
  document.addEventListener('click', event => {
    const request = event.target.closest('[data-request]'); if (request) openTicket(request.dataset.request).catch(reportError);
    const retry = event.target.closest('[data-retry]'); if (retry) run(retry, async () => { await change(draft => draft.retryDelivery(currentUser, retry.dataset.retry)); toast('Successful delivery retry simulated and recorded.'); });
    const staff = event.target.closest('[data-staff]'); if (staff) run(staff, async () => { const member = userById(staff.dataset.staff); await change(draft => draft.setStaffActive(currentUser, member.id, !member.is_active)); toast('Demo staff access updated.'); });
  });
  window.addEventListener('hashchange', () => handleDeepLink().catch(reportError));
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); deferredInstall = event; show('installBtn', true) });
  $('installBtn').onclick = async () => { if (!deferredInstall) { toast('On iPhone: Share → Add to Home Screen.'); return } await deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; show('installBtn', false) };
}
async function start() {
  bind(); let saved = null;
  try {
    saved = await loadDemo();
    const seed = seedDemo();
    if (saved) {
      // Sync phone and password credentials to previously saved team records
      let updated = false;
      for (const seededUser of seed.team) {
        const existing = saved.team?.find(u => u.id === seededUser.id);
        if (existing) {
          if (existing.phone !== seededUser.phone || existing.password !== seededUser.password) {
            existing.phone = seededUser.phone;
            existing.password = seededUser.password;
            updated = true;
          }
        }
      }
      engine = new DemoEngine(saved);
      if (updated) await saveDemo(state());
    } else {
      engine = new DemoEngine(seed);
      await saveDemo(state());
    }
  }
  catch (error) { memoryOnly = true; engine = new DemoEngine(seedDemo()); $('loginError').textContent = error.message + ' This session is temporary; refreshing will discard changes.'; show('loginError', true) }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('service-worker.js').catch(() => { });
  if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !window.matchMedia('(display-mode: standalone)').matches) show('installBtn', true);
  const id = savedSession(); if (id && userById(id)?.is_active) await login(id);
  setInterval(() => { if (currentUser && !busy && !document.querySelector('dialog[open]')) change(draft => draft.scan()).catch(reportError) }, 60000);
}
start().catch(error => { $('loginError').textContent = error.message; show('loginError', true) });
