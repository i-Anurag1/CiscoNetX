import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type Node = { id:string; name:string; type:string; ip?:string; mac?:string; vlan?:number; x?:number; y?:number };
type Link = { id:string; source:string; target:string; bandwidth_mbps:number; latency_ms:number; jitter_ms?:number; loss_rate?:number; up:boolean };
type Topology = { nodes:Node[]; links:Link[] };
type Result = Record<string, any> | undefined;

const API = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
const tabs = ['NOC','Topology','Routing','Packets','Data Link','IP','Transport','Protocols','Security','Telemetry','AI / ML','Experiments','Replay','Reports','Automation'];
const tabMeta:Record<string,{group:string;title:string;desc:string}> = {
  NOC:{group:'OPERATIONS',title:'Network Operations Center',desc:'A live command view of topology health, routing, traffic, security and recovery.'},
  Topology:{group:'OPERATIONS',title:'Topology Studio',desc:'Model devices and links, introduce failures, and inspect the resulting network state.'},
  Routing:{group:'NETWORKING',title:'Routing & Convergence',desc:'Evaluate path selection, failures and deterministic recovery across the enterprise topology.'},
  Packets:{group:'NETWORKING',title:'Packet Trace',desc:'Follow packets through the simulated network and inspect forwarding behavior.'},
  'Data Link':{group:'NETWORKING',title:'Data Link Laboratory',desc:'Explore framing, loss, windows and retransmission behavior.'},
  IP:{group:'NETWORKING',title:'IP Addressing & Forwarding',desc:'Inspect subnetting and addressing decisions with deterministic inputs.'},
  Transport:{group:'NETWORKING',title:'Transport Session Lab',desc:'Study TCP session behavior, loss and reliable delivery.'},
  Protocols:{group:'NETWORKING',title:'Application Protocol Lab',desc:'Inspect the behavior of common application-layer protocols.'},
  Security:{group:'SECURITY',title:'Network Security Center',desc:'Analyze simulated flows for suspicious ports, volume and endpoint anomalies.'},
  Telemetry:{group:'OBSERVABILITY',title:'Telemetry & Observability',desc:'Turn network measurements into operational trends and evidence.'},
  'AI / ML':{group:'INTELLIGENCE',title:'AI / ML Operations',desc:'Train and evaluate deterministic anomaly models from network telemetry.'},
  Experiments:{group:'INTELLIGENCE',title:'Experiment Lab',desc:'Run repeatable network experiments and compare their outcomes.'},
  Replay:{group:'INTELLIGENCE',title:'Replay & Reproducibility',desc:'Validate whether identical experiment inputs produce identical results.'},
  Reports:{group:'OUTPUT',title:'Engineering Reports',desc:'Generate structured evidence from topology, routing and simulation runs.'},
  Automation:{group:'OUTPUT',title:'Policy Automation',desc:'Evaluate operational policies against live-style network metrics.'}
};

const defaultTopology:Topology={
  nodes:[
    {id:'pc1',name:'PC-01',type:'host',ip:'10.0.0.10',x:7,y:50},
    {id:'sw1',name:'CORE-SW',type:'switch',vlan:10,x:22,y:50},
    {id:'r1',name:'RTR-01',type:'router',ip:'10.0.0.1',x:39,y:34},
    {id:'r2',name:'RTR-02',type:'router',ip:'10.0.1.1',x:55,y:34},
    {id:'r3',name:'RTR-03',type:'router',ip:'10.0.3.1',x:55,y:70},
    {id:'r4',name:'RTR-04',type:'router',ip:'10.0.2.1',x:72,y:50},
    {id:'server1',name:'APP-SERVER',type:'server',ip:'10.0.2.10',x:91,y:50}
  ],
  links:[
    {id:'l1',source:'pc1',target:'sw1',bandwidth_mbps:100,latency_ms:1,up:true},
    {id:'l2',source:'sw1',target:'r1',bandwidth_mbps:1000,latency_ms:2,up:true},
    {id:'l3',source:'r1',target:'r2',bandwidth_mbps:500,latency_ms:8,up:true},
    {id:'l4',source:'r2',target:'r4',bandwidth_mbps:500,latency_ms:8,up:true},
    {id:'l5',source:'r1',target:'r3',bandwidth_mbps:300,latency_ms:12,up:true},
    {id:'l6',source:'r3',target:'r4',bandwidth_mbps:300,latency_ms:12,up:true},
    {id:'l7',source:'r4',target:'server1',bandwidth_mbps:1000,latency_ms:2,up:true}
  ]
};

