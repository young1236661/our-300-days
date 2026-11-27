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

async function loadRuntime(signal) {
  const {FilesetResolver, HandLandmarker} = await import('./vendor/vision_bundle.mjs');
  const files = await FilesetResolver.forVisionTasks(new URL('vendor/wasm', root).href);
  const engine = await loadEngine(files.wasmBinaryPath, signal);
  return {files, engine, HandLandmarker};
}

export async function createDetector({signal, onDownloaded} = {}) {
  const transfer = new AbortController();
  const abort = () => transfer.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, {once: true});
  let engineUrl;
  try {
    const [model, {files, engine, HandLandmarker}] = await Promise.all([
      getFile(new URL('hand_landmarker.task', root), transfer.signal).then(response => response.arrayBuffer()),
      loadRuntime(transfer.signal)
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
