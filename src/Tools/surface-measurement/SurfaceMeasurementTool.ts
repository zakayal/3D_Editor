//@ts-ignore
import * as THREE from 'three';
import { BaseTool, ITool } from '../../Components/Base-tools/BaseTool';
import { InteractionEvent, ToolMode, SurfaceMeasurementAnnotation, ISceneController, IAnnotationManager, IDijkstraService, IEventEmitter } from '../../types/webgl-marking'; // 导入接口
//@ts-ignore
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

export class SurfaceMeasurementTool extends BaseTool implements ITool {
    private dijkstraService: IDijkstraService; 

    // --- 状态 ---
    private currentSurfaceUserPoints: Array<{ point: THREE.Vector3, intersection: THREE.Intersection | null }> = [];
    private currentSurfaceDisplayPath: THREE.Vector3[] = [];
    private currentSurfaceVisualCurve: THREE.Line | null = null;
    private currentSurfaceLength: number = 0;

    private previewSurfaceSegmentLine: THREE.Line | null = null;
    private startPointVisualCue: THREE.Mesh | null = null;
    private isSnappingToStartPoint: boolean = false;
    
    // 添加点标记存储
    private pointMarkers: THREE.Mesh[] = []; // 存储所有点的可视化标记

    // --- 配置 ---
    private readonly SNAP_DISTANCE_THRESHOLD: number = 0.01; // 吸附阈值 (根据模型大小调整)
    private readonly CUE_GEOMETRY_RADIUS: number = 0.003; // 吸附提示球大小
    private readonly POINT_MARKER_RADIUS: number = 0.002; // 点标记球大小
    private readonly LINE_COLOR: THREE.Color = new THREE.Color(0x0000ff); // 蓝色（实时测量线）
    private readonly SAVED_LINE_COLOR: THREE.Color = new THREE.Color(0xff0000); // 红色（保存后测量线）
    private readonly PREVIEW_COLOR: THREE.Color = new THREE.Color(0xffff00); // 黄色
    private readonly CUE_COLOR: THREE.Color = new THREE.Color(0xffff00); // 黄色
    private readonly POINT_MARKER_COLOR: THREE.Color = new THREE.Color(0x00ff00); // 绿色（点标记）

    private lastPreviewUpdateTime: number = 0;//上次预览更新时间戳
    private readonly PREVIEW_UPDATE_INTERVAL: number = 100; // 预览间隔时间

    constructor(sceneController: ISceneController, annotationManager: IAnnotationManager, dijkstraService: IDijkstraService, eventEmitter: IEventEmitter) { 
        super(sceneController, annotationManager, eventEmitter); 
        this.dijkstraService = dijkstraService;    
    }

    getMode(): ToolMode {
        return ToolMode.SurfaceMeasure;
    }

    activate(): void {
        super.activate();
        if (!this.dijkstraService.isReady()) {
            console.warn("[SurfaceTool.activate] Cannot activate SurfaceMeasurementTool, DijkstraService not ready.");
            this.eventEmitter.emit('notification', { message: "模型数据未就绪，无法开始表面测距。" });
            this.eventEmitter.emit('toolModeChangeRequested', { mode: ToolMode.Idle });
            return;
        }
        console.log("[SurfaceTool.activate] SurfaceMeasurementTool activated.");
        this.sceneController.orbitControls.enabled = true;
        this._resetCurrentPath();
        this._initVisualCues();
        this.eventEmitter.emit('modeChanged', { mode: ToolMode.SurfaceMeasure, enabled: true });
        this.eventEmitter.emit('measurementUpdated', { length: 0, showControls: true, isMeasuring: true });

        this.sceneController.renderer.domElement.classList.add('measure-cursor');
        this.sceneController.renderer.domElement.classList.remove('default-cursor');
    }

    deactivate(): void {
        console.log("[SurfaceTool.deactivate] SurfaceMeasurementTool deactivated.");
        this.sceneController.orbitControls.enabled = true;
        this._clearCurrentVisuals();
        this._resetCurrentPath();
        this._removeVisualCues();
        this.eventEmitter.emit('modeChanged', { mode: ToolMode.SurfaceMeasure, enabled: false });
        this.eventEmitter.emit('measurementUpdated', { showControls: false, isMeasuring: false });

        this.sceneController.renderer.domElement.classList.remove('measure-cursor');
        this.sceneController.renderer.domElement.classList.add('default-cursor');
    }