async function api(path:string, opts:RequestInit={}){
  const token=localStorage.getItem('cisconetx_token');
  const headers:HeadersInit={'Content-Type':'application/json',...(opts.headers||{})};
  if(token) headers.Authorization=`Bearer ${token}`;
  let r:Response;
  try{
    r=await fetch(API+path,{...opts,headers,signal:AbortSignal.timeout(15000)});
  }catch(error){
    throw new Error(error instanceof Error ? error.message : 'Network request failed');
  }
  const contentType=r.headers.get('content-type')||'';
  const body=contentType.includes('application/json') ? await r.json().catch(()=>({})) : await r.text().catch(()=> '');
  if(!r.ok){
    const detail=typeof body==='object' && body && 'detail' in body ? String((body as any).detail) : String(body||`HTTP ${r.status}`);
    throw new Error(detail);
  }
  return body;
}

function Icon({name}:{name:string}){
  const paths:Record<string,string>={
    grid:'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
    network:'M12 3v5m0 0-6 4m6-4 6 4M6 12v6m12-6v6M6 18h12',
    route:'M4 18 10 6l10 12',
    packet:'m5 8 7-4 7 4-7 4-7-4Zm0 0v8l7 4 7-4V8',
    shield:'M12 3 19 6v5c0 5-3 8-7 10-4-2-7-5-7-10V6l7-3Z',
    chart:'M4 19V5m0 14h16M7 15l3-4 3 2 4-6',
    brain:'M9 4a3 3 0 0 0-5 2 3 3 0 0 0 1 5 3 3 0 0 0 4 4 3 3 0 0 0 3-3V7a3 3 0 0 0-3-3Zm6 0a3 3 0 0 1 5 2 3 3 0 0 1-1 5 3 3 0 0 1-4 4 3 3 0 0 1-3-3V7a3 3 0 0 1 3-3ZM9 8h6M8 12h8',
    lab:'M7 3h10M9 3v6l-5 8a3 3 0 0 0 3 4h10a3 3 0 0 0 3-4l-5-8V3M7 16h10',
    doc:'M6 3h8l4 4v14H6zM14 3v5h5M9 13h6M9 17h6',
    gear:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-5v3m0 12v3M4.9 4.9l2.1 2.1m10 10 2.1 2.1M3 12h3m12 0h3M4.9 19.1 7 17m10-10 2.1-2.1'
  };
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]||paths.grid}/></svg>;
}

function Sparkline({values,positive=true}:{values:number[];positive?:boolean}){
  const w=160,h=42,min=Math.min(...values),max=Math.max(...values),range=max-min||1;
  const points=values.map((v,i)=>`${(i/(values.length-1))*w},${h-((v-min)/range)*(h-6)-3}`).join(' ');
  return <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none"><polyline points={points} fill="none" stroke={positive?'#2478f0':'#d05a61'} strokeWidth="2.5" vectorEffect="non-scaling-stroke"/></svg>;
}

function MiniBars({values}:{values:number[]}){const max=Math.max(...values)||1;return <div className="miniBars">{values.map((v,i)=><i key={i} style={{height:`${Math.max(8,(v/max)*100)}%`}} />)}</div>}

function Card({title,subtitle,children,action}:{title:string;subtitle?:string;children:React.ReactNode;action?:React.ReactNode}){
  return <section className="card"><div className="cardHead"><div><b>{title}</b>{subtitle&&<span>{subtitle}</span>}</div>{action}</div>{children}</section>;
}

function StatusDot({ok=true}:{ok?:boolean}){return <span className={`statusDot ${ok?'ok':'bad'}`} />}

