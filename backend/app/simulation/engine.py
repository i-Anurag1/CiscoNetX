import random, time
from app.simulation.algorithms import dijkstra, routing_table, crc32_bits, checksum16, hamming_encode

DEFAULT_TOPOLOGY={
 'nodes':[{'id':'pc1','name':'PC 1','type':'host','ip':'10.0.1.10'},{'id':'sw1','name':'Switch 1','type':'switch'},{'id':'r1','name':'Router 1','type':'router','ip':'10.0.0.1'},{'id':'r2','name':'Router 2','type':'router','ip':'10.0.0.2'},{'id':'r3','name':'Router 3','type':'router','ip':'10.0.0.3'},{'id':'r4','name':'Router 4','type':'router','ip':'10.0.0.4'},{'id':'server1','name':'Server 1','type':'server','ip':'10.0.2.10'}],
 'links':[{'id':'l1','source':'pc1','target':'sw1','bandwidth_mbps':100,'latency_ms':1,'up':True},{'id':'l2','source':'sw1','target':'r1','bandwidth_mbps':1000,'latency_ms':1,'up':True},{'id':'l3','source':'r1','target':'r2','bandwidth_mbps':100,'latency_ms':5,'up':True},{'id':'l4','source':'r2','target':'r4','bandwidth_mbps':100,'latency_ms':5,'up':True},{'id':'l5','source':'r1','target':'r3','bandwidth_mbps':100,'latency_ms':8,'up':True},{'id':'l6','source':'r3','target':'r4','bandwidth_mbps':100,'latency_ms':8,'up':True},{'id':'l7','source':'r4','target':'server1','bandwidth_mbps':1000,'latency_ms':1,'up':True}]}

class SimulationEngine:
    def __init__(self, seed=42): self.rng=random.Random(seed)
    def run(self, topology, scenario, source='pc1', destination='server1', packets=100):
        if not topology.get('nodes'): topology=DEFAULT_TOPOLOGY
        events=[]; metrics={'packets_generated':packets,'packets_delivered':0,'packets_dropped':0,'retransmissions':0,'avg_latency_ms':0,'throughput_mbps':0,'recovery_time_ms':0}
        path=dijkstra(topology,source,destination)
        events.append(self.ev('ROUTE_SELECTED',{'source':source,'destination':destination,'path':path}))
        if not path: return {'metrics':metrics,'events':events,'final_path':[]}
        active_path=path
        for i in range(min(packets,1000)):
            lost=self.rng.random()<0.02
            if lost:
                metrics['packets_dropped']+=1; metrics['retransmissions']+=1; events.append(self.ev('PACKET_DROPPED',{'packet':i,'reason':'simulated_loss'})); continue
            metrics['packets_delivered']+=1
            events.append(self.ev('PACKET_DELIVERED',{'packet':i,'path':active_path,'protocol':'TCP' if i%2==0 else 'UDP'}))
        if scenario in ('enterprise_failover','router_failure') and len(path)>=4:
            failed='r2' if 'r2' in path else path[len(path)//2]
            for l in topology.get('links',[]):
                if l['source']==failed or l['target']==failed:l['up']=False
            events.append(self.ev('NODE_FAILURE',{'node':failed}))
            new_path=dijkstra(topology,source,destination)
            active_path=new_path
            events.append(self.ev('REROUTE_COMPLETE',{'old_path':path,'new_path':new_path,'failed_node':failed,'recovery_time_ms':42}))
            metrics['recovery_time_ms']=42
        if scenario=='crc':
            data='1011001'; events += [self.ev('CRC_GENERATED',{'data':data,'crc':crc32_bits(data)}),self.ev('CRC_ERROR_CHECK',{'result':'error_detected'})]
        if scenario=='hamming':
            enc=hamming_encode('1011'); events += [self.ev('HAMMING_ENCODED',{'data':'1011','encoded':enc}),self.ev('HAMMING_CORRECTED',{'error_position':3})]
        if scenario=='checksum': events.append(self.ev('CHECKSUM',{'checksum':checksum16('CiscoNetX packet')}))
        if scenario=='tcp_congestion':
            cwnd=[1,2,4,8,16,12,14,16,18]; metrics['throughput_mbps']=sum(cwnd)/len(cwnd); events.append(self.ev('TCP_CONGESTION_WINDOW',{'cwnd':cwnd}))
        if scenario=='ddos':
            events.append(self.ev('SECURITY_ALERT',{'kind':'DDoS','severity':'high','action':'RATE_LIMIT'}))
        metrics['avg_latency_ms']=round(3.0+metrics['packets_dropped']*0.01,2)
        metrics['throughput_mbps']=metrics['throughput_mbps'] or round(metrics['packets_delivered']*8/metrics['avg_latency_ms']/100,2)
        return {'metrics':metrics,'events':events,'final_path':active_path,'routing_table':routing_table(topology,source)}
    def ev(self,kind,data): return {'ts':time.time(),'kind':kind,'data':data}
