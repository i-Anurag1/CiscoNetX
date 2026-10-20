from app.enterprise import switching_forward,arp_resolve,nat_table,vlan_forward,ipv4_header,ipv6_header,tcp_session,convergence,engineer,experiment,security_analyze,explain
from app.simulation.engine import DEFAULT_TOPOLOGY

def test_switch_arp_nat_vlan():
    s=switching_forward({'ports':['1','2','3'],'mac_table':{},'frame':{'source_mac':'aa','destination_mac':'zz','ingress_port':'1'}}); assert s['action']=='FLOOD' and s['mac_table']['aa']=='1'
    assert arp_resolve({'cache':{},'ip':'10.0.0.1'})['request_required']
    assert nat_table({'flows':[{'source_ip':'10.0.0.2','source_port':1234,'destination_ip':'203.0.113.2','destination_port':443}]})['entries'][0]['inside_global'].startswith('203.0.113.10:')
    assert vlan_forward({'source_vlan':10,'destination_vlan':20})['allowed'] is False

def test_headers_tcp():
    assert ipv4_header({'source':'10.0.0.1','destination':'10.0.0.2'})['version']==4
    assert ipv6_header({'source':'2001:db8::1','destination':'2001:db8::2'})['version']==6
    x=tcp_session({'loss':.1,'rounds':10,'seed':42}); assert x['state']=='CLOSED' and x['events'][0]['event']=='SYN'

def test_engineering_security_ai():
    x=convergence({'topology':DEFAULT_TOPOLOGY,'source':'pc1','destination':'server1','failed_nodes':['r2'],'packets':100}); assert x['before_path'] and x['after_path']
    t=engineer({'topology':DEFAULT_TOPOLOGY,'source':'pc1','destination':'server1','packets':100,'rate_mbps':80}); assert t['packets_delivered']<=100
    assert len(experiment({'topology':DEFAULT_TOPOLOGY})['results'])==3
    a=security_analyze({'flows':[{'source_ip':'10.0.0.1','destination_ip':'10.0.2.10','destination_port':p,'source_mac':'aa' if p%2 else 'bb'} for p in range(1,15)]}); assert a['alerts']
    assert explain({'question':'why route','state':{'topology':DEFAULT_TOPOLOGY,'route':['pc1','server1']}})['grounded']


def test_convergence_compares_healthy_baseline_with_failed_link():
    broken={**DEFAULT_TOPOLOGY,'links':[dict(e) for e in DEFAULT_TOPOLOGY['links']]}
    broken['links'][2]['up']=False
    x=convergence({'topology':broken,'baseline_topology':DEFAULT_TOPOLOGY,'source':'pc1','destination':'server1','packets':100})
    assert x['before_path'] != x['after_path']
    assert x['converged'] is True
