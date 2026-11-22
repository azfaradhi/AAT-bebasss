import fs from 'node:fs';
const env = fs.readFileSync(process.env.ENV_FILE ?? '.env.local','utf8');
const TOKEN = env.split('\n').find(l=>l.startsWith('SAT_GROUP_TOKEN=')).split('=')[1].trim().replace(/^["']|["']$/g,'');
const BASE='https://satellite.naufarrel.dev';
const H={authorization:`Bearer ${TOKEN}`};
const [,, mode, out, secs, from, lastId] = process.argv;
async function j(path, extra={}){const r=await fetch(BASE+path,{headers:{...H,...extra}});const t=await r.text();return {status:r.status,headers:Object.fromEntries([...r.headers].filter(([k])=>/content-type|retry|x-/.test(k))),body:t.slice(0,600)};}
if(mode==='session'){console.log(JSON.stringify(await j('/v1/session')));process.exit(0);}
if(mode==='bad'){ // error envelopes
  console.log(JSON.stringify({noauth:await (async()=>{const r=await fetch(BASE+'/v1/session');return {s:r.status,b:(await r.text()).slice(0,300)}})(),
   badfrom:await j('/v1/stream?from=abc'), negfrom:await j('/v1/stream?from=-1')}));process.exit(0);}
if(mode==='stream'){
  const ac=new AbortController(); setTimeout(()=>ac.abort(),Number(secs)*1000);
  const headers={...H,accept:'text/event-stream'}; if(lastId) headers['last-event-id']=lastId;
  const url=BASE+'/v1/stream'+(from!==undefined&&from!==''&&from!=='-'?`?from=${from}`:'');
  const t0=Date.now(); const ws=fs.createWriteStream(out);
  let res; try{ res=await fetch(url,{headers,signal:ac.signal}); }catch(e){console.log('connect-error',e.message);process.exit(1);}
  ws.write(JSON.stringify({meta:'open',status:res.status,ct:res.headers.get('content-type'),t:Date.now()-t0})+'\n');
  if(res.status!==200){ws.write(JSON.stringify({meta:'body',text:(await res.text()).slice(0,400)})+'\n');ws.end();console.log('status',res.status);process.exit(0);}
  const dec=new TextDecoder('utf-8'); let buf=''; let n=0;
  try{ for await (const chunk of res.body){ buf+=dec.decode(chunk,{stream:true}); let i;
    while((i=buf.indexOf('\n\n'))>=0){const frame=buf.slice(0,i);buf=buf.slice(i+2);
      ws.write(JSON.stringify({t:Date.now()-t0,frame})+'\n'); n++;} } }catch(e){ ws.write(JSON.stringify({meta:'end',reason:e.name,t:Date.now()-t0})+'\n'); }
  ws.end(); console.log('frames',n);
}
if(mode==='second'){ // second concurrent conn
  const r=await fetch(BASE+'/v1/stream?from=0',{headers:{...H,accept:'text/event-stream'}});
  console.log(JSON.stringify({status:r.status,ra:r.headers.get('retry-after'),body:(await r.text()).slice(0,300)}));
  process.exit(0);
}
