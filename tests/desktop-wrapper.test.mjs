import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('desktop wrapper isolates the Netlify app and builds an NSIS installer',async()=>{
  const main=await readFile('desktop-app/main.cjs','utf8');
  const pkg=JSON.parse(await readFile('desktop-app/package.json','utf8'));
  assert.match(main,/https:\/\/cerulean-youtiao-fd7466\.netlify\.app\//);
  assert.match(main,/nodeIntegration:\s*false/);
  assert.match(main,/contextIsolation:\s*true/);
  assert.match(main,/sandbox:\s*true/);
  assert.match(main,/webSecurity:\s*true/);
  assert.match(main,/setWindowOpenHandler\(\(\)\s*=>\s*\(\{\s*action:\s*'deny'/);
  assert.match(main,/will-navigate/);
  assert.equal(pkg.build.appId,'com.oakgallerie.oakdesk.desktop');
  assert.equal(pkg.build.win.target[0].target,'nsis');
  assert.deepEqual(pkg.build.win.target[0].arch,['x64']);
  assert.equal(pkg.build.win.icon,'assets/app-icon-512.png');
});
