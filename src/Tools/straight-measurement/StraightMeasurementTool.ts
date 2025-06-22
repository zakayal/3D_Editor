//@ts-ignore
import * as THREE from 'three';
import { BaseTool, ITool } from '../../components/Base-tools/BaseTool';
import { InteractionEvent, ToolMode, StraightMeasurementAnnotation, ISceneController, IAnnotationManager, IEventEmitter } from '../../types/webgl-marking'; 
//@ts-ignore
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

// 直线测量工具
export class StraightMeasurementTool extends BaseTool implements ITool {
    // --- 状态 ---
    private currentPoints: THREE.Vector3[] = [];
    private currentLine: THREE.Line | null = null;
    private currentStartSphere: THREE.Mesh | null = null;
    private currentEndSphere: THREE.Mesh | null = null;
    private currentLengthLabel: CSS2DObject | null = null;
    private previewLine: THREE.Line | null = null;

    // --- 配置 ---
    private readonly SPHERE_GEOMETRY_RADIUS: number = 0.003; // 端点球大小
    private readonly LINE_COLOR: THREE.Color = new THREE.Color(0xffff00); // 黄色
    private readonly PREVIEW_COLOR: THREE.Color = new THREE.Color(0xffff00); // 黄色

    constructor(sceneController: ISceneController, annotationManager: IAnnotationManager, eventEmitter: IEventEmitter) { 
        super(sceneController, annotationManager, eventEmitter); 
    }

    getMode(): ToolMode {
        return ToolMode.StraightMeasure;
    }

    activate(): void {
        super.activate();
        console.log("StraightMeasurementTool activated.");
        this.sceneController.orbitControls.enabled = true; // 测量时禁用相机
        this._resetCurrentMeasurement();
        this.eventEmitter.emit('modeChanged', { mode: ToolMode.StraightMeasure, enabled: true });
    }

    deactivate(): void {
        console.log("StraightMeasurementTool deactivated.");
        this.sceneController.orbitControls.enabled = true; // 恢复相机
        this._clearCurrentVisuals(true); // 清理所有视觉元素
        this.eventEmitter.emit('modeChanged', { mode: ToolMode.StraightMeasure, enabled: false });
    }

    onPointerDown(event: InteractionEvent): void {
        if (!event.intersection) return;

        const point = event.intersection.point.clone();
        this.currentPoints.push(point);
        this._clearPreviewLine(); // 无论如何，点击后都清除预览线

        if (this.currentPoints.length === 1) {
            // 第一个点：创建起始球
            this._clearCurrentVisuals(false); // 清理可能存在的旧视觉
            this.currentStartSphere = this._createSphere(point);
            this.sceneController.scene.add(this.currentStartSphere);
            // 预览线将在 onPointerMove 中创建
        } else if (this.currentPoints.length === 2) {
            // 第二个点：创建结束球和线，并完成测量
            const startPoint = this.currentPoints[0];
            const endPoint = this.currentPoints[1];

            this.currentEndSphere = this._createSphere(endPoint);
            this.sceneController.scene.add(this.currentEndSphere);

            const lineGeometry = new THREE.BufferGeometry().setFromPoints([startPoint, endPoint]);
            const lineMaterial = new THREE.LineBasicMaterial({
                color: this.LINE_COLOR,
                linewidth: 2, // WebGL 线宽限制
                depthTest: false,
                depthWrite: false,
            });
            this.currentLine = new THREE.Line(lineGeometry, lineMaterial);
            this.currentLine.renderOrder = 1000;
            this.sceneController.scene.add(this.currentLine);

            const length = startPoint.distanceTo(endPoint);
            const midPoint = new THREE.Vector3().addVectors(startPoint, endPoint).multiplyScalar(0.5);
            this.currentLengthLabel = this._createLengthLabel(length, midPoint);
            this.sceneController.scene.add(this.currentLengthLabel);

            this._finalizeMeasurement(); // 保存并重置
        }
    }

    onPointerMove(event: InteractionEvent): void {
        if (this.currentPoints.length !== 1 || !event.intersection) {
            this._clearPreviewLine();
            // 强制渲染以确保预览线的清除生效
            this.sceneController.forceRender();
            return;
        }

        const startPoint = this.currentPoints[0];
        const currentMousePos = event.intersection.point;

        this._clearPreviewLine(); // 清理旧的

        const points = [startPoint.clone(), currentMousePos.clone()];
        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const material = new THREE.LineDashedMaterial({
            color: this.PREVIEW_COLOR,
            linewidth: 1,
            scale: 1,
            dashSize: 0.05,
            gapSize: 0.03,
            depthTest: false,
            depthWrite: false,
        });
        this.previewLine = new THREE.Line(geometry, material);
        this.previewLine.renderOrder = 998;
        this.previewLine.computeLineDistances();
        this.sceneController.scene.add(this.previewLine);
        
        // 强制渲染以确保预览线显示
        this.sceneController.forceRender();
    }

