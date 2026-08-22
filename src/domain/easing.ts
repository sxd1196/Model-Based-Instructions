/** Easing curves. Pure number -> number on [0,1]. No dependencies. */
import type { Easing } from './schema';

export const EASING_FNS: Record<Easing, (t: number) => number> = {
  linear: (t) => t,
  easeIn: (t) => t * t,
  easeOut: (t) => t * (2 - t),
  easeInOut: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  step: (t) => (t >= 1 ? 1 : 0),
};

export function applyEasing(kind: Easing, t: number): number {
  return EASING_FNS[kind](clamp01(t));
}

export function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
