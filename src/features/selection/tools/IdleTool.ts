//@ts-ignore
import * as THREE from 'three';
import { BaseTool, ITool } from '../../../utils/BaseTool';
import { InteractionEvent, ToolMode, Annotation, ISceneController, IAnnotationManager, IEventEmitter } from '../../../types/webgl-marking';

export class IdleTool extends BaseTool implements ITool {
    private selectedAnnotationId: string | null = null;
    private raycaster = new THREE.Raycaster();
    private unsubscribeAnnotationRemoved: (() => void) | null = null; // 用于存储取消订阅函数

    constructor(sceneController: ISceneController, annotationManager: IAnnotationManager, eventEmitter: IEventEmitter) {
        super(sceneController, annotationManager, eventEmitter);
        // 设置 Raycaster 对线的拾取阈值 (根据需要调整)
        this.raycaster.params.Line = { threshold: 0.05 };
    }

    getMode(): ToolMode {
        return ToolMode.Idle;
    }

    activate(): void {

        super.activate();
        console.log("IdleTool activated.");
        // 允许相机控制
        this.sceneController.orbitControls.enabled = true;
        this.sceneController.orbitControls.mouseButtons.RIGHT = THREE.MOUSE.PAN
        this.sceneController.css2dRenderer.domElement.style.pointerEvents = 'none';

        this.eventEmitter.emit('modeChanged', { mode: this.getMode(), enabled: true });

        // 游标类名处理，UI层应监听 modeChanged 事件来处理，这里直接操作是为了快速实现。
        // 更好的做法是：UI层订阅 modeChanged 事件，并根据 mode 来设置 canvas 的 cursor 样式。
        // this.sceneController.renderer.domElement.classList.remove('measure-cursor');
        // this.sceneController.renderer.domElement.classList.add('default-cursor');

        this.unsubscribeAnnotationRemoved = this.eventEmitter.on('annotationRemoved', ({ id }) => {
            if (this.selectedAnnotationId === id) {
                this.deselectCurrent();
            }
        });
    }

    deactivate(): void {
        console.log("IdleTool deactivated.");
        // 确保在离开时取消选择
        this.deselectCurrent();
        // 取消监听 annotationRemoved 事件
        if (this.unsubscribeAnnotationRemoved) {
            this.unsubscribeAnnotationRemoved();
            this.unsubscribeAnnotationRemoved = null;
        }
    }

    onPointerDown(event: InteractionEvent): void {
        if (!event.pointer || !this.sceneController.camera) {
            this.deselectCurrent();
            return;
        }

        // 1. 获取所有可拾取的 3D 代理对象和模型本身
        const selectableObjects: THREE.Object3D[] = [];
        this.annotationManager.getAllAnnotations().forEach(anno => {
            switch (anno.type) {
                case ToolMode.ScaleBar:
                    selectableObjects.push(anno.object3D);
                    break;
                case ToolMode.SurfaceMeasure:
                    // 只拾取保存后的标签的代理对象
                    if (anno.proxyObject) selectableObjects.push(anno.proxyObject);
                    break;
                case ToolMode.StraightMeasure:
                    // 只拾取标签的代理对象
                    if (anno.proxyObject) selectableObjects.push(anno.proxyObject);
                    break;
                case ToolMode.Planimetering:
                    // 只拾取面积标签的代理对象，不允许直接点击高亮网格
                    if (anno.proxyObject) selectableObjects.push(anno.proxyObject);
                    break;
            }
        });

        // 2. 执行射线投射
        this.raycaster.setFromCamera(event.pointer, this.sceneController.camera);
        const intersects = this.raycaster.intersectObjects(selectableObjects, true);

        if (intersects.length > 0) {
            // 3. 查找被点击对象的标注物 ID
            const clickedObject = intersects[0].object;
            const foundId = this.annotationManager.findAnnotationIdByObject(clickedObject);

            if (foundId) {
                if (foundId !== this.selectedAnnotationId) {
                    this.deselectCurrent();
                    this.select(foundId);
                } else {
                    this.deselectCurrent();
                }
            } else {
                this.deselectCurrent();
            }
        } else {
            this.deselectCurrent();
        }
    }

    onPointerMove(_event: InteractionEvent): void {
    }

