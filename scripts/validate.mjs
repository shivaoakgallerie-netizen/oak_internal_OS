import {readFile,access} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
const html=await readFile('index.html','utf8'),app=await readFile('app.js','utf8');
for(const file of ['styles.css','prototype.css','app.js','config.js','vendor/supabase.js','manifest.webmanifest','icons/oak-mark.svg'])if(!html.includes(file))throw Error(file+' missing from index.html');
for(const file of ['app.js','workflow-rules.js','live-client.js','legacy-cleanup.js','config.js','service-worker.js','scripts/import-staff.mjs','scripts/staff-roster.mjs','scripts/staff-password-links.mjs','scripts/build.mjs','scripts/serve.mjs'])execFileSync(process.execPath,['--check',resolve(file)],{stdio:'inherit'});
for(const file of ['supabase/functions/notification-worker/index.ts','supabase/functions/notification-scan/index.ts','supabase/functions/resend-webhook/index.ts','supabase/functions/_shared/response.ts'])execFileSync(process.execPath,['--experimental-strip-types','--check',resolve(file)],{stdio:'inherit'});
if(/DemoEngine|seedDemo|from ['"]\.\/demo-|authenticate\(/.test(app))throw Error('Demo authentication remains in the live application');
const ids=new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]));
for(const [,id] of app.matchAll(/\$\('([^']+)'\)/g))if(!ids.has(id))throw Error('Missing HTML element '+id);
for(const [file,sql] of await Promise.all(['schema.sql','migrations/20260930_secure_admin_staff.sql'].map(async f=>[f,await readFile(f,'utf8')]))){
 if((sql.match(/\$\$/g)||[]).length%2)throw Error(file+' has unmatched SQL quoting');
 if(/for\s+all\s+to\s+authenticated/i.test(sql))throw Error(file+' contains a broad write policy');
 for(const rpc of ['is_admin','can_read_request','can_update_request','reserve_attachment','finalize_attachment'])if(!sql.includes(rpc))throw Error(file+' missing '+rpc);
}
JSON.parse(await readFile('manifest.webmanifest','utf8'));
for(const file of ['README.md','SUPABASE-SETUP.md','icons/logo.png','icons/symbol.png'])await access(file);
console.log('Secure application static validation passed.');
