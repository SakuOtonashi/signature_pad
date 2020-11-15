/**
 * The main idea and some parts of the code (e.g. drawing variable width Bézier curve) are taken from:
 * http://corner.squareup.com/2012/07/smoother-signatures.html
 *
 * Implementation of interpolation using cubic Bézier curves is taken from:
 * http://www.benknowscode.com/2012/09/path-interpolation-using-cubic-bezier_9742.html
 *
 * Algorithm for approximated length of a Bézier curve is taken from:
 * http://www.lemoda.net/maths/bezier-length/index.html
 */

import { Bezier } from './bezier';
import { BasicPoint, Point } from './point';
import { throttle } from './throttle';

export interface Options {
  dotSize?: number | (() => number);
  minWidth?: number;
  maxWidth?: number;
  minDistance?: number;
  backgroundColor?: string;
  penColor?: string;
  throttle?: number;
  velocityFilterWeight?: number;
  onBegin?: (event: WXTouch) => void;
  onEnd?: (event: WXTouch) => void;
}

export interface PointGroup {
  color: string;
  points: BasicPoint[];
}

interface WXTouchEvent extends UIEvent {
  changedTouches: WXTouch[];
  touches: WXTouch[];
}

interface WXTouch {
  x: number;
  y: number;
}

export default class SignaturePad {
  // Public stuff
  public dotSize: number | (() => number);
  public minWidth: number;
  public maxWidth: number;
  public minDistance: number;
  public backgroundColor: string;
  public penColor: string;
  public throttle: number;
  public velocityFilterWeight: number;
  public onBegin?: (event: WXTouch) => void;
  public onEnd?: (event: WXTouch) => void;

  // Private stuff
  /* tslint:disable: variable-name */
  private _ctx: CanvasRenderingContext2D;
  private _isEmpty: boolean;
  private _lastPoints: Point[]; // Stores up to 4 most recent points; used to generate a new curve
  private _data: PointGroup[]; // Stores all points in groups (one group per line or dot)
  private _lastVelocity: number;
  private _lastWidth: number;
  private _strokeMoveUpdate: (event: WXTouch) => void;
  /* tslint:enable: variable-name */

  constructor(
    private canvas: HTMLCanvasElement,
    options: Options = {},
  ) {
    this.velocityFilterWeight = options.velocityFilterWeight || 0.7;
    this.minWidth = options.minWidth || 0.5;
    this.maxWidth = options.maxWidth || 2.5;
    this.throttle = ('throttle' in options ? options.throttle : 16) as number; // in milisecondss
    this.minDistance = ('minDistance' in options
      ? options.minDistance
      : 5) as number; // in pixels
    this.dotSize =
      options.dotSize ||
      function dotSize(this: SignaturePad): number {
        return (this.minWidth + this.maxWidth) / 2;
      };
    this.penColor = options.penColor || 'black';
    this.backgroundColor = options.backgroundColor || 'rgba(0,0,0,0)';
    this.onBegin = options.onBegin;
    this.onEnd = options.onEnd;

    this._strokeMoveUpdate = this.throttle
      ? throttle(SignaturePad.prototype._strokeUpdate, this.throttle)
      : SignaturePad.prototype._strokeUpdate;
    this._ctx = canvas.getContext('2d') as CanvasRenderingContext2D;

    this.clear();

    // Enable mouse and touch event handlers
    this.on();
  }

  public clear(): void {
    const { _ctx: ctx, canvas } = this;

    // Clear canvas using background color
    ctx.fillStyle = this.backgroundColor;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    this._data = [];
    this._reset();
    this._isEmpty = true;
  }

  public fromDataURL(
    dataUrl: string,
    options: { width?: number; height?: number } = {},
    callback?: (error?: string | Event) => void,
  ): void {
    // @ts-ignore
    const image: HTMLImageElement = this.canvas.createImage();
    const width = options.width || this.canvas.width;
    const height = options.height || this.canvas.height;

    this._reset();

    image.onload = (): void => {
      this._ctx.drawImage(image, 0, 0, width, height);
      if (callback) {
        callback();
      }
    };
    image.onerror = (error): void => {
      if (callback) {
        callback(error);
      }
    };
    image.src = dataUrl;

    this._isEmpty = false;
  }

