import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import './crypto-core.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const site=path.join(root,'.share/site');
const access=JSON.parse(await fs.readFile(path.join(root,'.share/access.json'),'utf8'));
const config=JSON.parse(await fs.readFile(path.join(site,'config.json'),'utf8'));
const core=globalThis.MRIShareCrypto, key=await core.derive(access.password,config);
const encrypted=await fs.readFile(path.join(site,'manifest.bin'));
const manifest=JSON.parse(new TextDecoder().decode(await core.decrypt(encrypted,key,'manifest.bin')));
let rejected=0;
for(const [bytes,selectedKey,aad] of [[encrypted,await core.derive('wrong-password',config),'manifest.bin'],[encrypted,key,'wrong-path.bin'],[Buffer.concat([encrypted.subarray(0,-1),Buffer.from([encrypted.at(-1)^1])]),key,'manifest.bin']]) {
  try {await core.decrypt(bytes,selectedKey,aad); throw new Error('Invalid data unexpectedly decrypted');}
  catch(error) {if(error.name!=='OperationError') throw error; rejected++;}
}
const references=JSON.parse(await fs.readFile(path.join(root,'.share/render-reference.json'),'utf8'));
let tested=0,maxDifference=0;
for(const reference of references) {
  const meta=manifest.frames[reference.frame], descriptor=manifest.files[meta.file_id];
  const bytes=await core.decrypt(await fs.readFile(path.join(site,descriptor.asset)),key,descriptor.asset);
  const pixels=core.decodePixels(bytes,descriptor,meta);
  const actual=core.grayscale(pixels,meta,reference.center,reference.width,reference.invert);
  const expected=Buffer.from(reference.rgba,'base64');
  if(actual.length!==expected.length) throw new Error('Image dimension mismatch');
  for(let i=0;i<actual.length;i++) maxDifference=Math.max(maxDifference,Math.abs(actual[i]-expected[i]));
  if(maxDifference>1) throw new Error('Browser rendering differs from pydicom by more than one grayscale level');
  if(createHash('sha256').update(Buffer.from(pixels.buffer)).digest('hex')!==reference.pixels_sha256) throw new Error('Pixel values changed');
  tested++;
}
for(const [id,doc] of Object.entries(manifest.documents)) {
  const bytes=await core.decrypt(await fs.readFile(path.join(site,doc.asset)),key,doc.asset);
  if(new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-') throw new Error('Invalid PDF');
}
console.log(JSON.stringify({image_checks:tested,max_grayscale_difference:maxDifference,invalid_key_and_tamper_checks:rejected,reports: Object.keys(manifest.documents).length,frames: Object.keys(manifest.frames).length}));
