import { add, multiply } from './math.js'

export class Point {
  constructor(
    readonly x: number,
    readonly y: number
  ) {}

  translate(dx: number, dy: number): Point {
    return new Point(add(this.x, dx), add(this.y, dy))
  }

  scale(factor: number): Point {
    return new Point(multiply(this.x, factor), multiply(this.y, factor))
  }
}
