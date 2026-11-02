import type { MeetingClip } from './meeting-video-sequence';

interface CameraKey { time: number; scale: number; x: number; y: number }
const key = (time: number, scale = 1, x = 0, y = 0): CameraKey => ({ time, scale, x, y });
// Measured against idle-1's frontal pose at 480x270. Profile/nodding frames are
// deliberately not face-matched to the frontal pose: yaw must not trigger a zoom.
const RIGHT_CAMERA = [key(0, .978, -.25, 1), key(10, .978, -.25, 1), key(14.89, 1.011, -.25, 1.25)];
const CAMERA: Partial<Record<MeetingClip, readonly CameraKey[]>> = {
  'speaking-start': [key(0), key(2.53, 1.012, 0, .75), key(4.88, 1.002, 0, -.5)],
  'speaking-loop': [key(0, .998, 0, -.5), key(2.53, .990, 0, -2.25), key(4.88, 1.002, -.25, .5)],
  'speaking-end': [key(0, 1.001, 0, -.5), key(4.88, 1.002, .25, .5)],
  'turn-left': [key(0, .978, -.25, 1.5)],
  'return-left': [key(0, .980, -.25, 1.75), key(4.88, .984, -.25, 2.25)],
  'turn-right': RIGHT_CAMERA,
  'return-right': RIGHT_CAMERA,
  'center-bridge': [key(0, 1.001), key(4.88, 1.032, 0, .5)],
};

/** One shared camera size; small calibrated offsets correct the supplied clips. */
export function meetingVideoFraming(clip: MeetingClip, time: number, width: number, height: number) {
  const keys = CAMERA[clip] ?? [key(0)];
  const before = keys.findLast(frame => frame.time <= time) ?? keys[0]!;
  const after = keys.find(frame => frame.time > time) ?? before;
  const progress = after === before ? 0 : Math.min(1, Math.max(0, (time - before.time) / (after.time - before.time)));
  const eased = progress * progress * (3 - 2 * progress);
  const lerp = (a: number, b: number) => a + (b - a) * eased;
  const cameraScale = lerp(before.scale, after.scale);
  // Four percent shared overscan keeps all edges covered when correcting larger takes.
  const scale = 1.04 / cameraScale;
  const pixel = Math.max(width / 480, height / 270);
  const x = -lerp(before.x, after.x) * pixel * scale;
  const y = -lerp(before.y, after.y) * pixel * scale;
  return {
    scale, x, y,
    origin: `${width / 2}px ${95 * pixel}px`,
    transform: `translate3d(${x.toFixed(3)}px, ${y.toFixed(3)}px, 0) scale(${scale.toFixed(6)})`,
  };
}
