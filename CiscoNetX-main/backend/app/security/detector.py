from collections import Counter

def detect_port_scan(flows):
    ports=Counter((f.get('source_ip'),f.get('destination_ip')) for f in flows)
    hits=[]
    for pair,count in ports.items():
        unique=len({f.get('destination_port') for f in flows if (f.get('source_ip'),f.get('destination_ip'))==pair})
        if unique>=10: hits.append({'kind':'PORT_SCAN','severity':'high','source':pair[0],'destination':pair[1],'evidence':f'{unique} destination ports probed','action':'BLOCK'})
    return hits

def detect_ddos(flows, threshold=100):
    c=Counter(f.get('destination_ip') for f in flows)
    return [{'kind':'DDOS','severity':'high','source':'multiple','destination':dst,'evidence':f'{n} flows to destination','action':'RATE_LIMIT'} for dst,n in c.items() if n>=threshold]

def firewall_decide(packet,rules):
    for r in sorted(rules,key=lambda x:x.get('priority',0),reverse=True):
        match=(r.get('source_ip','*') in ('*',packet.get('source_ip')) and r.get('destination_ip','*') in ('*',packet.get('destination_ip')) and r.get('protocol','*') in ('*',packet.get('protocol')) and (r.get('destination_port') is None or r.get('destination_port')==packet.get('destination_port')))
        if match:return r['action']
    return 'ALLOW'
