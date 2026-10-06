from app.simulation.advanced import ospf,rip,tcp_state_machine,arq,medium_access,nat_translate,packet_trace
from app.simulation.engine import DEFAULT_TOPOLOGY

def test_ospf_and_rip():
    o=ospf(DEFAULT_TOPOLOGY,'pc1'); r=rip(DEFAULT_TOPOLOGY,'pc1')
    assert o['routes']['server1']['path']
    assert r['routes']['server1']['metric'] >= 1

def test_tcp_state_machine():
    x=tcp_state_machine(.1,12,42)
    assert x['events'][0]['event']=='SYN' and x['events'][-1]['state']=='CLOSED'

def test_arq_completes():
    for p in ('stop_and_wait','go_back_n','selective_repeat'):
        assert arq(p,8,3,[2],42)['complete']

def test_mac_access_and_nat():
    x=medium_access('csma_cd',8,50,.2,42)
    assert 0 <= x['throughput'] <= 1
    assert nat_translate('10.0.0.2',1234,'203.0.113.10')['protocol']=='PAT'

def test_packet_trace():
    x=packet_trace(DEFAULT_TOPOLOGY,'pc1','server1',20,42)
    assert x['path'][0]=='pc1' and x['path'][-1]=='server1'
