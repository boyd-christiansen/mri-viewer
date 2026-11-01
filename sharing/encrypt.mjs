import fs from 'node:fs/promises';
import path from 'node:path';
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const privateDir = path.join(root, '.share');
const staging = path.join(privateDir, 'staging');
const site = path.join(privateDir, 'site');
await fs.mkdir(privateDir, {recursive: true, mode: 0o700});
await fs.chmod(privateDir, 0o700);
await fs.mkdir(site, {recursive: true, mode: 0o700});
const accessPath = path.join(privateDir, 'access.json');
let access;
try { access = JSON.parse(await fs.readFile(accessPath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; access = {password: randomBytes(24).toString('base64url')}; }
await fs.writeFile(accessPath, JSON.stringify(access, null, 2), {mode: 0o600});
await fs.chmod(accessPath, 0o600);
const passwordFile=path.join(privateDir, 'Sharing password.txt');
try { await fs.access(passwordFile); } catch { await fs.writeFile(passwordFile, `Private MRI Viewer\n\nPassword: ${access.password}\n\nShare the site URL and this password only with your intended recipient.\n`, {mode: 0o600}); }
const reuse=process.argv.includes('--reuse-assets');
const previousConfig=reuse?JSON.parse(await fs.readFile(path.join(site,'config.json'),'utf8')):null;
const salt = reuse?Buffer.from(previousConfig.salt,'base64'):randomBytes(16), iterations = reuse?previousConfig.iterations:600000;
const key = pbkdf2Sync(access.password, salt, iterations, 32, 'sha256');
if(reuse){
  const old=await fs.readFile(path.join(site,'manifest.bin'));
  const decipher=createDecipheriv('aes-256-gcm',key,old.subarray(0,12));decipher.setAAD(Buffer.from('mri-share-v1:manifest.bin'));decipher.setAuthTag(old.subarray(-16));
  const previous=JSON.parse(gunzipSync(Buffer.concat([decipher.update(old.subarray(12,-16)),decipher.final()])));
  const next=JSON.parse(gunzipSync(await fs.readFile(path.join(staging,'manifest.bin'))));
  for(const key of ['frames','files','documents'])if(JSON.stringify(previous[key])!==JSON.stringify(next[key]))throw new Error('Asset descriptors changed; run a full encryption build.');
}
const paths = ['manifest.bin', ...(reuse?[]:(await fs.readdir(path.join(staging, 'assets'))).sort().map(name => `assets/${name}`))];
await fs.mkdir(path.join(site, 'assets'), {recursive: true});
let bytes = 0;
const usedIvs = new Set();
for (const relative of paths) {
  const plaintext = await fs.readFile(path.join(staging, relative));
  const iv = randomBytes(12);
  if (usedIvs.has(iv.toString('hex'))) throw new Error('Repeated IV');
  usedIvs.add(iv.toString('hex'));
  const aad = Buffer.from(`mri-share-v1:${relative}`);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  // Round-trip and authenticate each encrypted asset before it can be published.
  const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12));
  decipher.setAAD(aad); decipher.setAuthTag(encrypted.subarray(-16));
  const roundTrip = Buffer.concat([decipher.update(encrypted.subarray(12, -16)), decipher.final()]);
  if (!roundTrip.equals(plaintext)) throw new Error(`Verification failed: ${relative}`);
  await fs.writeFile(path.join(site, relative), encrypted);
  bytes += encrypted.length;
}
await fs.writeFile(path.join(site, 'config.json'), JSON.stringify({version: 1, salt: salt.toString('base64'), iterations}));

let html = await fs.readFile(path.join(root, 'web/index.html'), 'utf8');
html = html.replace('<title>MRI Viewer</title>', '<title>Private MRI Viewer</title>');
html = html.replace('<script src="/app.js" defer></script>', '<link rel="stylesheet" href="/share.css">\n  <script src="/crypto-core.js" defer></script>\n  <script src="/shared-source.js" defer></script>\n  <script src="/app.js" defer></script>');
html = html.replace('<body>', '<body class="locked">');
html = html.replace(/<button id="import-open"[^>]*>.*?<\/button>/, '<button id="import-open" hidden>Import</button><button id="lock-viewer">Lock</button>');
html = html.replace('Local only', 'Encrypted');
html = html.replace('Open local document', 'Open document');
html = html.replace('</body>', `${await fs.readFile(path.join(root, 'sharing/lock-screen.html'), 'utf8')}\n</body>`);
await fs.writeFile(path.join(site, 'index.html'), html);
for (const name of ['app.js', 'style.css', 'spatial.js', 'spatial.css', 'spatial.js.LICENSE.txt']) await fs.copyFile(path.join(root, 'web', name), path.join(site, name));
for (const name of ['shared-source.js', 'crypto-core.js', 'share.css']) await fs.copyFile(path.join(root, 'sharing', name), path.join(site, name));
const csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; frame-src blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
await fs.writeFile(path.join(site, 'vercel.json'), JSON.stringify({$schema:'https://openapi.vercel.sh/vercel.json',framework:null,buildCommand:null,installCommand:null,outputDirectory:'.',headers:[{source:'/(.*)',headers:[{key:'Content-Security-Policy',value:csp},{key:'X-Content-Type-Options',value:'nosniff'},{key:'Referrer-Policy',value:'no-referrer'},{key:'X-Frame-Options',value:'DENY'},{key:'X-Robots-Tag',value:'noindex, nofollow, noarchive'},{key:'Cache-Control',value:'no-store'}]}]},null,2));
await fs.writeFile(path.join(site, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
// Ensure no plaintext originals, access credentials, or staging files can enter the upload root.
const listing = await fs.readdir(site);
const allowed = new Set(['assets','manifest.bin','config.json','index.html','app.js','style.css','spatial.js','spatial.css','spatial.js.LICENSE.txt','crypto-core.js','shared-source.js','share.css','vercel.json','robots.txt','.vercel','.vercelignore','.gitignore']);
for (const name of listing) if (!allowed.has(name)) throw new Error(`Unexpected deployment file: ${name}`);
for (const name of listing.filter(n => /\.(js|css|html|json|txt)$/.test(n))) {
  const text = await fs.readFile(path.join(site,name),'utf8');
  if (text.includes(access.password)) throw new Error('Password appeared in a public file');
}
console.log(JSON.stringify({encrypted_assets: paths.length, encrypted_bytes: bytes, credentials_uploaded: false, original_files_modified: false}));