    private _initVisualCues(): void {
        if (!this.startPointVisualCue) {
            const cueGeometry = new THREE.SphereGeometry(this.CUE_GEOMETRY_RADIUS, 16, 16);
            const cueMaterial = new THREE.MeshBasicMaterial({
                color: this.CUE_COLOR,
                depthTest: false,
                depthWrite: false,
                transparent: true,
                opacity: 0.7
            });
            this.startPointVisualCue = new THREE.Mesh(cueGeometry, cueMaterial);
            this.startPointVisualCue.renderOrder = 1000;
            this.startPointVisualCue.visible = false;
            this.sceneController.scene.add(this.startPointVisualCue);
        }
    }

    private _removeVisualCues(): void {
        if (this.startPointVisualCue) {
            this.sceneController.scene.remove(this.startPointVisualCue);
            this.startPointVisualCue.geometry.dispose();
            (this.startPointVisualCue.material as THREE.Material).dispose();
            this.startPointVisualCue = null;
        }
    }

    onPointerDown(event: InteractionEvent): void {
        console.log("[SurfaceTool.onPointerDown] Pointer down event received.");
        if (!event.intersection) {
            console.log("[SurfaceTool.onPointerDown] No intersection, returning.");
            return;
        }
        if (!this.dijkstraService.isReady()) {
            console.warn("[SurfaceTool.onPointerDown] DijkstraService not ready, returning.");
            return;
        }

        const pointOnSurface = event.intersection.point.clone();
        const intersectionData = event.intersection;

        if (this.isSnappingToStartPoint && this.currentSurfaceUserPoints.length >= 2) {
            console.log("[SurfaceTool.onPointerDown] Snapping to start point to close path.");
            const firstPointData = this.currentSurfaceUserPoints[0];
            this._addPointToSurfacePath(firstPointData.point.clone(), firstPointData.intersection);
        } else {
            console.log("[SurfaceTool.onPointerDown] Adding new point to path.");
            this._addPointToSurfacePath(pointOnSurface, intersectionData);
        }
        this.eventEmitter.emit('measurementUpdated', { length: this.currentSurfaceLength, showControls: true, isMeasuring: true });
    }

    onPointerMove(event: InteractionEvent): void {
        if (this.currentSurfaceUserPoints.length === 0 || !this.dijkstraService.isReady()) {
            this._hidePreview();
            return;
        }

        if (event.intersection) {
            this._updatePathPreview(event.intersection);
            
            // 在移动时计算并显示预计的总长度
            if (this.currentSurfaceUserPoints.length > 0) {
                const tempLength = this._calculateProvisionalLength(event.intersection.point);
                this.eventEmitter.emit('measurementUpdated', { length: tempLength, showControls: true, isMeasuring: true });
            }
        } else {
            this._hidePreview();
            
            // 即使没有intersection，也要保持当前已确认的长度显示
            if (this.currentSurfaceUserPoints.length > 0) {
                this.eventEmitter.emit('measurementUpdated', { length: this.currentSurfaceLength, showControls: true, isMeasuring: true });
            }
        }
    }

    onContextMenu(event: InteractionEvent): void {
        event.originalEvent.preventDefault();
        this.cancelCurrentMeasurement();
    }

    onKeyDown(event: InteractionEvent): void {
        if ((event.originalEvent as KeyboardEvent).key === 'Escape') {
            this.cancelCurrentMeasurement();
        }
    }

    public cancelCurrentMeasurement(): void {
        console.log("[SurfaceTool.cancelCurrentMeasurement] Cancelling current measurement.");
        this._clearCurrentVisuals();
        this._resetCurrentPath();
        this.eventEmitter.emit('measurementUpdated', { showControls: false, isMeasuring: false });
        this.eventEmitter.emit('toolModeChangeRequested', { mode: ToolMode.Idle });
    }

