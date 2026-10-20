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


def test_arq_retransmits_lost_frames_and_completes():
    for protocol in ("stop_and_wait", "go_back_n", "selective_repeat"):
        result = arq(protocol, 8, 3, [2, 5], 42)
        assert result["complete"] is True
        assert result["delivered"] == list(range(8))
        assert any(e["action"] == "LOSS" and e["seq"] == 2 for e in result["events"])
        assert any(e["action"] == "RETRANSMIT" and e["seq"] == 2 for e in result["events"])


def test_arq_rejects_invalid_arguments():
    import pytest
    with pytest.raises(ValueError):
        arq("unknown", 8, 3, [])
    with pytest.raises(ValueError):
        arq("go_back_n", 8, 0, [])


def test_arq_empty_losses_means_no_loss():
    from app.simulation.advanced import arq

    for protocol in ("stop_and_wait", "go_back_n", "selective_repeat"):
        result = arq(protocol, frames=8, window=3, losses=[])
        assert result["complete"] is True
        assert not any(event["action"] == "LOSS" for event in result["events"])
