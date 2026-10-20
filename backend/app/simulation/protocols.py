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

def sliding_window(frames=8, window=4, loss=None, selective=False):
    if not 1 <= frames <= 10000 or not 1 <= window <= frames:
        raise ValueError("frames must be 1..10000 and window must be 1..frames")

    lost_frames = set(loss or [])
    if any(not isinstance(seq, int) or seq < 0 or seq >= frames for seq in lost_frames):
        raise ValueError("Loss indices must refer to valid frame sequence numbers")

    events = []
    delivered = set()
    failed_once = set()
    base = 0

    def send(seq, retransmission=False):
        if retransmission:
            action = "RETRANSMIT"
        else:
            action = "SEND"
        if seq in lost_frames and seq not in failed_once:
            failed_once.add(seq)
            events.append({"seq": seq, "action": "LOSS", "status": "timeout"})
            return False
        events.append({"seq": seq, "action": action, "status": "ACK"})
        return True

    while base < frames:
        end = min(frames, base + window)
        if selective:
            for seq in range(base, end):
                if seq not in delivered and send(seq):
                    delivered.add(seq)
            for seq in range(base, end):
                if seq not in delivered and send(seq, True):
                    delivered.add(seq)
        else:
            batch = list(range(base, end))
            first_missing = None
            for seq in batch:
                if not send(seq):
                    first_missing = seq
                    break
                delivered.add(seq)
            if first_missing is not None:
                for seq in batch[batch.index(first_missing) + 1:]:
                    events.append({"seq": seq, "action": "DISCARD", "status": "out_of_order"})
                for seq in range(first_missing, end):
                    if send(seq, True):
                        delivered.add(seq)
        while base in delivered:
            base += 1

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
