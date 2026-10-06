from dataclasses import dataclass
from typing import Any
import math

def hamming_decode(bits:str):
    bits=''.join(c for c in bits if c in '01'); a=[0]+[int(x) for x in bits]; n=len(bits); r=0
    while 2**r < n+1:r+=1
    err=0
    for p in range(r):
        pos=2**p; parity=0
        for i in range(1,n+1):
            if i&pos: parity ^= a[i]
        if parity: err += pos
    corrected=a[:]
    if 0<err<=n: corrected[err]^=1
    data=''.join(str(corrected[i]) for i in range(1,n+1) if i&(i-1))
    return {'input':bits,'error_position':err,'corrected':''.join(map(str,corrected[1:])),'data':data}

def sliding_window(frames=8,window=4,loss=None,selective=False):
    loss = set(loss or [])
    events=[]; acked=set(); i=0
    while len(acked)<frames:
        start=min(acked|{i}) if acked else i
        end=min(frames,start+window)
        for seq in range(start,end):
            if seq in acked: continue
            if seq in loss and not any(e.get('seq')==seq and e['action']=='RETRANSMIT' for e in events):
                events.append({'seq':seq,'action':'LOSS','status':'timeout'})
                if selective: continue
                for x in range(seq,end):
                    events.append({'seq':x,'action':'RETRANSMIT','status':'sent'})
                    acked.add(x)
                continue
            events.append({'seq':seq,'action':'SEND','status':'ACK'}); acked.add(seq)
        i=min(frames,max(acked)+1 if acked else i+1)
        if i>=frames and len(acked)<frames:
            i=min(acked or {0})
    return events

def aloha(nodes=10,slots=100,offered_load=0.3,slotted=True):
    success=0; collisions=0
    for s in range(slots):
        active=max(0,min(nodes,round(nodes*offered_load/2))) if slotted else max(0,min(nodes,round(nodes*offered_load)))
        if active==1: success+=1
        elif active>1: collisions+=1
    return {'slots':slots,'successful_slots':success,'collisions':collisions,'throughput':round(success/slots,4),'utilization':round(success/max(1,success+collisions),4)}

def tcp_model(loss=.1,rounds=20,mss=1460):
    cwnd=1.0; ssthresh=8.0; rows=[]; retrans=0
    for r in range(1,rounds+1):
        state='slow_start' if cwnd<ssthresh else 'congestion_avoidance'
        rows.append({'round':r,'cwnd':round(cwnd,3),'ssthresh':ssthresh,'state':state})
        hit=(r in {6,14} and loss>0)
        if hit: ssthresh=max(2,cwnd/2); cwnd=1; retrans+=1
        elif cwnd<ssthresh: cwnd*=2
        else: cwnd+=1
    return {'handshake':['SYN','SYN-ACK','ACK'],'rows':rows,'retransmissions':retrans,'mss':mss}
