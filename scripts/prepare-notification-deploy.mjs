// Produce self-contained sources for the Supabase dashboard editor.
// No environment files or credentials are included.
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const output=resolve('output/notification-deploy');
await mkdir(output,{recursive:true});
const helpers=await Promise.all(['response.ts','provider.js'].map(name=>readFile('supabase/functions/_shared/'+name,'utf8')));
for(const name of ['notification-worker','notification-scan']){
  const source=await readFile('supabase/functions/'+name+'/index.ts','utf8');
  const bundled=source.replace(/^import .* from '\.\.\/_shared\/[^']+';\r?\n/gm,'')+'\n'+helpers.join('\n');
  // Helper const bindings must exist before registering the server handler.
  const imports=bundled.match(/^import .*;$/gm)||[];
  const body=source.replace(/^import .*;\r?\n/gm,'');
  const result=imports.join('\n')+'\n'+helpers.join('\n')+'\n'+body;
  await writeFile(resolve(output,name+'.ts'),result);
  console.log('Prepared '+name+' ('+result.length+' characters)');
}
