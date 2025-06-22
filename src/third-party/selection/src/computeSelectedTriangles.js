// @ts-nocheck

import * as THREE from "three";
import { CONTAINED, INTERSECTED, NOT_INTERSECTED } from "three-mesh-bvh/src/core/Constants.js";
import { getConvexHull } from "../utils/math/getConvexHull.js";
import { lineCrossesLine } from "../utils/math/lineCrossesLine.js";
import {
	isPointInsidePolygon,
} from "../utils/math/pointRayCrossesSegments.js";

/**
 * Compute selected triangles:
 *
 * 1. Construct a list of screen space line segments that represent the shape drawn by the user.
 * 2. For every triangle in the geometry check if any part is within the shape. If it is then consider the triangle selected.
 *
 * @returns Array of triplets representing indices of vertices of selected triangles
 *
 * @see https://github.com/gkjohnson/three-mesh-bvh/issues/166#issuecomment-752194034
 */
export function computeSelectedTriangles( mesh, camera, selectionTool, params ) {

	// TODO: Possible improvements
	// - Correctly handle the camera near clip
	// - Improve line line intersect performance?

	toScreenSpaceMatrix
		.copy( mesh.matrixWorld )
		.premultiply( camera.matrixWorldInverse )
		.premultiply( camera.projectionMatrix );

	invWorldMatrix.copy( mesh.matrixWorld ).invert();
	camLocalPosition
		.set( 0, 0, 0 )
		.applyMatrix4( camera.matrixWorld )
		.applyMatrix4( invWorldMatrix );

	const lassoSegments = connectPointsWithLines(
		convertTripletsToPoints( selectionTool.points )
	);

	/**
	 * Per-depth cache of lasso segments that were filtered to be to the right of a box for that depth.
	 * @type {Array<Array<THREE.Line3>>}
	 */
	const perBoundsSegmentCache = [];

	/**
	 * Array of triplets representing indices of vertices of selected triangles.
	 * @type {Array<number>}
	 */
	const indices = [];

	// find all the triangles in the mesh that intersect the lasso
	mesh.geometry.boundsTree.shapecast( {
		intersectsBounds: ( box, isLeaf, score, depth ) => {

			// check if the bounds are intersected or contained by the lasso region to narrow down on the triangles

			if ( ! params.useBoundsTree ) {

				return INTERSECTED;

			}

			const projectedBoxPoints = extractBoxVertices( box, boxPoints ).map( ( v ) =>
				v.applyMatrix4( toScreenSpaceMatrix )
			);

			let minY = Infinity;
			let maxY = - Infinity;
			let minX = Infinity;
			for ( const point of projectedBoxPoints ) {

				if ( point.y < minY ) minY = point.y;
				if ( point.y > maxY ) maxY = point.y;
				if ( point.x < minX ) minX = point.x;

			}

			// filter the lasso segments to remove the ones completely to the left, above, or below the bounding box.
			// we don't need the ones on the left because the point-in-polygon ray casting algorithm casts rays to the right.
			// cache the filtered segments in the above array for subsequent child checks to use.
			const parentSegments = perBoundsSegmentCache[ depth - 1 ] || lassoSegments;
			const segmentsToCheck = parentSegments.filter( ( segment ) =>
				isSegmentToTheRight( segment, minX, minY, maxY )
			);
			perBoundsSegmentCache[ depth ] = segmentsToCheck;

			if ( segmentsToCheck.length === 0 ) {

				return NOT_INTERSECTED;

			}

			const hull = getConvexHull( projectedBoxPoints );
			const hullSegments = connectPointsWithLines( hull, boxLines );

			// If any lasso point is inside the hull (arbitrarily checking the first) then the bounds are intersected by the lasso.
			if ( isPointInsidePolygon( segmentsToCheck[ 0 ].start, hullSegments ) ) {

				return INTERSECTED;

			}

			// if any hull segment is intersected by any lasso segment then the bounds are intersected by the lasso
			for ( const hullSegment of hullSegments ) {

				for ( const selectionSegment of segmentsToCheck ) {

					if ( lineCrossesLine( hullSegment, selectionSegment ) ) {

						return INTERSECTED;

					}

				}

			}

			// No lasso segments intersected the bounds, and at least the first point is definitely outside the hull,
			// so either the entire hull is inside the lasso, or the lasso is somewhere different and does not touch the hull.
			return isPointInsidePolygon( hull[ 0 ], segmentsToCheck ) ? CONTAINED : NOT_INTERSECTED;

		},

		intersectsTriangle: ( tri, index, contained, depth ) => {

			// if the box containing this triangle was intersected or contained, check if the triangle itself should be selected

			const i3 = index * 3;
			const a = i3 + 0;
			const b = i3 + 1;
			const c = i3 + 2;

			// check all the segments if using no bounds tree
			const segmentsToCheck = params.useBoundsTree
				? perBoundsSegmentCache[ depth ]
				: lassoSegments;
			if (
				params.selectionMode === "centroid" ||
				params.selectionMode === "centroid-visible"
			) {

				// get the center of the triangle
				centroid
					.copy( tri.a )
					.add( tri.b )
					.add( tri.c )
					.multiplyScalar( 1 / 3 );
				screenCentroid.copy( centroid ).applyMatrix4( toScreenSpaceMatrix );

				if (
					contained ||
					isPointInsidePolygon( screenCentroid, segmentsToCheck )
				) {

					// if we're only selecting visible faces then perform a ray check to ensure the centroid
					// is visible.
					if (params.selectionMode === "centroid-visible") {
						tri.getNormal(faceNormal);
						
						// 1. 检查面片是否朝向相机
						const viewDirection = new THREE.Vector3().subVectors(camLocalPosition, centroid).normalize();
						const dotProduct = viewDirection.dot(faceNormal);
						
						if (dotProduct <= -0.3) {
							return false;
						}
						
						// 2. 计算三角形的特征
						// 计算三角形的边长
						const edgeAB = new THREE.Vector3().subVectors(tri.b, tri.a).length();
						const edgeBC = new THREE.Vector3().subVectors(tri.c, tri.b).length();
						const edgeCA = new THREE.Vector3().subVectors(tri.a, tri.c).length();
						
						// 找到最长边
						const maxEdgeLength = Math.max(edgeAB, edgeBC, edgeCA);
						
						// 根据三角形大小动态调整采样密度
						const numSamples = Math.max(2, Math.min(5, Math.ceil(maxEdgeLength * 100)));
						
						// 3. 生成检测点
						const checkPoints = [];
						
						// 添加重心点及其周围的点
						centroid.copy(tri.a).add(tri.b).add(tri.c).multiplyScalar(1/3);
						checkPoints.push(centroid.clone());
						
						// 在重心周围添加偏移点
						const centroidOffsets = [0.1, -0.1];
						for (const offset of centroidOffsets) {
							checkPoints.push(
								new THREE.Vector3()
									.copy(centroid)
									.addScaledVector(faceNormal, offset)
							);
						}
						
						// 在边上采样点，特别关注边缘区域
						for (let i = 1; i < numSamples; i++) {
							const t = i / numSamples;
							// 在每个采样位置添加多个点以更好地覆盖边缘
							const offsets = [-0.01, 0, 0.01];
							for (const offset of offsets) {
								const tt = t + offset;
								if (tt > 0 && tt < 1) {
									// AB边
									checkPoints.push(new THREE.Vector3().lerpVectors(tri.a, tri.b, tt));
									// BC边
									checkPoints.push(new THREE.Vector3().lerpVectors(tri.b, tri.c, tt));
									// CA边
									checkPoints.push(new THREE.Vector3().lerpVectors(tri.c, tri.a, tt));
								}
							}
						}
						
						// 4. 检查点的可见性
						let visiblePoints = 0;
						const minRequiredPoints = 2;  // 至少需要2个点可见
						const threshold = Math.max(minRequiredPoints, checkPoints.length * 0.15);
						
						// 投影三角形到屏幕空间进行检查
						const screenCentroid = centroid.clone().applyMatrix4(toScreenSpaceMatrix);
						if (!isPointInsidePolygon(screenCentroid, segmentsToCheck)) {
							return false;  // 如果重心不在选区内，直接返回
						}
						
						for (const point of checkPoints) {
							// 从多个偏移距离检测
							const offsets = [1e-3, 2e-3, 5e-3];
							
							for (const offset of offsets) {
								// 从检测点沿着多个方向进行检测
								const directions = [
									viewDirection.clone(),
									viewDirection.clone().addScaledVector(faceNormal, 0.1).normalize(),
									viewDirection.clone().addScaledVector(faceNormal, -0.1).normalize()
								];
								
								for (const dir of directions) {
									tempRay.origin.copy(point).addScaledVector(faceNormal, offset);
									tempRay.direction.copy(dir);
									
									const res = mesh.geometry.boundsTree.raycastFirst(
										tempRay,
										THREE.DoubleSide,
										1e-3
									);
									
									if (!res) {
										visiblePoints++;
										if (visiblePoints >= threshold) {
											indices.push(a, b, c);
											return params.selectWholeModel;
										}
										break;  // 该点可见，跳到下一个点
									}
									
									// 检查遮挡距离
									const distance = res.point.distanceTo(tempRay.origin);
									if (distance <= 8e-3) {
										visiblePoints++;
										if (visiblePoints >= threshold) {
											indices.push(a, b, c);
											return params.selectWholeModel;
										}
										break;  // 该点可见，跳到下一个点
									}
								}
							}
						}
						
						return false;
					}

					indices.push( a, b, c );
					return params.selectWholeModel;

				}

			} else if ( params.selectionMode === "intersection" ) {

				// 如果父边界框被标记为包含，则包含所有三角形
				if (contained) {
					indices.push(a, b, c);
					return params.selectWholeModel;
				}

				// 1. 首先检查面片朝向
				tri.getNormal(faceNormal);
				const viewDirection = new THREE.Vector3().subVectors(camLocalPosition, centroid).normalize();
				const dotProduct = viewDirection.dot(faceNormal);
				
				if (dotProduct <= -0.3) {  // 保持与之前相同的角度限制
					return false;
				}

				// 2. 投影三角形顶点到屏幕空间
				const projectedTriangle = [tri.a, tri.b, tri.c].map((v) =>
					v.clone().applyMatrix4(toScreenSpaceMatrix)
				);

				// 3. 检查投影点是否在选区内
				for (const point of projectedTriangle) {
					if (isPointInsidePolygon(point, segmentsToCheck)) {
						// 如果点在选区内，进行可见性检测
						tempRay.origin.copy(point);
						tempRay.origin.addScaledVector(faceNormal, 1e-3);
						tempRay.direction.copy(viewDirection);
						
						const res = mesh.geometry.boundsTree.raycastFirst(
							tempRay,
							THREE.DoubleSide,
							1e-3
						);
						
						if (!res || res.point.distanceTo(tempRay.origin) <= 8e-3) {
							indices.push(a, b, c);
							return params.selectWholeModel;
						}
					}
				}

				// 4. 检查三角形边是否与选区边界相交
				const triangleSegments = connectPointsWithLines(projectedTriangle, boxLines);
				for (const segment of triangleSegments) {
					for (const selectionSegment of segmentsToCheck) {
						if (lineCrossesLine(segment, selectionSegment)) {
							// 如果边相交，检查交点附近的可见性
							const intersectionPoint = new THREE.Vector3().addVectors(
								segment.start,
								segment.end
							).multiplyScalar(0.5);  // 使用边的中点作为近似

							// 从多个位置检查可见性
							const checkPoints = [
								intersectionPoint,
								new THREE.Vector3().lerpVectors(segment.start, intersectionPoint, 0.25),
								new THREE.Vector3().lerpVectors(segment.end, intersectionPoint, 0.25)
							];

							for (const point of checkPoints) {
								tempRay.origin.copy(point);
								tempRay.origin.addScaledVector(faceNormal, 1e-3);
								tempRay.direction.copy(viewDirection);
								
								const res = mesh.geometry.boundsTree.raycastFirst(
									tempRay,
									THREE.DoubleSide,
									1e-3
								);
								
								if (!res || res.point.distanceTo(tempRay.origin) <= 8e-3) {
									indices.push(a, b, c);
									return params.selectWholeModel;
								}
							}
						}
					}
				}

				// 5. 检查选区点是否在投影三角形内
				const triangleArea = getTriangleArea(projectedTriangle[0], projectedTriangle[1], projectedTriangle[2]);
				for (let i = 0; i < selectionTool.points.length; i += 3) {
					const point = new THREE.Vector3(
						selectionTool.points[i],
						selectionTool.points[i + 1],
						selectionTool.points[i + 2]
					).applyMatrix4(toScreenSpaceMatrix);

					if (isPointInTriangle(point, projectedTriangle[0], projectedTriangle[1], projectedTriangle[2], triangleArea)) {
						// 如果选区点在三角形内，进行可见性检测
						tempRay.origin.copy(point);
						tempRay.origin.addScaledVector(faceNormal, 1e-3);
						tempRay.direction.copy(viewDirection);
						
						const res = mesh.geometry.boundsTree.raycastFirst(
							tempRay,
							THREE.DoubleSide,
							1e-3
						);
						
						if (!res || res.point.distanceTo(tempRay.origin) <= 8e-3) {
							indices.push(a, b, c);
							return params.selectWholeModel;
						}
					}
				}

			}

			return false;

		},
	} );

	return indices;

}