    public saveCurrentMeasurement(): void {
        console.log("[SurfaceTool.saveCurrentMeasurement] Attempting to save measurement.");
        if (this.currentSurfaceUserPoints.length < 2) {
            console.warn("[SurfaceTool.saveCurrentMeasurement] Need at least two points to save measurement.");
            this.eventEmitter.emit('notification', { message: "请至少点击两个点以完成测量。" });
            return;
        }

        this._updateCurrentVisuals();
        this._hidePreview();

        if (this.currentSurfaceVisualCurve) {
            (this.currentSurfaceVisualCurve.material as THREE.LineBasicMaterial).color.copy(this.SAVED_LINE_COLOR);
        }

        const { labelObject: savedLengthLabel, lineObject: leaderLine } =
            this._createSavedMeasurementLabel(this.currentSurfaceLength, this.currentSurfaceDisplayPath);

        const measurementData: Omit<SurfaceMeasurementAnnotation, 'id' | 'type'> = {
            userClickedPoints: this.currentSurfaceUserPoints.map(data => data.point.clone()),
            pathPoints: [...this.currentSurfaceDisplayPath],
            length: this.currentSurfaceLength,
            curveLineObject: this.currentSurfaceVisualCurve,
            savedLabelObject: savedLengthLabel,
            leaderLineObject: leaderLine,
        };

        const addedAnnotation = this.annotationManager.addSurfaceMeasurement(measurementData);
        this.eventEmitter.emit('annotationAdded', addedAnnotation);
        this.eventEmitter.emit('measurementCompleted', addedAnnotation);
        console.log("[SurfaceTool.saveCurrentMeasurement] Measurement saved:", addedAnnotation.id);

        this.currentSurfaceVisualCurve = null;
        this._resetCurrentPath();
        this.eventEmitter.emit('measurementUpdated', { showControls: false, isMeasuring: false });
        this.eventEmitter.emit('toolModeChangeRequested', { mode: ToolMode.Idle });
    }

private _addPointToSurfacePath(point: THREE.Vector3, intersection: THREE.Intersection | null): void {
    const clonedPoint = point.clone(); // 克隆点以避免外部修改
    this.currentSurfaceUserPoints.push({ point: clonedPoint, intersection });

    if (this.currentSurfaceUserPoints.length === 1) {
        // 如果这是第一个点，直接添加到显示路径
        this.currentSurfaceDisplayPath.push(clonedPoint);
    } else if (this.dijkstraService.isReady()) {
        // 如果是后续的点，并且 Dijkstra 服务已就绪
        const previousPointData = this.currentSurfaceUserPoints[this.currentSurfaceUserPoints.length - 2]; // 获取上一个用户点击的点的信息
        const previousPoint = previousPointData.point;
        const newPoint = clonedPoint; // 当前点击的点

        // 获取上一个点在图中的顶点索引
        // 优先使用 intersection 数据获取更精确的附着面顶点
        const startVertexIndex = previousPointData.intersection
            ? this.dijkstraService.getClosestGraphVertexNearIntersection(previousPointData.intersection)
            : this.dijkstraService.getClosestVertexIndex(previousPoint);

        // 获取当前点在图中的顶点索引
        const endVertexIndex = intersection
            ? this.dijkstraService.getClosestGraphVertexNearIntersection(intersection)
            : this.dijkstraService.getClosestVertexIndex(newPoint);

        if (startVertexIndex !== null && endVertexIndex !== null) {
            // 如果两个点的顶点索引都找到了
            const pathSegment = this.dijkstraService.findShortestPath(startVertexIndex, endVertexIndex);

            if (pathSegment && pathSegment.length > 0) {
                // 如果找到了路径
                // 检查新路径段的第一个点是否与 currentSurfaceDisplayPath 的最后一个点相同
                // 如果相同，则从 pathSegment 的第二个点开始添加，以避免重复点
                if (this.currentSurfaceDisplayPath.length > 0 &&
                    pathSegment[0].equals(this.currentSurfaceDisplayPath[this.currentSurfaceDisplayPath.length - 1])) {
                    this.currentSurfaceDisplayPath.push(...pathSegment.slice(1));
                } else {
                    this.currentSurfaceDisplayPath.push(...pathSegment);
                }
                console.log(`[SurfaceTool._addPointToSurfacePath] Dijkstra path segment added. Length: ${pathSegment.length}`);
            } else {
                // 未找到 Dijkstra 路径（可能点在不同连通组件，或算法限制）
                // 回退策略：直接添加当前点击的点，形成直线段
                console.warn("[SurfaceTool._addPointToSurfacePath] Dijkstra path not found. Falling back to straight line segment.");
                this.currentSurfaceDisplayPath.push(newPoint);
            }
        } else {
            //未能为起点或终点找到有效的图顶点索引
            console.warn("[SurfaceTool._addPointToSurfacePath] Could not find vertex indices for Dijkstra path. Falling back to straight line segment.");
            this.currentSurfaceDisplayPath.push(newPoint);
        }
    } else {
        // Dijkstra 服务未就绪，或者不是第一个点但服务不可用
        // 回退策略：直接添加当前点击的点
        this.currentSurfaceDisplayPath.push(clonedPoint);
    }

    console.log(`[SurfaceTool._addPointToSurfacePath] User clicked point ${this.currentSurfaceUserPoints.length}:`, clonedPoint.toArray());
    console.log(`[SurfaceTool._addPointToSurfacePath] Display path now has ${this.currentSurfaceDisplayPath.length} points`);

    // 为新点添加可视化标记 (基于用户实际点击的点)
    this._addPointMarker(clonedPoint);

    // 更新视觉效果（基于 currentSurfaceDisplayPath）
    this._updateCurrentVisuals();
}

