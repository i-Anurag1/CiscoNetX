from app.simulation.engine import DEFAULT_TOPOLOGY
from app.simulation.flow import SDNController,traffic_simulation
from app.ml.service import synthetic_dataset,train
from app.security.engine import detect_port_scan,detect_ddos,evaluate_acl

def test_sdn_flow_install():
 c=SDNController(DEFAULT_TOPOLOGY); assert c.compute_path('pc1','server1'); r=c.install({'protocol':'TCP'},['FORWARD'],10); assert r['priority']==10

def test_traffic_deterministic():
 a=traffic_simulation(DEFAULT_TOPOLOGY,'pc1','server1',50,7); b=traffic_simulation(DEFAULT_TOPOLOGY,'pc1','server1',50,7); assert a['metrics']==b['metrics']

def test_security_detectors():
 flows=[{'source_ip':'10.0.0.9','destination_ip':'10.0.2.10','destination_port':p} for p in range(1,13)]
 assert detect_port_scan(flows,10)[0]['kind']=='PORT_SCAN'
 dd=[{'source_ip':f'10.0.0.{i%4}','destination_ip':'10.0.2.10','destination_port':443} for i in range(120)]
 assert detect_ddos(dd,100)[0]['kind']=='DDOS'
 assert evaluate_acl({'source_ip':'10.0.0.9','destination_ip':'10.0.2.10','protocol':'TCP','destination_port':22},[{'source_ip':'10.0.0.9','destination_port':22,'action':'DENY','priority':1}])=='DENY'

def test_ml_training():
 r=train(synthetic_dataset(120,42)); assert 'metrics' in r and 'accuracy' in r['metrics']
