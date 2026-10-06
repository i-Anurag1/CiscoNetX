import base64, hashlib, hmac, json, os, time

def hash_password(password:str, salt:bytes|None=None):
    salt=salt or os.urandom(16); digest=hashlib.pbkdf2_hmac('sha256',password.encode(),salt,210_000); return salt.hex()+':'+digest.hex()

def verify_password(password:str, encoded:str):
    try:
        salt_hex,digest_hex=encoded.split(':',1); digest=hashlib.pbkdf2_hmac('sha256',password.encode(),bytes.fromhex(salt_hex),210_000); return hmac.compare_digest(digest.hex(),digest_hex)
    except ValueError: return False

def issue_token(user_id:int, role:str, secret:str):
    payload=base64.urlsafe_b64encode(json.dumps({'sub':user_id,'role':role,'exp':int(time.time())+86400},separators=(',',':')).encode()).decode().rstrip('='); sig=hmac.new(secret.encode(),payload.encode(),hashlib.sha256).hexdigest(); return payload+'.'+sig

def verify_token(token:str,secret:str):
    try:
        payload,sig=token.split('.',1); expected=hmac.new(secret.encode(),payload.encode(),hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig,expected): return None
        raw=base64.urlsafe_b64decode(payload+'='*((4-len(payload)%4)%4)); data=json.loads(raw)
        return data if data['exp']>=time.time() else None
    except Exception: return None
