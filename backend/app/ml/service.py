from __future__ import annotations
import math, random
from typing import Any
FEATURES=('packet_rate','packet_loss','latency_ms','utilization')
def _features(s): return [float(s.get(k,0)) for k in FEATURES]
def score(features):
 x=_features(features); z=x[0]/1000+x[1]*8+x[2]/100+x[3]*2-2.5; p=1/(1+math.exp(-z))
 return {'model':'CiscoNetX-Telemetry-Baseline','label':'anomaly' if p>=.5 else 'normal','anomaly_probability':round(p,4),'features':dict(zip(FEATURES,x))}
def evaluate(samples):
 tp=fp=tn=fn=0
 for s in samples:
  pred=score(s)['label']=='anomaly'; actual=bool(s.get('anomaly'))
  if pred and actual: tp+=1
  elif pred: fp+=1
  elif actual: fn+=1
  else: tn+=1
 precision=tp/max(1,tp+fp); recall=tp/max(1,tp+fn); f1=2*precision*recall/max(1,precision+recall)
 return {'model':'CiscoNetX-Telemetry-Baseline','confusion_matrix':{'tp':tp,'fp':fp,'tn':tn,'fn':fn},'precision':round(precision,4),'recall':round(recall,4),'f1':round(f1,4),'accuracy':round((tp+tn)/max(1,tp+tn+fp+fn),4),'samples':len(samples)}
def synthetic_dataset(n=200,seed=42):
 r=random.Random(seed); out=[]
 for _ in range(n):
  a=r.random()<.25; out.append({'packet_rate':r.uniform(700,2000) if a else r.uniform(50,700),'packet_loss':r.uniform(.08,.5) if a else r.uniform(0,.05),'latency_ms':r.uniform(80,300) if a else r.uniform(1,50),'utilization':r.uniform(.75,1) if a else r.uniform(.05,.7),'anomaly':a})
 return out
def train(samples,seed=42):
 try:
  from sklearn.linear_model import LogisticRegression
  from sklearn.model_selection import train_test_split
  X=[_features(s) for s in samples]; y=[int(bool(s.get('anomaly'))) for s in samples]
  Xtr,Xte,ytr,yte=train_test_split(X,y,test_size=.25,random_state=seed,stratify=y); model=LogisticRegression(random_state=seed,max_iter=1000).fit(Xtr,ytr); pred=model.predict(Xte)
  tp=sum(a==1 and p==1 for a,p in zip(yte,pred)); tn=sum(a==0 and p==0 for a,p in zip(yte,pred)); fp=sum(a==0 and p==1 for a,p in zip(yte,pred)); fn=sum(a==1 and p==0 for a,p in zip(yte,pred))
  return {'model':'LogisticRegression','features':FEATURES,'train_samples':len(Xtr),'test_samples':len(Xte),'coefficients':model.coef_[0].round(6).tolist(),'intercept':round(float(model.intercept_[0]),6),'metrics':{'precision':round(tp/max(1,tp+fp),4),'recall':round(tp/max(1,tp+fn),4),'f1':round(2*tp/max(1,2*tp+fp+fn),4),'accuracy':round((tp+tn)/max(1,len(yte)),4)}}
 except Exception as exc: return {'model':'baseline-fallback','features':FEATURES,'metrics':evaluate(samples),'reason':str(exc)}

def train_multitask(samples, seed=42):
    """Train reproducible baseline classifiers for anomaly, congestion and failure risk."""
    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import train_test_split
    features=[]; anomaly=[]; congestion=[]; failure=[]
    for s in samples:
        features.append(_features(s)); anomaly.append(int(bool(s.get('anomaly')))); congestion.append(int(bool(s.get('congestion', float(s.get('utilization',0))>.8)))); failure.append(int(bool(s.get('failure', float(s.get('packet_loss',0))>.08 or float(s.get('latency_ms',0))>150))))
    result={'seed':seed,'samples':len(samples),'models':{}}
    for name,y in [('anomaly',anomaly),('congestion',congestion),('failure',failure)]:
        if len(set(y))<2: result['models'][name]={'status':'insufficient_class_variance'}; continue
        Xtr,Xte,ytr,yte=train_test_split(features,y,test_size=.25,random_state=seed,stratify=y)
        m=LogisticRegression(random_state=seed,max_iter=1000).fit(Xtr,ytr); pred=m.predict(Xte)
        tp=sum(a==1 and p==1 for a,p in zip(yte,pred));tn=sum(a==0 and p==0 for a,p in zip(yte,pred));fp=sum(a==0 and p==1 for a,p in zip(yte,pred));fn=sum(a==1 and p==0 for a,p in zip(yte,pred))
        precision=tp/max(1,tp+fp);recall=tp/max(1,tp+fn)
        result['models'][name]={'status':'trained','features':FEATURES,'train_samples':len(Xtr),'test_samples':len(Xte),'coefficients':m.coef_[0].round(6).tolist(),'intercept':round(float(m.intercept_[0]),6),'metrics':{'precision':round(precision,4),'recall':round(recall,4),'f1':round(2*precision*recall/max(1,precision+recall),4),'accuracy':round((tp+tn)/max(1,len(yte)),4)}}
    return result
