from __future__ import annotations
import ipaddress, json, math, random, statistics, time, uuid
from collections import defaultdict, Counter
from dataclasses import dataclass, asdict
from fastapi import APIRouter, HTTPException
from app.core.config import settings

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
    t=payload['topology']; baseline=payload.get('baseline_topology',t); src=payload.get('source','pc1'); dst=payload.get('destination','server1'); failed=payload.get('failed_nodes',[]); before=_shortest(baseline,src,dst); after=_shortest(t,src,dst,failed); lost=max(0,int(payload.get('packets',100)*float(payload.get('loss_rate',.02)))) if not after else int(payload.get('packets',100)*float(payload.get('failure_loss',.03)))
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



def _optional_llm_tutor(question: str, fallback: dict) -> dict:
    """Use an OpenAI-compatible endpoint when configured, otherwise stay offline."""
    if not (settings.ai_base_url and settings.ai_model):
        return fallback
    try:
        import httpx
        headers = {'Content-Type': 'application/json'}
        if settings.ai_api_key:
            headers['Authorization'] = f'Bearer {settings.ai_api_key}'
        prompt = (
            'You are a Computer Networks lab teacher. Return JSON only with keys '
            'lab_name, objective, steps, commands, expected_results, hints, viva_questions. '
            'Keep steps practical for a student using CiscoNetX. Do not invent packet captures or real devices. '
            f'Question: {question}'
        )
        with httpx.Client(timeout=settings.ai_timeout_seconds) as client:
            response = client.post(
                settings.ai_base_url.rstrip('/') + '/chat/completions',
                headers=headers,
                json={'model': settings.ai_model, 'temperature': 0.2, 'messages':[{'role':'user','content':prompt}]}
            )
            response.raise_for_status()
            body = response.json()
            content = body['choices'][0]['message']['content']
            if content.startswith('```'):
                content = content.split('\n',1)[1].rsplit('```',1)[0]
            data = json.loads(content)
            for key in ('lab_name','objective','steps','commands','expected_results','hints','viva_questions'):
                if key not in data:
                    return fallback
            return {**fallback, **data, 'mode':'llm', 'grounded':True}
    except Exception:
        return fallback

