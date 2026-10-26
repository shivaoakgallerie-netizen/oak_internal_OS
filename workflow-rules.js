// Presentation rules only. Every mutation and read is authorized again in Postgres.
export const TYPE_LABEL = Object.freeze({service:'Client work',help_ticket:'Ask for help',follow_up:'Personal reminder',urgent_message:'Urgent message'});
export const ROLE_LABEL = Object.freeze({admin:'Admin',staff:'Team member'});
export const ROLE_DESCRIPTION = Object.freeze({admin:'Keep team requests moving and help everyone stay up to date.',staff:'Create requests, share progress on assigned work, and talk with your team.'});
const active = user => Boolean(user?.is_active && ROLE_LABEL[user.role]);
export const canManage = user => active(user) && user.role === 'admin';
export const allowedTypes = user => !active(user) ? [] : canManage(user) ? Object.keys(TYPE_LABEL) : ['service','help_ticket','follow_up'];
export const canView = (user,ticket) => active(user) && Boolean(ticket) && (canManage(user) || ticket.assignee_id === user.id || ticket.created_by === user.auth_user_id || (!ticket.assignee_id && ['service','help_ticket'].includes(ticket.type)));
export const canUpdate = (user,ticket) => active(user) && Boolean(ticket) && (canManage(user) || ticket.assignee_id === user.id);
export const canAssign = (user,ticket) => canManage(user) && Boolean(ticket) && ticket.status !== 'Resolved' && ticket.type !== 'follow_up';
export const canAttach = (user,ticket) => canView(user,ticket) && ticket.status !== 'Resolved' && (canManage(user) || ticket.assignee_id === user.id || ticket.created_by === user.auth_user_id);
export const canAcknowledge = (user,ticket) => active(user) && ticket?.type === 'urgent_message' && ticket.status !== 'Resolved' && ticket.assignee_id === user.id && !ticket.urgent_acknowledged_at;
export const recipients = (state,type) => type === 'follow_up' ? [] : state.team.filter(active);
const CANCELLATION_REASON = Object.freeze({
  request_resolved: 'The request was marked Done.',
  request_updated: 'A new update was saved, so the old reminder was no longer needed.',
  assignment_changed: 'The request was assigned to someone else, so this reminder was stopped.',
  recipient_inactive: 'This person’s account is inactive, so the message was not sent.',
  urgent_acknowledged: 'This person confirmed they saw the urgent message.'
});
export function notificationCancellationText(notification) {
  if(notification.state!=='cancelled')return '';
  const reason=Object.hasOwn(CANCELLATION_REASON,notification.cancellation_reason)
    ?CANCELLATION_REASON[notification.cancellation_reason]:'The cancellation reason was not recorded.';
  return reason+' This notification will not be sent.';
}
export const isNotificationRetryScheduled = notification => notification.state==='failed'
  && !notification.processed_at && notification.attempt_count>0 && notification.attempt_count<4
  && Boolean(notification.next_attempt_at);
export function notificationTimingText(notification,format) {
  if(notification.state==='queued'&&notification.last_error==='Waiting for the recipient to enable browser alerts.')return 'Waiting for this person to enable alerts on their device.';
  const next=notification.next_attempt_at||notification.scheduled_for;
  if(notification.state==='queued'&&next)return 'Scheduled for: '+format(next);
  if(isNotificationRetryScheduled(notification))
    return 'Next retry: '+format(next)+' · Delivery attempts: '+notification.attempt_count;
  return '';
}
export function normalizePhone(value) {
  const phone=String(value||'').trim().replace(/[\s()-]/g,'');
  if (/^[6-9]\d{9}$/.test(phone)) return '+91'+phone;
  if (/^\+[1-9]\d{7,14}$/.test(phone)) return phone;
  throw new Error('Enter a 10-digit Indian mobile number or a full number with +country code.');
}
export function validatePublicConfig(config) {
  const url=String(config?.supabaseUrl||''),key=String(config?.publishableKey||'');
  if (!url || !key || /__|your-project|replace/i.test(url+key)) throw new Error('Supabase is not configured yet. Ask the administrator to connect this workspace.');
  const parsed=new URL(url);
  if (parsed.protocol !== 'https:' && !(['localhost','127.0.0.1'].includes(parsed.hostname) && parsed.protocol === 'http:')) throw new Error('Supabase must use HTTPS.');
  if (key.startsWith('sb_secret_')) throw new Error('A private key was provided as browser configuration. Use only a publishable or anon key.');
  if (!key.startsWith('sb_publishable_')) {
    let payload;
    try { payload=JSON.parse(atob(key.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))); } catch { throw new Error('Use a valid Supabase publishable or anon key.'); }
    if (payload.role !== 'anon') throw new Error('Privileged Supabase keys must never enter the browser.');
  }
  return {url:parsed.href.replace(/\/$/,''),key};
}