    /** 选择指定的标注物 */
    private select(id: string): void {
        this.selectedAnnotationId = id;
        const annotation = this.annotationManager.getAnnotation(id);
        if (annotation) {
            console.log("Annotation selected:", id);
            const buttonPosition = this.calculateButtonPosition(annotation);
            // 通过事件通知 UI 层显示删除按钮
            this.eventEmitter.emit('annotationSelected', {
                id: id,
                type: annotation.type as ToolMode,
                position: buttonPosition
            });
            // 高亮
            this.highlightAnnotation(annotation, true);
        }
    }

    /** 取消当前选择的标注物 */
    private deselectCurrent(): void {
        if (this.selectedAnnotationId) {
            const annotation = this.annotationManager.getAnnotation(this.selectedAnnotationId);
            if (annotation) {
                this.highlightAnnotation(annotation, false);
            }
            console.log("Annotation deselected:", this.selectedAnnotationId);

            this.eventEmitter.emit('annotationDeselected', { id: this.selectedAnnotationId });
            this.selectedAnnotationId = null;
        }
    }

    /**
     * 高亮或取消高亮标注物
     * @param annotation 标注对象
     * @param highlight 是否高亮
     */
    private highlightAnnotation(annotation: Annotation, highlight: boolean): void {
        const highlightColor = new THREE.Color(0xF56D27); // 绿色高亮
        const defaultSurfaceLineColor = new THREE.Color(0xff0000); // 表面测量默认红色
        const defaultStraightLineColor = new THREE.Color(0xffff00); // 直线测量默认黄色

        switch (annotation.type) {
            case ToolMode.ScaleBar:
                annotation.object3D.traverse((child: THREE.Object3D) => {
                    const mesh = child as THREE.Mesh;
                    if (mesh.isMesh && mesh.material) {
                        if (Array.isArray(mesh.material)) {
                            mesh.material.forEach((mat: THREE.Material) => {
                                (mat as THREE.MeshBasicMaterial).color = highlight ? highlightColor : (mesh.userData.originalColor || new THREE.Color(0xcccccc));
                            });
                        } else {
                            if (!mesh.userData.originalColor) {
                                mesh.userData.originalColor = (mesh.material as THREE.MeshBasicMaterial).color.clone();
                            }
                            (mesh.material as THREE.MeshBasicMaterial).color = highlight ? highlightColor : mesh.userData.originalColor;
                        }
                    }
                });
                break;
            case ToolMode.SurfaceMeasure:
                if (annotation.curveLineObject) {
                    (annotation.curveLineObject.material as THREE.LineBasicMaterial).color.copy(highlight ? highlightColor : defaultSurfaceLineColor);
                }
                if (annotation.savedLabelObject && annotation.savedLabelObject.element) {
                    if (highlight) {
                        annotation.savedLabelObject.element.classList.add('highlighted-label');
                    } else {
                        annotation.savedLabelObject.element.classList.remove('highlighted-label');
                    }
                }
                if (annotation.leaderLineObject) {
                    (annotation.leaderLineObject.material as THREE.LineBasicMaterial).color.copy(highlight ? highlightColor : defaultSurfaceLineColor);
                }
                break;
            case ToolMode.StraightMeasure:
                if (annotation.lineObject) {
                    (annotation.lineObject.material as THREE.LineBasicMaterial).color.copy(highlight ? highlightColor : defaultStraightLineColor);
                }
                if (annotation.startSphere) {
                    (annotation.startSphere.material as THREE.MeshBasicMaterial).color.copy(highlight ? highlightColor : defaultStraightLineColor);
                }
                if (annotation.endSphere) {
                    (annotation.endSphere.material as THREE.MeshBasicMaterial).color.copy(highlight ? highlightColor : defaultStraightLineColor);
                }
                if (annotation.lengthLabelObject && annotation.lengthLabelObject.element) {
                    // UI 层样式控制，工具层不应直接操作 DOM 样式
                    // 而是通过添加/移除类名来通知 UI 层
                    if (highlight) {
                        annotation.lengthLabelObject.element.classList.add('highlighted-label');
                    } else {
                        annotation.lengthLabelObject.element.classList.remove('highlighted-label');
                    }
                }
                break;
            case ToolMode.Planimetering:
                // 只高亮属于当前标注的面积标签
                if (annotation.areaLabelObject && annotation.areaLabelObject.element) {
                    if (highlight) {
                        annotation.areaLabelObject.element.classList.add('highlighted-label');
                    } else {
                        annotation.areaLabelObject.element.classList.remove('highlighted-label');
                    }
                }
                // 只高亮属于当前标注的高亮网格，并确保不影响其他网格
                if (annotation.highlightMesh &&
                    annotation.highlightMesh.geometry &&
                    annotation.highlightMesh.geometry.drawRange.count > 0) {

                    const material = annotation.highlightMesh.material as THREE.MeshBasicMaterial;

                    // 验证这个网格确实属于当前标注
                    const meshId = annotation.highlightMesh.userData?.measurementId || 'unknown';
                    console.log(`高亮网格 - 标注ID: ${annotation.id}, 网格ID: ${meshId}`);

                    if (highlight) {
                        // 使用标注ID和网格ID的组合作为唯一标识符
                        const colorKey = `originalColor_${annotation.id}_${meshId}`;
                        if (!annotation.highlightMesh.userData[colorKey]) {
                            annotation.highlightMesh.userData[colorKey] = material.color.clone();
                        }
                        material.color.copy(highlightColor);
                        console.log(`高亮网格: ${annotation.id}`);
                    } else {
                        const colorKey = `originalColor_${annotation.id}_${meshId}`;
                        if (annotation.highlightMesh.userData[colorKey]) {
                            material.color.copy(annotation.highlightMesh.userData[colorKey]);
                            console.log(`取消高亮网格: ${annotation.id}`);
                        }
                    }
                }
                break;
        }
    }