  public toDataURL(type = 'image/png', encoderOptions?: number): string {
    return this.canvas.toDataURL(type, encoderOptions);
  }

  public on(): void {
    this._handleTouchEvents();
  }

  public off(): void {
    // @ts-ignore
    this.canvas.removeEventListener('touchstart', this._handleTouchStart);
    // @ts-ignore
    this.canvas.removeEventListener('touchmove', this._handleTouchMove);
    // @ts-ignore
    this.canvas.removeEventListener('touchend', this._handleTouchEnd);
  }

  public isEmpty(): boolean {
    return this._isEmpty;
  }

  public fromData(pointGroups: PointGroup[]): void {
    this.clear();

    this._fromData(
      pointGroups,
      ({ color, curve }) => this._drawCurve({ color, curve }),
      ({ color, point }) => this._drawDot({ color, point }),
    );

    this._data = pointGroups;
  }

  public toData(): PointGroup[] {
    return this._data;
  }

  private _handleTouchStart = (event: WXTouchEvent): void => {
    // Prevent scrolling.
    event.preventDefault();

    if (event.touches.length === 1) {
      const touch = event.changedTouches[0];
      this._strokeBegin(touch);
    }
  };

  private _handleTouchMove = (event: WXTouchEvent): void => {
    // Prevent scrolling.
    event.preventDefault();

    const touch = event.touches[0];
    this._strokeMoveUpdate(touch);
  };

  private _handleTouchEnd = (event: WXTouchEvent): void => {
    event.preventDefault();

    const touch = event.changedTouches[0];
    this._strokeEnd(touch);
  };

  // Private methods
  private _strokeBegin(event: WXTouch): void {
    const newPointGroup = {
      color: this.penColor,
      points: [],
    };

    if (typeof this.onBegin === 'function') {
      this.onBegin(event);
    }

    this._data.push(newPointGroup);
    this._reset();
    this._strokeUpdate(event);
  }

  private _strokeUpdate(event: WXTouch): void {
    if (this._data.length === 0) {
      // This can happen if clear() was called while a signature is still in progress,
      // or if there is a race condition between start/update events.
      this._strokeBegin(event);
      return;
    }

    const point = this._createPoint(event.x, event.y);
    const lastPointGroup = this._data[this._data.length - 1];
    const lastPoints = lastPointGroup.points;
    const lastPoint =
      lastPoints.length > 0 && lastPoints[lastPoints.length - 1];
    const isLastPointTooClose = lastPoint
      ? point.distanceTo(lastPoint) <= this.minDistance
      : false;
    const color = lastPointGroup.color;

    // Skip this point if it's too close to the previous one
    if (!lastPoint || !(lastPoint && isLastPointTooClose)) {
      const curve = this._addPoint(point);

      if (!lastPoint) {
        this._drawDot({ color, point });
      } else if (curve) {
        this._drawCurve({ color, curve });
      }

      lastPoints.push({
        time: point.time,
        x: point.x,
        y: point.y,
      });
    }
  }

  private _strokeEnd(event: WXTouch): void {
    this._strokeUpdate(event);

    if (typeof this.onEnd === 'function') {
      this.onEnd(event);
    }
  }

  private _handleTouchEvents(): void {
    // @ts-ignore
    this.canvas.addEventListener('touchstart', this._handleTouchStart);
    // @ts-ignore
    this.canvas.addEventListener('touchmove', this._handleTouchMove);
    // @ts-ignore
    this.canvas.addEventListener('touchend', this._handleTouchEnd);
  }

  // Called when a new line is started
  private _reset(): void {
    this._lastPoints = [];
    this._lastVelocity = 0;
    this._lastWidth = (this.minWidth + this.maxWidth) / 2;
    this._ctx.fillStyle = this.penColor;
  }

  private _createPoint(x: number, y: number): Point {
    // @ts-ignore
    const dpr = this.canvas.pixelRatio
    return new Point(x * dpr, y * dpr, new Date().getTime());
  }

