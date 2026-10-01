import {createServer} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
const root=resolve('dist'),port=Number(process.env.PORT||8080);
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
createServer(async(req,res)=>{
 try{
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
  const path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  const file=resolve(root,'.'+(path==='/'?'/index.html':path));
  if(!file.startsWith(root+sep)||!(await stat(file)).isFile())throw Error('missing');
  res.writeHead(200,{'content-type':types[extname(file)]||'application/octet-stream','cache-control':'no-store','x-content-type-options':'nosniff'});
  res.end(req.method==='HEAD'?undefined:await readFile(file));
 }catch{res.writeHead(404);res.end('Not found');}
}).listen(port,'127.0.0.1',()=>console.log('Oak workspace: http://localhost:'+port));
