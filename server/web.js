import { createServer } from 'node:http';
import next from 'next';
import { clientAddress } from './client-network.js';

const dev = process.argv.includes('--dev');
const port = Number(process.env.PORT || 3000);
const hostname = process.env.WEB_HOST || (dev ? '127.0.0.1' : '0.0.0.0');
const app = next({ dev, hostname, port });
await app.prepare();
const handle = app.getRequestHandler();
const server = createServer((request,response)=>{
  // Next's default rewrite preserves X-Forwarded-For. Replace it at ingress
  // before proxying /api so the API sees a verified connection-derived address.
  const client = clientAddress(request,process.env.WEB_TRUSTED_PROXY_CIDRS);
  request.headers['x-forwarded-for'] = client;
  request.headers['x-real-ip'] = client;
  handle(request,response);
});
server.on('error',error=>{console.error('Web server failed:',error.message);process.exit(1);});
server.listen(port,hostname,()=>console.log(`DockFlow web ready at http://${hostname}:${port}`));
