from fastapi.testclient import TestClient
from app.main import app
from app.simulation.link_layer import stop_and_wait, sliding_window, aloha, csma
from app.simulation.packet_engine import PacketEngine

client=TestClient(app)

def test_all_link_labs_complete():
    assert stop_and_wait(5,.0)['complete']
    assert sliding_window(8,3,.0,False)['complete']
    assert sliding_window(8,3,.0,True)['complete']
    assert aloha('slotted_aloha',5,50,.2)['success']>=0
    assert csma('csma_ca',5,50,.2)['success']>=0

def test_packet_engine_headers_and_ttl():
    e=PacketEngine(); p=e.create('10.0.0.1','10.0.0.2','TCP',128,4); h=e.encapsulate(p)
    assert h['network']['protocol']=='TCP' and h['ethernet']['ethertype']=='IPv4'
    assert e.forward(p,63)['delivered']
    assert not e.forward(p,1)['delivered']

def test_new_api_surface():
    assert client.get('/api/v1/architecture/manifest').status_code==200
    assert client.post('/api/v1/lab/ethernet',json={'frame_bytes':1500,'link_mbps':100}).status_code==200
    assert client.post('/api/v1/lab/wifi',json={'nodes':10}).status_code==200
    assert client.post('/api/v1/lab/rfid',json={'tags':4}).status_code==200
    assert client.post('/api/v1/network/encapsulation',json={}).status_code==200
    assert client.post('/api/v1/telemetry/summary',json=[{'latency_ms':10,'utilization':.2,'packet_loss':.01,'packet_rate':100}]).status_code==200

def test_network_layer_apis():
    r=client.post('/api/v1/ipv4/header',json={'source':'10.0.0.1','destination':'10.0.0.2','payload_bytes':100}).json(); assert r['version']==4 and r['total_length']==120
    assert client.post('/api/v1/arp/resolve',json={'target_ip':'10.0.0.2','cache':{'10.0.0.2':'aa:bb:cc:dd:ee:ff'}}).json()['resolved']
    assert client.post('/api/v1/nat/pat-table',json={'connections':[{'source_ip':'10.0.0.2','source_port':1234,'destination_ip':'1.1.1.1'}]}).json()['mappings']
    assert client.post('/api/v1/vlan/frame-decision',json={'source_vlan':10,'destination_vlan':20,'trunk':False}).json()['forwarded'] is False

def test_physical_and_encapsulation():
    assert client.post('/api/v1/lab/physical-channel',json={'data_rate_mbps':100,'distance_km':1}).json()['estimated_effective_rate_mbps']>0
    assert client.post('/api/v1/lab/ethernet',json={'frame_bytes':1500,'link_mbps':100}).json()['standard']=='IEEE 802.3'
    assert client.post('/api/v1/lab/wifi',json={'nodes':5}).json()['mechanism']=='CSMA/CA with random backoff'
    assert client.post('/api/v1/lab/rfid',json={'tags':5}).json()['technology']=='RFID'

def test_config_telemetry_and_multitask_ml():
    assert client.post('/api/v1/devices/config/validate',json={'hostname':'r1','interfaces':{}}).json()['valid']
    assert client.post('/api/v1/telemetry/alerts',json=[{'latency_ms':200,'utilization':.9,'packet_loss':.1}]).json()['alerts']
    samples=[]
    for i in range(80):
        bad=i%2==0; samples.append({'packet_rate':1500 if bad else 200,'packet_loss':.2 if bad else .01,'latency_ms':200 if bad else 20,'utilization':.9 if bad else .3,'anomaly':bad,'congestion':bad,'failure':bad})
    r=client.post('/api/v1/ml/train-multitask?seed=42',json=samples); assert r.status_code==200 and 'models' in r.json()
