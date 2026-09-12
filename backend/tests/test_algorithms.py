from app.simulation.algorithms import dijkstra, crc32_bits, checksum16, hamming_encode
from app.simulation.engine import DEFAULT_TOPOLOGY

def test_dijkstra(): assert dijkstra(DEFAULT_TOPOLOGY,'pc1','server1') == ['pc1','sw1','r1','r2','r4','server1']
def test_crc(): assert len(crc32_bits('1011'))==32
def test_checksum(): assert len(checksum16('abc'))==4
def test_hamming(): assert hamming_encode('1011') == '0110011'
