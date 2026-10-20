from __future__ import annotations
import ipaddress, math, random
from collections import defaultdict
from typing import Any
from .algorithms import adjacency, dijkstra


def ospf(topology: dict, source: str) -> dict:
    g=adjacency(topology)
    table={}
    for dst in [n['id'] for n in topology.get('nodes',[]) if n['id']!=source]:
        path=dijkstra(topology,source,dst)
        table[dst]={"path":path,"cost":round(sum(_edge_cost(topology,a,b) for a,b in zip(path,path[1:])),3) if path else math.inf,
                    "next_hop":path[1] if len(path)>1 else None}
    neighbors=sorted(v for v,_,_ in g[source])
    return {"protocol":"OSPF","source":source,"neighbors":neighbors,"routes":table,"areas":[{"area":"0.0.0.0","role":"backbone"}],"state":"FULL"}


def rip(topology: dict, source: str, max_hops: int=15) -> dict:
    g=adjacency(topology); routes={source:{"metric":0,"next_hop":source,"path":[source]}}
    changed=True; rounds=0
    while changed and rounds<max(1,len(g)):
        changed=False; rounds+=1
        for u in list(routes):
            for v,_,_ in g[u]:
                cand=routes[u]["metric"]+1
                if cand<=max_hops and (v not in routes or cand<routes[v]["metric"]):
                    routes[v]={"metric":cand,"next_hop":v if u==source else routes[u]["next_hop"],"path":routes[u]["path"]+[v]}
                    changed=True
    return {"protocol":"RIP","source":source,"rounds":rounds,"routes":routes}


def _edge_cost(t,a,b):
    for e in t.get('links',[]):
        if {e.get('source'),e.get('target')}=={a,b}: return float(e.get('latency_ms',1))
    return 1.0


def tcp_state_machine(loss: float=.1, rounds: int=24, seed: int=42) -> dict:
    rng=random.Random(seed); states=[]; cwnd=1.0; ssthresh=8.0; retrans=0; state="CLOSED"
    for name in ["SYN","SYN-ACK","ACK"]: states.append({"event":name,"state":"ESTABLISHED" if name=="ACK" else "SYN_SENT"})
    state="ESTABLISHED"
    for r in range(1,rounds+1):
        timeout=rng.random()<loss*0.22
        dupacks=3 if (not timeout and rng.random()<loss*0.35) else 0
        phase="slow_start" if cwnd<ssthresh else "congestion_avoidance"
        states.append({"round":r,"state":state,"cwnd":round(cwnd,3),"ssthresh":round(ssthresh,3),"phase":phase,"timeout":timeout,"duplicate_acks":dupacks})
        if timeout:
            retrans+=1; ssthresh=max(2.0,cwnd/2); cwnd=1.0
        elif dupacks==3:
            retrans+=1; ssthresh=max(2.0,cwnd/2); cwnd=ssthresh
        elif cwnd<ssthresh: cwnd=min(cwnd*2, 10000)
        else: cwnd+=1/cwnd if cwnd else 1
    states.append({"event":"FIN","state":"FIN_WAIT"}); states.append({"event":"ACK","state":"CLOSED"})
    return {"protocol":"TCP","events":states,"retransmissions":retrans,"final_cwnd":round(cwnd,3)}


