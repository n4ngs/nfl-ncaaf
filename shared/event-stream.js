'use strict';
const zlib = require('node:zlib');
function acceptsGzip(value) {
  return String(value || '').split(',').some(token => {
    const [name,...params] = token.trim().toLowerCase().split(';');
    if (name.trim() !== 'gzip') return false;
    const quality = params.find(p=>p.trim().startsWith('q='));
    return !quality || Number(quality.trim().slice(2)) > 0;
  });
}
function pipeEventStream(upstream, response, requestHeaders, headers, statusCode) {
  const gzip = /text\/event-stream/i.test(String(headers['content-type'] || '')) && !headers['content-encoding'] && acceptsGzip(requestHeaders['accept-encoding']);
  if (!gzip) return false;
  const encoded = zlib.createGzip({level:zlib.constants.Z_BEST_SPEED,flush:zlib.constants.Z_SYNC_FLUSH});
  const out = {...headers,'content-encoding':'gzip','x-accel-buffering':'no'};
  delete out['content-length'];
  out.vary = [...new Set(String(out.vary || '').split(',').map(s=>s.trim()).filter(Boolean).concat('accept-encoding'))].join(', ');
  response.writeHead(statusCode,out);
  const cleanup = () => {upstream.destroy();encoded.destroy();};
  response.once('close',cleanup);
  upstream.once('error',error=>{encoded.destroy();response.destroy(error);});
  encoded.once('error',error=>{upstream.destroy();response.destroy(error);});
  upstream.pipe(encoded).pipe(response);
  return true;
}
module.exports = {pipeEventStream,acceptsGzip};
