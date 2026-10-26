export interface SwipePoint {
  x: number;
  y: number;
}

const INTENT_DISTANCE = 12;
const SWIPE_DISTANCE = 64;
const HORIZONTAL_RATIO = 1.5;

/** Classify deliberate horizontal movement before allowing navigation.
@param start - Initial touch position.
@param point - Current touch position.
@returns Pending, vertical, or a horizontal direction.
*/
export function swipeDirection(start: SwipePoint, point: SwipePoint) {
  const dx = point.x - start.x;
  const dy = point.y - start.y;

  if (Math.max(Math.abs(dx), Math.abs(dy)) < INTENT_DISTANCE) {
    return "pending";
  }

  if (Math.abs(dx) < Math.abs(dy) * HORIZONTAL_RATIO) {
    return "vertical";
  }

  return dx > 0 ? "right" : "left";
}

/** Require enough travel to complete a horizontal navigation gesture.
@param start - Initial touch position.
@param point - Released touch position.
@returns Completed direction, or null for a short or vertical gesture.
*/
export function completedSwipe(start: SwipePoint, point: SwipePoint) {
  const direction = swipeDirection(start, point);

  return Math.abs(point.x - start.x) >= SWIPE_DISTANCE && (direction === "left" || direction === "right")
    ? direction
    : null;
}
