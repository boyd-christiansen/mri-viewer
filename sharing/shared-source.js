(function () {
  "use strict";
  const helper = globalThis.MRIShareCrypto;
  let key, manifest;
  const files = new Map(), inFlight = new Map(), thumbnailUrls = new Map();
  let reportUrl;
  let reportPageUrls=[];
  function requireUnlocked() { if (!key || !manifest) throw new Error("Unlock the study first."); }
  async function encrypted(relative, selectedKey=key) {
    const response = await fetch("/" + relative, {cache:"no-store"});
    if (!response.ok) throw new Error("A shared file could not be loaded. Please try again.");
    return helper.decrypt(await response.arrayBuffer(), selectedKey, relative);
  }
  async function original(fileId) {
    requireUnlocked();
    if (files.has(fileId)) { const value=files.get(fileId); files.delete(fileId); files.set(fileId,value); return value; }
    if (!inFlight.has(fileId)) {
      const descriptor = manifest.files[fileId];
      if (!descriptor) throw new Error("This file is not part of the shared study.");
      inFlight.set(fileId,encrypted(descriptor.asset).then(buffer => {
        files.set(fileId,buffer); while(files.size>8) files.delete(files.keys().next().value); return buffer;
      }).finally(()=>inFlight.delete(fileId)));
    }
    return inFlight.get(fileId);
  }
  async function imageBlob(frameId, params=new URLSearchParams(), signal) {
    requireUnlocked(); const meta=manifest.frames[frameId];
    if (!meta) throw new Error("This image is not part of the study.");
    const descriptor=manifest.files[meta.file_id], buffer=await original(meta.file_id);
    if(signal?.aborted) throw new DOMException("Aborted","AbortError");
    const pixels=helper.decodePixels(buffer,descriptor,meta);
    const number = name => params.has(name) ? Number(params.get(name)) : null;
    const rgba=helper.grayscale(pixels,meta,number("center"),number("width"),params.get("invert")==="1");
    const target=document.createElement("canvas"); target.width=meta.columns; target.height=meta.rows;
    target.getContext("2d").putImageData(new ImageData(rgba,meta.columns,meta.rows),0,0);
    return new Promise((resolve,reject)=>target.toBlob(blob=>blob?resolve(blob):reject(new Error("Could not render image.")),"image/png"));
  }
  function download(buffer,mime,name) {
    const url=URL.createObjectURL(new Blob([buffer],{type:mime})), link=document.createElement("a");
    link.href=url; link.download=name; link.click(); setTimeout(()=>URL.revokeObjectURL(url),10000);
  }
  window.sharedImaging = {
    async api(route) {
      requireUnlocked();
      if(route==="/api/library") return manifest.library;
      if(route==="/api/spatial") return manifest.spatial;
      if(route==="/api/import-status") return {phase:"idle"};
      if(route.startsWith("/api/frame/")) {
        const frame=manifest.frames[route.split("/").pop()]; if(frame) return frame;
      }
      throw new Error("This action is not available in the shared viewer.");
    },
    async imageResponse(frame,params,signal) { return new Response(await imageBlob(frame,params,signal),{headers:{"Content-Type":"image/png"}}); },
    async thumbnail(frame) {
      if(!thumbnailUrls.has(frame)) thumbnailUrls.set(frame,URL.createObjectURL(await imageBlob(frame)));
      return thumbnailUrls.get(frame);
    },
    async downloadOriginal(fileId) { const buffer=await original(fileId); download(buffer,"application/dicom",manifest.files[fileId].name); },
    async openDocument(doc) {
      requireUnlocked(); const descriptor=manifest.documents[doc.id];
      if(!descriptor) throw new Error("This report is not part of the shared study.");
      const bytes=await encrypted(descriptor.asset);
      if(reportUrl) URL.revokeObjectURL(reportUrl);
      reportUrl=URL.createObjectURL(new Blob([bytes],{type:descriptor.mime}));
      document.getElementById("report-title").textContent=doc.study || doc.name;
      const pages=document.getElementById("report-pages"); pages.replaceChildren();
      for (const url of reportPageUrls) URL.revokeObjectURL(url);
      reportPageUrls=[];
      for(const [index,asset] of descriptor.pages.entries()) {
        const page=await encrypted(asset), url=URL.createObjectURL(new Blob([page],{type:"image/png"}));
        reportPageUrls.push(url);
        const image=document.createElement("img"); image.src=url; image.alt=`Report page ${index+1}`; pages.append(image);
      }
      const link=document.getElementById("report-download"); link.href=reportUrl; link.download=descriptor.name;
      document.getElementById("report-dialog").showModal();
    }
  };
  document.addEventListener("DOMContentLoaded",()=>{
    document.getElementById("lock-viewer").onclick=()=>location.reload();
    const report=document.getElementById("report-dialog");
    document.getElementById("report-close").onclick=()=>report.close();
    report.addEventListener("close",()=>{document.getElementById("report-pages").replaceChildren(); for(const url of reportPageUrls) URL.revokeObjectURL(url); reportPageUrls=[]; if(reportUrl) URL.revokeObjectURL(reportUrl); reportUrl=null;});
    document.getElementById("unlock-form").onsubmit=async event=>{
      event.preventDefault();
      const button=document.getElementById("unlock-button"),input=document.getElementById("sharing-password"),status=document.getElementById("unlock-status");
      button.disabled=true; status.textContent="Unlocking the encrypted study…";
      try {
        if(!crypto.subtle || !window.DecompressionStream) throw new Error("Please use a current Safari, Chrome, Firefox, or Edge browser.");
        const response=await fetch("/config.json",{cache:"no-store"});
        if(!response.ok) throw new Error("The sharing settings could not be loaded.");
        const config=await response.json(),candidate=await helper.derive(input.value,config);
        let decoded;
        try { decoded=await encrypted("manifest.bin",candidate); }
        catch(error) { if(error.name==="OperationError") throw new Error("That password did not unlock the study. Please try again."); throw error; }
        const parsed=JSON.parse(new TextDecoder().decode(decoded));
        if(parsed.version!==1 || !parsed.library?.series || !parsed.frames || !parsed.files) throw new Error("The shared study could not be read.");
        manifest=parsed; key=candidate; input.value=""; status.textContent="";
        document.body.classList.remove("locked"); document.body.classList.add("unlocked");
        window.dispatchEvent(new Event("imaging-ready"));
      } catch(error) { status.textContent=error.message || "The study could not be unlocked."; }
      finally {button.disabled=false;}
    };
  });
})();
