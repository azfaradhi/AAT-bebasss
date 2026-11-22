import fs from 'node:fs'; import readline from 'node:readline';
const f=process.argv[2]; const rl=readline.createInterface({input:fs.createReadStream(f)});
let meta=[],kinds={},prev=null,gaps=0,dups=0,first=null,last=null,lastT=0,hb=[],keys=new Map(),dupKeys=0,ooo=0,maxAcq=0,lateMin=[],tFirstData=null, buckets={};
const detKey=d=>`${d.satellite}|${d.acq_date}|${d.acq_time}|${Number(d.latitude).toFixed(5)}|${Number(d.longitude).toFixed(5)}`;
let updFields={},retReasons={},dayConf={},lastLines=[];
for await (const line of rl){ const o=JSON.parse(line); if(o.meta){meta.push(o);continue;}
 lastT=o.t; const fr=o.frame; const m={}; let data=[];
 for(const l of fr.split('\n')){ if(l.startsWith(':')){m.comment=l;continue;} const k=l.indexOf(':'); if(k<0)continue; const f=l.slice(0,k); const v=l.slice(k+1).replace(/^ /,''); if(f==='data')data.push(v); else m[f]=v; }
 const ev=m.event||'(none)'; kinds[ev]=(kinds[ev]||0)+1;
 const sec=Math.floor(o.t/10000); buckets[sec]=(buckets[sec]||0)+1;
 const id=m.id!==undefined?Number(m.id):null; if(id!==null){ if(first===null)first=id; if(prev!==null){ if(id===prev)dups++; else if(id!==prev+1)gaps++; } prev=id; last=id; }
 if(ev==='heartbeat'){hb.push({t:o.t,id:m.id,data:data.join('')});continue;}
 let d; try{d=JSON.parse(data.join('\n'));}catch{continue;}
 if(ev==='detection'){ const det=d.detection; const k=detKey(det); if(keys.has(k))dupKeys++; else keys.set(k,1);
   const t=Date.parse(`${det.acq_date}T${String(det.acq_time).padStart(4,'0').replace(/(..)$/,':$1')}:00Z`); if(t<maxAcq)ooo++; else maxAcq=t; dayConf[det.confidence]=(dayConf[det.confidence]||0)+1; }
 if(ev==='update'){ for(const c of Object.keys(d.changes))updFields[c]=(updFields[c]||0)+1; }
 if(ev==='retract'){ retReasons[d.reason]=(retReasons[d.reason]||0)+1; }
}
console.log(JSON.stringify({meta,kinds,firstId:first,lastId:last,gaps,dupOffsets:dups,dupDetectionKeys:dupKeys,uniqueKeys:keys.size,outOfOrderAcq:ooo,conf:dayConf,updFields,retReasons,hbCount:hb.length,hbSample:hb.slice(0,3),durMs:lastT,per10s:buckets},null,0));
