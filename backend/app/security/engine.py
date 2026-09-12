from collections import Counter

def _match(p,r):
 for key,pkey in [('source_ip','source_ip'),('destination_ip','destination_ip'),('protocol','protocol'),('source_port','source_port'),('destination_port','destination_port')]:
  rv=r.get(key,'*')
  if rv not in (None,'','*','ANY','any') and str(p.get(pkey))!=str(rv): return False
 return True

def evaluate_acl(packet,rules):
 for r in sorted(rules,key=lambda x:x.get('priority',100)):
  if _match(packet,r): return r.get('action','DENY')
 return 'DENY'

def detect_anomalies(flows):
 alerts=[]; by_src=Counter(f.get('source_ip') for f in flows); pairs={}; macs={}
 for f in flows:
  pairs.setdefault((f.get('source_ip'),f.get('destination_ip')),set()).add(f.get('destination_port'))
  if f.get('source_ip') and f.get('source_mac'): macs.setdefault(f['source_ip'],set()).add(f['source_mac'])
 for src,n in by_src.items():
  if src and n>=20: alerts.append({'kind':'DDOS','severity':'high','source':src,'destination':'*','evidence':f'{n} flows from source','action':'RATE_LIMIT'})
 for (src,dst),ports in pairs.items():
  if src and len(ports)>=10: alerts.append({'kind':'PORT_SCAN','severity':'high','source':src,'destination':dst,'evidence':f'{len(ports)} destination ports probed','action':'BLOCK'})
 for ip,values in macs.items():
  if len(values)>1: alerts.append({'kind':'ARP_SPOOF','severity':'high','source':ip,'destination':'*','evidence':f'{len(values)} MAC addresses observed','action':'BLOCK'})
 return alerts

def detect_port_scan(flows,threshold=10):
 hits=[]; pairs={}
 for f in flows: pairs.setdefault((f.get('source_ip'),f.get('destination_ip')),set()).add(f.get('destination_port'))
 for (src,dst),ports in pairs.items():
  if src and len(ports)>=threshold: hits.append({'kind':'PORT_SCAN','severity':'high','source':src,'destination':dst,'unique_ports':len(ports),'action':'BLOCK'})
 return hits

def detect_ddos(flows,threshold=100):
 c=Counter(f.get('destination_ip') for f in flows); return [{'kind':'DDOS','severity':'high','source':'multiple','destination':dst,'flows':n,'action':'RATE_LIMIT'} for dst,n in c.items() if dst and n>=threshold]
