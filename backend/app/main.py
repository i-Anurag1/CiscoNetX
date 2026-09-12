import json, time, uuid
from fastapi import FastAPI, Depends, HTTPException, WebSocket, WebSocketDisconnect, Header
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from sqlalchemy import select
from app.core.config import settings
from app.db.session import Base, engine, get_db
from app.models import Project, SimulationRun, SecurityIncident, AuditEvent, User
from app.schemas.network import ProjectCreate, SimulationRequest, Topology, FirewallRule
from app.simulation.engine import SimulationEngine, DEFAULT_TOPOLOGY
from app.simulation.algorithms import dijkstra, routing_table, distance_vector, crc32_bits, checksum16, hamming_encode
from app.simulation.protocols import hamming_decode, sliding_window, aloha, tcp_model
from app.simulation.advanced import ospf, rip, tcp_state_machine, arq, medium_access, nat_translate, packet_trace, topology_stats
from app.ml.service import synthetic_dataset, train
from app.security.detector import firewall_decide
from app.security.engine import evaluate_acl, detect_anomalies, detect_port_scan, detect_ddos
from app.security.auth import hash_password, verify_password, issue_token, verify_token
from app.ml.service import score, evaluate
from app.simulation.flow import SDNController, traffic_simulation
from app.networking import subnet, validate_topology
from app.enterprise import router as enterprise_router

Base.metadata.create_all(bind=engine)
app=FastAPI(title='CiscoNetX API',version='6.0.0',description='Enterprise network simulation and NOC platform')
app.add_middleware(CORSMiddleware,allow_origins=[x.strip() for x in settings.cors_origins.split(',')],allow_credentials=True,allow_methods=['*'],allow_headers=['*'])
clients=set()
app.include_router(enterprise_router)

def audit(db,pid,action,details): db.add(AuditEvent(project_id=pid,action=action,details=details)); db.commit()

@app.post('/api/v1/auth/register')
def register(email:str,password:str,db:Session=Depends(get_db)):
    email=email.strip().lower()
    if len(password)<10: raise HTTPException(422,'Password must contain at least 10 characters')
    if db.scalar(select(User).where(User.email==email)): raise HTTPException(409,'User already exists')
    u=User(email=email,password_hash=hash_password(password)); db.add(u); db.commit(); db.refresh(u)
    return {'id':u.id,'email':u.email,'role':u.role,'token':issue_token(u.id,u.role,settings.secret_key)}

@app.post('/api/v1/auth/login')
def login(email:str,password:str,db:Session=Depends(get_db)):
    u=db.scalar(select(User).where(User.email==email.strip().lower()))
    if not u or not verify_password(password,u.password_hash): raise HTTPException(401,'Invalid credentials')
    return {'id':u.id,'email':u.email,'role':u.role,'token':issue_token(u.id,u.role,settings.secret_key)}

@app.get('/api/v1/auth/verify')
def verify(authorization:str|None=Header(default=None)):
    if not authorization or not authorization.lower().startswith('bearer '): raise HTTPException(401,'Bearer token required')
    data=verify_token(authorization[7:].strip(),settings.secret_key)
    if not data: raise HTTPException(401,'Invalid or expired token')
    return {'valid':True,'user_id':data['sub'],'role':data['role']}

@app.get('/health')
def health(): return {'status':'ok','database':'ok','simulator':'ok','ml':'ready','version':'6.0.0'}
@app.get('/api/v1/topology/default')
def default_topology(): return DEFAULT_TOPOLOGY
@app.post('/api/v1/topology/validate')
def topology_validate(topology:Topology): return validate_topology(topology.model_dump())
@app.post('/api/v1/projects')
def create_project(payload:ProjectCreate,db:Session=Depends(get_db)):
    p=Project(name=payload.name,description=payload.description,topology=payload.topology.model_dump()); db.add(p); db.commit(); db.refresh(p); return {'id':p.id,'name':p.name,'description':p.description,'topology':p.topology}
@app.get('/api/v1/projects')
def projects(db:Session=Depends(get_db)): return [{'id':p.id,'name':p.name,'description':p.description,'created_at':p.created_at} for p in db.scalars(select(Project)).all()]
@app.get('/api/v1/projects/{pid}')
def project(pid:int,db:Session=Depends(get_db)):
    p=db.get(Project,pid)
    if not p: raise HTTPException(404,'Project not found')
    return {'id':p.id,'name':p.name,'description':p.description,'topology':p.topology}
