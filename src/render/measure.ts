import { bottom, contains, right, type Box } from './geometry.ts';

export interface Guide {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Distance shown on the label; absent for dashed extension lines. */
  value?: number;
}

const EPSILON = 0.01;

/**
 * Redline guides between the selected box and the hovered box, in artboard pixels: the four insets when one box
 * contains the other, otherwise the horizontal and/or vertical gap, plus dashed extensions when the boxes do not
 * line up on the other axis.
 */
export function measureBetween(selected: Box, hovered: Box): Guide[] {
  if (contains(hovered, selected)) {
    return insets(selected, hovered);
  }
  if (contains(selected, hovered)) {
    return insets(hovered, selected);
  }
  return [...horizontalGap(selected, hovered), ...verticalGap(selected, hovered)];
}

function insets(inner: Box, outer: Box): Guide[] {
  const cx = inner.x + inner.width / 2;
  const cy = inner.y + inner.height / 2;
  const guides: Guide[] = [
    { x1: cx, y1: outer.y, x2: cx, y2: inner.y, value: inner.y - outer.y },
    { x1: cx, y1: bottom(inner), x2: cx, y2: bottom(outer), value: bottom(outer) - bottom(inner) },
    { x1: outer.x, y1: cy, x2: inner.x, y2: cy, value: inner.x - outer.x },
    { x1: right(inner), y1: cy, x2: right(outer), y2: cy, value: right(outer) - right(inner) },
  ];
  return guides.filter((guide) => (guide.value ?? 0) > EPSILON);
}

function horizontalGap(a: Box, b: Box): Guide[] {
  let from: number;
  let to: number;
  let edgeOfB: number;
  if (b.x >= right(a)) {
    [from, to, edgeOfB] = [right(a), b.x, b.x];
  } else if (right(b) <= a.x) {
    [from, to, edgeOfB] = [right(b), a.x, right(b)];
  } else {
    return [];
  }
  const top = Math.max(a.y, b.y);
  const btm = Math.min(bottom(a), bottom(b));
  const y = top <= btm ? (top + btm) / 2 : a.y + a.height / 2;
  const guides: Guide[] = [{ x1: from, y1: y, x2: to, y2: y, value: to - from }];
  if (y < b.y || y > bottom(b)) {
    guides.push({ x1: edgeOfB, y1: y < b.y ? b.y : bottom(b), x2: edgeOfB, y2: y });
  }
  return guides;
}

function verticalGap(a: Box, b: Box): Guide[] {
  let from: number;
  let to: number;
  let edgeOfB: number;
  if (b.y >= bottom(a)) {
    [from, to, edgeOfB] = [bottom(a), b.y, b.y];
  } else if (bottom(b) <= a.y) {
    [from, to, edgeOfB] = [bottom(b), a.y, bottom(b)];
  } else {
    return [];
  }
  const left = Math.max(a.x, b.x);
  const rgt = Math.min(right(a), right(b));
  const x = left <= rgt ? (left + rgt) / 2 : a.x + a.width / 2;
  const guides: Guide[] = [{ x1: x, y1: from, x2: x, y2: to, value: to - from }];
  if (x < b.x || x > right(b)) {
    guides.push({ x1: x < b.x ? b.x : right(b), y1: edgeOfB, x2: x, y2: edgeOfB });
  }
  return guides;
}
