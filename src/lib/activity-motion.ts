// Shared by activity disclosure height and chevron CSS transitions.
export const ACTIVITY_MOTION = {
  duration: 200,
  easing: "cubic-bezier(0.4, 0, 0.2, 1)",
} as const;

export const ACTIVITY_TRANSITION = {
  transitionDuration: `${String(ACTIVITY_MOTION.duration)}ms`,
  transitionTimingFunction: ACTIVITY_MOTION.easing,
} as const;