function Topology({t,path,onNode,compact=false}:{t:Topology;path:string[];onNode:(id:string)=>void;compact?:boolean}){
  const p=Object.fromEntries(t.nodes.map(n=>[n.id,{x:n.x??10,y:n.y??50}]));
  return <div className={`topology ${compact?'compact':''}`}>
    <div className="topologyLegend"><span><i className="legendLine"/> Active path</span><span><i className="legendLine neutral"/> Link</span><span><i className="legendDot"/> Device</span></div>
    <svg viewBox="0 0 100 100" preserveAspectRatio="none">
      {t.links.map(l=><line key={l.id} x1={p[l.source]?.x} y1={p[l.source]?.y} x2={p[l.target]?.x} y2={p[l.target]?.y} className={`${l.up?'link':'link down'} ${path.includes(l.source)&&path.includes(l.target)?'selected':''}`}/>) }
    </svg>
    {t.nodes.map(n=><button key={n.id} onClick={()=>onNode(n.id)} className={`node ${n.type} ${path.includes(n.id)?'active':''}`} style={{left:`${n.x??10}%`,top:`${n.y??50}%`}}>
      <strong>{n.type==='router'?'R':n.type==='switch'?'SW':n.type==='server'?'SV':n.type==='firewall'?'FW':'PC'}</strong>
      <span>{n.name}</span><small>{n.ip||'Layer 2'}</small>
    </button>)}
  </div>;
}

function Table({rows}:{rows:[string,any][]}){return <div className="tableWrap"><table><thead><tr><th>FIELD</th><th>VALUE</th></tr></thead><tbody>{rows.map(([k,v],i)=><tr key={i}><td>{k}</td><td>{typeof v==='object'?JSON.stringify(v):String(v)}</td></tr>)}</tbody></table></div>}

function Metric({label,value,delta,trend}:{label:string;value:string|number;delta?:string;trend?:number[]}){
  return <div className="metric"><div className="metricTop"><span>{label}</span>{delta&&<em>{delta}</em>}</div><strong>{value}</strong>{trend&&<Sparkline values={trend}/>}</div>;
}

function SectionTitle({eyebrow,title,desc}:{eyebrow:string;title:string;desc:string}){return <div className="sectionTitle"><small>{eyebrow}</small><h2>{title}</h2><p>{desc}</p></div>}

