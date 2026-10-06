from sklearn.ensemble import IsolationForest
import numpy as np

def train_anomaly(samples):
    X=np.asarray(samples,dtype=float)
    model=IsolationForest(n_estimators=100,random_state=42,contamination='auto').fit(X)
    return model

def predict(model,samples): return model.predict(np.asarray(samples,dtype=float)).tolist()
