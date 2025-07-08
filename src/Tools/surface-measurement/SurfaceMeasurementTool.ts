//@ts-ignore
import * as THREE from 'three';
import { BaseTool, ITool } from '../../components/Base-tools/BaseTool';
import { InteractionEvent, ToolMode, SurfaceMeasurementAnnotation, ISceneController, IAnnotationManager, IDijkstraService, IEventEmitter, IContextProvider } from '../../types/webgl-marking'; // 导入接口
//@ts-ignore
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

export class SurfaceMeasurementTool extends BaseTool implements ITool {
    private dijkstraService: IDijkstraService;
    private contextProvider: IContextProvider;

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
    private readonly CUE_GEOMETRY_RADIUS: number = 0.003; // 吸附提示球大小
    private readonly POINT_MARKER_RADIUS: number = 0.002; // 点标记球大小
    private readonly LINE_COLOR: THREE.Color = new THREE.Color(0x0000ff); // 蓝色（实时测量线）
    private readonly SAVED_LINE_COLOR: THREE.Color = new THREE.Color(0xff0000); // 红色（保存后测量线）
    private readonly CUE_COLOR: THREE.Color = new THREE.Color(0xffff00); // 黄色
    private readonly POINT_MARKER_COLOR: THREE.Color = new THREE.Color(0x00ff00); // 绿色（点标记）

    constructor(
        sceneController: ISceneController, 
        annotationManager: IAnnotationManager, 
        dijkstraService: IDijkstraService, 
        eventEmitter: IEventEmitter,
        contextProvider: IContextProvider
    ) {
        super(sceneController, annotationManager, eventEmitter);
        this.dijkstraService = dijkstraService;
        this.contextProvider = contextProvider;
    }

    /**
     * 获取当前测量上下文的partId，如果没有则使用默认值
     */
    private _getCurrentPartId(): string {
        const currentPartId = this.contextProvider.getCurrentContextPartId();
        // 如果没有当前上下文，默认使用主模型
        return currentPartId || 'human_model';
    }

    /**
     * 检查指定上下文的图数据是否准备就绪
     */
    private _isContextReady(partId: string): boolean {
        return this.dijkstraService.isContextReady(partId);
    }

    getMode(): ToolMode {
        return ToolMode.SurfaceMeasure;
    }

    activate(): void {
        super.activate();
        
        const currentPartId = this._getCurrentPartId();
        
        if (!this._isContextReady(currentPartId)) {
            console.warn(`[SurfaceTool.activate] Context ${currentPartId} not ready, DijkstraService not available.`);
            this.eventEmitter.emit('notification', { 
                message: `当前上下文 ${currentPartId} 的图数据未就绪，无法开始表面测距。`,
                type: 'warn'
            });
            this.eventEmitter.emit('toolModeChangeRequested', { mode: ToolMode.Idle });
            return;
        }
        
        console.log(`[SurfaceTool.activate] SurfaceMeasurementTool activated for context: "${currentPartId}"`);
        this.sceneController.orbitControls.enabled = true;
        this._resetCurrentPath();
        this._initVisualCues();
        this.eventEmitter.emit('modeChanged', { mode: this.getMode(), enabled: true });
        this.eventEmitter.emit('measurementUpdated', { length: 0, showControls: true, isMeasuring: true });

        // this.sceneController.renderer.domElement.classList.add('measure-cursor');
        // this.sceneController.renderer.domElement.classList.remove('default-cursor');
    }