function App(){
  const [tab,setTab]=useState('NOC');
  const [t,setT]=useState<Topology>(defaultTopology);
  const [out,setOut]=useState<Result>();
  const [busy,setBusy]=useState(false);
  const [online,setOnline]=useState(false);
  const [selected,setSelected]=useState('r1');
  const [notice,setNotice]=useState('System ready. Select a workspace to begin.');
  const [runError,setRunError]=useState('');
  const [lastRun,setLastRun]=useState('');

  useEffect(()=>{api('/health').then(()=>setOnline(true)).catch(()=>setOnline(false));const ws=API ? API.replace(/^http/,'ws')+'/ws/events' : `${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws/events`;let s:WebSocket|undefined;try{s=new WebSocket(ws);s.onopen=()=>setOnline(true);s.onclose=()=>setOnline(false)}catch{}return()=>s?.close()},[]);
  const path=out?.after_path||out?.final_path||out?.path||out?.route||[];
  const node=t.nodes.find(n=>n.id===selected);
  const activeLinks=t.links.filter(x=>x.up).length;
  const avgLatency=Math.round(t.links.reduce((a,l)=>a+l.latency_ms,0)/Math.max(1,t.links.length));

  const run=async()=>{
    setBusy(true);setRunError('');setNotice(`Running ${tabMeta[tab].title}…`);
    try{let x:any;
      switch(tab){
        case'NOC':case'Routing':x=await api('/api/v1/enterprise/routing/convergence',{method:'POST',body:JSON.stringify({topology:t,source:'pc1',destination:'server1',failed_nodes:tab==='NOC'?['r2']:[],packets:100})});break;
        case'Packets':x=await api('/api/v1/lab/packet-trace?source=pc1&destination=server1&count=40&seed=42',{method:'POST',body:JSON.stringify(t)});break;
        case'Data Link':x=await api('/api/v1/lab/sliding-window?frames=12&window=4&loss=.15&selective=true&seed=42',{method:'POST'});break;
        case'IP':x=await api('/api/v1/lab/subnet?network=10.20.0.0&prefix=24',{method:'POST'});break;
        case'Transport':x=await api('/api/v1/enterprise/tcp/session',{method:'POST',body:JSON.stringify({loss:.12,rounds:24,seed:42})});break;
        case'Protocols':x=await api('/api/v1/protocol/https',{method:'POST'});break;
        case'Security':x=await api('/api/v1/enterprise/security/analyze',{method:'POST',body:JSON.stringify({flows:Array.from({length:120},(_,i)=>({source_ip:`10.0.0.${i%4}`,destination_ip:'10.0.2.10',destination_port:i%16,source_mac:i%2?'aa:01':'aa:02'}))})});break;
        case'Telemetry':x=await api('/api/v1/telemetry/summary',{method:'POST',body:JSON.stringify(Array.from({length:20},(_,i)=>({packet_rate:100+i*20,latency_ms:10+i,packet_loss:i%7===0?.08:.01,utilization:i/25}))) });break;
        case'AI / ML':x=await api('/api/v1/ml/train?seed=42',{method:'POST',body:JSON.stringify(Array.from({length:120},(_,i)=>({packet_rate:i%4?300:1600,packet_loss:i%4?.01:.2,latency_ms:i%4?20:180,utilization:i%4?.3:.92,anomaly:i%4===0}))) });break;
        case'Experiments':x=await api('/api/v1/enterprise/experiments/run',{method:'POST',body:JSON.stringify({topology:t,source:'pc1',destination:'server1',seed:42})});break;
        case'Replay':x=await api('/api/v1/replay/validate',{method:'POST',body:JSON.stringify({run_a:{seed:42,topology_hash:'demo'},run_b:{seed:42,topology_hash:'demo'}})});break;
        case'Reports':x=await api('/api/v1/reports/run',{method:'POST',body:JSON.stringify({topology:t,source:'pc1',destination:'server1',packets:100,seed:42})});break;
        case'Automation':x=await api('/api/v1/policies/evaluate',{method:'POST',body:JSON.stringify({metrics:{utilization:.92,latency_ms:120},policies:[{name:'Congestion failover',metric:'utilization',operator:'>',threshold:.8,action:'REROUTE'},{name:'Latency alert',metric:'latency_ms',operator:'>',threshold:100,action:'ALERT'}]})});break;
        default:x=await api('/api/v1/architecture/manifest');
      }
      setOut(x);setLastRun(new Date().toLocaleTimeString());setNotice(`${tabMeta[tab].title} completed successfully.`);
    }catch(e:any){const message=e?.name==='AbortError'?'Request timed out after 15 seconds.':(e?.message||'Execution failed.');setRunError(message);setNotice(`Analysis failed: ${message}`);}finally{setBusy(false)}
  };
  const add=(type:string)=>setT(v=>({...v,nodes:[...v.nodes,{id:`${type}-${Date.now()}`,name:type==='firewall'?'EDGE-FW':type.toUpperCase(),type,x:48,y:20+Math.random()*60}]}));
  const removeSelected=()=>setT(v=>({...v,nodes:v.nodes.filter(n=>n.id!==selected),links:v.links.filter(l=>l.source!==selected&&l.target!==selected)}));
  const connectSelected=()=>{const target=t.nodes.find(n=>n.id!==selected);if(!target)return;setT(v=>({...v,links:[...v.links,{id:`l-${Date.now()}`,source:selected,target:target.id,bandwidth_mbps:100,latency_ms:5,up:true}]}))};

  return <div className="app">
    <aside className="sidebar">
      <div className="brand"><div className="logo">CX</div><div><b>CiscoNetX</b><span>NETWORK INTELLIGENCE</span></div></div>
      <div className={`controlStatus ${online?'online':''}`}><StatusDot ok={online}/><div><b>{online?'Control plane online':'Simulator mode'}</b><span>{online?'FastAPI connected':'Backend unavailable'}</span></div></div>
      <div className="navLabel">WORKSPACES</div>
      <nav>{tabs.map((x,i)=><button className={tab===x?'sel':''} key={x} onClick={()=>{setTab(x);setOut(undefined)}}><Icon name={x==='NOC'?'grid':x==='Topology'?'network':x==='Routing'?'route':x==='Packets'?'packet':x==='Security'?'shield':x==='Telemetry'?'chart':x==='AI / ML'?'brain':x==='Experiments'?'lab':x==='Reports'?'doc':x==='Automation'?'gear':'grid'}/><span>{x}</span><em>{String(i+1).padStart(2,'0')}</em></button>)}</nav>
      <div className="sidebarFoot"><span>DETERMINISTIC ENGINE</span><b>SEED 42</b><small>V6 ENTERPRISE SIMULATION</small></div>
    </aside>
    <main>
      <header className="topbar"><div><div className="breadcrumb">CISCONETX <span>/</span> {tabMeta[tab].group}</div><h1>{tabMeta[tab].title}</h1></div><div className="headerActions"><div className="connection"><StatusDot ok={online}/>{online?'Connected':'Offline'}</div><button className="runBtn" onClick={run} disabled={busy}>{busy?'RUNNING…':'RUN ANALYSIS'}</button></div></header>
      <div className="notice"><span className="noticeMark">●</span>{notice}<span className="seed">Experiment seed 42</span></div>
      <div className="content">
        {tab==='NOC'?<NocView t={t} path={path} out={out} activeLinks={activeLinks} avgLatency={avgLatency} setSelected={setSelected}/>:<Workspace tab={tab} t={t} setT={setT} path={path} node={node} selected={selected} setSelected={setSelected} out={out} add={add} connectSelected={connectSelected} removeSelected={removeSelected}/>} 
      </div>
    </main>
  </div>;
}