@app.put('/api/v1/projects/{pid}/topology')
def update_topology(pid:int,topology:Topology,db:Session=Depends(get_db)):
    p=db.get(Project,pid)
    if not p: raise HTTPException(404,'Project not found')
    check=validate_topology(topology.model_dump())
    if not check['valid']: raise HTTPException(422,check)
    p.topology=topology.model_dump(); db.add(p); audit(db,pid,'TOPOLOGY_UPDATED',check); return p.topology
@app.post('/api/v1/projects/{pid}/simulate')
def simulate(pid:int,payload:SimulationRequest,db:Session=Depends(get_db)):
    p=db.get(Project,pid)
    if not p: raise HTTPException(404,'Project not found')
    result=SimulationEngine(payload.seed).run(json.loads(json.dumps(p.topology)),payload.scenario,payload.source,payload.destination,payload.packets)
    run=SimulationRun(project_id=pid,scenario=payload.scenario,seed=payload.seed,metrics=result['metrics'],events=result['events']); db.add(run); db.commit(); db.refresh(run); audit(db,pid,'SIMULATION_COMPLETED',{'run_id':run.id,'scenario':payload.scenario}); return {'run_id':run.id,**result}
@app.get('/api/v1/projects/{pid}/runs')
def runs(pid:int,db:Session=Depends(get_db)): return [{'id':r.id,'scenario':r.scenario,'seed':r.seed,'metrics':r.metrics,'created_at':r.created_at} for r in db.scalars(select(SimulationRun).where(SimulationRun.project_id==pid).order_by(SimulationRun.id.desc())).all()]
@app.get('/api/v1/projects/{pid}/runs/{rid}')
def run_detail(pid:int,rid:int,db:Session=Depends(get_db)):
    r=db.get(SimulationRun,rid)
    if not r or r.project_id!=pid: raise HTTPException(404,'Run not found')
    return {'id':r.id,'scenario':r.scenario,'seed':r.seed,'metrics':r.metrics,'events':r.events}
@app.get('/api/v1/routing/dijkstra')
def route(topology_json:str,source:str,target:str): return {'path':dijkstra(json.loads(topology_json),source,target)}
@app.post('/api/v1/routing/dijkstra')
def route_post(topology:Topology,source:str,target:str): return {'path':dijkstra(topology.model_dump(),source,target)}
@app.post('/api/v1/routing/distance-vector')
def dv(topology:Topology): return distance_vector(topology.model_dump())
@app.post('/api/v1/routing/table')
def rtable(topology:Topology,source:str): return routing_table(topology.model_dump(),source)
@app.post('/api/v1/lab/crc')
def crc(data:str): return {'data':data,'crc':crc32_bits(data)}
@app.post('/api/v1/lab/checksum')
def checksum(data:str): return {'data':data,'checksum':checksum16(data)}
@app.post('/api/v1/lab/hamming/encode')
def hamming(data:str): return {'data':data,'encoded':hamming_encode(data)}
@app.post('/api/v1/lab/hamming/decode')
def hamming_dec(data:str): return hamming_decode(data)
@app.post('/api/v1/lab/arq')
def arq(protocol:str='go_back_n',frames:int=8,loss_index:int=3,window:int=4):
    if protocol not in ('go_back_n','selective_repeat','stop_and_wait'): raise HTTPException(400,'Unsupported ARQ protocol')
    return {'protocol':protocol,'window':window,'events':sliding_window(frames,window,[loss_index],protocol=='selective_repeat')}
@app.post('/api/v1/lab/aloha')
def aloha_api(nodes:int=10,slots:int=100,load:float=.3,slotted:bool=True): return aloha(nodes,slots,load,slotted)
@app.post('/api/v1/lab/tcp')
def tcp(loss:float=.1,rounds:int=20): return tcp_model(loss,rounds)
@app.post('/api/v1/lab/subnet')
def subnet_api(network:str,prefix:int): return subnet(network,prefix)
@app.post('/api/v1/lab/packet')
def packet(packet:dict):
    p=dict(packet); p.setdefault('id',str(uuid.uuid4())); p.setdefault('timestamp',time.time()); p.setdefault('status','created'); return p
