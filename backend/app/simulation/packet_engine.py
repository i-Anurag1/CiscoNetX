from __future__ import annotations
import uuid,time,ipaddress
from dataclasses import dataclass,asdict

@dataclass
class Packet:
    id:str
    source_ip:str
    destination_ip:str
    protocol:str
    ttl:int=64
    payload_bytes:int=64
    source_mac:str='00:00:00:00:00:01'
    destination_mac:str='ff:ff:ff:ff:ff:ff'
    sequence:int=0

class PacketEngine:
    def create(self, source_ip, destination_ip, protocol='TCP', payload_bytes=64, sequence=0):
        ipaddress.ip_address(source_ip); ipaddress.ip_address(destination_ip)
        return Packet(str(uuid.uuid4()),source_ip,destination_ip,protocol.upper(),64,payload_bytes,sequence=sequence)
    def encapsulate(self, packet:Packet):
        return {'ethernet':{'src':packet.source_mac,'dst':packet.destination_mac,'ethertype':'IPv6' if ipaddress.ip_address(packet.source_ip).version==6 else 'IPv4'},'network':asdict(packet)}
    def forward(self, packet:Packet, hops:int=1):
        packet.ttl-=hops
        return {'delivered':packet.ttl>0,'ttl':packet.ttl,'packet':asdict(packet)}
