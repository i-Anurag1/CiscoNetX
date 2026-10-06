from __future__ import annotations
import ipaddress, math, random, statistics, time, uuid
from collections import defaultdict, Counter
from dataclasses import dataclass, asdict
from fastapi import APIRouter, HTTPException

router = APIRouter(prefix='/api/v1/enterprise', tags=['enterprise'])


def _graph(t):
    g=defaultdict(list)
    for e in t.get('links',[]):
        if not e.get('up',True): continue
        c=float(e.get('latency_ms',1))+100.0/max(float(e.get('bandwidth_mbps',100)),1)
        g[e['source']].append((e['target'],c,e)); g[e['target']].append((e['source'],c,e))
    return g


def _shortest(t,src,dst,blocked=None):
    blocked=set(blocked or []); g=_graph(t); dist={src:0}; prev={}; q=[(0,src)]; seen=set()
    import heapq
    while q:
        d,u=heapq.heappop(q)
        if u in seen: continue
        seen.add(u)
        if u==dst: break
        for v,c,e in g[u]:
            if v in blocked or u in blocked: continue
            nd=d+c
            if nd<dist.get(v,float('inf')):
                dist[v]=nd; prev[v]=u; heapq.heappush(q,(nd,v))
    if dst not in dist: return []
    path=[]; u=dst
    while u!=src: path.append(u); u=prev[u]
    path.append(src); return list(reversed(path))


def _edges(t,path):
    out=[]
    for a,b in zip(path,path[1:]):
        for e in t.get('links',[]):
            if {e['source'],e['target']}=={a,b}:
                out.append(e); break
    return out


@router.post('/switching/forward')
def switching_forward(payload:dict):
    table=payload.get('mac_table',{}); frame=payload.get('frame',{}); src=frame.get('source_mac'); dst=frame.get('destination_mac'); ingress=frame.get('ingress_port')
    learned=dict(table); learned[src]=ingress if src else ingress
    if dst in learned: action='UNICAST'; ports=[learned[dst]]
    else: action='FLOOD'; ports=[p for p in payload.get('ports',[]) if p!=ingress]
    return {'action':action,'outgoing_ports':ports,'mac_table':learned,'vlan':frame.get('vlan',1)}


@router.post('/arp/resolve')
def arp_resolve(payload:dict):
    cache=payload.get('cache',{}); ip=payload.get('ip'); mac=payload.get('mac'); now=int(time.time())
    if mac: cache[ip]={'mac':mac,'expires_at':now+payload.get('ttl',300),'state':'REACHABLE'}
    entry=cache.get(ip)
    return {'ip':ip,'entry':entry,'request_required':entry is None or entry.get('expires_at',0)<now,'cache':cache}


@router.post('/nat/table')
def nat_table(payload:dict):
    entries=[]
    public_ip=payload.get('public_ip','203.0.113.10')
    for i,m in enumerate(payload.get('flows',[])):
        local=f"{m['source_ip']}:{m['source_port']}"; global_ep=f"{public_ip}:{payload.get('start_port',40000)+i}"
        entries.append({'protocol':m.get('protocol','TCP'),'inside_local':local,'inside_global':global_ep,'destination':f"{m.get('destination_ip','*')}:{m.get('destination_port','*')}",'state':'ACTIVE'})
    return {'public_ip':public_ip,'entries':entries}


@router.post('/vlan/forward')
def vlan_forward(payload:dict):
    src=int(payload.get('source_vlan',1)); dst=int(payload.get('destination_vlan',1)); mode=payload.get('mode','access')
    same=src==dst; trunk=mode.lower()=='trunk'; allowed=same or trunk
    return {'allowed':allowed,'reason':'same VLAN' if same else ('802.1Q trunk permits tagged VLAN' if trunk else 'VLAN isolation'),'source_vlan':src,'destination_vlan':dst,'mode':mode}


@router.post('/ipv4/header')
def ipv4_header(payload:dict):
    src=ipaddress.ip_address(payload['source']); dst=ipaddress.ip_address(payload['destination'])
    if src.version!=4 or dst.version!=4: raise HTTPException(422,'IPv4 addresses required')
    return {'version':4,'ihl':5,'dscp':payload.get('dscp',0),'total_length':payload.get('payload_bytes',0)+20,'identification':payload.get('identification',1),'flags':payload.get('flags',0),'fragment_offset':payload.get('fragment_offset',0),'ttl':payload.get('ttl',64),'protocol':payload.get('protocol','TCP'),'source':str(src),'destination':str(dst)}


