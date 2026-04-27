export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export interface Circle {
  readonly center: Vec2;
  readonly radius: number;
}

export interface Segment {
  readonly a: Vec2;
  readonly b: Vec2;
}

/** Closed polygon. Vertices in order; last vertex connects back to first. */
export interface Polygon {
  readonly vertices: ReadonlyArray<Vec2>;
}

export interface AABB {
  readonly min: Vec2;
  readonly max: Vec2;
}