@app.post('/api/v1/protocol/dns')
def dns(host:str='server.cisconetx.local',ip:str='10.0.2.10'): return {'protocol':'DNS','query':host,'response':ip,'ttl':300,'cached':False}
@app.post('/api/v1/protocol/http')
def http_flow(host:str='server.cisconetx.local',path:str='/'): return {'protocol':'HTTP','steps':['DNS QUERY','DNS RESPONSE','SYN','SYN-ACK','ACK',f'GET {path}','HTTP/1.1 200 OK'],'host':host}
@app.post('/api/v1/protocol/tcp-handshake')
def tcp_handshake(): return {'protocol':'TCP','steps':['SYN','SYN-ACK','ACK'],'state':'ESTABLISHED'}
@app.post('/api/v1/security/firewall/evaluate')
def firewall(packet:dict,rules:list[FirewallRule]): return {'action':evaluate_acl(packet,[r.model_dump() for r in rules])}
@app.post('/api/v1/security/detect')
def detect(flows:list[dict]): return {'alerts':detect_anomalies(flows)}
@app.post('/api/v1/ml/score')
def ml_score(features:dict): return score(features)
@app.post('/api/v1/ml/evaluate')
def ml_eval(samples:list[dict]): return evaluate(samples)
@app.get('/api/v1/scenarios')
def scenarios():
    names=['enterprise_failover','router_failure','crc','hamming','checksum','tcp_congestion','ddos','vlan_segmentation','arp_resolution','nat_translation','ospf_convergence','dns_http','port_scan','congestion','full_stack_demo']
    return [{'id':x,'name':x.replace('_',' ').title()} for x in names]
@app.post('/api/v1/projects/{pid}/export')
def export_project(pid:int,db:Session=Depends(get_db)):
    p=db.get(Project,pid)
    if not p: raise HTTPException(404,'Project not found')
    return {'project':{'id':p.id,'name':p.name,'description':p.description},'topology':p.topology,'runs':[{'id':r.id,'scenario':r.scenario,'metrics':r.metrics,'events':r.events} for r in db.scalars(select(SimulationRun).where(SimulationRun.project_id==pid)).all()]}
@app.websocket('/ws/events')
async def ws(websocket:WebSocket):
    await websocket.accept(); clients.add(websocket)
    try:
        while True: await websocket.receive_text()
    except WebSocketDisconnect: clients.discard(websocket)

@app.post('/api/v1/lab/csma')
def csma(nodes:int=10,slots:int=100,offered_load:float=.4,cd:bool=True):
    import random
    rng=random.Random(42); collisions=success=0
    for _ in range(slots):
        attempts=sum(rng.random()<offered_load for _ in range(nodes))
        if attempts==1: success+=1
        elif attempts>1: collisions+=1
    return {'protocol':'CSMA/CD' if cd else 'CSMA/CA','slots':slots,'success':success,'collisions':collisions,'throughput':round(success/slots,4)}

@app.post('/api/v1/lab/switch')
def switch_forward(source_mac:str,destination_mac:str,mac_table:dict):
    return {'learned_source':source_mac,'decision':'UNICAST' if destination_mac in mac_table else 'FLOOD','outgoing_interface':mac_table.get(destination_mac)}

@app.post('/api/v1/lab/arp')
def arp(source_ip:str,destination_ip:str,cache:dict):
    hit=destination_ip in cache
    return {'request':None if hit else f'Who has {destination_ip}?','reply':cache.get(destination_ip),'cache_hit':hit}

@app.post('/api/v1/lab/nat')
def nat(source_ip:str,source_port:int,public_ip:str='203.0.113.10'):
    return {'inside_local':f'{source_ip}:{source_port}','inside_global':f'{public_ip}:{source_port}','translation':'source NAT/PAT'}

@app.post('/api/v1/lab/ipv4-header')
def ipv4_header(source:str,destination:str,protocol:int=6,ttl:int=64,length:int=60):
    return {'version':4,'ihl':5,'total_length':length,'ttl':ttl,'protocol':protocol,'source':source,'destination':destination}

@app.post('/api/v1/lab/ipv6-header')
def ipv6_header(source:str,destination:str,next_header:int=6,hop_limit:int=64,payload_length:int=40):
    return {'version':6,'traffic_class':0,'flow_label':0,'payload_length':payload_length,'next_header':next_header,'hop_limit':hop_limit,'source':source,'destination':destination}

@app.post('/api/v1/assistant')
def assistant(question:str,project_id:int|None=None,db:Session=Depends(get_db)):
    q=question.lower(); evidence=[]
    if project_id:
        p=db.get(Project,project_id)
        if p: evidence.append(f'topology has {len(p.topology.get("nodes",[]))} nodes and {len(p.topology.get("links",[]))} links')
    if 'route' in q: answer='CiscoNetX uses the active topology and link latency to compute shortest paths with Dijkstra and exposes routing-table evidence.'
    elif 'packet' in q: answer='Inspect packet events to follow creation, forwarding, drops, retransmissions, and delivery across each hop.'
    elif 'security' in q or 'ddos' in q: answer='Security analysis evaluates simulated flows for abnormal rates and destination-port fan-out, then records defensive alerts.'
    elif 'congestion' in q: answer='Traffic engineering measures utilization, latency, packet loss and throughput, while TCP simulation exposes congestion-window behavior.'
    else: answer='CiscoNetX links topology, routing, packet events, telemetry, security and experiments through one simulation state.'
    return {'answer':answer,'evidence':evidence,'grounded':bool(evidence)}