def arq(protocol: str, frames: int = 12, window: int = 4, losses: list[int] | None = None, seed: int = 42):
    if protocol not in ("stop_and_wait", "go_back_n", "selective_repeat"):
        raise ValueError("Unsupported ARQ protocol")
    if not 1 <= frames <= 10000 or not 1 <= window <= frames:
        raise ValueError("frames must be 1..10000 and window must be 1..frames")

    lost_frames = set([3] if losses is None else losses)
    if any(not isinstance(seq, int) or seq < 0 or seq >= frames for seq in lost_frames):
        raise ValueError("Loss indices must refer to valid frame sequence numbers")

    events = []
    delivered = set()
    failed_once = set()
    base = 0

    def transmit(seq, retransmission=False):
        action = "RETRANSMIT" if retransmission else "SEND"
        events.append({"action": action, "seq": seq})
        if seq in lost_frames and seq not in failed_once:
            failed_once.add(seq)
            events.append({"action": "LOSS", "seq": seq})
            return False
        events.append({"action": "ACK", "seq": seq})
        return True

    while base < frames:
        if protocol == "stop_and_wait":
            if not transmit(base):
                transmit(base, True)
            delivered.add(base)
            base += 1
            continue

        end = min(frames, base + window)
        if protocol == "selective_repeat":
            for seq in range(base, end):
                if seq not in delivered and transmit(seq):
                    delivered.add(seq)
            for seq in range(base, end):
                if seq not in delivered:
                    if transmit(seq, True):
                        delivered.add(seq)
        else:
            batch = list(range(base, end))
            first_missing = None
            for seq in batch:
                if not transmit(seq):
                    first_missing = seq
                    break
                delivered.add(seq)
            if first_missing is not None:
                for seq in batch[batch.index(first_missing) + 1:]:
                    events.append({"action": "DISCARD", "seq": seq})
                for seq in range(first_missing, end):
                    if transmit(seq, True):
                        delivered.add(seq)

        while base in delivered:
            base += 1

    return {
        "protocol": protocol,
        "frames": frames,
        "window": window,
        "events": events,
        "delivered": sorted(delivered),
        "complete": len(delivered) == frames,
    }

def medium_access(protocol:str, nodes:int=10, slots:int=200, offered_load:float=.3, seed:int=42):
    rng=random.Random(seed); success=collision=idle=0; attempts=0
    for slot in range(slots):
        if protocol in ('aloha','slotted_aloha'): active=sum(rng.random()<offered_load for _ in range(nodes))
        else: active=sum(rng.random()<min(.95,offered_load) for _ in range(nodes))
        attempts+=active
        if active==0: idle+=1
        elif active==1: success+=1
        else: collision+=1
    return {"protocol":protocol,"slots":slots,"attempts":attempts,"success":success,"collisions":collision,"idle":idle,"throughput":round(success/slots,4),"collision_rate":round(collision/max(1,slots),4)}


def nat_translate(source_ip:str, source_port:int, public_ip:str, public_port:int|None=None):
    ipaddress.ip_address(source_ip); ipaddress.ip_address(public_ip)
    return {"inside_local":f"{source_ip}:{source_port}","inside_global":f"{public_ip}:{public_port or source_port}","protocol":"PAT","state":"ACTIVE"}


def packet_trace(topology:dict, source:str, destination:str, count:int=20, seed:int=42):
    path=dijkstra(topology,source,destination); rng=random.Random(seed); packets=[]; dropped=0; latency=0
    for i in range(count):
        loss=rng.random()<0.03
        hops=max(0,len(path)-1); l=sum(_edge_cost(topology,a,b) for a,b in zip(path,path[1:]))
        if loss: dropped+=1
        else: latency+=l; packets.append({"id":f"pkt-{i+1:04d}","source":source,"destination":destination,"protocol":"TCP" if i%2==0 else "UDP","path":path,"status":"DROPPED" if loss else "DELIVERED","hops":hops,"latency_ms":round(l,2)})
    return {"path":path,"packets":packets,"metrics":{"generated":count,"delivered":count-dropped,"dropped":dropped,"loss_rate":round(dropped/max(1,count),4),"avg_latency_ms":round(latency/max(1,count-dropped),2)}}


def topology_stats(topology:dict):
    links=topology.get('links',[]); nodes=topology.get('nodes',[])
    return {"nodes":len(nodes),"links":len(links),"up_links":sum(bool(e.get('up',True)) for e in links),"down_links":sum(not bool(e.get('up',True)) for e in links),"devices_by_type":{t:sum(n.get('type')==t for n in nodes) for t in sorted({n.get('type','unknown') for n in nodes})}}
