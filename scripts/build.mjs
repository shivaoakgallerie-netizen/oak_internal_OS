import {cp,mkdir,rm,readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validatePublicConfig} from '../workflow-rules.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),output=resolve(root,'dist');
// Read local configuration without ever copying .env or privileged keys.
try{process.loadEnvFile(resolve(root,'.env'));}catch(error){if(error.code!=='ENOENT')throw error;}
// Parse the checked-in public config in an isolated object.
const sandbox={window:{}};(await import('node:vm')).runInNewContext(await readFile(resolve(root,'config.js'),'utf8'),sandbox);
const config={...sandbox.window.OAK_CONFIG};
for(const [env,field] of Object.entries({PUBLIC_SUPABASE_URL:'supabaseUrl',PUBLIC_SUPABASE_PUBLISHABLE_KEY:'publishableKey',PUBLIC_VAPID_KEY:'vapidPublicKey',PUBLIC_TURNSTILE_SITE_KEY:'captchaSiteKey'}))if(process.env[env])config[field]=process.env[env];
validatePublicConfig(config);
await rm(output,{recursive:true,force:true});await mkdir(resolve(output,'vendor'),{recursive:true});
for(const file of ['index.html','styles.css','prototype.css','app.js','workflow-rules.js','live-client.js','legacy-cleanup.js','manifest.webmanifest','service-worker.js'])await cp(resolve(root,file),resolve(output,file));
await cp(resolve(root,'icons'),resolve(output,'icons'),{recursive:true});
await cp(resolve(root,'node_modules/@supabase/supabase-js/dist/umd/supabase.js'),resolve(output,'vendor/supabase.js'));
await writeFile(resolve(output,'config.js'),'// Public configuration only.\nwindow.OAK_CONFIG = '+JSON.stringify(config,null,2)+';\n');
console.log('Built secure Supabase workspace in '+output);