@app.post('/api/v1/routing/ospf')
def ospf_api(topology:Topology, source:str): return ospf(topology.model_dump(),source)

@app.post('/api/v1/routing/rip')
def rip_api(topology:Topology, source:str): return rip(topology.model_dump(),source)

@app.post('/api/v1/lab/arq-v2')
def arq_v2(protocol:str='go_back_n',frames:int=12,window:int=4,losses:list[int]=[3],seed:int=42):
    if protocol not in ('stop_and_wait','go_back_n','selective_repeat'): raise HTTPException(400,'Unsupported ARQ protocol')
    return arq(protocol,frames,window,losses,seed)

@app.post('/api/v1/lab/mac-access')
def mac_access(protocol:str='csma_cd',nodes:int=10,slots:int=200,offered_load:float=.3,seed:int=42):
    if protocol not in ('aloha','slotted_aloha','csma_cd','csma_ca'): raise HTTPException(400,'Unsupported access protocol')
    return medium_access(protocol,nodes,slots,offered_load,seed)

@app.post('/api/v1/lab/nat-v2')
def nat_v2(source_ip:str,source_port:int,public_ip:str='203.0.113.10',public_port:int|None=None):
    return nat_translate(source_ip,source_port,public_ip,public_port)

@app.post('/api/v1/lab/packet-trace')
def trace(topology:Topology,source:str,destination:str,count:int=20,seed:int=42):
    if count<1 or count>10000: raise HTTPException(422,'count must be between 1 and 10000')
    return packet_trace(topology.model_dump(),source,destination,count,seed)

@app.post('/api/v1/lab/tcp-state')
def tcp_state(loss:float=.1,rounds:int=24,seed:int=42): return tcp_state_machine(loss,rounds,seed)

@app.post('/api/v1/topology/stats')
def topo_stats(topology:Topology): return topology_stats(topology.model_dump())

@app.post('/api/v1/ml/dataset')
def ml_dataset(n:int=200,seed:int=42):
    if n<20 or n>10000: raise HTTPException(422,'n must be between 20 and 10000')
    return {'samples':synthetic_dataset(n,seed),'count':n,'seed':seed}

@app.get('/api/v1/protocols')
def protocols():
    return {
      'layers':{
        'data_link':['Ethernet','IEEE 802.3','IEEE 802.11','ARP','CRC','Checksum','Hamming Code','Stop-and-Wait','Sliding Window','Go-Back-N','Selective Repeat','ALOHA','Slotted ALOHA','CSMA/CD','CSMA/CA'],
        'network':['IPv4','IPv6','CIDR','Subnetting','NAT','Distance Vector','Link State','RIP','OSPF','Dijkstra'],
        'transport':['TCP','UDP','Three-way Handshake','Flow Control','Slow Start','Congestion Avoidance','Fast Retransmit','QoS'],
        'application':['DNS','HTTP','HTTPS','FTP','SMTP','SNMP']
      }
    }

@app.get('/api/v1/projects/{pid}/audit')
def audit_log(pid:int,db:Session=Depends(get_db)):
    return [{'id':x.id,'action':x.action,'details':x.details,'created_at':x.created_at} for x in db.scalars(select(AuditEvent).where(AuditEvent.project_id==pid).order_by(AuditEvent.id.desc())).all()]

@app.get('/api/v1/projects/{pid}/incidents')
def incidents(pid:int,db:Session=Depends(get_db)):
    return [{'id':x.id,'kind':x.kind,'severity':x.severity,'source':x.source,'destination':x.destination,'evidence':x.evidence,'action':x.action,'created_at':x.created_at} for x in db.scalars(select(SecurityIncident).where(SecurityIncident.project_id==pid).order_by(SecurityIncident.id.desc())).all()]

@app.get('/api/v1/metrics')
def metrics(): return {'simulations_total':'application metric','protocols':['IPv4','IPv6','ARP','NAT','Ethernet','TCP','UDP','DNS','HTTP','SNMP'],'subsystems':['routing','switching','security','ml','telemetry']}

