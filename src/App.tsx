/*
  React HSV Range Picker via Camera / Video / Image (OpenCV.js)
  ------------------------------------------------------------
  • Tech: React + TypeScript + TailwindCSS
  • Features: camera selection, start/stop, HSV sliders, blur/morph toggles,
              live mask preview, eyedropper on click, file upload (image/video),
              fully responsive.

  Setup notes:
  1) Ensure Tailwind is configured in your project.
  2) Add OpenCV.js script in your index.html (or host locally):
     <script async src="https://docs.opencv.org/4.x/opencv.js"></script>
  3) Import and use this component: <HsvPicker />
*/

import React, { useEffect, useMemo, useRef, useState, type JSX } from "react";

// Minimal ambient type for OpenCV.js
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const cv: any;

type SourceMode = "camera" | "video" | "image";

type Range = {
  hMin: number;
  hMax: number;
  sMin: number;
  sMax: number;
  vMin: number;
  vMax: number;
};

type Eyedrop = {
  x: number;
  y: number;
  H: number;
  S: number;
  V: number;
} | null;

const defaultRange: Range = { hMin: 0, hMax: 179, sMin: 50, sMax: 255, vMin: 50, vMax: 255 };

export default function HsvPicker(): JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);

  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>("");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [opencvReady, setOpencvReady] = useState<boolean>(false);

  const [sourceMode, setSourceMode] = useState<SourceMode>("camera");
  const [imageURL, setImageURL] = useState<string>("");
  const [videoURL, setVideoURL] = useState<string>("");

  const [range, setRange] = useState<Range>(defaultRange);
  const [useBlur, setUseBlur] = useState<boolean>(true);
  const [useMorph, setUseMorph] = useState<boolean>(false);
  const [eyedrop, setEyedrop] = useState<Eyedrop>(null);

  // OpenCV mats cache
  const matsRef = useRef<{ src?: any; hsv?: any; mask?: any; dst?: any; kernel?: any } | null>({});

  // ————————————————————————————————————————————————
  // Helpers: devices & camera control
  // ————————————————————————————————————————————————
  const refreshDevices = async (): Promise<void> => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      const cams = list.filter((d) => d.kind === "videoinput");
      setDevices(cams);
      if (!deviceId && cams.length > 0) setDeviceId(cams[0].deviceId);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("enumerateDevices failed", e);
    }
  };

  const startCamera = async (): Promise<void> => {
    setSourceMode("camera");
    try {
      if (stream) stopCamera();
      const constraints: MediaStreamConstraints = {
        video: deviceId
          ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
          : { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      };
      const s = await navigator.mediaDevices.getUserMedia(constraints);
      setStream(s);
      if (videoRef.current) {
        videoRef.current.srcObject = s;
        await videoRef.current.play();
        // Wait for intrinsic size
        await new Promise<void>((resolve) => {
          const v = videoRef.current!;
          if (v.readyState >= 2 && v.videoWidth && v.videoHeight) return resolve();
          const onLoaded = (): void => {
            v.removeEventListener("loadeddata", onLoaded);
            resolve();
          };
          v.addEventListener("loadeddata", onLoaded, { once: true });
        });
      }
      setIsRunning(true);
    } catch (e: any) {
      alert("Failed to access camera: " + e?.message);
    }
  };

  const stopCamera = (): void => {
    try {
      setIsRunning(false);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
        setStream(null);
      }
      if (videoRef.current) {
        videoRef.current.pause();
        videoRef.current.srcObject = null;
        if (videoURL) {
          videoRef.current.removeAttribute("src");
        }
      }
    } catch {
      /* noop */
    }
  };

  // ————————————————————————————————————————————————
  // OpenCV runtime readiness
  // ————————————————————————————————————————————————
  useEffect(() => {
    let mounted = true;
    const check = (): void => {
      try {
        if (typeof cv !== "undefined" && cv?.Mat) {
          if (mounted) setOpencvReady(true);
        } else {
          setTimeout(check, 120);
        }
      } catch {
        setTimeout(check, 150);
      }
    };
    check();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!opencvReady) return;
    const maybeInit = async (): Promise<void> => {
      await refreshDevices();
      await startCamera();
    };
    if (cv?.onRuntimeInitialized) {
      const prev = cv.onRuntimeInitialized;
      cv.onRuntimeInitialized = (): void => {
        prev?.();
        void maybeInit();
      };
    } else {
      void maybeInit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opencvReady]);

  useEffect(() => {
    if (!opencvReady) return;
    // restart camera on device change if in camera mode
    if (sourceMode === "camera" && (stream || devices.length)) {
      void startCamera();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);

  // ————————————————————————————————————————————————
  // Upload handlers
  // ————————————————————————————————————————————————
  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (!file) return;
    stopCamera();
    if (imageURL) URL.revokeObjectURL(imageURL);
    const url = URL.createObjectURL(file);
    setImageURL(url);
    setSourceMode("image");
    setIsRunning(true);
  };

  const handleVideoUpload = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    if (!file || !videoRef.current) return;
    stopCamera();
    if (videoURL) URL.revokeObjectURL(videoURL);
    const url = URL.createObjectURL(file);
    setVideoURL(url);
    setSourceMode("video");
    const v = videoRef.current;
    v.srcObject = null;
    v.src = url;
    await v.play();
    await new Promise<void>((resolve) => {
      if (v.readyState >= 2 && v.videoWidth && v.videoHeight) return resolve();
      const onLoaded = (): void => {
        v.removeEventListener("loadeddata", onLoaded);
        resolve();
      };
      v.addEventListener("loadeddata", onLoaded, { once: true });
    });
    setIsRunning(true);
  };

  // ————————————————————————————————————————————————
  // Processing loop
  // ————————————————————————————————————————————————
  const tick = (): void => {
    if (!isRunning || !canvasRef.current || typeof cv === "undefined") {
      return;
    }

    const canvas = canvasRef.current;
    const v = videoRef.current;
    const img = imageRef.current;
    const usingImage = sourceMode === "image" && img && img.complete && img.naturalWidth > 0;
    const usingVideo = sourceMode !== "image" && v && v.readyState >= 2 && v.videoWidth > 0 && v.videoHeight > 0;

    if (!usingImage && !usingVideo) {
      rafRef.current = requestAnimationFrame(tick);
      return;
    }

    const w = usingImage ? img!.naturalWidth : v!.videoWidth;
    const h = usingImage ? img!.naturalHeight : v!.videoHeight;

    const mats = matsRef.current!;

    // Allocate mats if needed
    if (!mats.src || mats.src.cols !== w || mats.src.rows !== h) {
      mats.src?.delete?.();
      mats.hsv?.delete?.();
      mats.mask?.delete?.();
      mats.dst?.delete?.();
      mats.kernel?.delete?.();

      mats.src = new cv.Mat(h, w, cv.CV_8UC4);
      mats.hsv = new cv.Mat(h, w, cv.CV_8UC3);
      mats.mask = new cv.Mat(h, w, cv.CV_8UC1);
      mats.dst = new cv.Mat(h, w, cv.CV_8UC1);
      mats.kernel = cv.Mat.ones(3, 3, cv.CV_8U);
      canvas.width = w;
      canvas.height = h;
    }

    try {
      // Grab current frame via offscreen canvas to avoid VideoCapture size issues
      if (!offscreenRef.current) offscreenRef.current = document.createElement("canvas");
      const grab = offscreenRef.current;
      grab.width = w;
      grab.height = h;
      const gctx = grab.getContext("2d");
      if (!gctx) throw new Error("2D context not available");
      if (usingImage) {
        gctx.drawImage(img as HTMLImageElement, 0, 0, w, h);
      } else {
        gctx.drawImage(v as HTMLVideoElement, 0, 0, w, h);
      }
      const imgData = gctx.getImageData(0, 0, w, h);
      mats.src.data.set(imgData.data);

      // RGBA -> BGR -> HSV
      cv.cvtColor(mats.src, mats.hsv, cv.COLOR_RGBA2BGR);
      if (useBlur) cv.GaussianBlur(mats.hsv, mats.hsv, new cv.Size(3, 3), 0, 0, cv.BORDER_DEFAULT);

      const low = new cv.Mat(h, w, cv.CV_8UC3, new cv.Scalar(range.hMin, range.sMin, range.vMin, 0));
      const high = new cv.Mat(h, w, cv.CV_8UC3, new cv.Scalar(range.hMax, range.sMax, range.vMax, 255));
      cv.inRange(mats.hsv, low, high, mats.mask);
      low.delete();
      high.delete();

      if (useMorph) {
        cv.morphologyEx(mats.mask, mats.dst, cv.MORPH_OPEN, mats.kernel);
      } else {
        mats.mask.copyTo(mats.dst);
      }

      cv.imshow(canvas, mats.dst);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(e);
      setIsRunning(false);
      return;
    }

    rafRef.current = requestAnimationFrame(tick);
  };

  useEffect(() => {
    if (isRunning) {
      rafRef.current = requestAnimationFrame(tick);
      return () => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
      };
    }
    return;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning, range, useBlur, useMorph, sourceMode]);

  // ————————————————————————————————————————————————
  // Eyedropper for both image and video
  // ————————————————————————————————————————————————
  const onSourceClick = (clientX: number, clientY: number): void => {
    if (!matsRef.current?.src) return;

    let px = 0;
    let py = 0;

    if (sourceMode === "image" && imageRef.current) {
      const el = imageRef.current;
      const rect = el.getBoundingClientRect();
      px = Math.floor(((clientX - rect.left) * el.naturalWidth) / rect.width);
      py = Math.floor(((clientY - rect.top) * el.naturalHeight) / rect.height);
    } else if (videoRef.current) {
      const el = videoRef.current;
      const rect = el.getBoundingClientRect();
      px = Math.floor(((clientX - rect.left) * el.videoWidth) / rect.width);
      py = Math.floor(((clientY - rect.top) * el.videoHeight) / rect.height);
    } else {
      return;
    }

    px = Math.max(0, Math.min(px, matsRef.current.src.cols - 1));
    py = Math.max(0, Math.min(py, matsRef.current.src.rows - 1));

    const roi = matsRef.current.src.roi(new cv.Rect(px, py, 1, 1));
    const bgr = new cv.Mat();
    const hsv1 = new cv.Mat();
    cv.cvtColor(roi, bgr, cv.COLOR_RGBA2BGR);
    cv.cvtColor(bgr, hsv1, cv.COLOR_BGR2HSV);
    const H = hsv1.ucharPtr(0, 0)[0];
    const S = hsv1.ucharPtr(0, 0)[1];
    const V = hsv1.ucharPtr(0, 0)[2];
    setEyedrop({ x: px, y: py, H, S, V });
    roi.delete();
    bgr.delete();
    hsv1.delete();
  };

  // Cleanup mats + stream
  useEffect(() => {
    return () => {
      stopCamera();
      const mats = matsRef.current;
      mats?.src?.delete?.();
      mats?.hsv?.delete?.();
      mats?.mask?.delete?.();
      mats?.dst?.delete?.();
      mats?.kernel?.delete?.();
      if (imageURL) URL.revokeObjectURL(imageURL);
      if (videoURL) URL.revokeObjectURL(videoURL);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rangeText = useMemo(
    () => `inRange: H[${range.hMin},${range.hMax}] S[${range.sMin},${range.sMax}] V[${range.vMin},${range.vMax}]`,
    [range]
  );

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 sm:p-6">
      <div className="mx-auto max-w-6xl space-y-4">
        <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">HSV Range Picker (OpenCV.js)</h1>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={startCamera}
              className="px-3 py-2 rounded-2xl border border-slate-700 bg-slate-800 hover:bg-slate-700 text-sm"
            >Start Camera</button>
            <button
              onClick={stopCamera}
              className="px-3 py-2 rounded-2xl border border-slate-700 bg-slate-900 hover:bg-slate-800 text-sm"
            >Stop</button>

            <label className="text-xs sm:text-sm flex items-center gap-2 px-2 py-1 rounded-xl border border-slate-800 bg-slate-900">
              <span className="opacity-80">Camera</span>
              <select
                value={deviceId}
                onChange={(e) => setDeviceId(e.target.value)}
                className="bg-transparent text-slate-100 text-xs sm:text-sm outline-none"
              >
                {devices.map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId} className="bg-slate-900">
                    {d.label || `Camera ${i + 1}`}
                  </option>
                ))}
              </select>
            </label>

            {/* Upload buttons */}
            <label className="text-xs sm:text-sm flex items-center gap-2 px-2 py-1 rounded-xl border border-slate-800 bg-slate-900 cursor-pointer" title="Upload image">
              <input type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
              <span className="opacity-80">Upload Image</span>
            </label>
            <label className="text-xs sm:text-sm flex items-center gap-2 px-2 py-1 rounded-xl border border-slate-800 bg-slate-900 cursor-pointer" title="Upload video">
              <input type="file" accept="video/*" className="hidden" onChange={handleVideoUpload} />
              <span className="opacity-80">Upload Video</span>
            </label>

            <label className="text-xs sm:text-sm flex items-center gap-2 px-2 py-1 rounded-xl border border-slate-800 bg-slate-900">
              <input type="checkbox" checked={useBlur} onChange={(e) => setUseBlur(e.target.checked)} />
              <span className="opacity-80">Blur 3×3</span>
            </label>
            <label className="text-xs sm:text-sm flex items-center gap-2 px-2 py-1 rounded-xl border border-slate-800 bg-slate-900">
              <input type="checkbox" checked={useMorph} onChange={(e) => setUseMorph(e.target.checked)} />
              <span className="opacity-80">Morph (open 3×3)</span>
            </label>
          </div>
        </header>

        <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Preview panel */}
          <div className="rounded-3xl border border-slate-800 bg-slate-900/60 p-3 sm:p-4 shadow-xl shadow-black/20">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <div className="text-xs mb-2 opacity-70">Original</div>
                <div className="overflow-hidden rounded-2xl border border-slate-800 bg-black">
                  {sourceMode === "image" ? (
                    <img
                      ref={imageRef}
                      src={imageURL}
                      onClick={(e) => onSourceClick(e.clientX, e.clientY)}
                      className="w-full h-auto cursor-crosshair select-none"
                      alt="uploaded"
                    />
                  ) : (
                    <video
                      ref={videoRef}
                      onClick={(e) => onSourceClick(e.clientX, e.clientY)}
                      playsInline
                      muted={sourceMode === "camera"}
                      autoPlay
                      className="w-full h-auto cursor-crosshair select-none"
                    />
                  )}
                </div>
              </div>
              <div>
                <div className="text-xs mb-2 opacity-70">Mask (inRange)</div>
                <div className="overflow-hidden rounded-2xl border border-slate-800 bg-black">
                  <canvas ref={canvasRef} className="w-full h-auto" />
                </div>
              </div>
            </div>
            <p className="text-xs mt-2 opacity-70">Click the original to sample exact HSV at a pixel.</p>
          </div>

          {/* Controls panel */}
          <div className="rounded-3xl border border-slate-800 bg-slate-900/60 p-4 shadow-xl shadow-black/20 space-y-4">
            <div className="grid grid-cols-[110px_1fr_60px] items-center gap-y-3 gap-x-3">
              {/* H */}
              <label className="text-slate-300/90">H min</label>
              <input
                type="range"
                min={0}
                max={179}
                value={range.hMin}
                onChange={(e) => setRange((r) => ({ ...r, hMin: Number(e.target.value) }))}
                className="w-full accent-indigo-400"
              />
              <output className="text-right text-slate-400">{range.hMin}</output>

              <label className="text-slate-300/90">H max</label>
              <input
                type="range"
                min={0}
                max={179}
                value={range.hMax}
                onChange={(e) => setRange((r) => ({ ...r, hMax: Number(e.target.value) }))}
                className="w-full accent-indigo-400"
              />
              <output className="text-right text-slate-400">{range.hMax}</output>

              {/* S */}
              <label className="text-slate-300/90">S min</label>
              <input
                type="range"
                min={0}
                max={255}
                value={range.sMin}
                onChange={(e) => setRange((r) => ({ ...r, sMin: Number(e.target.value) }))}
                className="w-full accent-indigo-400"
              />
              <output className="text-right text-slate-400">{range.sMin}</output>

              <label className="text-slate-300/90">S max</label>
              <input
                type="range"
                min={0}
                max={255}
                value={range.sMax}
                onChange={(e) => setRange((r) => ({ ...r, sMax: Number(e.target.value) }))}
                className="w-full accent-indigo-400"
              />
              <output className="text-right text-slate-400">{range.sMax}</output>

              {/* V */}
              <label className="text-slate-300/90">V min</label>
              <input
                type="range"
                min={0}
                max={255}
                value={range.vMin}
                onChange={(e) => setRange((r) => ({ ...r, vMin: Number(e.target.value) }))}
                className="w-full accent-indigo-400"
              />
              <output className="text-right text-slate-400">{range.vMin}</output>

              <label className="text-slate-300/90">V max</label>
              <input
                type="range"
                min={0}
                max={255}
                value={range.vMax}
                onChange={(e) => setRange((r) => ({ ...r, vMax: Number(e.target.value) }))}
                className="w-full accent-indigo-400"
              />
              <output className="text-right text-slate-400">{range.vMax}</output>
            </div>

            <div className="text-xs rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 font-mono">
              {rangeText}
            </div>

            <div className="text-xs rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 font-mono">
              Eyedrop: {eyedrop ? `@(${eyedrop.x},${eyedrop.y}) → H:${eyedrop.H} S:${eyedrop.S} V:${eyedrop.V}` : "—"}
            </div>
          </div>
        </section>

        <footer className="text-xs opacity-60">
          H range: 0–179, S/V range: 0–255 (OpenCV convention). Works best on HTTPS or localhost due to camera permissions.
        </footer>
      </div>
    </div>
  );
}