const invWorldMatrix = new THREE.Matrix4();
const camLocalPosition = new THREE.Vector3();
const tempRay = new THREE.Ray();
const centroid = new THREE.Vector3();
const screenCentroid = new THREE.Vector3();
const faceNormal = new THREE.Vector3();
const toScreenSpaceMatrix = new THREE.Matrix4();
const boxPoints = new Array( 8 ).fill().map( () => new THREE.Vector3() );
const boxLines = new Array( 12 ).fill().map( () => new THREE.Line3() );

/**
 * Produce a list of 3D points representing vertices of the box.
 *
 * @param {THREE.Box3} box
 * @param {Array<THREE.Vector3>} target Array of 8 vectors to write to
 * @returns {Array<THREE.Vector3>}
 */
function extractBoxVertices( box, target ) {

	const { min, max } = box;
	let index = 0;

	for ( let x = 0; x <= 1; x ++ ) {

		for ( let y = 0; y <= 1; y ++ ) {

			for ( let z = 0; z <= 1; z ++ ) {

				const v = target[ index ];
				v.x = x === 0 ? min.x : max.x;
				v.y = y === 0 ? min.y : max.y;
				v.z = z === 0 ? min.z : max.z;
				index ++;

			}

		}

	}

	return target;

}

/**
 * Determine if a line segment is to the right of a box.
 *
 * @param {THREE.Line3} segment
 * @param {number} minX The leftmost X coordinate of the box
 * @param {number} minY The bottommost Y coordinate of the box
 * @param {number} maxY The topmost Y coordinate of the box
 * @returns {boolean}
 */
