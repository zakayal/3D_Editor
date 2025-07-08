// @ts-nocheck

import * as THREE from "three";

/** Abstract class representing a selection using a pointer. */
class Selection {

	constructor() {

		this.dragging = false;

	}

	handlePointerDown() {

		this.dragging = true;

	}
	handlePointerUp() {

		this.dragging = false;

	}
	handlePointerMove() { }

	get points() {

		return [];

	}

	clearPoints() {
		this.lassoPoints = [];
	}

	/** Convert absolute screen coordinates `x` and `y` to relative coordinates in range [-1; 1]. */
	static normalizePoint(x, y, renderer) {
		const rect = renderer.domElement.getBoundingClientRect();

		return [
			(x / rect.width) * 2 - 1,
			-((y / rect.height) * 2 - 1),
		];
	}

}

const tempVec0 = new THREE.Vector2();
const tempVec1 = new THREE.Vector2();
const tempVec2 = new THREE.Vector2();
/** Selection that adds points on drag and connects the start and end points with a straight line. */
export class LassoSelection extends Selection {

	constructor(renderer) {

		super();
		this.lassoPoints = [];
		this.prevX = - Infinity;
		this.prevY = - Infinity;
		this.renderer = renderer;
	}

	handlePointerDown(e) {

		super.handlePointerDown();
		const rect = this.renderer.domElement.getBoundingClientRect();
		this.prevX = e.clientX - rect.left;
		this.prevY = e.clientY - rect.top;
		this.lassoPoints = [];

	}

	handlePointerMove(e) {
		const rect = this.renderer.domElement.getBoundingClientRect();
		const ex = e.clientX - rect.left;
		const ey = e.clientY - rect.top;
		const [nx, ny] = Selection.normalizePoint(ex, ey, this.renderer);

		// If the mouse hasn't moved a lot since the last point
		if (Math.abs(ex - this.prevX) >= 3 || Math.abs(ey - this.prevY) >= 3) {

			// Check if the mouse moved in roughly the same direction as the previous point
			// and replace it if so.
			const i = this.lassoPoints.length / 3 - 1;
			const i3 = i * 3;
			let doReplace = false;
			if (this.lassoPoints.length > 3) {

				// prev segment direction
				tempVec0.set(this.lassoPoints[i3 - 3], this.lassoPoints[i3 - 3 + 1]);
				tempVec1.set(this.lassoPoints[i3], this.lassoPoints[i3 + 1]);
				tempVec1.sub(tempVec0).normalize();

				// this segment direction
				tempVec0.set(this.lassoPoints[i3], this.lassoPoints[i3 + 1]);
				tempVec2.set(nx, ny);
				tempVec2.sub(tempVec0).normalize();

				const dot = tempVec1.dot(tempVec2);
				doReplace = dot > 0.99;

			}

			if (doReplace) {

				this.lassoPoints[i3] = nx;
				this.lassoPoints[i3 + 1] = ny;

			} else {

				this.lassoPoints.push(nx, ny, 0);

			}

			this.prevX = ex;
			this.prevY = ey;

			return { changed: true };

		}

		return { changed: false };

	}

	get points() {

		return this.lassoPoints;

	}

	clearPoints() {
		this.lassoPoints = [];
	}
}

export class BoxSelection extends Selection {

	constructor(renderer) {

		super();
		this.startX = 0;
		this.startY = 0;
		this.currentX = 0;
		this.currentY = 0;
		this.renderer = renderer;
	}

	handlePointerDown(e) {

		super.handlePointerDown();
		const rect = this.renderer.domElement.getBoundingClientRect();
		this.prevX = e.clientX - rect.left;
		this.prevY = e.clientY - rect.top;
		const [nx, ny] = Selection.normalizePoint(this.prevX, this.prevY, this.renderer);
		this.startX = nx;
		this.startY = ny;
		this.lassoPoints = [];

	}

	handlePointerMove(e) {
		const rect = this.renderer.domElement.getBoundingClientRect();
		const ex = e.clientX - rect.left;
		const ey = e.clientY - rect.top;

		const [nx, ny] = Selection.normalizePoint(ex, ey, this.renderer);
		this.currentX = nx;
		this.currentY = ny;

		if (ex === this.prevX && ey === this.prevY) {

			return { changed: false };

		}

		this.prevX = ex;
		this.prevY = ey;

		return { changed: true };

	}

	get points() {

		return [
			[this.startX, this.startY, 0],
			[this.currentX, this.startY, 0],
			[this.currentX, this.currentY, 0],
			[this.startX, this.currentY, 0],
		].flat();

	}

}
