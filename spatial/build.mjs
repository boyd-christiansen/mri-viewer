import path from 'node:path';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);
let dependencies=path.join(root,'node_modules');
try { require.resolve('esbuild'); } catch { dependencies=path.join(root,'.cache/spatial/node_modules'); }
const {build}=await import(path.join(dependencies,'esbuild/lib/main.js'));
await build({entryPoints:[path.join(root,'spatial/viewer.mjs')],outfile:path.join(root,'web/spatial.js'),bundle:true,minify:true,format:'iife',target:['es2022'],nodePaths:[dependencies],legalComments:'external'});
await fs.copyFile(path.join(dependencies,'three/LICENSE'),path.join(root,'web/spatial.js.LICENSE.txt'));
console.log('Built local 3D viewer with Three.js 0.180.0.');