function isSegmentToTheRight( segment, minX, minY, maxY ) {

	const sx = segment.start.x;
	const sy = segment.start.y;
	const ex = segment.end.x;
	const ey = segment.end.y;

	if ( sx < minX && ex < minX ) return false;
	if ( sy > maxY && ey > maxY ) return false;
	if ( sy < minY && ey < minY ) return false;

	return true;

}

/**
 * Given a list of points representing a polygon, produce a list of line segments of that polygon.
 *
 * @param {Array<THREE.Vector3>} points
 * @param {Array<THREE.Line3> | null} target Array of the same length as `points` of lines to write to
 * @returns {Array<THREE.Line3>}
 */
function connectPointsWithLines( points, target = null ) {

	if ( target === null ) {

		target = new Array( points.length ).fill( null ).map( () => new THREE.Line3() );

	}

	return points.map( ( p, i ) => {

		const nextP = points[ ( i + 1 ) % points.length ];
		const line = target[ i ];
		line.start.copy( p );
		line.end.copy( nextP );
		return line;

	} );

}

/**
 * Convert a list of triplets representing coordinates into a list of 3D points.
 * @param {Array<number>} array Array of points in the form [x0, y0, z0, x1, y1, z1, …]
 * @returns {Array<THREE.Vector3>}
 */
function convertTripletsToPoints( array ) {

	const points = [];
	for ( let i = 0; i < array.length; i += 3 ) {

		points.push( new THREE.Vector3( array[ i ], array[ i + 1 ], array[ i + 2 ] ) );

	}

	return points;

}

// 辅助函数：计算三角形面积
function getTriangleArea(p1, p2, p3) {
	const a = p2.clone().sub(p1);
	const b = p3.clone().sub(p1);
	return Math.abs(a.cross(b).length() / 2);
}

// 辅助函数：检查点是否在三角形内
function isPointInTriangle(p, a, b, c, totalArea) {
	const area1 = getTriangleArea(p, a, b);
	const area2 = getTriangleArea(p, b, c);
	const area3 = getTriangleArea(p, c, a);
	
	// 允许一定的误差
	const sum = area1 + area2 + area3;
	return Math.abs(sum - totalArea) <= 1e-10;
}