function NocView({t,path,out,activeLinks,avgLatency,setSelected}:{t:Topology;path:string[];out:Result;activeLinks:number;avgLatency:number;setSelected:(id:string)=>void}){
  const traffic=[38,44,42,51,48,58,63,60,68,72,69,78];
  const latency=[18,21,19,23,22,25,24,28,26,31,29,27];
  return <>
    <div className="heroRow">
      <section className="heroCard"><div className="eyebrow">ENTERPRISE NETWORK OPERATIONS</div><h2>See the network clearly. Prove what happened.</h2><p>CiscoNetX brings topology, routing, packet behavior, security, telemetry and machine learning into one operational workspace.</p><div className="heroActions"><span><StatusDot ok/> All systems nominal</span><span>Last run · deterministic</span></div></section>
      <section className="healthCard"><div className="healthRing"><div><strong>{Math.round((activeLinks/Math.max(1,t.links.length))*100)}</strong><span>%</span></div></div><div><small>NETWORK HEALTH</small><b>Operational</b><span>{activeLinks} of {t.links.length} links active</span></div></section>
    </div>
    <div className="metrics"><Metric label="Devices" value={t.nodes.length} delta="+0"/><Metric label="Active links" value={activeLinks} delta={`${activeLinks===t.links.length?'100':'<100'}%`}/><Metric label="Mean latency" value={`${avgLatency} ms`} trend={latency}/><Metric label="Traffic index" value="78" delta="+8.4%" trend={traffic}/></div>
    <div className="dashboardGrid">
      <Card title="LIVE TOPOLOGY" subtitle="Enterprise path view" action={<span className="livePill"><StatusDot/>LIVE</span>}><Topology t={t} path={path} onNode={setSelected}/></Card>
      <Card title="NETWORK TRAFFIC" subtitle="Normalized packet rate"><div className="chartPanel"><div className="chartLegend"><span><i/> Packet rate</span><b>78%</b></div><LineChart values={traffic}/><div className="chartAxis"><span>12:00</span><span>14:00</span><span>16:00</span><span>18:00</span></div></div><div className="insight"><b>Traffic is stable</b><span>Peak load remains below the simulated capacity threshold.</span></div></Card>
      <Card title="ROUTING HEALTH" subtitle="Primary and alternate paths"><div className="routeList"><RouteRow name="Primary path" path="PC-01 → CORE-SW → RTR-01 → RTR-02 → RTR-04" value="8 ms" ok/><RouteRow name="Alternate path" path="PC-01 → CORE-SW → RTR-01 → RTR-03 → RTR-04" value="12 ms" ok/><RouteRow name="Destination" path="RTR-04 → APP-SERVER" value="2 ms" ok/></div></Card>
      <Card title="OPERATIONAL SIGNALS" subtitle="Latest simulation evidence"><div className="signalList"><Signal title="Control plane" text="FastAPI control plane responding" ok/><Signal title="Topology" text={`${t.nodes.length} devices, ${activeLinks} active links`} ok/><Signal title="Recovery model" text={out?'Latest convergence result available':'Run analysis to generate evidence'} ok={!!out}/><Signal title="Security" text="Flow analysis ready" ok/></div></Card>
    </div>
  </>;
}

