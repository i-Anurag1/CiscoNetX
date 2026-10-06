from __future__ import annotations
import random
from dataclasses import dataclass

@dataclass
class Frame:
    seq: int
    payload: str
    checksum: str = ''
    corrupted: bool = False


def stop_and_wait(frames: int = 8, loss: float = .1, seed: int = 42):
    rng=random.Random(seed); events=[]; delivered=[]; attempts=0
    for seq in range(frames):
        while seq not in delivered and attempts < frames*20:
            attempts+=1; events.append({'type':'SEND','seq':seq})
            if rng.random()<loss: events.append({'type':'TIMEOUT','seq':seq}); continue
            events.append({'type':'ACK','seq':seq}); delivered.append(seq)
    return {'protocol':'Stop-and-Wait','frames':frames,'delivered':delivered,'attempts':attempts,'events':events,'complete':len(delivered)==frames}


def sliding_window(frames: int=12, window: int=4, loss: float=.1, selective: bool=False, seed: int=42):
    rng=random.Random(seed); events=[]; acked=set(); base=0; attempts=0
    while base<frames and attempts<frames*20:
        batch=list(range(base,min(frames,base+window)))
        for seq in batch:
            if seq in acked: continue
            attempts+=1; events.append({'type':'SEND','seq':seq,'window':[base,min(frames-1,base+window-1)]})
            if rng.random()<loss:
                events.append({'type':'LOSS','seq':seq})
                if not selective:
                    for later in batch:
                        if later>seq and later not in acked: events.append({'type':'RETRANSMIT','seq':later})
                continue
            acked.add(seq); events.append({'type':'ACK','seq':seq})
        while base in acked: base+=1
    return {'protocol':'Selective Repeat' if selective else 'Go-Back-N','frames':frames,'window':window,'delivered':sorted(acked),'attempts':attempts,'events':events,'complete':len(acked)==frames}


def aloha(protocol='aloha', nodes=10, slots=200, load=.3, seed=42):
    rng=random.Random(seed); success=collision=idle=0
    for slot in range(slots):
        active=sum(rng.random()<load for _ in range(nodes))
        if active==0: idle+=1
        elif active==1: success+=1
        else: collision+=1
    return {'protocol':protocol,'nodes':nodes,'slots':slots,'success':success,'collisions':collision,'idle':idle,'throughput':success/slots,'collision_rate':collision/slots}


def csma(protocol='csma_cd', nodes=10, slots=200, load=.3, seed=42):
    rng=random.Random(seed); success=collision=idle=backoff=0
    for _ in range(slots):
        active=sum(rng.random()<load for _ in range(nodes))
        if active==0: idle+=1
        elif active==1: success+=1
        else:
            collision+=1; backoff+=min(10,active)
    return {'protocol':protocol,'nodes':nodes,'slots':slots,'success':success,'collisions':collision,'idle':idle,'backoff_events':backoff,'throughput':success/slots}