@router.post('/assistant/tutor')
def assistant_tutor(payload: dict):
    """Student-facing CN lab coach.

    Works offline with a curriculum engine and accepts an optional external
    LLM adapter later. It returns structured lab guidance instead of a raw
    paragraph so the UI can turn the answer into an executable lab.
    """
    question = str(payload.get('question', '')).strip()
    if not question:
        raise HTTPException(422, 'Enter the lab question first')
    if len(question) > 8000:
        raise HTTPException(422, 'Question is limited to 8000 characters')

    q = question.lower()
    topics: list[str] = []
    if any(x in q for x in ('rip', 'distance vector')):
        topics.append('RIP / Distance Vector')
    if any(x in q for x in ('ospf', 'link state')):
        topics.append('OSPF / Link State')
    if any(x in q for x in ('dijkstra', 'shortest path', 'shortest-path', 'routing')):
        topics.append('Routing / Dijkstra')
    if any(x in q for x in ('subnet', 'cidr', 'ipv4', 'ip address')):
        topics.append('IPv4 / Subnetting')
    if any(x in q for x in ('tcp', 'three-way', 'handshake', 'congestion', 'slow start')):
        topics.append('TCP / Transport')
    if any(x in q for x in ('udp',)):
        topics.append('UDP / Transport')
    if any(x in q for x in ('arp',)):
        topics.append('ARP')
    if any(x in q for x in ('nat', 'pat')):
        topics.append('NAT / PAT')
    if any(x in q for x in ('vlan', 'trunk', '802.1q')):
        topics.append('VLAN / Switching')
    if any(x in q for x in ('crc', 'checksum', 'hamming')):
        topics.append('Error Detection / Correction')
    if any(x in q for x in ('go-back-n', 'selective repeat', 'stop-and-wait', 'sliding window', 'arq')):
        topics.append('ARQ / Data Link')
    if any(x in q for x in ('csma', 'aloha', 'collision')):
        topics.append('MAC / Random Access')
    if any(x in q for x in ('dns', 'http', 'https', 'application layer')):
        topics.append('Application Protocols')
    if any(x in q for x in ('firewall', 'ddos', 'port scan', 'security', 'attack')):
        topics.append('Network Security')
    if not topics:
        topics.append('Computer Networks Fundamentals')

    if any(x in q for x in ('rip', 'distance vector')):
        lab_name = 'RIP routing convergence lab'
        objective = 'Build a small routed network, configure RIP-style distance-vector routing, then observe route learning and convergence.'
        steps = [
            'Build PC-01 → RTR-01 → RTR-02 → PC-02.',
            'Assign one IPv4 subnet to each router-facing link and one LAN per router.',
            'Enable RIP on both routers and advertise the connected networks.',
            'Run the routing analysis and inspect the learned next hop and path cost.',
            'Break the inter-router link, restore it, and compare convergence behavior.'
        ]
        commands = ['enable', 'configure terminal', 'router rip', 'version 2', 'network 10.0.0.0', 'network 10.0.1.0', 'no auto-summary', 'end', 'show ip route']
        expected = ['Both routers learn the remote LAN.', 'The routing table shows a learned route.', 'Traffic reaches the destination before and after recovery.']
        topology = _student_topology('rip')
    elif any(x in q for x in ('ospf', 'link state')):
        lab_name = 'OSPF link-state lab'
        objective = 'Build a routed topology and inspect shortest-path selection and link-state convergence.'
        steps = ['Build three routers in a triangle.', 'Assign IPv4 addresses to every routed link.', 'Enable OSPF area 0 on all routers.', 'Run the routing analysis and compare primary and alternate paths.', 'Disable one link and observe the new shortest path.']
        commands = ['enable', 'configure terminal', 'router ospf 1', 'network 10.0.0.0 0.0.0.255 area 0', 'end', 'show ip ospf neighbor', 'show ip route ospf']
        expected = ['OSPF neighbors reach FULL state.', 'Routes are learned through OSPF.', 'Traffic moves over the alternate path after a failure.']
        topology = _student_topology('ospf')
    elif any(x in q for x in ('subnet', 'cidr')):
        lab_name = 'IPv4 subnetting lab'
        objective = 'Calculate subnet boundaries, host ranges and broadcast addresses, then verify them in CiscoNetX.'
        steps = ['Identify the required number of subnets or hosts.', 'Choose the new prefix length.', 'Calculate network, first host, last host and broadcast for each subnet.', 'Enter the addresses into the topology.', 'Use the IP workspace to verify the calculation.']
        commands = []
        expected = ['Every subnet has a unique network address.', 'Usable host ranges do not overlap.', 'Broadcast addresses match the selected prefix.']
        topology = _student_topology('ip')
    elif any(x in q for x in ('tcp', 'three-way', 'handshake', 'congestion', 'slow start')):
        lab_name = 'TCP transport lab'
        objective = 'Observe TCP connection establishment, acknowledgements, retransmission and congestion-window behavior.'
        steps = ['Create a client and server path.', 'Run the Transport workspace.', 'Identify SYN, SYN-ACK and ACK.', 'Introduce packet loss.', 'Compare retransmissions and congestion-window changes.']
        commands = []
        expected = ['The three-way handshake reaches ESTABLISHED.', 'Loss causes retransmission behavior.', 'Congestion control reduces the sending window after loss.']
        topology = _student_topology('tcp')
    elif any(x in q for x in ('go-back-n', 'selective repeat', 'stop-and-wait', 'sliding window', 'arq')):
        lab_name = 'ARQ and sliding-window lab'
        objective = 'Compare reliable data-link protocols under deterministic frame loss.'
        steps = ['Open Data Link.', 'Select the ARQ protocol from the question.', 'Use a fixed frame count and window size.', 'Introduce a lost frame.', 'Compare retransmitted frames and delivery efficiency.']
        commands = []
        expected = ['Go-Back-N retransmits from the lost frame onward.', 'Selective Repeat retransmits only missing frames.', 'Stop-and-Wait sends one frame before waiting for acknowledgement.']
        topology = _student_topology('arq')
    elif any(x in q for x in ('vlan', 'trunk', '802.1q')):
        lab_name = 'VLAN segmentation lab'
        objective = 'Create isolated broadcast domains and verify access/trunk behavior.'
        steps = ['Add two switches and hosts.', 'Assign hosts to different VLANs.', 'Connect switches with a trunk.', 'Verify same-VLAN forwarding.', 'Test cross-VLAN traffic and explain why a router or Layer-3 switch is required.']
        commands = ['enable', 'configure terminal', 'vlan 10', 'name STUDENTS', 'vlan 20', 'name FACULTY', 'interface gigabitEthernet 0/1', 'switchport mode trunk', 'end', 'show vlan brief']
        expected = ['Hosts in the same VLAN communicate at Layer 2.', 'Different VLANs remain isolated without Layer-3 routing.', 'The trunk carries tagged VLAN traffic.']
        topology = _student_topology('vlan')
    else:
        lab_name = 'Computer Networks guided lab'
        objective = 'Turn the teacher question into a repeatable topology, simulation and verification workflow.'
        steps = ['Identify the protocol or layer involved.', 'Build the smallest topology needed to reproduce the question.', 'Configure addressing and protocol behavior.', 'Run the matching CiscoNetX workspace.', 'Inspect the evidence and write the observation and conclusion.']
        commands = []
        expected = ['The topology matches the question.', 'The simulation produces observable protocol behavior.', 'The final answer is supported by simulation evidence.']
        topology = _student_topology('generic')

    hints = [
        'Start with the smallest topology needed for the question.',
        'Use deterministic seed 42 so your result is repeatable.',
        'Change one variable at a time when testing a failure or protocol behavior.',
        'In your lab record, write the setup, input, observation and conclusion.'
    ]
    viva = [
        f'Which OSI/TCP-IP layer does {topics[0]} belong to?',
        'What changes when one link or device fails?',
        'Which evidence in the simulator proves your answer?'
    ]
    fallback = {
        'assistant': 'CiscoNetX AI Lab Coach',
        'lab_name': lab_name,
        'topics': topics,
        'objective': objective,
        'steps': steps,
        'commands': commands,
        'expected_results': expected,
        'hints': hints,
        'viva_questions': viva,
        'topology': topology,
        'mode': 'offline-curriculum',
        'grounded': True,
    }
    return _optional_llm_tutor(question, fallback)