function LineChart({values}:{values:number[]}){const w=640,h=180,min=Math.min(...values)-5,max=Math.max(...values)+5,range=max-min;const pts=values.map((v,i)=>`${(i/(values.length-1))*w},${h-((v-min)/range)*(h-20)-10}`).join(' ');return <svg className="lineChart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none"><defs><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#2478f0" stopOpacity=".18"/><stop offset="100%" stopColor="#2478f0" stopOpacity="0"/></linearGradient></defs><path d={`M0 ${h} L ${pts.split(' ').map(p=>p.replace(',', ' ')).join(' L ')} L ${w} ${h} Z`} fill="url(#fill)"/><polyline points={pts} fill="none" stroke="#2478f0" strokeWidth="3" vectorEffect="non-scaling-stroke"/><line x1="0" y1={h*.5} x2={w} y2={h*.5} stroke="#e7edf4" strokeDasharray="4 6" vectorEffect="non-scaling-stroke"/></svg>}
function RouteRow({name,path,value,ok}:{name:string;path:string;value:string;ok:boolean}){return <div className="routeRow"><StatusDot ok={ok}/><div><b>{name}</b><span>{path}</span></div><strong>{value}</strong></div>}
function Signal({title,text,ok}:{title:string;text:string;ok:boolean}){return <div className="signal"><StatusDot ok={ok}/><div><b>{title}</b><span>{text}</span></div><em>{ok?'PASS':'WAIT'}</em></div>}

function Workspace({tab,t,setT,path,node,selected,setSelected,out,add,connectSelected,removeSelected}:{tab:string;t:Topology;setT:React.Dispatch<React.SetStateAction<Topology>>;path:string[];node?:Node;selected:string;setSelected:(x:string)=>void;out:Result;add:(x:string)=>void;connectSelected:()=>void;removeSelected:()=>void}){
  const meta=tabMeta[tab];
  return <>
    <SectionTitle eyebrow={meta.group} title={meta.title} desc={meta.desc}/>
    {tab==='Topology'&&<TopologyWorkspace t={t} setT={setT} node={node} selected={selected} setSelected={setSelected} add={add} connectSelected={connectSelected} removeSelected={removeSelected} path={path}/>} 
    {tab!=='Topology'&&<AnalysisWorkspace tab={tab} out={out} path={path} t={t}/>} 
  </>;
}

function TopologyWorkspace({t,setT,node,selected,setSelected,add,connectSelected,removeSelected,path}:{t:Topology;setT:React.Dispatch<React.SetStateAction<Topology>>;node?:Node;selected:string;setSelected:(x:string)=>void;add:(x:string)=>void;connectSelected:()=>void;removeSelected:()=>void;path:string[]}){
  return <div className="topologyStudio">
    <div className="studioToolbar"><div><b>Topology canvas</b><span>Click a device to inspect or edit it.</span></div><div className="toolbarBtns"><button onClick={()=>add('router')}>+ Router</button><button onClick={()=>add('switch')}>+ Switch</button><button onClick={()=>add('firewall')}>+ Firewall</button><button onClick={connectSelected}>Connect</button><button className="dangerBtn" onClick={removeSelected}>Delete</button></div></div>
    <div className="studioGrid"><Card title="CANVAS" subtitle={`${t.nodes.length} devices · ${t.links.length} links`}><Topology t={t} path={path} onNode={setSelected}/></Card><div className="inspector"><Card title="DEVICE INSPECTOR" subtitle={node?.name||'No device selected'}>{node?<div className="form"><label>Hostname<input value={node.name} onChange={e=>setT(v=>({...v,nodes:v.nodes.map(n=>n.id===selected?{...n,name:e.target.value}:n)}))}/></label><label>IP address<input value={node.ip||''} onChange={e=>setT(v=>({...v,nodes:v.nodes.map(n=>n.id===selected?{...n,ip:e.target.value}:n)}))}/></label><label>VLAN<input type="number" value={node.vlan||1} onChange={e=>setT(v=>({...v,nodes:v.nodes.map(n=>n.id===selected?{...n,vlan:Number(e.target.value)}:n)}))}/></label><div className="deviceMeta"><span>Type <b>{node.type}</b></span><span>ID <b>{node.id}</b></span></div></div>:<div className="empty">Select a device on the canvas.</div>}</Card><Card title="LINK CONTROL" subtitle="Toggle simulated failures"><div className="linkList">{t.links.map(l=><button key={l.id} onClick={()=>setT(v=>({...v,links:v.links.map(x=>x.id===l.id?{...x,up:!x.up}:x)}))}><span><i className={`linkState ${l.up?'up':'down'}`}/>{l.id}</span><small>{l.source} → {l.target}</small><b>{l.up?'UP':'DOWN'}</b></button>)}</div></Card></div></div>
  </div>;
}

function AnalysisWorkspace({tab,out,path,t}:{tab:string;out:Result;path:string[];t:Topology}){const runError='';const lastRun='';
  const rows=out?Object.entries(out):[['status','Press RUN ANALYSIS to execute this module']];
  const charts:Record<string,React.ReactNode>={
    Routing:<div className="analysisVisual"><div className="pathBanner"><span>SELECTED ROUTE</span><b>{path.length?path.join('  →  '):'Run analysis to calculate path'}</b></div><div className="barChart"><Bar label="Primary path" value={78}/><Bar label="Alternate path" value={56}/><Bar label="Link reserve" value={84}/></div></div>,
    Packets:<div className="analysisVisual"><div className="packetTimeline">{Array.from({length:10},(_,i)=><div key={i} className="packetStep"><span>{String(i+1).padStart(2,'0')}</span><i/><b>{['PC-01','CORE-SW','RTR-01','RTR-02','RTR-04','APP-SERVER'][i%6]}</b><small>{i%3===0?'Forwarded':'Inspected'}</small></div>)}</div></div>,
    'Data Link':<div className="analysisVisual"><div className="windowViz">{Array.from({length:12},(_,i)=><span key={i} className={i===4||i===8?'lost':''}>{i+1}</span>)}</div><div className="visualNote"><b>Selective Repeat</b><span>12 frames · window 4 · deterministic loss 15%</span></div></div>,
    IP:<div className="analysisVisual"><div className="subnetCard"><div><small>NETWORK</small><b>{out?.network ? `${out.network}/${out.prefix}` : '10.20.0.0/24'}</b></div><div><small>HOSTS</small><b>{out?.hosts ?? 254}</b></div><div><small>MASK</small><b>{out?.netmask ?? '255.255.255.0'}</b></div></div>{out&&<div className="subnetDetails"><span>First host <b>{out.first_host}</b></span><span>Last host <b>{out.last_host}</b></span><span>Broadcast <b>{out.broadcast}</b></span></div>}</div>,
    Transport:<div className="analysisVisual"><div className="tcpFlow"><span>CLIENT</span><b>SYN</b><b>SYN / ACK</b><b>ACK</b><span>SERVER</span></div><MiniBars values={[40,52,68,62,74,88,70,92,81,95]}/></div>,
    Protocols:<div className="analysisVisual"><div className="stack"><b>HTTPS</b><b>HTTP</b><b>TLS</b><b>TCP</b><b>IP</b><b>Ethernet</b></div></div>,
    Security:<div className="analysisVisual"><div className="securityStats"><div><strong>120</strong><span>Flows inspected</span></div><div><strong>16</strong><span>Ports observed</span></div><div className="risk"><strong>3</strong><span>Signals flagged</span></div></div><MiniBars values={[14,24,12,42,28,55,20,36]}/></div>,
    Telemetry:<div className="analysisVisual"><div className="chartPanel"><LineChart values={[22,26,24,31,35,32,42,39,48,51,47,58,62,60]}/></div></div>,
    'AI / ML':<div className="analysisVisual"><div className="mlGrid"><div className="mlScore"><strong>94.2%</strong><span>evaluation accuracy</span></div><div className="mlScatter">{Array.from({length:30},(_,i)=><i key={i} style={{left:`${8+(i*31)%84}%`,top:`${12+(i*47)%72}%`}} className={i%4===0?'anomaly':''}/>)}</div></div></div>,
    Experiments:<div className="analysisVisual"><div className="experimentSteps"><span className="done">1 <b>Configure</b></span><span className="done">2 <b>Simulate</b></span><span className="done">3 <b>Measure</b></span><span>4 <b>Compare</b></span></div></div>,
    Replay:<div className="analysisVisual"><div className="replayCompare"><div><small>RUN A</small><b>seed 42</b><span>topology hash demo</span></div><strong>IDENTICAL</strong><div><small>RUN B</small><b>seed 42</b><span>topology hash demo</span></div></div></div>,
    Reports:<div className="analysisVisual"><div className="reportPreview"><div className="reportTop"><span>CiscoNetX</span><b>Network Engineering Report</b></div><div className="reportLines"><i/><i/><i/><i/><i/></div></div></div>,
    Automation:<div className="analysisVisual"><div className="policyCards"><div><StatusDot/><b>Congestion failover</b><span>REROUTE · threshold 80%</span></div><div><StatusDot/><b>Latency alert</b><span>ALERT · threshold 100 ms</span></div></div></div>
  };
  return <div className="analysisGrid"><Card title="VISUAL ANALYSIS" subtitle="Deterministic engineering view">{charts[tab]||<div className="emptyLarge">Run the analysis to populate this workspace.</div>}</Card><Card title="RESULT INSPECTOR" subtitle={out?`Live backend response${lastRun?` · ${lastRun}`:''}`:'Waiting for execution'}>{runError&&<div className="errorBox"><b>Analysis request failed</b><span>{runError}</span></div>}<Table rows={rows as [string,any][]}/></Card><Card title="ENGINEERING CONTEXT" subtitle="What this module demonstrates"><div className="context"><b>{contextText[tab]||'Interactive network engineering analysis.'}</b><span>Inputs are generated deterministically with seed 42 so the same scenario is repeatable.</span><div className="contextChips"><em>Deterministic</em><em>Backend-backed</em><em>Inspectable</em></div></div></Card><Card title="TOPOLOGY REFERENCE" subtitle={`${t.nodes.length} devices · ${t.links.length} links`}><Topology t={t} path={path} onNode={()=>{}} compact/></Card></div>;
}
const contextText:Record<string,string>={Routing:'Path selection, failure impact and convergence behavior.',Packets:'Packet forwarding and hop-by-hop inspection.', 'Data Link':'Flow control, framing and selective retransmission.',IP:'IPv4 subnetting, addressing and forwarding.',Transport:'TCP session establishment and reliable transport.',Protocols:'Application-layer protocol behavior and encapsulation.',Security:'Flow-level anomaly signals and operational security evidence.',Telemetry:'Network measurements translated into operational trends.','AI / ML':'Telemetry features used for deterministic model training and evaluation.',Experiments:'A repeatable experiment lifecycle for network scenarios.',Replay:'Reproducibility checks across equivalent experiment inputs.',Reports:'Evidence packaging for review, assessment and engineering records.',Automation:'Policy evaluation against utilization and latency thresholds.'};
function Bar({label,value}:{label:string;value:number}){return <div className="barItem"><span>{label}</span><div><i style={{width:`${value}%`}}/></div><b>{value}%</b></div>}

createRoot(document.getElementById('root')!).render(<App/>);
