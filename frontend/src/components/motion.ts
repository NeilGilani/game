/** A critically damped spring: no overshoot of selection targets, no timer loop.
 * Precomputed keyframes let the browser compositor animate opacity/transform. */
export const SPRING = { mass: 1, stiffness: 480, damping: 44, duration: 360 } as const;
const frequency = Math.sqrt(SPRING.stiffness / SPRING.mass);
export const screenSpring: Keyframe[] = Array.from({ length: 25 }, (_, i) => {
  const offset = i / 24;
  const time = (offset * SPRING.duration) / 1000;
  const remaining = i === 24 ? 0 : (1 + frequency * time) * Math.exp(-frequency * time);
  return {
    offset,
    opacity: 1 - remaining,
    transform: `translateY(${8 * remaining}px) scale(${1 - 0.008 * remaining})`,
  };
});
