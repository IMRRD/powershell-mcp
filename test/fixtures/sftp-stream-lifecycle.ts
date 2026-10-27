// Standalone adaptation of issue14-sync-review/review-abrupt.ts.
// No process-wide error handlers: late stream errors must crash this child.
import ssh2 from 'ssh2';
const { Server, utils } = ssh2;
import { generateKeyPairSync, createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { runSftp } from '../../src/sftp.js';
const mode=process.argv[2];
const download=mode.startsWith('download-');
const fault=mode.replace(/^(upload|download)-/, '');
assert.ok(['close-loss','close-error','close-hang','close-late','hardlink-loss','hardlink-graceful','success'].includes(fault));
const dir=mkdtempSync(join(tmpdir(),'review-abrupt-'));
const body=Buffer.from('verification close transport loss');
const source=join(dir,'source');
writeFileSync(source,body);
const key=generateKeyPairSync('rsa',{
  modulusLength:2048
}).privateKey.export({
  type:'pkcs1',format:'pem'
});
const publicKey=utils.parseKey(key);
if(publicKey instanceof Error)throw publicKey;
const pin='SHA256:'+createHash('sha256').update(publicKey.getPublicSSH()).digest('base64').replace(/=+$/,'');
const files=new Map<string,Buffer>(download ? [['/final', body]] : []);
const clients=new Set<any>();
let releaseClose: (() => void) | undefined;
const serverErrors: Error[] = [];
let opens=0, closePending=false, hardlinkSeen=false;
const server=new Server({
  hostKeys:[key]
},client=>{
  clients.add(client);
  client.on('error',error=>serverErrors.push(error));
  client.on('close',()=>clients.delete(client));
  client.on('authentication',ctx=>ctx.accept()).on('ready',()=>client.on('session',accept=>{
    const session=accept();
    session.on('sftp',accept=>{
      const sftp=accept();
      const handles=new Map<string,{
        path:string,n:number
      }>();
      let serial=0;
      // Advertise the hardlink extension on this local fixture only.
      const protocol=(sftp as any)._protocol;
      const send=protocol.channelData.bind(protocol);
      protocol.channelData=(id:number,packet:Buffer)=>{
        if(packet.length===9&&packet[4]===2){
          const name=Buffer.from('hardlink@openssh.com');
          const extension=Buffer.alloc(9+name.length);
          extension.writeUInt32BE(name.length);
          name.copy(extension,4);
          extension.writeUInt32BE(1,4+name.length);
          extension[8+name.length]=49;
          const advertised=Buffer.concat([packet,extension]);
          advertised.writeUInt32BE(advertised.length-4);
          return send(id,advertised);
        }return send(id,packet);
      };
      sftp.on('OPEN',(id,path,flags)=>{
        if(flags&8)files.set(path,Buffer.alloc(0));
        if(!files.has(path))return sftp.status(id,2);
        const handle=Buffer.alloc(4);
        handle.writeUInt32BE(++serial);
        handles.set(handle.toString('hex'),{
          path,n:++opens
        });
        sftp.handle(id,handle);
      });
      sftp.on('STAT',(id,path)=>files.has(path)?sftp.attrs(id,{
        size:files.get(path)!.length
      }):sftp.status(id,2));
      sftp.on('FSTAT',(id,h)=>{
        const f=handles.get(h.toString('hex'))!;
        sftp.attrs(id,{
          size:files.get(f.path)!.length
        });
      });
      sftp.on('WRITE',(id,h,offset,data)=>{
        const f=handles.get(h.toString('hex'))!;
        const old=files.get(f.path)!;
        const next=Buffer.alloc(Math.max(old.length,offset+data.length));
        old.copy(next);
        data.copy(next,offset);
        files.set(f.path,next);
        sftp.status(id,0);
      });
      sftp.on('READ',(id,h,offset,length)=>{
        const f=handles.get(h.toString('hex'))!;
        const data=files.get(f.path)!;
        offset>=data.length?sftp.status(id,1):sftp.data(id,data.subarray(offset,offset+length));
      });
      sftp.on('CLOSE',(id,h)=>{
        const f=handles.get(h.toString('hex'))!;
        handles.delete(h.toString('hex'));
        if(f.n===(download?2:3)){
          closePending=true;
          console.log('verification CLOSE reached', mode);
          if(fault==='close-error'){
            sftp.status(id,4);
            return;
          }
          if(fault==='close-loss'){
            // Old code sends hardlink while CLOSE is pending and crashes on its
            // abrupt loss. Ordered code never submits it; lose transport here.
            setTimeout(()=>{
              console.log('abrupt socket loss before finalization');
              (client as any)._sock.destroy();
            },80);
            return;
          }
          if(fault==='close-hang')return;
          if(fault==='close-late'){
            releaseClose=()=>sftp.status(id,0);
            return;
          }
          closePending=false;
        }sftp.status(id,0);
      });
      sftp.on('REMOVE',(id,path)=>{
        files.delete(path);
        sftp.status(id,0);
      });
      sftp.on('EXTENDED',(id,name,payload)=>{
        assert.equal(name,'hardlink@openssh.com');
        const size=payload.readUInt32BE(0),temp=payload.subarray(4,4+size).toString();
        const start=4+size;
        const target=payload.subarray(start+4,start+4+payload.readUInt32BE(start)).toString();
        hardlinkSeen=true;
        files.set(target,files.get(temp)!);
        if(fault==='close-loss'||fault==='hardlink-loss'){
          console.log('hardlink applied; abrupt socket destroy; CLOSE pending:',closePending);
          (client as any)._sock.destroy();
        }else if(fault==='hardlink-graceful'){
          console.log('hardlink applied; graceful disconnect');
          client.end();
        }
        else sftp.status(id,0);
      });
    });
  }));
});
try{
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();
  if(!address||typeof address==='string')throw Error('address');
  const result=await runSftp({
    host:'127.0.0.1',port:address.port,username:'fixture',password:'synthetic',hostKeyPins:[pin],staged:true,direction:download?'download':'upload',localPath:download?join(dir,'target'):source,remotePath:'/final',timeoutMs:5000
  });
  console.log('result',JSON.stringify(result));
  // Wait beyond the result and then force remaining fixture sockets closed.
  // No global exception handlers: a late stream error must terminate this child.
  releaseClose?.();
  await new Promise(resolve=>setTimeout(resolve,200));
  for(const client of clients)(client as any)._sock.destroy();
  await new Promise(resolve=>setTimeout(resolve,200));
  assert.deepEqual(serverErrors, []);
  if(fault==='success'){
    assert.equal(result.ok,true);
    assert.equal(result.verification,'sha256_matched');
    assert.equal(result.finalized,true);
  }else{
    assert.equal(result.ok,false);
    if(fault.startsWith('hardlink-')){
      assert.equal(hardlinkSeen,true);
      assert.equal(closePending,false);
      assert.equal(result.verification,'sha256_matched');
      assert.equal(result.finalized,undefined);
      assert.equal(result.cleanup,'unknown');
      assert.deepEqual(files.get('/final'),body);
    }else{
      assert.equal(hardlinkSeen,false,'no hardlink before verification CLOSE acknowledgement');
      assert.equal(result.verification,'failed');
      assert.equal(result.finalized,false);
      assert.equal(download?existsSync(join(dir,'target')):files.has('/final'),false);
      if(fault==='close-error'){
        assert.equal(result.cleanup,'removed');
        assert.match(result.error!,/Failure/);
      }
      else if(fault==='close-hang'||fault==='close-late'||!download){
        assert.equal(result.timedOut,true);
        assert.equal(result.cleanup,'unknown');
      }
      else {
        assert.equal(result.cleanup,'removed');
        assert.match(result.error!,/No response from server/);
      }
    }
  }
  console.log('lifecycle regression passed',mode);
}finally{
  for(const client of clients)client.end();
  await new Promise<void>(resolve=>server.close(()=>resolve()));
  rmSync(dir,{
    recursive:true,force:true
  });
}
