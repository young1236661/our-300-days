const root = new URL('./', import.meta.url);

// Normal downloads retain HTTP compression. Resume only after a stalled or
// broken connection. HTTP byte ranges refer to the uncompressed static file.
async function readAsset(url, signal, cache = 'default') {
  const chunks = [];
  let received = 0;
  let interruptions = 0;
  const pieceSize = 768 * 1024;
  for (;;) {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    const request = new AbortController();
    const abort = () => request.abort();
    signal.addEventListener('abort', abort, {once: true});
    const target = new URL(url);
    const headers = {};
    const resume = interruptions > 0;
    const start = received;
    const end = start + pieceSize - 1;
    if (resume) {
      headers.Range = 'bytes=' + start + '-' + end;
      target.searchParams.set('part', start + '-' + end);
      target.searchParams.set('attempt', String(interruptions));
    }
    let timer, stalled = false;
    function watch() {
      clearTimeout(timer);
      timer = setTimeout(() => { stalled = true; abort(); }, resume ? 30000 : 15000);
    }
    try {
      watch();
      const response = await fetch(target, {signal: request.signal, cache, headers});
      if (!response.ok) throw new Error('Could not load ' + target.pathname + ' (HTTP ' + response.status + ')');
      let range;
      if (response.status === 206) {
        range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') || '');
        if (!range || !resume || +range[1] !== start || +range[2] > end || +range[2] < start || +range[3] <= +range[2]) {
          throw new Error('Unexpected asset byte range');
        }
      } else {
        // Servers that ignore Range return a complete replacement.
        received = 0;
        chunks.length = 0;
      }
      const reader = response.body.getReader();
      for (;;) {
        watch();
        const {value, done} = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
      }
      if (range && received !== +range[2] + 1) throw new Error('Incomplete asset byte range');
      if (!range || received === +range[3]) return new Blob(chunks);
    } catch (error) {
      if (signal.aborted || (!stalled && !(error instanceof TypeError)) || interruptions >= 3) throw error;
      interruptions++;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      request.abort();
    }
  }
}

async function loadEngine(url, signal) {
  let decoder;
  try {
    decoder = new DecompressionStream('brotli');
  } catch {
    // Older Safari versions can use the original HTTP-compressed WASM.
  }
  if (decoder) {
    const name = new URL(url).pathname.split('/').pop();
    try {
      const packed = await readAsset(new URL('packed/0.10.32/' + name + '.br.bin', root), signal, 'force-cache');
      const decoded = packed.stream().pipeThrough(decoder);
      return await new Response(decoded, {headers: {'Content-Type': 'application/wasm'}}).blob();
    } catch (error) {
      if (signal.aborted) throw error;
    }
  }
  const original = await readAsset(url, signal);
  return original.slice(0, original.size, 'application/wasm');
}

// Same SIMD instructions used by FilesetResolver in the pinned MediaPipe 0.10.32.
// Check them locally so a slow JS response cannot delay the engine download.
const simdProbe = Uint8Array.of(0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11);
function engineFiles() {
  const name = WebAssembly.validate(simdProbe) ? 'vision_wasm_internal' : 'vision_wasm_nosimd_internal';
  const base = new URL('vendor/wasm/' + name, root).href;
  return {wasmLoaderPath: base + '.js', wasmBinaryPath: base + '.wasm'};
}

export async function createDetector({signal, onDownloaded} = {}) {
  const transfer = new AbortController();
  const abort = () => transfer.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, {once: true});
  let engineUrl;
  try {
    const files = engineFiles();
    const [model, engine, {HandLandmarker}] = await Promise.all([
      readAsset(new URL('hand_landmarker.task', root), transfer.signal).then(blob => blob.arrayBuffer()),
      loadEngine(files.wasmBinaryPath, transfer.signal),
      import('./vendor/vision_bundle.mjs')
    ]);
    onDownloaded?.();
    engineUrl = URL.createObjectURL(engine);
    return await HandLandmarker.createFromOptions({...files, wasmBinaryPath: engineUrl}, {
      baseOptions: {modelAssetBuffer: new Uint8Array(model), delegate: 'CPU'},
      runningMode: 'VIDEO', numHands: 1, minHandDetectionConfidence: .60,
      minHandPresenceConfidence: .58, minTrackingConfidence: .58
    });
  } finally {
    transfer.abort();
    signal?.removeEventListener('abort', abort);
    if (engineUrl) URL.revokeObjectURL(engineUrl);
  }
}
