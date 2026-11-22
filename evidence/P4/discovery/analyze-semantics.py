import json,sys,datetime as dt,collections,statistics
def parse(fr):
    m={};d=[]
    for l in fr.split('\n'):
        k=l.find(':')
        if k<0: continue
        f=l[:k];v=l[k+1:].lstrip(' ')
        if f=='data': d.append(v)
        else: m[f]=v
    return m,json.loads('\n'.join(d))
def key(x): return f"{x['satellite']}|{x['acq_date']}|{x['acq_time']}|{x['latitude']:.5f}|{x['longitude']:.5f}"
def ts(x):
    hh,mm=divmod(int(x['acq_time']),100)
    return dt.datetime.fromisoformat(x['acq_date']).replace(tzinfo=dt.timezone.utc)+dt.timedelta(hours=hh,minutes=mm)
seen={};maxt=None;late=[];vnow=None
dupsame=dupdiff=0;upd_unknown=upd_after_retract=ret_unknown=ret_twice=det_after_retract=0;retracted=set()
upd_flip_low=0;vn_lag=[];vn_pairs=[]
sat=collections.Counter();dates=collections.Counter();
upd_changes=collections.Counter()
frames=0
for l in open(sys.argv[1]):
    o=json.loads(l)
    if 'frame' not in o: continue
    m,d=parse(o['frame']);ev=m['event']
    if ev=='heartbeat': vnow=dt.datetime.fromisoformat(d['virtual_now'].replace('Z','+00:00')); continue
    if ev=='detection':
        x=d['detection'];k=key(x);t=ts(x);sat[x['satellite']]+=1;dates[x['acq_date']]+=1
        if maxt and t<maxt: late.append((maxt-t).total_seconds()/60)
        else: maxt=t
        if vnow: vn_lag.append((vnow-t).total_seconds()/60)
        if k in seen:
            if seen[k]==x: dupsame+=1
            else: dupdiff+=1
        if k in retracted: det_after_retract+=1
        seen[k]=x
    elif ev=='update':
        k=d['key']
        if k not in seen: upd_unknown+=1
        if k in retracted: upd_after_retract+=1
        for c in d['changes']: upd_changes[c]+=1
        if 'confidence' in d['changes'] and k in seen:
            if d['changes']['confidence']=='l' and seen[k]['confidence']!='l': upd_flip_low+=1
        if k in seen: seen[k]={**seen[k],**d['changes']}
    elif ev=='retract':
        k=d['key']
        if k not in seen: ret_unknown+=1
        if k in retracted: ret_twice+=1
        retracted.add(k)
late.sort()
def p(a,q): return round(a[min(len(a)-1,int(q*len(a)))],1) if a else None
print(json.dumps({'late_n':len(late),'late_min_p50':p(late,.5),'p90':p(late,.9),'p95':p(late,.95),'p99':p(late,.99),'max':round(late[-1],1),'frac_gt_360':round(sum(1 for x in late if x>360)/len(late),4),'frac_gt_180':round(sum(1 for x in late if x>180)/len(late),4),'frac_gt_720':round(sum(1 for x in late if x>720)/len(late),4),
 'dup_same':dupsame,'dup_diff':dupdiff,'upd_unknown_key':upd_unknown,'upd_after_retract':upd_after_retract,'ret_unknown':ret_unknown,'ret_twice':ret_twice,'det_after_retract':det_after_retract,'upd_to_low_from_nonlow':upd_flip_low,'upd_changes':upd_changes,'sat':sat,'dates':dict(sorted(dates.items())),
 'acq_vs_heartbeat_vnow_lag_min_p50':p(sorted(vn_lag),.5),'p99':p(sorted(vn_lag),.99),'min':round(min(vn_lag),1)},default=str))
