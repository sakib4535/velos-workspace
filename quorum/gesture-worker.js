/* Classic worker: MediaPipe's WASM runtime needs importScripts support. */
let landmarker = null;

self.onmessage = async ({ data }) => {
  const { id, type, frame, timestamp, config } = data;
  try {
    if (type === 'init') {
      const vision = await import(config.bundleUrl);
      const fileset = await vision.FilesetResolver.forVisionTasks(config.wasmUrl);
      const options = {
        baseOptions: { modelAssetPath: config.modelUrl },
        runningMode: 'VIDEO', numHands: 1,
        minHandDetectionConfidence: 0.55,
        minHandPresenceConfidence: 0.55,
        minTrackingConfidence: 0.55
      };
      try {
        landmarker = await vision.HandLandmarker.createFromOptions(fileset, {
          ...options,
          canvas: new OffscreenCanvas(1, 1),
          baseOptions: { ...options.baseOptions, delegate: 'GPU' }
        });
      } catch (_) {
        landmarker = await vision.HandLandmarker.createFromOptions(fileset, options);
      }
      self.postMessage({ id });
    } else if (type === 'detect') {
      if (!landmarker) throw new Error('Hand tracking is not ready');
      const result = landmarker.detectForVideo(frame, timestamp);
      self.postMessage({ id, landmarks: result?.landmarks?.[0] || null });
    }
  } catch (error) {
    self.postMessage({ id, error: error?.message || 'Hand tracking failed' });
  } finally {
    frame?.close();
  }
};
