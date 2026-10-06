from app.ml.service import synthetic_dataset,train
from app.security.engine import detect_anomalies

def test_ml_real_training_pipeline():
 r=train(synthetic_dataset(160,9),9); assert r['metrics']['accuracy'] >= .5

def test_arp_spoof_detection():
 flows=[{'source_ip':'10.0.0.7','destination_ip':'10.0.0.1','source_mac':m,'destination_port':1} for m in ('aa','bb')]
 assert any(x['kind']=='ARP_SPOOF' for x in detect_anomalies(flows))