    /** 计算删除按钮的建议位置 */
    private calculateButtonPosition(annotation: Annotation): THREE.Vector3 {
        let position = new THREE.Vector3();
        try {
            switch (annotation.type) {
                case ToolMode.ScaleBar:
                    position = annotation.object3D.position.clone();
                    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(annotation.object3D.quaternion);
                    position.add(up.multiplyScalar(0.05));
                    break;
                case ToolMode.SurfaceMeasure:
                    // 如果有保存的标签，则使用标签位置作为参考
                    if (annotation.savedLabelObject) {
                        position.copy(annotation.savedLabelObject.position);
                        // 在标签上方偏移一点
                        position.y += 0.02;
                    } else if (annotation.pathPoints.length > 0) {
                        // 否则 fallback 到路径中点
                        const midIndex = Math.floor(annotation.pathPoints.length / 2);
                        position = annotation.pathPoints[midIndex].clone();
                        position.y += 0.05;
                    }
                    break;
                case ToolMode.StraightMeasure:
                    // 如果有长度标签，则使用标签位置作为参考
                    if (annotation.lengthLabelObject) {
                        position.copy(annotation.lengthLabelObject.position);
                        // 在标签上方偏移一点
                        position.y += 0.02;
                    } else {
                        // 否则 fallback 到线段中点
                        position = new THREE.Vector3().addVectors(annotation.startPoint, annotation.endPoint).multiplyScalar(0.5);
                        position.y += 0.05;
                    }
                    break;
                case ToolMode.Planimetering:
                    if (annotation.areaLabelObject) {
                        position.copy(annotation.areaLabelObject.position);
                        // 在标签上方偏移一点
                        position.y += 0.02;
                    } else if (annotation.firstClickPosition) {
                        // 否则 fallback 到第一次点击位置
                        position.copy(annotation.firstClickPosition);
                        position.y += 0.05;
                    }
                    break;
            }
        } catch (error) {
            console.error("Error calculating button position:", error, annotation);

            if (annotation.type === ToolMode.ScaleBar) position = annotation.object3D.position.clone();
            else if (annotation.type === ToolMode.StraightMeasure) position = annotation.startPoint.clone();
            else if (annotation.type === ToolMode.SurfaceMeasure && annotation.pathPoints.length > 0) position = annotation.pathPoints[0].clone();
            else if (annotation.type === ToolMode.Planimetering && annotation.highlightMesh) position = annotation.highlightMesh.position.clone();
        }
        return position;
    }

    onKeyDown(event: InteractionEvent): void {

        if ((event.originalEvent as KeyboardEvent).key === 'Delete' && this.selectedAnnotationId) {
            const idToDelete = this.selectedAnnotationId;

            this.eventEmitter.emit('annotationDeselected', { id: idToDelete });

            if (this.annotationManager.removeAnnotation(idToDelete)) {
                this.eventEmitter.emit('annotationRemoved', { id: idToDelete });
            }
        }

        if ((event.originalEvent as KeyboardEvent).key === 'Escape') {
            this.deselectCurrent();
        }
    }

    dispose(): void {
        super.dispose();
        this.selectedAnnotationId = null;
        // 确保在 dispose 时也取消监听
        if (this.unsubscribeAnnotationRemoved) {
            this.unsubscribeAnnotationRemoved();
            this.unsubscribeAnnotationRemoved = null;
        }
    }


}