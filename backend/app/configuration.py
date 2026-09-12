from __future__ import annotations
from copy import deepcopy

DEFAULT_DEVICE_CONFIG={'hostname':'device','interfaces':{},'vlans':{},'static_routes':[],'acl':[],'firewall':[],'routing':{'protocol':'static'}}

def validate_device_config(cfg):
    errors=[]
    if not str(cfg.get('hostname','')).strip(): errors.append('hostname required')
    for name,iface in cfg.get('interfaces',{}).items():
        if not isinstance(iface,dict): errors.append(f'{name}: interface must be object')
    for route in cfg.get('static_routes',[]):
        if not all(k in route for k in ('network','next_hop')): errors.append('route requires network and next_hop')
    return {'valid':not errors,'errors':errors}

def diff_config(old,new):
    changes=[]
    keys=sorted(set(old)|set(new))
    for k in keys:
        if old.get(k)!=new.get(k): changes.append({'field':k,'before':old.get(k),'after':new.get(k)})
    return changes