@app.post('/api/v1/protocol/https')
def https_flow(host:str='server.cisconetx.local',path:str='/'):
    return {'protocol':'HTTPS','steps':['DNS QUERY','DNS RESPONSE','TCP SYN','TCP SYN-ACK','TCP ACK','TLS CLIENT HELLO','TLS SERVER HELLO','KEY EXCHANGE','GET '+path,'HTTP/2 200'],'encrypted_application_data':True,'host':host}

@app.post('/api/v1/protocol/ftp')
def ftp_flow(host:str='ftp.cisconetx.local'):
    return {'protocol':'FTP','steps':['TCP CONTROL CONNECT','USER','PASS','PASV','DATA CONNECT','LIST','TRANSFER COMPLETE','QUIT'],'host':host}

@app.post('/api/v1/protocol/smtp')
def smtp_flow(sender:str='alice@cisconetx.local',recipient:str='bob@cisconetx.local'):
    return {'protocol':'SMTP','steps':['TCP CONNECT','220 READY','EHLO','MAIL FROM','RCPT TO','DATA','250 ACCEPTED','QUIT'],'sender':sender,'recipient':recipient}

@app.post('/api/v1/protocol/snmp')
def snmp_flow(device:str='r1',oid:str='1.3.6.1.2.1.1.3.0'):
    return {'protocol':'SNMP','steps':['GET REQUEST','DEVICE LOOKUP','GET RESPONSE'],'device':device,'oid':oid,'value':'sysUpTime.0'}

@app.post('/api/v1/lab/vlan')
def vlan_sim(source_vlan:int,destination_vlan:int,mode:str='access'):
    allowed=source_vlan==destination_vlan or mode=='trunk'
    return {'source_vlan':source_vlan,'destination_vlan':destination_vlan,'mode':mode,'forwarding':'ALLOW' if allowed else 'ISOLATE','reason':'same broadcast domain' if allowed else 'VLAN boundary'}

@app.post('/api/v1/lab/ipv4-validate')
def ipv4_validate(address:str,prefix:int):
    import ipaddress
    n=ipaddress.ip_network(f'{address}/{prefix}',strict=False); a=ipaddress.ip_address(address)
    return {'valid':a.version==4,'address':str(a),'network':str(n.network_address),'prefix':n.prefixlen,'is_private':a.is_private,'is_global':a.is_global}

@app.post('/api/v1/lab/ipv6-validate')
def ipv6_validate(address:str,prefix:int):
    import ipaddress
    n=ipaddress.ip_network(f'{address}/{prefix}',strict=False); a=ipaddress.ip_address(address)
    return {'valid':a.version==6,'address':a.compressed,'network':str(n.network_address),'prefix':n.prefixlen,'is_private':a.is_private,'is_global':a.is_global}

@app.post('/api/v1/experiments/compare-routing')
def compare_routing(topology:Topology,source:str='r1',destination:str='server1'):
    t=topology.model_dump(); d=dijkstra(t,source,destination); o=ospf(t,source); rr=rip(t,source)
    return {'source':source,'destination':destination,'algorithms':{'Dijkstra':{'path':d},'OSPF':o['routes'].get(destination,{}),'RIP':rr['routes'].get(destination,{})}}

@app.post('/api/v1/reports/run')
def report_run(topology:Topology,source:str='pc1',destination:str='server1',packets:int=100,seed:int=42):
    trace_data=packet_trace(topology.model_dump(),source,destination,packets,seed)
    return {'title':'CiscoNetX Network Engineering Report','metadata':{'seed':seed,'source':source,'destination':destination},'topology':topology_stats(topology.model_dump()),'route':trace_data['path'],'packet_metrics':trace_data['metrics'],'protocols':['IPv4','IPv6','ARP','NAT','TCP','UDP','DNS','HTTP'],'generated_at':time.time()}


@app.post('/api/v1/sdn/path')
def sdn_path(topology:Topology,source:str,destination:str):
    c=SDNController(topology.model_dump()); path=c.compute_path(source,destination); c.install({'source':source,'destination':destination},[f'OUTPUT:{destination}']); return {'path':path,**c.snapshot()}

@app.post('/api/v1/sdn/flow')
def sdn_flow(topology:Topology,source:str,destination:str,protocol:str='TCP',priority:int=100):
    c=SDNController(topology.model_dump()); path=c.compute_path(source,destination); rule=c.install({'source':source,'destination':destination,'protocol':protocol},['FORWARD'],priority); return {'path':path,'rule':rule,'controller':c.snapshot()}

