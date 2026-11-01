(function (scope) {
  "use strict";
  const encoder = new TextEncoder();
  async function derive(password, config) {
    const salt = Uint8Array.from(atob(config.salt), c => c.charCodeAt(0));
    const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({name:"PBKDF2", salt, iterations:config.iterations, hash:"SHA-256"}, material, {name:"AES-GCM", length:256}, false, ["decrypt"]);
  }
  async function decrypt(buffer, key, relative) {
    const bytes = new Uint8Array(buffer);
    const compressed = await crypto.subtle.decrypt({name:"AES-GCM",iv:bytes.slice(0,12),additionalData:encoder.encode(`mri-share-v1:${relative}`),tagLength:128},key,bytes.slice(12));
    return new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  }
  function decodePixels(buffer, descriptor, meta) {
    const count = meta.rows * meta.columns, bytes = descriptor.bits / 8;
    const start = descriptor.offset + meta.frame * count * bytes;
    if (start + count * bytes > buffer.byteLength) throw new Error("The image data is incomplete.");
    const view = new DataView(buffer), output = new Float32Array(count);
    const mask = 2 ** descriptor.stored - 1, sign = 2 ** (descriptor.stored - 1);
    for (let i = 0; i < count; i++) {
      let value = (bytes === 2 ? view.getUint16(start + i * 2, true) : view.getUint8(start + i)) & mask;
      if (descriptor.signed && value >= sign) value -= 2 ** descriptor.stored;
      output[i] = Math.fround(Math.fround(value * meta.slope) + meta.intercept);
    }
    return output;
  }
  function grayscale(pixels, meta, center, width, invert=false) {
    const output = new Uint8ClampedArray(pixels.length * 4), c = center ?? meta.center, w = Math.max(1,width ?? meta.width);
    const reversed = (meta.photometric === "MONOCHROME1") !== invert;
    for (let i = 0; i < pixels.length; i++) {
      let value;
      if (meta.voi_function === "SIGMOID") value = 1 / (1 + Math.exp(Math.max(-80,Math.min(80,-4*(pixels[i]-c)/w))));
      else if (meta.voi_function === "LINEAR_EXACT") value = (pixels[i]-c)/w+.5;
      else if (w <= 1) value = pixels[i] > c-.5 ? 1 : 0;
      else value = (pixels[i]-(c-.5))/(w-1)+.5;
      value = Number.isFinite(value) ? Math.max(0,Math.min(1,value)) : 0;
      if (reversed) value = 1 - value;
      const shade = Math.floor(value*255);
      output[i*4] = output[i*4+1] = output[i*4+2] = shade; output[i*4+3] = 255;
    }
    return output;
  }
  scope.MRIShareCrypto = {derive,decrypt,decodePixels,grayscale};
})(globalThis);
