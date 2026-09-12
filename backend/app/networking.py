import ipaddress

def validate_topology(t):
    ids={n['id'] for n in t.get('nodes',[])}; errors=[]
    if len(ids)!=len(t.get('nodes',[])): errors.append('Duplicate node id')
    for l in t.get('links',[]):
        if l.get('source') not in ids or l.get('target') not in ids: errors.append(f"Invalid link {l.get('id')}")
        if float(l.get('bandwidth_mbps',1))<=0: errors.append(f"Invalid bandwidth on {l.get('id')}")
    return {'valid':not errors,'errors':errors}

def subnet(network,prefix):
    n=ipaddress.ip_network(f'{network}/{prefix}',strict=False); hosts=list(n.hosts()) if n.num_addresses<100000 else []
    return {'network':str(n.network_address),'broadcast':str(n.broadcast_address),'prefix':n.prefixlen,'netmask':str(n.netmask),'wildcard':str(n.hostmask),'first_host':str(hosts[0]) if hosts else None,'last_host':str(hosts[-1]) if hosts else None,'hosts':max(0,n.num_addresses-2) if n.version==4 and n.prefixlen<31 else n.num_addresses,'version':n.version}