def _student_topology(kind: str) -> dict:
    if kind in ('rip', 'tcp', 'ip'):
        return {
            'nodes': [
                {'id':'pc1','name':'PC-01','type':'host','ip':'10.0.0.10','x':10,'y':50},
                {'id':'r1','name':'RTR-01','type':'router','ip':'10.0.0.1','x':35,'y':50},
                {'id':'r2','name':'RTR-02','type':'router','ip':'10.0.1.1','x':65,'y':50},
                {'id':'pc2','name':'PC-02','type':'host','ip':'10.0.1.10','x':90,'y':50},
            ],
            'links': [
                {'id':'l1','source':'pc1','target':'r1','bandwidth_mbps':100,'latency_ms':1,'up':True},
                {'id':'l2','source':'r1','target':'r2','bandwidth_mbps':100,'latency_ms':5,'up':True},
                {'id':'l3','source':'r2','target':'pc2','bandwidth_mbps':100,'latency_ms':1,'up':True},
            ]
        }
    if kind == 'ospf':
        return {
            'nodes': [
                {'id':'r1','name':'RTR-01','type':'router','ip':'10.0.0.1','x':25,'y':35},
                {'id':'r2','name':'RTR-02','type':'router','ip':'10.0.1.1','x':75,'y':35},
                {'id':'r3','name':'RTR-03','type':'router','ip':'10.0.2.1','x':50,'y':70},
            ],
            'links': [
                {'id':'l1','source':'r1','target':'r2','bandwidth_mbps':100,'latency_ms':5,'up':True},
                {'id':'l2','source':'r2','target':'r3','bandwidth_mbps':100,'latency_ms':5,'up':True},
                {'id':'l3','source':'r1','target':'r3','bandwidth_mbps':100,'latency_ms':10,'up':True},
            ]
        }
    return {
        'nodes': [
            {'id':'pc1','name':'PC-01','type':'host','ip':'10.0.0.10','x':15,'y':50},
            {'id':'sw1','name':'SW-01','type':'switch','vlan':10,'x':40,'y':50},
            {'id':'r1','name':'RTR-01','type':'router','ip':'10.0.0.1','x':65,'y':50},
            {'id':'server1','name':'SERVER-01','type':'server','ip':'10.0.1.10','x':90,'y':50},
        ],
        'links': [
            {'id':'l1','source':'pc1','target':'sw1','bandwidth_mbps':100,'latency_ms':1,'up':True},
            {'id':'l2','source':'sw1','target':'r1','bandwidth_mbps':1000,'latency_ms':2,'up':True},
            {'id':'l3','source':'r1','target':'server1','bandwidth_mbps':100,'latency_ms':3,'up':True},
        ]
    }

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