    private _addPointMarker(point: THREE.Vector3): void {
        const markerGeometry = new THREE.SphereGeometry(this.POINT_MARKER_RADIUS, 8, 8);
        const markerMaterial = new THREE.MeshBasicMaterial({
            color: this.POINT_MARKER_COLOR,
            depthTest: false,
            depthWrite: false,
            transparent: true,
            opacity: 0.9
        });
        const marker = new THREE.Mesh(markerGeometry, markerMaterial);
        marker.position.copy(point);
        marker.renderOrder = 1001; // 高于其他元素
        this.sceneController.scene.add(marker);
        this.pointMarkers.push(marker);
        console.log("[SurfaceTool._addPointMarker] Added point marker at:", point.toArray());
    }

    private _clearPointMarkers(): void {
        this.pointMarkers.forEach(marker => {
            this.sceneController.scene.remove(marker);
            marker.geometry.dispose();
            (marker.material as THREE.Material).dispose();
        });
        this.pointMarkers = [];
        console.log("[SurfaceTool._clearPointMarkers] Cleared all point markers.");
    }

    private _updateCurrentVisuals(): void {
        console.log("[SurfaceTool._updateCurrentVisuals] Called. User points:", this.currentSurfaceUserPoints.length, "Display path:", this.currentSurfaceDisplayPath.length);
        
        // 清除旧的视觉连线
        if (this.currentSurfaceVisualCurve) {
            this.sceneController.scene.remove(this.currentSurfaceVisualCurve);
            this.currentSurfaceVisualCurve.geometry.dispose();
            (this.currentSurfaceVisualCurve.material as THREE.Material).dispose();
            this.currentSurfaceVisualCurve = null;
        }

        // 如果少于2个点，不绘制连线，但保持已有长度
        if (this.currentSurfaceDisplayPath.length < 2) {
            if (this.currentSurfaceDisplayPath.length === 0) {
                this.currentSurfaceLength = 0;
                console.log("[SurfaceTool._updateCurrentVisuals] No points, length set to 0.");
            }
            this.eventEmitter.emit('measurementUpdated', { length: this.currentSurfaceLength, showControls: this.currentSurfaceUserPoints.length > 0, isMeasuring: true });
            return;
        }

        // 计算所有点击点之间的总长度
        this.currentSurfaceLength = 0;
        for (let i = 0; i < this.currentSurfaceDisplayPath.length - 1; i++) {
            this.currentSurfaceLength += this.currentSurfaceDisplayPath[i].distanceTo(this.currentSurfaceDisplayPath[i + 1]);
        }
        console.log("[SurfaceTool._updateCurrentVisuals] Calculated total length:", this.currentSurfaceLength);

        // 直接使用点击点绘制连线（不使用曲线平滑）
        const geometry = new THREE.BufferGeometry().setFromPoints(this.currentSurfaceDisplayPath);
        const material = new THREE.LineBasicMaterial({
            color: this.LINE_COLOR,
            transparent: true,
            opacity: 0.8,
            depthTest: false,
            depthWrite: false
        });
        this.currentSurfaceVisualCurve = new THREE.Line(geometry, material);
        this.currentSurfaceVisualCurve.renderOrder = 999;
        this.sceneController.scene.add(this.currentSurfaceVisualCurve);
        console.log("[SurfaceTool._updateCurrentVisuals] Visual curve updated/created with", this.currentSurfaceDisplayPath.length, "points.");

        this.eventEmitter.emit('measurementUpdated', { length: this.currentSurfaceLength, showControls: true, isMeasuring: true });
    }

