from __future__ import annotations
import statistics

def summarize(samples):
    if not samples: return {'count':0}
    def vals(k): return [float(x.get(k,0)) for x in samples]
    return {'count':len(samples),'avg_latency_ms':round(statistics.mean(vals('latency_ms')),3),'p95_latency_ms':round(sorted(vals('latency_ms'))[max(0,int(.95*len(samples))-1)],3),'avg_utilization':round(statistics.mean(vals('utilization')),4),'avg_packet_loss':round(statistics.mean(vals('packet_loss')),4),'max_packet_rate':max(vals('packet_rate'))}

def threshold_alerts(samples, latency_ms=100, utilization=.85, packet_loss=.05):
    alerts=[]
    for i,s in enumerate(samples):
        if float(s.get('latency_ms',0))>latency_ms: alerts.append({'index':i,'kind':'HIGH_LATENCY','value':s.get('latency_ms')})
        if float(s.get('utilization',0))>utilization: alerts.append({'index':i,'kind':'CONGESTION','value':s.get('utilization')})
        if float(s.get('packet_loss',0))>packet_loss: alerts.append({'index':i,'kind':'PACKET_LOSS','value':s.get('packet_loss')})
    return alerts
