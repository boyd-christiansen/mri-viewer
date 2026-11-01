import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import './crypto-core.js';

const core=globalThis.MRIShareCrypto;
const config={salt:Buffer.alloc(16,42).toString('base64'),iterations:1000};
const key=await core.derive('synthetic-test-only',config);
const material=await crypto.subtle.importKey('raw',new TextEncoder().encode('synthetic-test-only'),'PBKDF2',false,['deriveKey']);
const encryptKey=await crypto.subtle.deriveKey({name:'PBKDF2',salt:Uint8Array.from(atob(config.salt),c=>c.charCodeAt(0)),iterations:config.iterations,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['encrypt']);
const path='test.bin';
const iv=crypto.getRandomValues(new Uint8Array(12));
const input=new TextEncoder().encode('Synthetic data only');
const sealed=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(`mri-share-v1:${path}`)},encryptKey,gzipSync(input)));
const encrypted=new Uint8Array(iv.length+sealed.length);encrypted.set(iv);encrypted.set(sealed,iv.length);

test('encrypted assets round-trip and decompress',async()=>{
  assert.deepEqual(new Uint8Array(await core.decrypt(encrypted,key,path)),input);
});
test('wrong passwords, substituted paths and tampered ciphertext are rejected',async()=>{
  const wrong=await core.derive('another-test-value',config),tampered=encrypted.slice();tampered[tampered.length-1]^=1;
  await assert.rejects(core.decrypt(encrypted,wrong,path),{name:'OperationError'});
  await assert.rejects(core.decrypt(encrypted,key,'other.bin'),{name:'OperationError'});
  await assert.rejects(core.decrypt(tampered,key,path),{name:'OperationError'});
});
test('signed source pixels and rescale are decoded without changing values',()=>{
  const raw=new ArrayBuffer(8),view=new DataView(raw);[-100,0,100,200].forEach((value,index)=>view.setInt16(index*2,value,true));
  const descriptor={offset:0,bits:16,stored:16,signed:true,rows:2,columns:2};
  const frame={frame:0,rows:2,columns:2,slope:2,intercept:-10};
  assert.deepEqual([...core.decodePixels(raw,descriptor,frame)],[-210,-10,190,390]);
});
