#!/usr/bin/env python3
"""Read-only audit of public Roblox emote payloads, never an in-game execution test."""
import argparse,concurrent.futures,datetime,gzip,hashlib,io,json,re,struct,time,urllib.request,urllib.error
from pathlib import Path

def get(url,binary=False):
    for attempt in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'EmoteClubCatalogAudit/1.0'}),timeout=20) as r:
                body=r.read(5*1024*1024+1)
                if body.startswith(b'\x1f\x8b'):body=gzip.GzipFile(fileobj=io.BytesIO(body)).read(5*1024*1024+1)
                if len(body)>5*1024*1024:return {'status':r.status,'error':'Payload exceeds 5 MiB audit limit'}
                return {'status':r.status,'body':body if binary else json.loads(body)}
        except urllib.error.HTTPError as e:
            if e.code in (429,500,502,503,504) and attempt<4:
                delay=min(2**attempt,8)
                try:delay=max(delay,min(float(e.headers.get('Retry-After',delay)),30))
                except ValueError:pass
                time.sleep(delay);continue
            return {'status':e.code,'error':e.read(200).decode('utf8','replace')}
        except Exception as e:
            if attempt<2:time.sleep(1);continue
            return {'status':None,'error':str(e)}

def lz4(data):
    out=bytearray();i=0
    while i<len(data):
        token=data[i];i+=1;n=token>>4
        if n==15:
            while True:
                x=data[i];i+=1;n+=x
                if x!=255:break
        out.extend(data[i:i+n]);i+=n
        if i>=len(data):break
        offset=int.from_bytes(data[i:i+2],'little');i+=2
        if not offset or offset>len(out):raise ValueError('Invalid LZ4 offset')
        n=(token&15)+4
        if (token&15)==15:
            while True:
                x=data[i];i+=1;n+=x
                if x!=255:break
        for _ in range(n):out.append(out[-offset])
    return bytes(out)

def chunks(body):
    if body.startswith(b'<roblox!'):
        pos=32
        while pos+16<=len(body):
            name=body[pos:pos+4];clen,ulen=struct.unpack_from('<II',body,pos+4);pos+=16
            n=clen or ulen;raw=body[pos:pos+n];pos+=n
            payload=lz4(raw) if clen else raw
            if len(payload)!=ulen:raise ValueError('Chunk length mismatch')
            yield name,payload
            if name.startswith(b'END'):break
    else:yield b'XML',body

def animations(body):
    result=[]
    for name,payload in chunks(body):
        if name==b'PROP' and len(payload)>9:
            n=struct.unpack_from('<I',payload,4)[0]
            prop=payload[8:8+n]
            if prop!=b'AnimationId':continue
            kind=payload[8+n];values=payload[9+n:]
            if kind!=1:continue
            pos=0
            while pos+4<=len(values):
                n=struct.unpack_from('<I',values,pos)[0];pos+=4
                value=values[pos:pos+n].decode('utf8','replace');pos+=n
                matches=re.findall(r'(?:rbxassetid://|[?&]id=)(\d+)',value)
                result.extend(matches)
        elif name==b'XML':result.extend(re.findall(rb'(?:rbxassetid://|[?&]id=)(\d+)',payload))
    return list(dict.fromkeys(v.decode() if isinstance(v,bytes) else v for v in result))

def metadata(asset_id):
    url=f'https://assetdelivery.roblox.com/v2/assetId/{asset_id}'
    r=get(url);data=r.pop('body',{})
    return {'source':url,'status':r['status'],'assetTypeId':data.get('assetTypeId'),'isArchived':data.get('isArchived'),'hasLocations':bool(data.get('locations')),'error':r.get('error')}

def payload(asset_id):
    url=f'https://assetdelivery.roblox.com/v1/asset/?id={asset_id}'
    r=get(url,True);body=r.pop('body',b'')
    return {'source':url,'status':r['status'],'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest() if body else None,'robloxContainer':(body.startswith(b'<roblox!') or b'<roblox' in body[:100]), 'error':r.get('error')},body

def audit(item):
    asset_id=str(item['id']);m=metadata(asset_id);p,body=payload(asset_id)
    try:ids=animations(body) if p['robloxContainer'] else [];parse_error=None
    except Exception as e:ids=[];parse_error=str(e)
    children=[]
    for child_id in ids:
        cm=metadata(child_id);cp,_=payload(child_id)
        children.append({'id':child_id,'metadata':cm,'payload':cp})
    passed=(m['status']==200 and m['assetTypeId']==61 and m['isArchived'] is False and m['hasLocations'] and p['status']==200 and p['robloxContainer'] and bool(children) and all(c['metadata']['status']==200 and c['metadata']['assetTypeId']==24 and c['metadata']['isArchived'] is False and c['payload']['status']==200 and c['payload']['robloxContainer'] for c in children))
    audit_status='verified' if passed else 'authentication-required' if p['status'] in (401,403) or any(c['payload']['status'] in (401,403) for c in children) else 'unknown'
    return {'id':asset_id,'name':item.get('name'),'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'metadata':m,'payload':p,'animationIds':ids,'animations':children,'parseError':parse_error,'payloadAuditPassed':passed,'payloadAuditStatus':audit_status,'testedInGame':False}

def main():
    a=argparse.ArgumentParser();a.add_argument('input');a.add_argument('--output',default='catalog-delivery-audit.json');a.add_argument('--workers',type=int,default=2);a.add_argument('--refresh',action='store_true');args=a.parse_args()
    items=json.loads(Path(args.input).read_text());items=items.get('items',items) if isinstance(items,dict) else items
    cache=json.loads(Path(args.output).read_text()) if Path(args.output).exists() and not args.refresh else []
    records={str(x['id']):x for x in cache}
    for record in records.values():
        if 'payloadAuditStatus' not in record:record['payloadAuditStatus']='verified' if record['payloadAuditPassed'] else 'authentication-required' if record['payload']['status'] in (401,403) else 'unknown'
    pending=[x for x in items if str(x['id']) not in records]
    print(f'Auditing {len(pending)} public payloads; {len(records)} cached',flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        for record in pool.map(audit,pending):
            records[record['id']]=record
            Path(args.output).write_text(json.dumps(list(records.values()),ensure_ascii=False,indent=2)+'\n')
            print(f"{record['id']} {record['name']}: {record['payloadAuditStatus']}; animations={','.join(record['animationIds'])}",flush=True)
    Path(args.output).write_text(json.dumps(list(records.values()),ensure_ascii=False,indent=2)+'\n')
    selected=[records[str(item['id'])] for item in items]
    print(json.dumps({'checked':len(selected),'passed':sum(x['payloadAuditPassed'] for x in selected),'testedInGame':False}),flush=True)
if __name__=='__main__':main()
