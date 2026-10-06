from __future__ import annotations
import shutil, subprocess, platform

def command_exists(name): return shutil.which(name) is not None

def dry_run_plan(topology):
    nodes=topology.get('nodes',[]); links=topology.get('links',[])
    commands=[]
    for n in nodes:
        if n.get('type') in ('router','switch','host','server'):
            commands.append({'device':n['id'],'action':'create_namespace','status':'planned'})
    for l in links: commands.append({'link':l['id'],'action':'create_veth','source':l['source'],'target':l['target'],'status':'planned'})
    return {'mode':'dry-run','safe':True,'commands':commands}

def run_checked(command, timeout=10):
    if not command or not command_exists(command[0]): return {'ok':False,'error':f'{command[0]} unavailable'}
    try:
        p=subprocess.run(command,capture_output=True,text=True,timeout=timeout,check=False)
        return {'ok':p.returncode==0,'returncode':p.returncode,'stdout':p.stdout[-4000:],'stderr':p.stderr[-4000:]}
    except Exception as e: return {'ok':False,'error':str(e)}

def adapter_status():
    return {'platform':platform.system(),'adapters':{x:command_exists(x) for x in ('mn','ovs-vsctl','vtysh','tcpdump','ip')},'scapy':command_exists('python')}
