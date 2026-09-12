from __future__ import annotations
import shutil,platform

def capability_report():
    tools={x:bool(shutil.which(x)) for x in ('mn','ovs-vsctl','vtysh','tcpdump','ip')}
    try:
        import scapy.all
        scapy=True
    except Exception:
        scapy=False
    tools['scapy']=scapy
    return {'platform':platform.system(),'tools':tools,'linux_networking':platform.system()=='Linux','ready_for_emulation':platform.system()=='Linux' and all(tools.values())}