    onKeyDown(event: InteractionEvent): void {
        
        console.log("StraightMeasurementTool: onKeyDown triggered. Original key:", (event.originalEvent as KeyboardEvent).key);
        if ((event.originalEvent as KeyboardEvent).key === 'Escape') {
            this._resetCurrentMeasurement();
            console.log("StraightMeasurementTool: Emitting toolModeChangeRequested to Idle.");
            this.eventEmitter.emit('toolModeChangeRequested', { mode: ToolMode.Idle });
        }
    }

    private _finalizeMeasurement(): void {
        if (this.currentPoints.length !== 2 || !this.currentLine || !this.currentStartSphere || !this.currentEndSphere || !this.currentLengthLabel) {
            console.warn("Cannot finalize straight measurement, data incomplete.");
            this._resetCurrentMeasurement();
            return;
        }

        const startPoint = this.currentPoints[0];
        const endPoint = this.currentPoints[1];
        const length = startPoint.distanceTo(endPoint);

        const measurementData: Omit<StraightMeasurementAnnotation, 'id' | 'type'> = {
            startPoint: startPoint.clone(),
            endPoint: endPoint.clone(),
            length: length,
            lineObject: this.currentLine,
            startSphere: this.currentStartSphere,
            endSphere: this.currentEndSphere,
            lengthLabelObject: this.currentLengthLabel,
        };

        const addedAnnotation = this.annotationManager.addStraightMeasurement(measurementData);
        this.eventEmitter.emit('annotationAdded', addedAnnotation);
        this.eventEmitter.emit('measurementCompleted', addedAnnotation);

        // 重置状态，准备下一次测量（但不离开模式）
        this.currentPoints = [];
        this.currentLine = null;
        this.currentStartSphere = null;
        this.currentEndSphere = null;
        this.currentLengthLabel = null;
    }

    private _resetCurrentMeasurement(): void {
        this._clearCurrentVisuals(true);
        this.currentPoints = [];
    }

    private _clearCurrentVisuals(fullClear: boolean = true): void {
        if (this.currentLine) {
            this.sceneController.scene.remove(this.currentLine);
            this.currentLine.geometry.dispose();
            (this.currentLine.material as THREE.Material).dispose();
            this.currentLine = null;
        }
        if (this.currentStartSphere) {
            this.sceneController.scene.remove(this.currentStartSphere);
            this.currentStartSphere.geometry.dispose();
            (this.currentStartSphere.material as THREE.Material).dispose();
            this.currentStartSphere = null;
        }
        if (this.currentEndSphere) {
            this.sceneController.scene.remove(this.currentEndSphere);
            this.currentEndSphere.geometry.dispose();
            (this.currentEndSphere.material as THREE.Material).dispose();
            this.currentEndSphere = null;
        }
        if (this.currentLengthLabel) {
            if (this.currentLengthLabel.element.parentElement) {
                this.currentLengthLabel.element.parentElement.removeChild(this.currentLengthLabel.element);
            }
            this.sceneController.scene.remove(this.currentLengthLabel);
            this.currentLengthLabel = null;
        }
        if (fullClear) {
            this._clearPreviewLine();
        }
    }

    private _clearPreviewLine(): void {
        if (this.previewLine) {
            this.sceneController.scene.remove(this.previewLine);
            this.previewLine.geometry.dispose();
            (this.previewLine.material as THREE.Material).dispose();
            this.previewLine = null;
        }
    }


    private _createSphere(position: THREE.Vector3): THREE.Mesh {
        const geometry = new THREE.SphereGeometry(this.SPHERE_GEOMETRY_RADIUS, 16, 16);
        const material = new THREE.MeshBasicMaterial({
            color: this.LINE_COLOR,
            depthTest: false,
            depthWrite: false,
        });
        const sphere = new THREE.Mesh(geometry, material);
        sphere.position.copy(position);
        sphere.renderOrder = 1001; // 比线高
        return sphere;
    }

    private _createLengthLabel(length: number, position: THREE.Vector3): CSS2DObject {
        const labelDiv = document.createElement('div');
        labelDiv.className = 'measurement-label straight-label'; // 添加类名
        labelDiv.textContent = `${length.toFixed(2)} m`;

        const labelObject = new CSS2DObject(labelDiv);
        labelObject.position.copy(position);
        labelObject.layers.set(0);

        return labelObject;
    }

    dispose(): void {
        super.dispose();
        this._clearCurrentVisuals(true);
    }
}