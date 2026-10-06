from dataclasses import dataclass,asdict
from typing import Any
from .algorithms import dijkstra
@dataclass
class FlowRule:
 priority:int; match:dict[str,Any]; actions:list[str]; packets:int=0; bytes:int=0
class SDNController:
 def __init__(self,topology): self.topology=topology; self.flows=[]; self.events=[]
 def compute_path(self,source,destination):
  path=dijkstra(self.topology,source,destination); self.events.append({'event':'PATH_COMPUTED','source':source,'destination':destination,'path':path}); return path
 def install(self,match,actions,priority=100):
  f=FlowRule(priority,match,actions); self.flows.append(f); self.events.append({'event':'FLOW_INSTALLED','rule':asdict(f)}); return asdict(f)
 def snapshot(self): return {'flows':[asdict(x) for x in self.flows],'events':self.events}

def traffic_simulation(topology,source,destination,packets=100,seed=42,rate_mbps=10):
 import random
 rng=random.Random(seed); path=dijkstra(topology,source,destination); events=[]; delivered=dropped=0; total_latency=0.0
 links={(l['source'],l['target']):l for l in topology.get('links',[])}
 links.update({(l['target'],l['source']):l for l in topology.get('links',[])})
 for i in range(packets):
  if not path: dropped+=1; events.append({'event':'DROP','packet':i,'reason':'NO_ROUTE'}); continue
  latency=0.0; loss=False; hops=[]
  for a,b in zip(path,path[1:]):
   l=links.get((a,b))
   if not l or not l.get('up',True): loss=True; events.append({'event':'DROP','packet':i,'node':a,'reason':'LINK_DOWN'}); break
   latency+=float(l.get('latency_ms',1)); hops.append({'from':a,'to':b,'latency_ms':float(l.get('latency_ms',1))})
   if rng.random()<float(l.get('loss_rate',0)): loss=True
  packet={'id':f'pkt-{i+1:06d}','source':source,'destination':destination,'protocol':'TCP' if i%2==0 else 'UDP','ttl':64,'hops':hops,'latency_ms':round(latency,3)}
  if loss: dropped+=1; events.append({'event':'DROP','packet':packet,'reason':'LOSS_RATE'})
  else: delivered+=1; total_latency+=latency; events.append({'event':'DELIVERED','packet':packet})
 avg=total_latency/max(1,delivered); duration=max(.001,avg/1000*max(1,delivered))
 return {'path':path,'events':events,'metrics':{'generated':packets,'delivered':delivered,'dropped':dropped,'loss_rate':round(dropped/max(1,packets),4),'avg_latency_ms':round(avg,3),'throughput_mbps':round(delivered*1500*8/1e6/duration,3),'offered_rate_mbps':rate_mbps}}
