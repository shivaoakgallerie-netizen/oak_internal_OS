import {cp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),output=resolve(root,'dist');
const variables={
  '__SUPABASE_URL__':process.env.PUBLIC_SUPABASE_URL,
  '__SUPABASE_PUBLISHABLE_KEY__':process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  '__VAPID_PUBLIC_KEY__':process.env.PUBLIC_VAPID_KEY,
  '__TURNSTILE_SITE_KEY__':process.env.PUBLIC_TURNSTILE_SITE_KEY
};
// This release is a browser-only prototype; provider configuration is optional.
await rm(output,{recursive:true,force:true});await mkdir(output,{recursive:true});
for(const file of ['index.html','styles.css','prototype.css','app.js','demo-model.js','demo-storage.js','manifest.webmanifest','service-worker.js'])await cp(resolve(root,file),resolve(output,file));
await cp(resolve(root,'icons'),resolve(output,'icons'),{recursive:true});
let config=await readFile(resolve(root,'config.js'),'utf8');for(const [token,value] of Object.entries(variables))if(value)config=config.replaceAll(token,value);await writeFile(resolve(output,'config.js'),config);
console.log(`Built browser-only prototype in ${output}`);