    deactivate(): void {
        console.log("[SurfaceTool.deactivate] SurfaceMeasurementTool deactivated.");
        this.sceneController.orbitControls.enabled = true;
        this._clearCurrentVisuals();
        this._resetCurrentPath();
        this._removeVisualCues();
        this.eventEmitter.emit('modeChanged', { mode: this.getMode(), enabled: false });
        this.eventEmitter.emit('measurementUpdated', { showControls: false, isMeasuring: false });

        // this.sceneController.renderer.domElement.classList.remove('measure-cursor');
        // this.sceneController.renderer.domElement.classList.add('default-cursor');
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

        const currentPartId = this._getCurrentPartId();
        if (!this._isContextReady(currentPartId)) {
            console.warn(`[SurfaceTool.onPointerDown] Context ${currentPartId} not ready, returning.`);
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
        // 直接隐藏预览，并返回
        this._hidePreview();

        // (可选) 如果你还想在移动时看到长度变化，可以保留长度计算逻辑
        if (this.currentSurfaceUserPoints.length > 0 && event.intersection) {
            const tempLength = this._calculateProvisionalLength(event.intersection.point);
            this.eventEmitter.emit('measurementUpdated', { length: tempLength, showControls: true, isMeasuring: true });
        } else if (this.currentSurfaceUserPoints.length > 0) {
            this.eventEmitter.emit('measurementUpdated', { length: this.currentSurfaceLength, showControls: true, isMeasuring: true });
        }

        // 确保在每次移动时都隐藏预览线
        if (this.previewSurfaceSegmentLine) {
            this.previewSurfaceSegmentLine.visible = false;
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

        const contextId = this.contextProvider.getCurrentContextPartId() || 'human_model'
        const measurementData: Omit<SurfaceMeasurementAnnotation, 'id' | 'type' | 'contextId'> = {
            userClickedPoints: this.currentSurfaceUserPoints.map(data => data.point.clone()),
            pathPoints: [...this.currentSurfaceDisplayPath],
            length: this.currentSurfaceLength,
            curveLineObject: this.currentSurfaceVisualCurve,
            savedLabelObject: savedLengthLabel,
            leaderLineObject: leaderLine,
        };

        const addedAnnotation = this.annotationManager.addSurfaceMeasurement(measurementData,contextId);
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
        } else {
            // 获取当前上下文
            const currentPartId = this._getCurrentPartId();
            
            if (this._isContextReady(currentPartId)) {
                // 如果是后续的点，并且 Dijkstra 服务已就绪
                const previousPointData = this.currentSurfaceUserPoints[this.currentSurfaceUserPoints.length - 2]; // 获取上一个用户点击的点的信息
                const previousPoint = previousPointData.point;
                const newPoint = clonedPoint; // 当前点击的点

                // 获取上一个点在图中的顶点索引 - 传入 partId
                const startVertexIndex = previousPointData.intersection
                    ? this.dijkstraService.getClosestGraphVertexNearIntersection(previousPointData.intersection, currentPartId)
                    : this.dijkstraService.getClosestVertexIndex(previousPoint, currentPartId);

                // 获取当前点在图中的顶点索引 - 传入 partId
                const endVertexIndex = intersection
                    ? this.dijkstraService.getClosestGraphVertexNearIntersection(intersection, currentPartId)
                    : this.dijkstraService.getClosestVertexIndex(newPoint, currentPartId);

                if (startVertexIndex !== null && endVertexIndex !== null) {
                    // 如果两个点的顶点索引都找到了 - 传入 partId
                    const pathSegment = this.dijkstraService.findShortestPath(startVertexIndex, endVertexIndex, currentPartId);

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
                        console.log(`[SurfaceTool._addPointToSurfacePath] Dijkstra path segment added for context "${currentPartId}". Length: ${pathSegment.length}`);
                    } else {
                        // 未找到 Dijkstra 路径（可能点在不同连通组件，或算法限制）
                        // 回退策略：直接添加当前点击的点，形成直线段
                        console.warn(`[SurfaceTool._addPointToSurfacePath] Dijkstra path not found for context "${currentPartId}". Falling back to straight line segment.`);
                        this.currentSurfaceDisplayPath.push(newPoint);
                    }
                } else {
                    //未能为起点或终点找到有效的图顶点索引
                    console.warn(`[SurfaceTool._addPointToSurfacePath] Could not find vertex indices for Dijkstra path in context "${currentPartId}". Falling back to straight line segment.`);
                    this.currentSurfaceDisplayPath.push(newPoint);
                }
            } else {
                // 如果上下文图数据未准备好，使用回退策略
                console.warn(`[SurfaceTool._addPointToSurfacePath] Context "${currentPartId}" not ready. Falling back to straight line segment.`);
                this.currentSurfaceDisplayPath.push(clonedPoint);
            }
        }

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

        const lengthInCm = length * 100; 
        labelDiv.textContent = `${lengthInCm.toFixed(2)} cm`;

        const labelObject = new CSS2DObject(labelDiv);
        labelObject.layers.set(0);

        let leaderLine: THREE.Line = new THREE.Line();

        if (pathPoints.length > 1) {
            const pathRefPoint = pathPoints[0].clone();
            let surfaceNormal = new THREE.Vector3(0, 1, 0);
            const meshGeometry = this.sceneController.getTargetMeshGeometry();
            const meshWorldMatrix = this.sceneController.getTargetMeshWorldMatrix();

            if (meshGeometry && meshWorldMatrix) {
                const currentPartId = this._getCurrentPartId();
                const graphData = this.dijkstraService.getGraphData(currentPartId);
                if (graphData) {
                    const closestVertexIndex = this.dijkstraService.getClosestVertexIndex(pathRefPoint, currentPartId);
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