@app.post('/api/v1/traffic/simulate')
def traffic(topology:Topology,source:str='pc1',destination:str='server1',packets:int=100,seed:int=42,rate_mbps:float=10):
    if packets<1 or packets>10000: raise HTTPException(422,'packets must be between 1 and 10000')
    return traffic_simulation(topology.model_dump(),source,destination,packets,seed,rate_mbps)

@app.post('/api/v1/security/port-scan')
def port_scan(flows:list[dict],threshold:int=10): return {'alerts':detect_port_scan(flows,threshold)}

@app.post('/api/v1/security/ddos')
def ddos(flows:list[dict],threshold:int=100): return {'alerts':detect_ddos(flows,threshold)}

@app.post('/api/v1/ml/train')
def ml_train(samples:list[dict],seed:int=42):
    if len(samples)<30: raise HTTPException(422,'At least 30 samples are required')
    return train(samples,seed)

@app.get('/api/v1/emulation/capabilities')
def emulation_capabilities():
    from integrations.linux_tools import capability_report
    return capability_report()

@app.get('/api/v1/capabilities')
def capabilities():
    return {'simulation':['packet-forwarding','routing','switching','VLAN','ARP','NAT','IPv4','IPv6','TCP','UDP','DNS','HTTP','HTTPS','FTP','SMTP','SNMP'],'routing':['Dijkstra','Distance Vector','RIP','OSPF','ECMP','failover'],'data_link':['CRC','Checksum','Hamming','Stop-and-Wait','Go-Back-N','Selective Repeat','ALOHA','CSMA/CD','CSMA/CA'],'security':['ACL','firewall','DDoS','port-scan','ARP-spoofing','IP-MAC anomaly'],'operations':['SDN flow rules','traffic engineering','replayable seeds','audit logs','health checks'],'ml':['synthetic telemetry','baseline anomaly score','LogisticRegression training','evaluation']}

@app.post('/api/v1/emulation/plan')
def emulation_plan(topology:Topology):
    from integrations.emulation import dry_run_plan
    return dry_run_plan(topology.model_dump())

@app.get('/api/v1/emulation/status')
def emulation_status():
    from integrations.emulation import adapter_status
    return adapter_status()

@app.post('/api/v1/projects/{pid}/policies/evaluate')
def project_policy(pid:int,payload:dict,db:Session=Depends(get_db)):
    if not db.get(Project,pid): raise HTTPException(404,'Project not found')
    from app.enterprise import policy_evaluate
    return policy_evaluate(payload)

@app.post('/api/v1/projects/{pid}/reports/pdf')
def report_pdf(pid:int,db:Session=Depends(get_db)):
    from fastapi.responses import Response
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas
    p=db.get(Project,pid)
    if not p: raise HTTPException(404,'Project not found')
    import io
    buf=io.BytesIO(); c=canvas.Canvas(buf,pagesize=A4); y=800
    lines=[f'CiscoNetX Network Engineering Report',f'Project: {p.name}',f'Devices: {len(p.topology.get("nodes",[]))}',f'Links: {len(p.topology.get("links",[]))}','']
    for r in db.scalars(select(SimulationRun).where(SimulationRun.project_id==pid).order_by(SimulationRun.id.desc()).limit(10)).all():
        lines.append(f'Run {r.id} | {r.scenario} | seed={r.seed} | metrics={r.metrics}')
    for line in lines:
        if y<50: c.showPage(); y=800
        c.drawString(45,y,line[:130]); y-=16
    c.save(); return Response(buf.getvalue(),media_type='application/pdf',headers={'Content-Disposition':f'attachment; filename="cisconetx-{pid}.pdf"'})

@app.get('/api/v1/projects/{pid}/runs.csv')
def runs_csv(pid:int,db:Session=Depends(get_db)):
    from fastapi.responses import PlainTextResponse
    import csv,io
    if not db.get(Project,pid): raise HTTPException(404,'Project not found')
    buf=io.StringIO(); w=csv.writer(buf); w.writerow(['id','scenario','seed','status','metrics'])
    for r in db.scalars(select(SimulationRun).where(SimulationRun.project_id==pid).order_by(SimulationRun.id)).all(): w.writerow([r.id,r.scenario,r.seed,r.status,json.dumps(r.metrics,separators=(',',':'))])
    return PlainTextResponse(buf.getvalue(),media_type='text/csv')

