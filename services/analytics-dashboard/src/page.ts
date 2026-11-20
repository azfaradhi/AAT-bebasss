// Single self-contained page: no CDN, charts are inline SVG built from /api/summary. Values are always set with textContent.
export const PAGE = `<!doctype html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Analitik Kebencanaan BNPB</title>
<style>
:root{--bg:#fafafa;--fg:#1b1b1f;--mut:#666;--card:#fff;--line:#d9d9de;--warn:#fff3cd;--warnfg:#664d03;--err:#f8d7da;--errfg:#58151c}
@media (prefers-color-scheme:dark){:root{--bg:#16161a;--fg:#ececf1;--mut:#9a9aa5;--card:#1f1f25;--line:#34343c;--warn:#3d3200;--warnfg:#ffe69c;--err:#3b1519;--errfg:#f1aeb5}}
*{box-sizing:border-box}body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
h1{font-size:20px;margin:0 0 12px}h2{font-size:15px;margin:0 0 8px}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:end;margin-bottom:12px}
label{display:flex;flex-direction:column;font-size:12px;color:var(--mut);gap:2px}
input,select,button{font:inherit;padding:5px 8px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg)}
button{cursor:pointer}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;margin-bottom:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
#banner{display:none;padding:8px 12px;border-radius:8px;margin-bottom:12px}
#banner.partial{display:block;background:var(--warn);color:var(--warnfg)}
#banner.error{display:block;background:var(--err);color:var(--errfg)}
.kpi{display:flex;gap:24px;flex-wrap:wrap}.kpi b{font-size:26px;display:block}.kpi span{color:var(--mut);font-size:12px}
svg{width:100%;height:auto;display:block}svg text{fill:var(--mut);font-size:10px}
.legend{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;margin-top:6px}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px}
</style></head><body>
<h1>Analitik Kebencanaan</h1>
<div id="banner" role="status"></div>
<div class="bar">
  <label>Dari<input id="from" type="datetime-local"></label>
  <label>Sampai<input id="to" type="datetime-local"></label>
  <label>Bucket<select id="bucket"><option value="day">per hari</option><option value="hour">per jam</option></select></label>
  <button id="apply">Terapkan</button><button id="reset">Semua waktu</button>
</div>
<div class="card kpi"><div><b id="total">-</b><span>total kejadian</span></div><div><b id="asof">-</b><span>per waktu (as_of)</span></div></div>
<div class="card"><h2>Kejadian per jenis dari waktu ke waktu</h2><div id="line"></div><div class="legend" id="legend"></div></div>
<div class="grid">
  <div class="card"><h2>Per tingkat keparahan</h2><div id="sev"></div></div>
  <div class="card"><h2>Per area (teratas)</h2><div id="area"></div></div>
</div>
<script>
const TYPES=[['gempa','Gempa','#1f77b4'],['tsunami','Tsunami','#17becf'],['gunung_berapi','Gunung berapi','#d62728'],['kebakaran_hutan','Kebakaran hutan','#ff7f0e'],['pesisir','Pesisir','#2ca02c']];
const SEV=[['NORMAL','#8c8c8c'],['WASPADA','#e6c200'],['SIAGA','#ff7f0e'],['AWAS','#d62728']];
const NS='http://www.w3.org/2000/svg';
const $=id=>document.getElementById(id);
function el(name,attrs,text){const e=document.createElementNS(NS,name);for(const k in attrs)e.setAttribute(k,attrs[k]);if(text!==undefined)e.textContent=text;return e}
function svg(w,h){return el('svg',{viewBox:'0 0 '+w+' '+h,role:'img'})}
function fmtBucket(b,bucket){return bucket==='hour'?b.slice(5,13).replace('T',' ')+'h':b.slice(0,10)}
function line(data,bucket){
  const box=$('line');box.replaceChildren();
  const W=640,H=220,L=36,B=22,T=8,R=8,pts=data.by_type_over_time;
  if(!pts.length){box.textContent='Belum ada data pada rentang ini.';return}
  const max=Math.max(1,...pts.flatMap(p=>TYPES.map(t=>p[t[0]])));
  const x=i=>L+(pts.length===1?(W-L-R)/2:i*(W-L-R)/(pts.length-1)),y=v=>T+(H-T-B)*(1-v/max);
  const s=svg(W,H);
  for(let g=0;g<=4;g++){const v=Math.round(max*g/4);s.append(el('line',{x1:L,x2:W-R,y1:y(v),y2:y(v),stroke:'#8884','stroke-width':1}),el('text',{x:L-4,y:y(v)+3,'text-anchor':'end'},String(v)))}
  const step=Math.ceil(pts.length/8);
  pts.forEach((p,i)=>{if(i%step===0)s.append(el('text',{x:x(i),y:H-6,'text-anchor':i===pts.length-1?'end':i===0?'start':'middle'},fmtBucket(p.bucket,bucket)))});
  for(const [k,name,color] of TYPES){
    const d=pts.map((p,i)=>(i?'L':'M')+x(i).toFixed(1)+' '+y(p[k]).toFixed(1)).join(' ');
    s.append(el('path',{d,fill:'none',stroke:color,'stroke-width':2}));
    pts.forEach((p,i)=>s.append(el('circle',{cx:x(i),cy:y(p[k]),r:2.5,fill:color},undefined)));
  }
  box.append(s);
}
function bars(box,rows,w){
  box.replaceChildren();
  if(!rows.length){box.textContent='Belum ada data.';return}
  const row=24,W=w||360,H=rows.length*row+4,max=Math.max(1,...rows.map(r=>r.value)),s=svg(W,H);
  rows.forEach((r,i)=>{
    const yy=i*row+2,bw=Math.max(1,(W-170)*r.value/max);
    s.append(el('text',{x:0,y:yy+14,'font-size':11},r.label.length>22?r.label.slice(0,21)+'…':r.label),
      el('rect',{x:120,y:yy+3,width:bw,height:14,rx:2,fill:r.color||'#1f77b4'}),
      el('text',{x:120+bw+4,y:yy+14},String(r.value)));
  });
  box.append(s);
}
function legend(){const l=$('legend');l.replaceChildren();for(const [,name,color] of TYPES){const s=document.createElement('span'),i=document.createElement('i');i.style.background=color;s.append(i,name);l.append(s)}}
function banner(kind,text){const b=$('banner');b.className=kind||'';b.textContent=text||''}
function query(){
  const q=new URLSearchParams(),f=$('from').value,t=$('to').value;
  if(f)q.set('from',new Date(f).toISOString());if(t)q.set('to',new Date(t).toISOString());
  q.set('bucket',$('bucket').value);return q;
}
async function load(){
  try{
    const res=await fetch('/api/summary?'+query());
    const data=await res.json();
    if(!res.ok){banner('error','Tidak dapat memuat data: '+((data.error&&data.error.message)||res.status));return}
    if(data.partial)banner('partial','Data belum lengkap: unit penyimpanan tidak terjangkau ('+(data.unavailable_units||[]).join(', ')+'). Angka dapat lebih kecil dari sebenarnya.');
    else banner('','');
    $('total').textContent=String(data.total);$('asof').textContent=data.as_of;
    line(data,$('bucket').value);
    bars($('sev'),SEV.map(([k,c])=>({label:k,value:data.by_severity[k]||0,color:c})));
    bars($('area'),data.by_area.slice(0,15).map(a=>({label:a.area_name,value:a.count})),420);
  }catch(e){banner('error','Tidak dapat memuat data: '+e.message)}
}
$('apply').onclick=load;
$('reset').onclick=()=>{$('from').value='';$('to').value='';load()};
legend();load();setInterval(load,10000);
</script></body></html>`;