@router.post('/ipv6/header')
def ipv6_header(payload:dict):
    src=ipaddress.ip_address(payload['source']); dst=ipaddress.ip_address(payload['destination'])
    if src.version!=6 or dst.version!=6: raise HTTPException(422,'IPv6 addresses required')
    return {'version':6,'traffic_class':payload.get('traffic_class',0),'flow_label':payload.get('flow_label',0),'payload_length':payload.get('payload_bytes',0),'next_header':payload.get('next_header','TCP'),'hop_limit':payload.get('hop_limit',64),'source':src.compressed,'destination':dst.compressed}


@router.post('/tcp/session')
def tcp_session(payload:dict):
    seed=int(payload.get('seed',42)); rng=random.Random(seed); loss=float(payload.get('loss',0.1)); rounds=int(payload.get('rounds',20)); cwnd=1.0; ssthresh=8.0; state='CLOSED'; events=[]; retrans=0; rtt=[]
    for e in ('SYN','SYN-ACK','ACK'): events.append({'event':e,'state':'ESTABLISHED' if e=='ACK' else 'SYN-SENT'})
    state='ESTABLISHED'
    for n in range(1,rounds+1):
        sample=round(rng.uniform(10,80)*(1+loss*2),2); rtt.append(sample); timeout=rng.random()<loss*.35; dup=3 if (not timeout and rng.random()<loss*.5) else 0
        phase='SLOW_START' if cwnd<ssthresh else 'CONGESTION_AVOIDANCE'
        events.append({'round':n,'state':state,'cwnd':round(cwnd,3),'ssthresh':round(ssthresh,3),'phase':phase,'rtt_ms':sample,'timeout':timeout,'duplicate_acks':dup})
        if timeout: retrans+=1; ssthresh=max(2,cwnd/2); cwnd=1
        elif dup==3: retrans+=1; ssthresh=max(2,cwnd/2); cwnd=ssthresh
        elif cwnd<ssthresh: cwnd=min(cwnd*2,10000)
        else: cwnd+=1/max(cwnd,1)
    events += [{'event':'FIN','state':'FIN-WAIT-1'},{'event':'ACK','state':'CLOSED'}]
    return {'protocol':'TCP','state':'CLOSED','events':events,'retransmissions':retrans,'avg_rtt_ms':round(statistics.mean(rtt),2),'final_cwnd':round(cwnd,3)}


@router.post('/routing/convergence')
def convergence(payload:dict):
    t=payload['topology']; src=payload.get('source','pc1'); dst=payload.get('destination','server1'); failed=payload.get('failed_nodes',[]); before=_shortest(t,src,dst); after=_shortest(t,src,dst,failed); lost=max(0,int(payload.get('packets',100)*float(payload.get('loss_rate',.02)))) if not after else int(payload.get('packets',100)*float(payload.get('failure_loss',.03)))
    recovery=round(10+len(after)*3+len(failed)*15,2) if after else None
    return {'before_path':before,'after_path':after,'failed_nodes':failed,'packets_affected':lost,'recovery_time_ms':recovery,'converged':bool(after)}