# v6 engineering APIs: explicit protocol, packet, telemetry, configuration and lab contracts.
from app.simulation.link_layer import stop_and_wait, sliding_window as sw_sim, aloha as aloha_sim, csma as csma_sim
from app.simulation.packet_engine import PacketEngine
from app.telemetry import summarize as telemetry_summary, threshold_alerts
from app.configuration import DEFAULT_DEVICE_CONFIG, validate_device_config, diff_config
from app.services.reporting import csv_runs as service_csv_runs, pdf_report as service_pdf_report

packet_engine = PacketEngine()

@app.post('/api/v1/lab/stop-and-wait')
def lab_stop_and_wait(frames:int=8, loss:float=.1, seed:int=42):
    return stop_and_wait(frames, loss, seed)

@app.post('/api/v1/lab/sliding-window')
def lab_sliding_window(frames:int=12, window:int=4, loss:float=.1, selective:bool=False, seed:int=42):
    return sw_sim(frames, window, loss, selective, seed)

@app.post('/api/v1/lab/medium-access')
def lab_medium_access(protocol:str='csma_cd', nodes:int=10, slots:int=200, load:float=.3, seed:int=42):
    if protocol in ('aloha','slotted_aloha'): return aloha_sim(protocol,nodes,slots,load,seed)
    if protocol in ('csma','csma_cd','csma_ca'): return csma_sim(protocol,nodes,slots,load,seed)
    raise HTTPException(400,'Unsupported medium access protocol')

@app.post('/api/v1/packets/create')
def packet_create(payload:dict):
    return packet_engine.encapsulate(packet_engine.create(payload['source_ip'],payload['destination_ip'],payload.get('protocol','TCP'),int(payload.get('payload_bytes',64)),int(payload.get('sequence',0))))

@app.post('/api/v1/packets/forward')
def packet_forward(payload:dict):
    p=packet_engine.create(payload['source_ip'],payload['destination_ip'],payload.get('protocol','TCP'),int(payload.get('payload_bytes',64)),int(payload.get('sequence',0)))
    return packet_engine.forward(p,int(payload.get('hops',1)))

@app.post('/api/v1/telemetry/summary')
def telemetry_summary_api(samples:list[dict]): return telemetry_summary(samples)

@app.post('/api/v1/telemetry/alerts')
def telemetry_alerts(samples:list[dict],latency_ms:float=100,utilization:float=.85,packet_loss:float=.05):
    return {'alerts':threshold_alerts(samples,latency_ms,utilization,packet_loss)}

@app.post('/api/v1/devices/config/validate')
def device_config_validate(config:dict): return validate_device_config(config)

@app.post('/api/v1/devices/config/diff')
def device_config_diff(old:dict,new:dict): return {'changes':diff_config(old,new)}

@app.get('/api/v1/devices/config/default')
def device_config_default(): return DEFAULT_DEVICE_CONFIG

@app.post('/api/v1/ipv4/header')
def ipv4_header(payload:dict):
    import ipaddress
    src=ipaddress.ip_address(payload['source']); dst=ipaddress.ip_address(payload['destination'])
    if src.version != 4 or dst.version != 4: raise HTTPException(422,'IPv4 addresses required')
    return {'version':4,'ihl':5,'dscp':int(payload.get('dscp',0)),'ecn':int(payload.get('ecn',0)),'total_length':20+int(payload.get('payload_bytes',0)),'identification':int(payload.get('identification',1)),'flags':payload.get('flags',0),'fragment_offset':int(payload.get('fragment_offset',0)),'ttl':int(payload.get('ttl',64)),'protocol':payload.get('protocol','TCP'),'checksum':'simulated-header-checksum','source':str(src),'destination':str(dst)}

@app.post('/api/v1/vlan/frame-decision')
def vlan_frame_decision(payload:dict):
    src=int(payload.get('source_vlan',1)); dst=int(payload.get('destination_vlan',1)); trunk=bool(payload.get('trunk',False)); native=payload.get('native_vlan')
    forwarded=src==dst or trunk
    return {'forwarded':forwarded,'source_vlan':src,'destination_vlan':dst,'trunk':trunk,'native_vlan':native,'reason':'same VLAN' if src==dst else ('802.1Q trunk carries VLAN' if trunk else 'VLAN boundary blocks forwarding')}

@app.post('/api/v1/arp/resolve')
def arp_resolve(payload:dict):
    cache=payload.get('cache',{}); ip=payload['target_ip']; mac=cache.get(ip)
    return {'request':None if mac else {'operation':'REQUEST','target_ip':ip,'broadcast':'ff:ff:ff:ff:ff:ff'},'reply':{'operation':'REPLY','target_ip':ip,'target_mac':mac} if mac else None,'resolved':bool(mac)}

