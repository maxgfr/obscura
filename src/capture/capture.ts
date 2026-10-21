/**
 * Opening captures. The browser asks for each one (and the screen picker
 * cannot be skipped or remembered): the studio restores layouts, never
 * access. Device ids are used for the session only and never saved.
 */

export type NoiseMode = "off" | "browser" | "rnnoise";

export function micConstraints(noise: NoiseMode, deviceId: string): MediaTrackConstraints {
  const browser = noise === "browser";
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    echoCancellation: noise !== "off",
    noiseSuppression: browser,
    autoGainControl: browser,
    channelCount: { ideal: 2 },
    sampleRate: { ideal: 48_000 },
  };
}

export function cameraConstraints(deviceId: string, fps: number): MediaTrackConstraints {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: Math.min(fps, 60) },
  };
}

export function displayOptions(fps: number): DisplayMediaStreamOptions {
  return {
    video: {
      frameRate: { ideal: fps, max: fps },
      width: { max: 3840 },
      height: { max: 2160 },
    },
    // Tab audio everywhere; system audio on Windows and ChromeOS.
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    // Chromium hints; others ignore them.
    selfBrowserSurface: "exclude",
    systemAudio: "include",
    surfaceSwitching: "include",
    monitorTypeSurfaces: "include",
  } as DisplayMediaStreamOptions;
}

export function canCaptureScreen(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia;
}

export async function openDisplay(fps: number): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getDisplayMedia(displayOptions(fps));
  const v = stream.getVideoTracks()[0];
  if (v) v.contentHint = "detail";
  return stream;
}

/** Opens a device; a remembered device that is gone falls back to the default. */
export async function openDevice(
  kind: "camera" | "mic",
  deviceId: string,
  opts: { fps: number; noise: NoiseMode },
): Promise<MediaStream> {
  const build = (id: string): MediaStreamConstraints =>
    kind === "camera"
      ? { video: cameraConstraints(id, opts.fps), audio: false }
      : { audio: micConstraints(opts.noise, id), video: false };
  try {
    return await navigator.mediaDevices.getUserMedia(build(deviceId));
  } catch (err) {
    const name = err instanceof DOMException ? err.name : "";
    if (!deviceId || !["OverconstrainedError", "NotFoundError", "NotReadableError"].includes(name))
      throw err;
    return navigator.mediaDevices.getUserMedia(build(""));
  }
}

export interface DeviceInfo {
  id: string;
  label: string;
}

export async function listDevices(): Promise<{ mics: DeviceInfo[]; cams: DeviceInfo[] }> {
  const all = await navigator.mediaDevices.enumerateDevices();
  const real = all.filter(
    (d) => d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications",
  );
  const pick = (kind: MediaDeviceKind, fallback: string) =>
    real
      .filter((d) => d.kind === kind)
      .map((d, i) => ({ id: d.deviceId, label: d.label || `${fallback} ${i + 1}` }));
  return { mics: pick("audioinput", "Microphone"), cams: pick("videoinput", "Camera") };
}

/** Human message for a capture error. */
export function captureError(err: unknown): string {
  const name = err instanceof DOMException || err instanceof Error ? err.name : "";
  switch (name) {
    case "NotAllowedError":
      return "Permission denied. Allow access in the address bar to use this source.";
    case "NotFoundError":
      return "No such device is connected.";
    case "NotReadableError":
      return "The device is busy or blocked by the system.";
    case "AbortError":
      return "Cancelled.";
    default:
      return err instanceof Error ? err.message : "Could not open this source.";
  }
}
