import {readFile,access} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const html=await readFile(resolve(root,'index.html'),'utf8');
for(const file of ['styles.css','prototype.css','app.js','manifest.webmanifest','icons/oak-mark.svg']){await access(resolve(root,file));if(!html.includes(file))throw new Error(`${file} is not referenced by index.html`)}
for(const file of ['demo-model.js','demo-storage.js','config.js','service-worker.js','tests/workflow.sql'])await access(resolve(root,file));
const app=await readFile(resolve(root,'app.js'),'utf8');
for(const file of ['demo-model.js','demo-storage.js'])if(!new RegExp(`from\\s+['\"]\\./${file.replaceAll('.','\\.')}['\"]`).test(app))throw new Error(`${file} is not imported by app.js`);
if(!app.includes('service-worker.js'))throw new Error('app.js does not register the service worker');
if(/<script[^>]+src=["'][^"']*(?:config\.js|supabase)/i.test(html))throw new Error('The prototype must not load live authentication configuration');
JSON.parse(await readFile(resolve(root,'manifest.webmanifest'),'utf8'));
for(const file of ['app.js','demo-model.js','demo-storage.js','config.js','service-worker.js','scripts/import-staff.mjs','scripts/build.mjs'])execFileSync(process.execPath,['--check',resolve(root,file)],{stdio:'inherit'});
for(const file of ['supabase/functions/notification-worker/index.ts','supabase/functions/notification-scan/index.ts','supabase/functions/resend-webhook/index.ts','supabase/functions/_shared/response.ts'])execFileSync(process.execPath,['--experimental-strip-types','--check',resolve(root,file)],{stdio:'inherit'});
const schema=await readFile(resolve(root,'schema.sql'),'utf8'),migration=await readFile(resolve(root,'migrations/20260923_internal_workflow_upgrade.sql'),'utf8');
for(const token of ['create_request','record_request_update','assign_request','acknowledge_urgent','register_push_subscription','claim_notification_batch'])if(!schema.includes(token))throw new Error(`schema.sql is missing ${token}`);
for(const [name,sql] of [['schema.sql',schema],['upgrade migration',migration]]){if((sql.match(/\$\$/g)||[]).length%2)throw new Error(`${name} has an unmatched dollar quote`);if(/for\s+all\s+to\s+authenticated/i.test(sql))throw new Error(`${name} contains an over-broad FOR ALL policy`)}
console.log('Static validation passed.');
