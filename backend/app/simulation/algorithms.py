from collections import defaultdict, deque
import heapq

def adjacency(topology, only_up=True):
    g=defaultdict(list)
    for e in topology.get('links',[]):
        if only_up and not e.get('up',True): continue
        w=float(e.get('latency_ms',1))
        g[e['source']].append((e['target'],w,e))
        g[e['target']].append((e['source'],w,e))
    return g

def dijkstra(topology, source, target):
    g=adjacency(topology)
    dist={source:0.0}; prev={}; pq=[(0.0,source)]
    while pq:
        d,u=heapq.heappop(pq)
        if d!=dist.get(u): continue
        if u==target: break
        for v,w,_ in g[u]:
            nd=d+w
            if nd<dist.get(v,float('inf')):
                dist[v]=nd; prev[v]=u; heapq.heappush(pq,(nd,v))
    if target not in dist: return []
    path=[]; cur=target
    while cur!=source:
        path.append(cur); cur=prev[cur]
    path.append(source); return path[::-1]

def routing_table(topology, source):
    nodes=[n['id'] for n in topology.get('nodes',[])]
    return [{'destination':n,'next_hop':(dijkstra(topology,source,n)[1] if len(dijkstra(topology,source,n))>1 else n),'path':dijkstra(topology,source,n)} for n in nodes if n!=source]

def distance_vector(topology):
    g=adjacency(topology); result={}
    for src in g:
        dist={src:0}; q=deque([src])
        while q:
            u=q.popleft()
            for v,w,_ in g[u]:
                nd=dist[u]+w
                if nd<dist.get(v,float('inf')): dist[v]=nd; q.append(v)
        result[src]=dist
    return result

def crc32_bits(data: str):
    poly=0x04C11DB7; reg=0
    for ch in data.encode():
        reg ^= ch<<24
        for _ in range(8): reg=((reg<<1)^poly)&0xffffffff if reg&0x80000000 else (reg<<1)&0xffffffff
    return f'{reg:032b}'

def checksum16(data: str):
    b=data.encode(); total=0
    if len(b)%2:b+=b'\0'
    for i in range(0,len(b),2): total += (b[i]<<8)|b[i+1]; total=(total&0xffff)+(total>>16)
    return f'{(~total)&0xffff:04x}'

def hamming_encode(bits: str):
    bits=''.join(c for c in bits if c in '01'); m=len(bits); r=0
    while 2**r < m+r+1:r+=1
    arr=['0']*(m+r); j=0
    for i in range(1,m+r+1):
        if i&(i-1): arr[i-1]=bits[j]; j+=1
    for p in range(r):
        pos=2**p; x=0
        for i in range(1,m+r+1):
            if i&pos:x^=int(arr[i-1])
        arr[pos-1]=str(x)
    return ''.join(arr)
