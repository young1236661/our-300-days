const root = new URL('./', import.meta.url);

async function getFile(url, signal, cache = 'default') {
  const response = await fetch(url, {signal, cache});
  if (!response.ok) throw new Error(`Could not load ${url} (HTTP ${response.status})`);
  return response;
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
      const packed = await getFile(new URL('packed/0.10.32/' + name + '.br.bin', root), signal, 'force-cache');
      const decoded = packed.body.pipeThrough(decoder);
      return await new Response(decoded, {headers: {'Content-Type': 'application/wasm'}}).blob();
    } catch (error) {
      if (signal.aborted) throw error;
    }
  }
  const original = await getFile(url, signal);
  return original.blob();
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
      getFile(new URL('hand_landmarker.task', root), transfer.signal).then(response => response.arrayBuffer()),
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
