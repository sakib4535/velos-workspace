/* Keep camera inference off the call's UI thread whenever the browser supports it. */
export async function createGestureTracker(config, onStatus = () => {}) {
  let detector = null;
  let closed = false;
  let worker = null;
  let requestId = 0;
  const pending = new Map();

  function closeWorker() {
    worker?.terminate();
    worker = null;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error('Hand tracking worker stopped'));
    }
    pending.clear();
  }

  function request(type, data = {}, transfer = [], timeout = 2500) {
    return new Promise((resolve, reject) => {
      const id = ++requestId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Hand tracking worker timed out'));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      try {
        worker.postMessage({ id, type, ...data }, transfer);
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  async function createMainDetector() {
    onStatus('loading browser hand tracking…');
    const vision = await timed(import(config.bundleUrl), 12000, 'MediaPipe library');
    const fileset = await timed(vision.FilesetResolver.forVisionTasks(config.wasmUrl), 12000, 'MediaPipe runtime');
    const options = {
      baseOptions: { modelAssetPath: config.modelUrl },
      runningMode: 'VIDEO', numHands: 1,
      minHandDetectionConfidence: 0.55,
      minHandPresenceConfidence: 0.55,
      minTrackingConfidence: 0.55
    };
    let model;
    try {
      model = await timed(vision.HandLandmarker.createFromOptions(fileset, {
        ...options, baseOptions: { ...options.baseOptions, delegate: 'GPU' }
      }), 12000, 'GPU hand tracking', closeLateModel);
    } catch (_) {
      onStatus('loading CPU hand tracking…');
      model = await timed(vision.HandLandmarker.createFromOptions(fileset, options), 15000, 'CPU hand tracking', closeLateModel);
    }
    if (closed) {
      model.close();
      throw new Error('Hand tracking stopped');
    }
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) {
      model.close();
      throw new Error('Camera frame processing is unavailable');
    }
    return {
      async detect(video, timestamp) {
        const { width, height } = frameSize(video, config.inputWidth);
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
        context.drawImage(video, 0, 0, width, height);
        return model.detectForVideo(canvas, timestamp)?.landmarks?.[0] || null;
      },
      close() { model.close(); }
    };
  }

  if (typeof Worker !== 'undefined' && typeof createImageBitmap === 'function' && typeof OffscreenCanvas !== 'undefined') {
    try {
      /* The MediaPipe WASM loader uses importScripts, so this must be a classic worker. */
      worker = new Worker(new URL('./gesture-worker.js', import.meta.url));
      worker.onmessage = ({ data }) => {
        const item = pending.get(data.id);
        if (!item) return;
        pending.delete(data.id);
        clearTimeout(item.timer);
        if (data.error) item.reject(new Error(data.error));
        else item.resolve(data.landmarks || null);
      };
      worker.onerror = () => closeWorker();
      await request('init', { config }, [], 30000);
    } catch (_) {
      closeWorker();
    }
  }

  try {
    if (!worker) detector = await createMainDetector();
  } catch (error) {
    closeWorker();
    throw error;
  }

  return {
    async detect(video, timestamp) {
      if (closed) return null;
      if (worker) {
        let bitmap;
        try {
          const { width, height } = frameSize(video, config.inputWidth);
          bitmap = await createImageBitmap(video, { resizeWidth: width, resizeHeight: height, resizeQuality: 'low' });
          if (closed) { bitmap.close(); return null; }
          return await request('detect', { frame: bitmap, timestamp }, [bitmap]);
        } catch (error) {
          bitmap?.close();
          if (closed) return null;
          closeWorker();
          detector = await createMainDetector();
        }
      }
      if (!closed && !detector) detector = await createMainDetector();
      return closed ? null : detector.detect(video, timestamp);
    },
    close() {
      closed = true;
      closeWorker();
      detector?.close();
      detector = null;
    }
  };
}

export function frameSize(video, maxWidth) {
  const scale = Math.min(1, maxWidth / video.videoWidth);
  return { width: Math.max(1, Math.round(video.videoWidth * scale)), height: Math.max(1, Math.round(video.videoHeight * scale)) };
}

function closeLateModel(model) { try { model?.close(); } catch (_) { /* already released */ } }

function timed(promise, timeout, label, onLateValue) {
  let expired = false;
  let timer;
  const guarded = Promise.resolve(promise).then((value) => {
    if (expired) onLateValue?.(value);
    return value;
  });
  return Promise.race([
    guarded,
    new Promise((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(new Error(`${label} timed out`)); }, timeout);
    })
  ]).finally(() => clearTimeout(timer));
}