@router.post('/traffic/engineer')
def engineer(payload:dict):
    t=payload['topology']; src=payload.get('source','pc1'); dst=payload.get('destination','server1'); packets=int(payload.get('packets',1000)); rate=float(payload.get('rate_mbps',10)); threshold=float(payload.get('utilization_threshold',.8)); path=_shortest(t,src,dst); edges=_edges(t,path); bottleneck=min([float(e.get('bandwidth_mbps',100)) for e in edges] or [100]); utilization=min(1,rate/bottleneck); rerouted=False; alt=[]
    if utilization>threshold and len(path)>2:
        alt=_shortest(t,src,dst,{path[len(path)//2]})
        rerouted=bool(alt)
    latency=sum(float(e.get('latency_ms',1)) for e in edges); loss=sum(float(e.get('loss_rate',0)) for e in edges)
    delivered=int(packets*(1-min(.99,loss))); throughput=min(rate,bottleneck)*(1-loss)
    return {'path':alt if rerouted else path,'original_path':path,'rerouted':rerouted,'bottleneck_mbps':bottleneck,'utilization':round(utilization,4),'latency_ms':round(latency,2),'packet_loss_rate':round(loss,4),'packets_generated':packets,'packets_delivered':delivered,'throughput_mbps':round(throughput,3),'jitter_ms':round(statistics.mean([float(e.get('jitter_ms',0)) for e in edges]) if edges else 0,3)}


@router.post('/experiments/run')
def experiment(payload:dict):
    t=payload['topology']; src=payload.get('source','pc1'); dst=payload.get('destination','server1'); seed=int(payload.get('seed',42)); rng=random.Random(seed); results=[]
    for algo in ('Dijkstra','RIP','OSPF'):
        path=_shortest(t,src,dst); hops=max(0,len(path)-1); base=sum(float(e.get('latency_ms',1)) for e in _edges(t,path)); metric=base if algo!='RIP' else hops
        results.append({'algorithm':algo,'path':path,'hops':hops,'metric':round(metric,3),'convergence_ms':round(5+hops*2+rng.random()*3,3),'score':round(1/(1+metric),5)})
    return {'experiment_id':str(uuid.uuid4()),'source':src,'destination':dst,'seed':seed,'results':results}


@router.post('/security/analyze')
def security_analyze(payload:dict):
    flows=payload.get('flows',[]); bysrc=Counter(x.get('source_ip') for x in flows); bypair=defaultdict(set); macs=defaultdict(set); alerts=[]
    for f in flows:
        bypair[(f.get('source_ip'),f.get('destination_ip'))].add(f.get('destination_port')); 
        if f.get('source_ip') and f.get('source_mac'): macs[f['source_ip']].add(f['source_mac'])
    for src,n in bysrc.items():
        if src and n>=20: alerts.append({'kind':'DDOS','severity':'HIGH','source':src,'evidence':f'{n} flows observed','action':'RATE_LIMIT'})
    for (src,dst),ports in bypair.items():
        if src and len(ports)>=10: alerts.append({'kind':'PORT_SCAN','severity':'HIGH','source':src,'destination':dst,'evidence':f'{len(ports)} ports probed','action':'BLOCK'})
    for src,ms in macs.items():
        if len(ms)>1: alerts.append({'kind':'ARP_SPOOF','severity':'HIGH','source':src,'evidence':f'{len(ms)} MAC identities','action':'BLOCK'})
    return {'alerts':alerts,'risk_score':min(100,len(alerts)*25)}


@router.post('/assistant/explain')
def explain(payload:dict):
    q=str(payload.get('question','')).lower(); state=payload.get('state',{}); evidence=[]
    if state.get('topology'): evidence.append(f"{len(state['topology'].get('nodes',[]))} devices and {len(state['topology'].get('links',[]))} links")
    if state.get('route'): evidence.append('route='+'>'.join(state['route']))
    if state.get('metrics'): evidence.append(f"metrics={state['metrics']}")
    if 'route' in q: answer='The selected route is derived from the current topology and link costs. Inspect the route evidence and link metrics before changing policy.'
    elif 'packet' in q: answer='Packet behavior is explained from the trace event sequence, including forwarding, drops, retransmissions and delivery.'
    elif 'security' in q or 'attack' in q: answer='The security result is grounded in observed simulated flows, source/destination fan-out, rate and MAC identity changes.'
    elif 'congestion' in q: answer='Congestion is evaluated from offered rate, bottleneck bandwidth, utilization, latency, loss and TCP congestion-window behavior.'
    else: answer='Use the topology, route, metrics and event evidence supplied with the question to inspect the current network state.'
    return {'answer':answer,'evidence':evidence,'grounded':bool(evidence),'model':'CiscoNetX-Grounded-Router'}


@router.post('/replay/validate')
def replay_validate(payload:dict):
    a=payload.get('run_a',{}); b=payload.get('run_b',{}); same=a.get('seed')==b.get('seed') and a.get('topology_hash')==b.get('topology_hash')
    return {'deterministic':same,'reason':'same seed and topology identity' if same else 'seed or topology differs'}

@router.post('/policies/evaluate')
def policy_evaluate(payload:dict):
    metrics=payload.get('metrics',{}); policies=payload.get('policies',[]); actions=[]
    for p in policies:
        metric=p.get('metric'); op=p.get('operator','>'); threshold=float(p.get('threshold',0)); value=float(metrics.get(metric,0)); hit={'>' : value>threshold,'>=':value>=threshold,'<':value<threshold,'<=':value<=threshold,'==':value==threshold}.get(op,False)
        actions.append({'policy':p.get('name','unnamed'),'metric':metric,'value':value,'threshold':threshold,'triggered':hit,'action':p.get('action','ALERT')})
    return {'actions':actions,'triggered':sum(a['triggered'] for a in actions)}

@router.post('/ml/features')
def ml_features(payload:dict):
    m=payload.get('metrics',{}); return {'features':{'packet_rate':float(m.get('packet_rate',0)),'packet_loss':float(m.get('packet_loss',0)),'latency_ms':float(m.get('latency_ms',0)),'utilization':float(m.get('utilization',0))},'schema_version':'1.0'}

@router.post('/qos/classify')
def qos_classify(payload:dict):
    dscp=int(payload.get('dscp',0)); protocol=str(payload.get('protocol','TCP')).upper(); classes={46:'EF',34:'AF41',26:'AF31',0:'BE'}; return {'class':classes.get(dscp,'CS1' if dscp<8 else 'AF'),'dscp':dscp,'protocol':protocol,'priority':'HIGH' if dscp>=34 else ('MEDIUM' if dscp>=16 else 'NORMAL')}