@app.post('/api/v1/nat/pat-table')
def nat_pat_table(payload:dict):
    mappings=[]; public_ip=payload.get('public_ip','203.0.113.10')
    for i,item in enumerate(payload.get('connections',[]),1):
        mappings.append({'inside_local':f"{item['source_ip']}:{item.get('source_port',10000+i)}",'inside_global':f"{public_ip}:{item.get('public_port',40000+i)}",'destination':f"{item['destination_ip']}:{item.get('destination_port',443)}",'state':'ESTABLISHED'})
    return {'protocol':'PAT','mappings':mappings}

@app.post('/api/v1/icmp/ping')
def icmp_ping(payload:dict):
    return {'protocol':'ICMP','type':8,'code':0,'source':payload['source'],'destination':payload['destination'],'echo_reply':bool(payload.get('reachable',True)),'ttl':int(payload.get('ttl',64))}

@app.get('/api/v1/architecture/manifest')
def architecture_manifest():
    return {'version':'6.0.0','planes':['control','data','management','security','analytics'],'components':['topology','switching','routing','packet-engine','protocol-labs','traffic-engineering','security','telemetry','ml','assistant','persistence','observability','reporting','emulation'],'deterministic_simulation':True}

@app.post('/api/v1/lab/physical-channel')
def physical_channel(payload:dict):
    rate=float(payload.get('data_rate_mbps',100)); distance=float(payload.get('distance_km',1)); fiber=payload.get('medium','fiber'); impairment=float(payload.get('impairment_db',0));
    propagation_ms=round(distance/(200_000 if fiber=='fiber' else 100_000),6)
    effective=max(0,rate*(10**(-impairment/10)))
    return {'medium':fiber,'data_rate_mbps':rate,'distance_km':distance,'propagation_delay_ms':propagation_ms,'impairment_db':impairment,'estimated_effective_rate_mbps':round(effective,4)}

@app.post('/api/v1/lab/wifi')
def wifi_sim(payload:dict):
    nodes=int(payload.get('nodes',10)); collisions=max(0,nodes-1); channel=float(payload.get('channel_mbps',100)); offered=float(payload.get('offered_mbps',50));
    efficiency=max(.05,min(.95,1-collisions/(nodes*4))) if nodes else 1
    return {'standard':'IEEE 802.11','nodes':nodes,'channel_mbps':channel,'offered_mbps':offered,'estimated_efficiency':round(efficiency,4),'throughput_mbps':round(min(channel,offered)*efficiency,4),'mechanism':'CSMA/CA with random backoff'}

@app.post('/api/v1/lab/ethernet')
def ethernet_sim(payload:dict):
    frame=int(payload.get('frame_bytes',1500)); rate=float(payload.get('link_mbps',100)); utilization=float(payload.get('utilization',.5));
    tx_ms=frame*8/(rate*1_000_000)*1000
    return {'standard':'IEEE 802.3','frame_bytes':frame,'link_mbps':rate,'utilization':utilization,'transmission_time_ms':round(tx_ms,6),'estimated_queue_delay_ms':round(tx_ms*utilization/max(.001,1-utilization),6)}

@app.post('/api/v1/lab/rfid')
def rfid_sim(payload:dict):
    tags=int(payload.get('tags',10)); collisions=max(0,tags-1); return {'technology':'RFID','tags':tags,'reader':payload.get('reader','reader-1'),'anti_collision':'framed-slotted-ALOHA','collision_events':collisions}

@app.post('/api/v1/network/encapsulation')
def encapsulation(payload:dict):
    data=str(payload.get('payload','CiscoNetX')); layers=[{'layer':'Application','data':data},{'layer':'Transport','header':{'protocol':payload.get('protocol','TCP'),'src_port':payload.get('source_port',49152),'dst_port':payload.get('destination_port',443)}},{'layer':'Network','header':{'src':payload.get('source_ip','10.0.0.10'),'dst':payload.get('destination_ip','10.0.2.10')}},{'layer':'Data Link','header':{'src_mac':payload.get('source_mac','00:00:00:00:00:01'),'dst_mac':payload.get('destination_mac','00:00:00:00:00:02')}},{'layer':'Physical','signal':'frame transmitted'}]
    return {'encapsulation':layers,'decapsulation':list(reversed(layers))}

@app.post('/api/v1/ml/train-multitask')
def ml_train_multitask(samples:list[dict],seed:int=42):
    if len(samples)<30: raise HTTPException(422,'At least 30 samples are required')
    from app.ml.service import train_multitask
    return train_multitask(samples,seed)