  // Add point to _lastPoints array and generate a new curve if there are enough points (i.e. 3)
  private _addPoint(point: Point): Bezier | null {
    const { _lastPoints } = this;

    _lastPoints.push(point);

    if (_lastPoints.length > 2) {
      // To reduce the initial lag make it work with 3 points
      // by copying the first point to the beginning.
      if (_lastPoints.length === 3) {
        _lastPoints.unshift(_lastPoints[0]);
      }

      // _points array will always have 4 points here.
      const widths = this._calculateCurveWidths(_lastPoints[1], _lastPoints[2]);
      const curve = Bezier.fromPoints(_lastPoints, widths);

      // Remove the first element from the list, so that there are no more than 4 points at any time.
      _lastPoints.shift();

      return curve;
    }

    return null;
  }

  private _calculateCurveWidths(
    startPoint: Point,
    endPoint: Point,
  ): { start: number; end: number } {
    const velocity =
      this.velocityFilterWeight * endPoint.velocityFrom(startPoint) +
      (1 - this.velocityFilterWeight) * this._lastVelocity;

    const newWidth = this._strokeWidth(velocity);

    const widths = {
      end: newWidth,
      start: this._lastWidth,
    };

    this._lastVelocity = velocity;
    this._lastWidth = newWidth;

    return widths;
  }

  private _strokeWidth(velocity: number): number {
    return Math.max(this.maxWidth / (velocity + 1), this.minWidth);
  }

  private _drawCurveSegment(x: number, y: number, width: number): void {
    const ctx = this._ctx;

    ctx.moveTo(x, y);
    ctx.arc(x, y, width, 0, 2 * Math.PI, false);
    this._isEmpty = false;
  }

  private _drawCurve({ color, curve }: { color: string; curve: Bezier }): void {
    const ctx = this._ctx;
    const widthDelta = curve.endWidth - curve.startWidth;
    // '2' is just an arbitrary number here. If only lenght is used, then
    // there are gaps between curve segments :/
    const drawSteps = Math.floor(curve.length()) * 2;

    ctx.beginPath();
    ctx.fillStyle = color;

    for (let i = 0; i < drawSteps; i += 1) {
      // Calculate the Bezier (x, y) coordinate for this step.
      const t = i / drawSteps;
      const tt = t * t;
      const ttt = tt * t;
      const u = 1 - t;
      const uu = u * u;
      const uuu = uu * u;

      let x = uuu * curve.startPoint.x;
      x += 3 * uu * t * curve.control1.x;
      x += 3 * u * tt * curve.control2.x;
      x += ttt * curve.endPoint.x;

      let y = uuu * curve.startPoint.y;
      y += 3 * uu * t * curve.control1.y;
      y += 3 * u * tt * curve.control2.y;
      y += ttt * curve.endPoint.y;

      const width = Math.min(
        curve.startWidth + ttt * widthDelta,
        this.maxWidth,
      );
      this._drawCurveSegment(x, y, width);
    }

    ctx.closePath();
    ctx.fill();
  }

  private _drawDot({
    color,
    point,
  }: {
    color: string;
    point: BasicPoint;
  }): void {
    const ctx = this._ctx;
    const width =
      typeof this.dotSize === 'function' ? this.dotSize() : this.dotSize;

    ctx.beginPath();
    this._drawCurveSegment(point.x, point.y, width);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  private _fromData(
    pointGroups: PointGroup[],
    drawCurve: SignaturePad['_drawCurve'],
    drawDot: SignaturePad['_drawDot'],
  ): void {
    for (const group of pointGroups) {
      const { color, points } = group;

      if (points.length > 1) {
        for (let j = 0; j < points.length; j += 1) {
          const basicPoint = points[j];
          const point = new Point(basicPoint.x, basicPoint.y, basicPoint.time);

          // All points in the group have the same color, so it's enough to set
          // penColor just at the beginning.
          this.penColor = color;

          if (j === 0) {
            this._reset();
          }

          const curve = this._addPoint(point);

          if (curve) {
            drawCurve({ color, curve });
          }
        }
      } else {
        this._reset();

        drawDot({
          color,
          point: points[0],
        });
      }
    }
  }
}