    private _updatePathPreview(intersection: THREE.Intersection): void {
        const now = Date.now();
        if (now - this.lastPreviewUpdateTime < this.PREVIEW_UPDATE_INTERVAL) {
            return;
        }
        this.lastPreviewUpdateTime = now;

        // 如果没有任何点击点，不显示预览
        if (this.currentSurfaceUserPoints.length === 0) {
            this._hidePreview();
            return;
        }

        // 初始化预览线段
        if (!this.previewSurfaceSegmentLine) {
            const geometry = new THREE.BufferGeometry();
            const material = new THREE.LineDashedMaterial({
                color: this.PREVIEW_COLOR,
                depthTest: false,
                depthWrite: false,
                transparent: true,
                opacity: 0.8,
                dashSize: 0.02, // 虚线效果
                gapSize: 0.01,
                scale: 1
            });
            this.previewSurfaceSegmentLine = new THREE.Line(geometry, material);
            this.previewSurfaceSegmentLine.renderOrder = 998;
            this.sceneController.scene.add(this.previewSurfaceSegmentLine);
            console.log("[SurfaceTool._updatePathPreview] Initialized previewSurfaceSegmentLine and added to scene.");
        }

        // 获取最后一个点击点
        const lastClickedPoint = this.currentSurfaceUserPoints[this.currentSurfaceUserPoints.length - 1].point;
        if (!lastClickedPoint) {
            console.error("[SurfaceTool._updatePathPreview] lastClickedPoint is undefined, cannot draw preview.");
            this._hidePreview();
            return;
        }

        // 检查是否需要吸附到起始点（用于闭合路径）
        let previewEndPoint = intersection.point.clone();
        this.isSnappingToStartPoint = false;

        const firstPointData = this.currentSurfaceUserPoints[0];
        if (this.currentSurfaceUserPoints.length >= 2 && this.startPointVisualCue && firstPointData?.point) {
            const distanceToStart = intersection.point.distanceTo(firstPointData.point);
            if (distanceToStart < this.SNAP_DISTANCE_THRESHOLD) {
                previewEndPoint = firstPointData.point.clone();
                this.isSnappingToStartPoint = true;
                this.startPointVisualCue.position.copy(firstPointData.point);
                this.startPointVisualCue.visible = true;
            } else {
                this.startPointVisualCue.visible = false;
            }
        }

        // 创建简单的预览线段：从最后一个点击点到鼠标位置
        try {
            const previewPoints = [lastClickedPoint.clone(), previewEndPoint];
            this.previewSurfaceSegmentLine.geometry.setFromPoints(previewPoints);
            this.previewSurfaceSegmentLine.computeLineDistances(); // 计算虚线距离
            this.previewSurfaceSegmentLine.visible = true;
            console.log("[SurfaceTool._updatePathPreview] Preview line updated from last clicked point to mouse position.");
        } catch (e) {
            console.error("[SurfaceTool._updatePathPreview] Error creating preview line:", e);
            this._hidePreview();
        }
    }

    private _hidePreview(): void {
        if (this.previewSurfaceSegmentLine) this.previewSurfaceSegmentLine.visible = false;
        if (this.startPointVisualCue) this.startPointVisualCue.visible = false;
        this.isSnappingToStartPoint = false;
    }

    private _calculateProvisionalLength(mousePosition: THREE.Vector3 | null): number {
        let provisionalLength = this.currentSurfaceLength;
        if (this.currentSurfaceUserPoints.length > 0 && mousePosition) {
            const lastClickedPoint = this.currentSurfaceUserPoints[this.currentSurfaceUserPoints.length - 1].point;
            if (lastClickedPoint) {
                // 添加从最后一个点击点到鼠标位置的距离
                provisionalLength += lastClickedPoint.distanceTo(mousePosition);
            }
        }
        return provisionalLength;
    }

    private _resetCurrentPath(): void {
        console.log("[SurfaceTool._resetCurrentPath] Resetting current path data.");
        this.currentSurfaceUserPoints = [];
        this.currentSurfaceDisplayPath = [];
        this.currentSurfaceLength = 0;
        this.isSnappingToStartPoint = false;
        if (this.startPointVisualCue) this.startPointVisualCue.visible = false;
        this._clearPointMarkers();
        this._hidePreview();
    }

