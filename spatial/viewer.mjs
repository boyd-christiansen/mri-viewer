import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {validFrame,corners,center,normal,orientationName,intersection,contextIndices} from './geometry.mjs';

const $=id=>document.getElementById(id), bridge=window.mriViewer;
const palette=['#b9e6cb','#e4bf87','#87c6df','#b6b0e7','#d4a78d','#9eb3bd'];
const view={visible:false,ready:false,items:[],active:null,generation:0,pending:0,queue:[],busy:0,textures:new Map(),inFlight:new Map(),used:new Set(),cameraMode:'oblique',lastPointer:null};
let scene,camera,renderer,controls,planes,outlines,intersections,body,labels,grid,bodyAnchor=new THREE.Vector3(),observer;
let needsRender=true,dragMoved=false;
const v=p=>new THREE.Vector3(...p);
const changed=()=>{needsRender=true;};
const status=message=>{$('space-status').textContent=message;};
function error(message){$('space-error').hidden=!message;$('space-error').textContent=message||'';}
function clearGroup(group){
  while(group?.children.length){const child=group.children[0];group.remove(child);child.traverse(obj=>{obj.geometry?.dispose();if(obj.material){for(const material of [obj.material].flat())material.dispose();}});}
}
function line(points,color,opacity=1){return new THREE.Line(new THREE.BufferGeometry().setFromPoints(points.map(v)),new THREE.LineBasicMaterial({color,transparent:true,opacity,depthWrite:false}));}
function rectangle(frame,color,opacity){const points=corners(frame);return line([...points,points[0]],color,opacity);}
function frameAt(item){return item.frames[item.index];}
function activeItem(){return view.items.find(item=>item.id===view.active);}
function shownItems(){return view.items.filter(item=>item.shown);}
function showControls(item){
  $('space-active-title').textContent=item?item.description:'Select a series';
  $('space-slice').max=item?.frames.length||1;$('space-slice').value=(item?.index||0)+1;
  $('space-slice-value').textContent=item?`${item.index+1} / ${item.frames.length}`:'—';
  const frame=item&&frameAt(item);
  $('space-slice-position').textContent=frame?`${orientationName(frame)} · ${frame.thickness||'?'} mm thick`:'';
  for(const id of ['space-slice','space-prev','space-next','space-open-slice'])$(id).disabled=!item;
  document.querySelectorAll('.space-series-row').forEach(row=>{const entry=view.items.find(i=>i.id===row.dataset.id);row.classList.toggle('active',entry?.id===view.active);row.classList.toggle('dimmed',!entry?.shown);row.querySelector('input').checked=!!entry?.shown;row.querySelector('button').setAttribute('aria-pressed',String(entry?.id===view.active));});
}
function activate(id,index){
  const item=view.items.find(i=>i.id===id);if(!item)return;
  const other=shownItems().find(i=>i.reference_id!==item.reference_id);
  if(other)for(const i of view.items)i.shown=false;
  item.shown=true;view.active=id;
  if(Number.isFinite(index))item.index=Math.max(0,Math.min(item.frames.length-1,index));
  showControls(item);rebuild();
}
function seriesList(){
  const target=$('space-series-list');target.replaceChildren();
  let previous='';
  for(const item of view.items){
    if(item.study!==previous){const heading=document.createElement('h3');heading.className='space-series-group';heading.textContent=item.study.replace(' WITHOUT CONTRAST','');target.append(heading);previous=item.study;}
    const row=document.createElement('div');row.className='space-series-row';row.dataset.id=item.id;row.style.setProperty('--series-color',item.color);
    const check=document.createElement('input');check.type='checkbox';check.setAttribute('aria-label',`Show ${item.study}: ${item.description}`);check.checked=item.shown;
    check.onchange=()=>{if(check.checked){const mismatch=shownItems().some(i=>i.reference_id!==item.reference_id);if(mismatch)for(const i of view.items)i.shown=false;item.shown=true;}else item.shown=false;showControls(activeItem());rebuild();};
    const button=document.createElement('button'),copy=document.createElement('span'),detail=document.createElement('small');copy.textContent=item.description;
    const orientations=new Set(item.frames.map(orientationName));detail.textContent=`${item.frames.length} slices · ${orientations.size>1?'Multiple directions':orientationName(item.frames[0]).split(' · ')[0]}`;copy.append(detail);button.append(copy);button.onclick=()=>activate(item.id);row.append(check,button);target.append(row);
  }
}
function defaultSet(){
  for(const item of view.items){item.index=Math.floor((item.frames.length-1)/2);item.shown=false;}
  const selected=bridge.selected.series;
  const reference=view.items.find(i=>i.id===selected?.id)?.reference_id||view.items.find(i=>!/LOCALIZER/i.test(i.description))?.reference_id;
  const candidates=view.items.filter(i=>i.reference_id===reference&&!/LOCALIZER/i.test(i.description));
  const chosen=[];
  for(const study of new Set(candidates.map(i=>i.study))){
    const group=candidates.filter(i=>i.study===study);
    const sagittal=group.find(i=>/T2/i.test(i.description)&&orientationName(i.frames[0]).startsWith('Sagittal'));
    if(sagittal)chosen.push(sagittal);
    const axial=group.filter(i=>/T2/i.test(i.description)&&orientationName(i.frames[0]).startsWith('Axial'));
    chosen.push(...axial);
  }
  if(!chosen.length&&candidates.length)chosen.push(candidates[0]);
  if(!chosen.length&&view.items.length)chosen.push(view.items[0]);
  for(const item of chosen)item.shown=true;
  const item=chosen.find(i=>i.id===selected?.id)||chosen[0];view.active=item?.id||null;
  showControls(item);rebuild();cameraView('oblique');
}
async function ensureReady(){
  if(view.ready)return;
  const response=await bridge.api('/api/spatial');
  if(!response?.series)throw new Error('The scan geometry is unavailable. Please reopen the updated viewer.');
  view.items=response.series.map((series,i)=>({...series,color:palette[i%palette.length],shown:false,index:0,frames:series.frames.map(f=>({...f,rows:series.rows,columns:series.columns})).filter(validFrame)})).filter(i=>i.frames.length&&i.reference_id);
  // Prefer distinct, consistent colors for the default complementary series.
  let n=0;for(const item of view.items.filter(i=>!/LOCALIZER/i.test(i.description)&&/T2/i.test(i.description)))item.color=palette[n++%palette.length];
  if(!view.items.length)throw new Error('These images do not contain enough recorded spatial information for the 3D view.');
  initScene();seriesList();view.ready=true;defaultSet();
}
function initScene(){
  scene=new THREE.Scene();scene.background=new THREE.Color('#090f14');
  renderer=new THREE.WebGLRenderer({canvas:$('space-canvas'),antialias:true,alpha:false,preserveDrawingBuffer:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio||1,2));renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.localClippingEnabled=true;
  camera=new THREE.PerspectiveCamera(38,1,1,6000);camera.up.set(0,1,0);
  const initial=$('space-stage').getBoundingClientRect();renderer.setSize(initial.width,initial.height,false);camera.aspect=initial.width/initial.height;camera.updateProjectionMatrix();
  controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.dampingFactor=.09;controls.minDistance=80;controls.maxDistance=2300;controls.addEventListener('change',changed);
  planes=new THREE.Group();outlines=new THREE.Group();intersections=new THREE.Group();body=new THREE.Group();labels=new THREE.Group();scene.add(body,planes,outlines,intersections,labels);
  scene.add(new THREE.HemisphereLight('#b8d1df','#17232d',2));const light=new THREE.DirectionalLight('#e1edf5',2.5);light.position.set(-250,400,-600);scene.add(light);
  grid=new THREE.GridHelper(650,13,'#30414d','#192732');grid.position.y=-515;grid.material.transparent=true;grid.material.opacity=.5;scene.add(grid);
  makeBody();
  const stage=$('space-stage');observer=new ResizeObserver(()=>{const w=stage.clientWidth,h=stage.clientHeight;if(!w||!h)return;renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();changed();});observer.observe(stage);
  const raycaster=new THREE.Raycaster();
  renderer.domElement.addEventListener('pointerdown',event=>{view.lastPointer=[event.clientX,event.clientY];dragMoved=false;});
  renderer.domElement.addEventListener('pointermove',event=>{if(view.lastPointer&&Math.hypot(event.clientX-view.lastPointer[0],event.clientY-view.lastPointer[1])>5)dragMoved=true;});
  renderer.domElement.addEventListener('pointerup',event=>{
    if(event.button!==0||dragMoved||!view.lastPointer)return;view.lastPointer=null;
    const bounds=renderer.domElement.getBoundingClientRect();raycaster.setFromCamera(new THREE.Vector2((event.clientX-bounds.left)/bounds.width*2-1,-(event.clientY-bounds.top)/bounds.height*2+1),camera);
    const hit=raycaster.intersectObjects(planes.children).find(hit=>hit.object.visible);if(hit)activate(hit.object.userData.seriesId,hit.object.userData.index);
  });
  renderer.domElement.addEventListener('keydown',event=>{
    if(event.key==='ArrowUp'||event.key==='ArrowDown'){event.preventDefault();event.stopPropagation();moveSlice(event.key==='ArrowUp'?-1:1);}
    if(event.key.toLowerCase()==='r'){event.preventDefault();event.stopPropagation();cameraView('oblique');}
  });
  function loop(){requestAnimationFrame(loop);if(!view.visible)return;controls.update();if(needsRender){renderer.render(scene,camera);needsRender=false;}}
  loop();
}
function sprite(text,position,color='#a8bcc9',size=15){
  const canvas=document.createElement('canvas');canvas.width=160;canvas.height=64;const ctx=canvas.getContext('2d');ctx.font='500 28px -apple-system, sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle=color;ctx.fillText(text,80,32);
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
  const object=new THREE.Sprite(new THREE.SpriteMaterial({map:texture,transparent:true,depthTest:false,depthWrite:false,opacity:.85}));object.position.copy(v(position));object.scale.set(size*2.5,size,1);labels.add(object);return object;
}
function bodyMaterial(){return new THREE.MeshStandardMaterial({color:'#7193aa',roughness:.75,metalness:0,transparent:true,opacity:.07,side:THREE.DoubleSide,depthWrite:false});}
function ellipsoid(position,radii){
  const object=new THREE.Mesh(new THREE.SphereGeometry(1,40,28),bodyMaterial());object.position.copy(v(position));object.scale.set(...radii);body.add(object);return object;
}
function makeBody(){
  const neck=view.items.find(i=>/CERVICAL/i.test(i.study)&&!/LOCALIZER/i.test(i.description)&&orientationName(i.frames[0]).startsWith('Sagittal'));
  if(neck){const mid=v(center(neck.frames[Math.floor(neck.frames.length/2)]));bodyAnchor.set(mid.x,mid.y+26,mid.z-14);}
  const rings=[[-505,155,100],[-465,153,104],[-405,143,100],[-345,144,104],[-285,167,114],[-220,187,119],[-160,192,111],[-115,181,93],[-85,125,65],[-70,53,47]];
  const segments=64,positions=[],indices=[];
  for(const [y,rx,rz] of rings)for(let i=0;i<segments;i++){const t=i/segments*Math.PI*2;positions.push(rx*Math.cos(t),y,-20+rz*Math.sin(t));}
  for(let ring=0;ring<rings.length-1;ring++)for(let i=0;i<segments;i++){const a=ring*segments+i,b=ring*segments+(i+1)%segments,c=a+segments,d=b+segments;indices.push(a,c,b,b,c,d);}
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setIndex(indices);geometry.computeVertexNormals();body.add(new THREE.Mesh(geometry,bodyMaterial()));
  ellipsoid([0,107,-6],[79,102,89]);ellipsoid([0,-31,-5],[48,75,47]);
  ellipsoid([-191,-155,-15],[43,76,56]);ellipsoid([191,-155,-15],[43,76,56]);
  for(const [y,rx,rz] of rings.filter((_,i)=>i%2===0)){const points=Array.from({length:65},(_,i)=>[rx*Math.cos(i/64*Math.PI*2),y,-20+rz*Math.sin(i/64*Math.PI*2)]);body.add(line(points,'#65879b',.12));}
  // A head meridian and shoulder contour make the generic shape legible at low opacity.
  body.add(line(Array.from({length:65},(_,i)=>[79*Math.cos(i/64*Math.PI*2),107+102*Math.sin(i/64*Math.PI*2),-6]),'#65879b',.22));
  body.position.copy(bodyAnchor);grid.position.add(bodyAnchor);
  for(const [text,p] of [['H',[0,236,0]],['F',[0,-545,0]],['L',[-265,-210,-15]],['R',[265,-210,-15]],['A',[0,-225,-200]],['P',[0,-225,165]]])sprite(text,v(p).add(bodyAnchor).toArray());
  const rulerX=-255,rulerY=-430,rulerZ=-180;
  labels.add(line([[rulerX,rulerY,rulerZ],[rulerX+100,rulerY,rulerZ]].map(p=>v(p).add(bodyAnchor).toArray()),'#7896a8',.7));
  for(const dx of [0,100])labels.add(line([[rulerX+dx,rulerY-5,rulerZ],[rulerX+dx,rulerY+5,rulerZ]].map(p=>v(p).add(bodyAnchor).toArray()),'#7896a8',.7));
  sprite('100 mm',v([rulerX+50,rulerY-17,rulerZ]).add(bodyAnchor).toArray(),'#7896a8',12);updateBody();
}
function updateBody(){
  if(!body)return;const amount=Number($('space-body').value)/100;body.visible=amount>0;
  const clipping=$('space-cutaway').checked?[new THREE.Plane(new THREE.Vector3(0,0,1),-(bodyAnchor.z-20))]:[];
  body.traverse(obj=>{if(obj.isMesh){obj.material.opacity=amount*.55;obj.material.clippingPlanes=clipping;}else if(obj.isLine)obj.material.opacity=amount*.8;});changed();
}
function setCameraButtons(mode){view.cameraMode=mode;document.querySelectorAll('[data-camera]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.camera===mode)));}
function cameraView(mode,fit=false){
  if(!camera)return;
  const box=new THREE.Box3();
  if(fit){for(const item of shownItems())for(const frame of item.frames)for(const p of corners(frame))box.expandByPoint(v(p));}
  if(box.isEmpty())box.setFromCenterAndSize(v([0,-150,0]).add(bodyAnchor),new THREE.Vector3(470,750,300));
  const target=box.getCenter(new THREE.Vector3()),size=box.getSize(new THREE.Vector3());
  // Fit the bounding sphere, including narrow portrait viewports.
  const directions={oblique:[-1,.3,-1.6],front:[0,0,-1],side:[-1,0,0],back:[0,0,1]};
  const direction=v(directions[mode]||directions.oblique).normalize(),right=new THREE.Vector3().crossVectors(camera.up,direction).normalize(),up=new THREE.Vector3().crossVectors(direction,right).normalize();
  const tanV=Math.tan(camera.fov*Math.PI/360),tanH=tanV*camera.aspect;
  let distance=250;
  for(const x of [box.min.x,box.max.x])for(const y of [box.min.y,box.max.y])for(const z of [box.min.z,box.max.z]){
    const offset=new THREE.Vector3(x,y,z).sub(target),depth=offset.dot(direction);
    distance=Math.max(distance,depth+Math.abs(offset.dot(right))/tanH,depth+Math.abs(offset.dot(up))/tanV);
  }
  camera.position.copy(target).add(direction.multiplyScalar(distance*1.1));controls.target.copy(target);controls.update();setCameraButtons(mode);changed();
}
function meshFor(frame){
  const points=corners(frame).flat(),geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(points,3));geometry.setAttribute('uv',new THREE.Float32BufferAttribute([0,1,1,1,1,0,0,0],2));geometry.setIndex([0,2,1,0,3,2]);geometry.computeVertexNormals();
  return new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({transparent:true,side:THREE.DoubleSide,depthWrite:false,toneMapped:false}));
}
async function textureFor(frame,detail){
  const key=`${frame.id}:${detail?'detail':'context'}:${$('space-background').checked?'fade':'solid'}`;
  view.used.add(key);
  if(view.textures.has(key)){const value=view.textures.get(key);view.textures.delete(key);view.textures.set(key,value);return value;}
  if(view.inFlight.has(key))return view.inFlight.get(key);
  const fade=$('space-background').checked;
  const promise=(async()=>{
    const bitmap=await createImageBitmap(await bridge.imageBlob(frame.id));
    const max=detail?768:256,ratio=Math.min(1,max/Math.max(bitmap.width,bitmap.height));
    const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*ratio));canvas.height=Math.max(1,Math.round(bitmap.height*ratio));
    const ctx=canvas.getContext('2d',{willReadFrequently:fade});ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
    if(fade){const pixels=ctx.getImageData(0,0,canvas.width,canvas.height);for(let p=0;p<pixels.data.length;p+=4)pixels.data[p+3]=Math.round(Math.min(1,Math.max(0,(pixels.data[p]-5)/18))*255);ctx.putImageData(pixels,0,0);}
    const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.minFilter=THREE.LinearFilter;texture.magFilter=THREE.LinearFilter;texture.generateMipmaps=false;view.textures.set(key,texture);return texture;
  })().finally(()=>view.inFlight.delete(key));view.inFlight.set(key,promise);return promise;
}
function trimTextures(){
  for(const [key,texture] of view.textures){if(view.textures.size<=120)break;if(!view.used.has(key)){texture.dispose();texture.image.width=1;texture.image.height=1;view.textures.delete(key);}}
}
function pump(){
  while(view.busy<3&&view.queue.length){
    const task=view.queue.shift();if(task.generation!==view.generation)continue;view.busy++;
    textureFor(task.frame,task.detail).then(texture=>{
      if(task.generation!==view.generation)return;task.mesh.material.map=texture;task.mesh.material.needsUpdate=true;task.mesh.visible=true;changed();
    }).catch(()=>{if(task.generation===view.generation){view.failed++;error('One or more slice images could not be loaded. Select the series again to retry.');}}).finally(()=>{
      view.busy--;if(task.generation===view.generation){view.pending--;updateStatus();}trimTextures();pump();
    });
  }
}
function updateStatus(){
  const items=shownItems(),count=items.reduce((total,item)=>total+item.frames.length,0);
  const base=items.length?`${items.length} series · ${count} recorded slice positions`:'Choose a series to place its slices in space.';
  status(view.pending?`${base} · Loading ${view.pending} images…`:base);
  $('space-stage').dataset.visibleSeries=items.length;$('space-stage').dataset.slicePositions=count;$('space-stage').dataset.loading=view.pending;
}
function rebuild(){
  if(!planes)return;view.generation++;view.queue=[];view.pending=0;view.failed=0;view.used=new Set();error('');
  clearGroup(planes);clearGroup(outlines);clearGroup(intersections);
  const items=shownItems(),selectedFrames=[];
  for(const item of items){
    const selected=frameAt(item);selectedFrames.push({frame:selected,item});
    if($('space-outlines').checked)for(const frame of item.frames)outlines.add(rectangle(frame,item.color,.15));
    const outline=rectangle(selected,item.color,item.id===view.active?1:.65);outline.renderOrder=5;outline.material.depthTest=false;outlines.add(outline);
    for(const index of contextIndices(item.frames.length,item.index,$('space-context').value)){
      const frame=item.frames[index],detail=index===item.index,mesh=meshFor(frame);mesh.userData={seriesId:item.id,index};mesh.visible=false;
      mesh.material.opacity=Number($('space-opacity').value)/100*(detail?(item.id===view.active?1:.72):.13);mesh.material.alphaTest=.015;
      planes.add(mesh);view.queue.push({generation:view.generation,frame,detail,mesh});view.pending++;
    }
  }
  if($('space-intersections').checked)for(let i=0;i<selectedFrames.length;i++)for(let j=i+1;j<selectedFrames.length;j++){
    const a=selectedFrames[i],b=selectedFrames[j];if(a.item.reference_id!==b.item.reference_id)continue;
    const points=intersection(a.frame,b.frame);if(points){const object=line(points,'#f3e7b0',.95);object.material.depthTest=false;object.renderOrder=10;intersections.add(object);}
  }
  view.queue.sort((a,b)=>Number(b.detail)-Number(a.detail));
  $('space-reference-note').textContent='Recorded geometry (mm). Movement between series can affect alignment.';
  updateStatus();changed();pump();
}
function moveSlice(delta){const item=activeItem();if(!item)return;item.index=Math.max(0,Math.min(item.frames.length-1,item.index+delta));showControls(item);rebuild();}
async function setMode(spatial,sync=true){
  view.visible=spatial;bridge.stopPlay();$('slice-view').hidden=spatial;$('space-view').hidden=!spatial;
  $('mode-slices').setAttribute('aria-pressed',String(!spatial));$('mode-space').setAttribute('aria-pressed',String(spatial));
  document.body.classList.toggle('spatial-mode',spatial);
  try{
    if(spatial){$('study-title').textContent='3D slice map';$('study-subtitle').textContent='';await ensureReady();observer?.disconnect();observer?.observe($('space-stage'));changed();}
    else if(sync){const item=activeItem();if(item)await bridge.openSlice(item.id,item.index);}
  }catch(e){error(`The 3D view could not start. ${e.message} You can continue using the slice viewer.`);}
}
$('mode-space').onclick=()=>setMode(true);$('mode-slices').onclick=()=>setMode(false);
$('space-open-slice').onclick=()=>setMode(false);$('space-preset').onclick=defaultSet;
$('space-slice').oninput=event=>{const item=activeItem();if(item){item.index=Number(event.target.value)-1;showControls(item);rebuild();}};
$('space-prev').onclick=()=>moveSlice(-1);$('space-next').onclick=()=>moveSlice(1);
for(const id of ['space-opacity','space-context','space-outlines','space-intersections','space-background'])$(id).addEventListener(id==='space-opacity'?'input':'change',rebuild);
$('space-body').oninput=updateBody;$('space-cutaway').onchange=updateBody;
for(const button of document.querySelectorAll('[data-camera]'))button.onclick=()=>cameraView(button.dataset.camera);
$('space-fit').onclick=()=>cameraView(view.cameraMode,true);
$('space-fullscreen').onclick=()=>{if(document.fullscreenElement)document.exitFullscreen();else $('space-view').requestFullscreen().catch(()=>status('Use your browser’s full-screen option to expand the view.'));};
window.addEventListener('mri-series',event=>{if(view.visible&&view.ready)activate(event.detail.series.id,event.detail.index);});
window.addEventListener('mri-library',()=>{if(view.ready){view.ready=false;view.visible=false;location.reload();}});
// UI mode only; all clinical metadata and textures use the same local/decrypted source as 2D.