    private _clearCurrentVisuals(fullClear: boolean = true): void {
        if (this.currentSurfaceVisualCurve) {
            this.sceneController.scene.remove(this.currentSurfaceVisualCurve);
            this.currentSurfaceVisualCurve.geometry.dispose();
            (this.currentSurfaceVisualCurve.material as THREE.Material).dispose();
            this.currentSurfaceVisualCurve = null;
        }

        if (this.previewSurfaceSegmentLine && fullClear) { 
            this.sceneController.scene.remove(this.previewSurfaceSegmentLine);
            this.previewSurfaceSegmentLine.geometry.dispose();
            (this.previewSurfaceSegmentLine.material as THREE.Material).dispose();
            this.previewSurfaceSegmentLine = null;
        }

        if (fullClear) {
            this._resetCurrentPath(); 
        }
    }

    private _createSavedMeasurementLabel(length: number, pathPoints: THREE.Vector3[]): { labelObject: CSS2DObject, lineObject: THREE.Line } {
        const labelDiv = document.createElement('div');
        labelDiv.className = 'measurement-label surface-label saved-surface-label';
        labelDiv.textContent = `${length.toFixed(2)} m`;

        const labelObject = new CSS2DObject(labelDiv);
        labelObject.layers.set(0);

        let leaderLine: THREE.Line = new THREE.Line(); 

        if (pathPoints.length > 1) {
            const pathRefPoint = pathPoints[0].clone();
            let surfaceNormal = new THREE.Vector3(0, 1, 0);
            const meshGeometry = this.sceneController.getTargetMeshGeometry();
            const meshWorldMatrix = this.sceneController.getTargetMeshWorldMatrix();

            if (meshGeometry && meshWorldMatrix) {
                const graphData = this.dijkstraService.getGraphData();
                if (graphData) {
                    const closestVertexIndex = this.dijkstraService.getClosestVertexIndex(pathRefPoint);
                    if (closestVertexIndex !== null && meshGeometry.attributes.normal) {
                        const normalAttribute = meshGeometry.attributes.normal as THREE.BufferAttribute;
                        const tempNormal = new THREE.Vector3().fromBufferAttribute(normalAttribute, closestVertexIndex);
                        const normalMatrix = new THREE.Matrix3().getNormalMatrix(meshWorldMatrix);
                        tempNormal.applyMatrix3(normalMatrix).normalize();
                        surfaceNormal.copy(tempNormal);
                    }
                }
            }
            
            const labelOffsetDistance = 0.01; 
            let labelPosition = pathRefPoint.clone().add(surfaceNormal.clone().multiplyScalar(labelOffsetDistance));

            if (pathPoints.length === 2) {
                const segmentDirection = new THREE.Vector3().subVectors(pathPoints[1], pathPoints[0]).normalize();
                const crossDir = new THREE.Vector3().crossVectors(segmentDirection, surfaceNormal).normalize();
                labelPosition.add(crossDir.multiplyScalar(labelOffsetDistance * 0.3));
            }
            labelObject.position.copy(labelPosition);

            const leaderLinePoints: THREE.Vector3[] = [];
            const labelInnerPoint = labelPosition.clone().sub(surfaceNormal.clone().multiplyScalar(labelOffsetDistance * 0.9));
            leaderLinePoints.push(labelPosition.clone());
            leaderLinePoints.push(labelInnerPoint);
            leaderLinePoints.push(pathRefPoint.clone());

            const leaderLineGeometry = new THREE.BufferGeometry().setFromPoints(leaderLinePoints);
            const leaderLineMaterial = new THREE.LineBasicMaterial({
                color: this.SAVED_LINE_COLOR,
                // linewidth: 1,
                transparent: true,
                opacity: 0.7, 
                depthTest: true, 
                depthWrite: true,
            });
            leaderLine = new THREE.Line(leaderLineGeometry, leaderLineMaterial);
            leaderLine.renderOrder = 997;
        } else {
            console.warn("[SurfaceTool._createSavedMeasurementLabel] Path has too few points to create meaningful saved label and leader line.");
            labelObject.position.copy(pathPoints[0] || new THREE.Vector3());
        }
        return { labelObject, lineObject: leaderLine };
    }

    dispose(): void {
        super.dispose();
        this._clearCurrentVisuals(true); 
        this._removeVisualCues();
        console.log("[SurfaceTool.dispose] SurfaceMeasurementTool disposed.");
    }
}