//@ts-ignore
import * as THREE from 'three';
import { BaseTool } from '../../components/Base-tools/BaseTool';
import { ITool } from '../../components/Base-tools/BaseTool';
import { InteractionEvent, ToolMode, ScaleBarAnnotation, ISceneController, IAnnotationManager, IEventEmitter,IContextProvider } from '../../types/webgl-marking'; 

export class ScaleBarTool extends BaseTool implements ITool {
    private previewScaleBar: THREE.Object3D | null = null;
    private previewRotationAngle: number = 0;
    private currentPlacementNormal: THREE.Vector3 = new THREE.Vector3(0, 1, 0);
    private currentPlacementTangent: THREE.Vector3 = new THREE.Vector3(1, 0, 0);
    private isPreviewVisible: boolean = false;
    private currentSurfacePoint: THREE.Vector3 = new THREE.Vector3(); // 新增：存储当前表面点位置

    private contextProvider:IContextProvider;

    constructor(sceneController: ISceneController, annotationManager: IAnnotationManager, eventEmitter: IEventEmitter,contextProvider:IContextProvider) { 
        super(sceneController, annotationManager, eventEmitter); 
        this.contextProvider = contextProvider
    }

    getMode(): ToolMode {
        return ToolMode.ScaleBar;
    }

    activate(): void {
        super.activate();
        console.log("ScaleBarTool activated.");
        this.sceneController.orbitControls.enabled = false; // 放置时禁用相机控制
        
        // 重置状态 - 特别是在新模型加载后
        this.previewRotationAngle = 0;
        this.isPreviewVisible = false;
        this.currentPlacementNormal.set(0, 1, 0);
        this.currentPlacementTangent.set(1, 0, 0);
        this.currentSurfacePoint.set(0, 0, 0);
        
        // 确保总是重新创建预览对象，避免使用可能已被污染的baseModel
        if (this.previewScaleBar) {
            this.sceneController.scene.remove(this.previewScaleBar);
            this.previewScaleBar = null;
        }
        this.previewScaleBar =  this.initPreview();
        
        if (this.previewScaleBar) {
            this.previewScaleBar.visible = false;
        }
        this.eventEmitter.emit('modeChanged', { mode: ToolMode.ScaleBar, enabled: true });
    }

    deactivate(): void {
        console.log("ScaleBarTool deactivated.");
        this.sceneController.orbitControls.enabled = true; // 恢复相机控制
        if (this.previewScaleBar) {
            this.previewScaleBar.visible = false;
            this.isPreviewVisible = false;
        }
        this.eventEmitter.emit('modeChanged', { mode: ToolMode.ScaleBar, enabled: false });
    }

    private initPreview(): THREE.Object3D | null {
        const baseModel = this.sceneController.scaleBarBaseModel;
        if (!baseModel) {
            console.error("Scale bar base model not loaded!");
            this.eventEmitter.emit('error', { message: "Scale bar base model not loaded!" });
            return null;
        }
        
        // 深度克隆模型以避免对原始模型的影响
        const previewObject = baseModel.clone()
        previewObject.visible = false;
        
        // 优化材质处理：使用原始材质的副本而不是可能已被修改的材质
        previewObject.traverse((child: THREE.Object3D) => {
            const mesh = child as THREE.Mesh;
            if (mesh.isMesh && mesh.material) {
                // 查找对应的原始子对象
                const originalChild = this.findOriginalChild(baseModel, child);
                let originalMaterial: THREE.Material;
                
                if (originalChild && (originalChild as THREE.Mesh).material) {
                    originalMaterial = (originalChild as THREE.Mesh).material as THREE.Material;
                } else {
                    originalMaterial = mesh.material as THREE.Material;
                }
                
                // 创建新的材质实例，避免引用污染
                if (originalMaterial.type === 'MeshStandardMaterial') {
                    const newMaterial = new THREE.MeshStandardMaterial();
                    newMaterial.copy(originalMaterial);
                    newMaterial.transparent = true;
                    newMaterial.opacity = 0.6;
                    newMaterial.depthWrite = false;
                    mesh.material = newMaterial;
                } else {
                    // 对于其他类型的材质，使用克隆方式
                    const clonedMaterial = originalMaterial.clone();
                    clonedMaterial.transparent = true;
                    clonedMaterial.opacity = 0.6;
                    clonedMaterial.depthWrite = false;
                    mesh.material = clonedMaterial;
                }
            }
        });
        this.sceneController.scene.add(previewObject);
        return previewObject
    }
    
    // 辅助方法：找到原始模型中对应的子对象
    private findOriginalChild(baseModel: THREE.Scene, targetChild: THREE.Object3D): THREE.Object3D | null {
        let result: THREE.Object3D | null = null;
        let targetIndex = 0;
        let currentIndex = 0;
        
        // 首先找到目标child在其父对象中的索引
        if (targetChild.parent) {
            targetIndex = targetChild.parent.children.indexOf(targetChild);
        }
        
        // 在原始模型中查找相同路径的对象
        baseModel.traverse((child: THREE.Object3D) => {
            if (child.type === targetChild.type && 
                child.name === targetChild.name && 
                currentIndex === targetIndex) {
                result = child;
                return;
            }
            if (child.type === targetChild.type) {
                currentIndex++;
            }
        });
        
        return result;
    }

    onPointerMove(event: InteractionEvent): void {
        if (!this.previewScaleBar) return;

        if (event.intersection && event.intersection.face) {
            if (!this.isPreviewVisible) {
                this.previewScaleBar.visible = true;
                this.isPreviewVisible = true;
            }

            this.updatePreviewPosition(event.intersection);
            

        } else {
            if (this.isPreviewVisible) {
                this.previewScaleBar.visible = false;
                this.isPreviewVisible = false;
            }
        }
    }

    onWheel(event: InteractionEvent): void {
        if (!this.previewScaleBar || !this.isPreviewVisible) return;

        event.originalEvent.preventDefault(); // 阻止页面滚动
        const wheelEvent = event.originalEvent as WheelEvent;
        const delta = wheelEvent.deltaY * -0.005; // 旋转灵敏度
        this.previewRotationAngle += delta;

        // 更新预览姿态，使用存储的表面点位置而不是当前比例尺位置
        this.updatePreviewTransform(this.currentSurfacePoint);
        
    }

    onPointerDown(event: InteractionEvent): void {
        if (event.intersection && this.previewScaleBar && this.isPreviewVisible) {
            // 克隆当前的预览对象作为实际放置的对象
            const newScaleBarObject = this.previewScaleBar.clone() as THREE.Group;
            // 恢复材质为不透明
            newScaleBarObject.traverse((child: THREE.Object3D) => {
                const mesh = child as THREE.Mesh;
                if (mesh.isMesh) {
                    mesh.material = (mesh.material as THREE.Material).clone();
                    mesh.material.transparent = false;
                    mesh.material.opacity = 1.0;
                    mesh.material.depthWrite = true;
                }
            });
            // 确保使用最终的位置和旋转
            newScaleBarObject.position.copy(this.previewScaleBar.position);
            newScaleBarObject.quaternion.copy(this.previewScaleBar.quaternion);

            const contextId = this.contextProvider.getCurrentContextPartId() || 'human_model'
            const data: Omit<ScaleBarAnnotation, 'id' | 'type' | 'contextId'> = {
                object3D: newScaleBarObject,
                normal: this.currentPlacementNormal.clone(),
                tangent: this.currentPlacementTangent.clone(), // 保存最终的切线
                accumulatedRotation: this.previewRotationAngle,
            };

            const addedAnnotation = this.annotationManager.addScaleBar(data,contextId);
            this.eventEmitter.emit('annotationAdded', addedAnnotation);

            // 放置后自动切换回 IdleTool，通过事件请求切换
            this.eventEmitter.emit('toolModeChangeRequested', { mode: ToolMode.Idle });
        }
    }

    onKeyDown(event: InteractionEvent): void {
        console.log("ScaleBarTool: onKeyDown triggered. Original key:", (event.originalEvent as KeyboardEvent).key);
        if ((event.originalEvent as KeyboardEvent).key === 'Escape') {
            console.log("ScaleBarTool: ESC key detected. Emitting toolModeChangeRequested to Idle.");
            this.eventEmitter.emit('toolModeChangeRequested', { mode: ToolMode.Idle });
        }
    }

    /** 根据当前法线、切线和旋转角度更新预览对象的位置和姿态 */
    private updatePreviewTransform(surfacePoint: THREE.Vector3): void {
        const activeModel = this.sceneController.activeModelForRaycasting;
        if (!this.previewScaleBar || !activeModel) return;

        const finalNormal = this.currentPlacementNormal.clone();
        const baseTangent = this.currentPlacementTangent.clone();

        // 计算旋转后的切线
        const rotationAroundNormal = new THREE.Quaternion().setFromAxisAngle(finalNormal, this.previewRotationAngle);
        const finalTangent = baseTangent.clone().applyQuaternion(rotationAroundNormal);

        // 计算双切线 (Z 轴)
        const finalZAxis = new THREE.Vector3().crossVectors(finalTangent, finalNormal).normalize();

        // 构建旋转矩阵并设置四元数
        const rotationMatrix = new THREE.Matrix4().makeBasis(finalTangent, finalNormal, finalZAxis);
        this.previewScaleBar.quaternion.setFromRotationMatrix(rotationMatrix);

        // 计算偏移量，使比例尺稍微离开表面 - 使用固定的小偏移量
        const fixedOffset = 0.01; 
        const adjustedPoint = surfacePoint.clone().add(finalNormal.clone().multiplyScalar(fixedOffset));
        this.previewScaleBar.position.copy(adjustedPoint);
    }

    /**
     * 重置预览对象 - 在新模型加载后调用
     */
    public resetPreview(): void {
        if (this.previewScaleBar) {
            this.sceneController.scene.remove(this.previewScaleBar);
            this.previewScaleBar.traverse((child: THREE.Object3D) => {
                const mesh = child as THREE.Mesh;
                if (mesh.isMesh) {
                    mesh.geometry?.dispose();
                    if (Array.isArray(mesh.material)) {
                        mesh.material.forEach((m: THREE.Material) => m.dispose());
                    } else {
                        mesh.material?.dispose();
                    }
                }
            });
            this.previewScaleBar = null;
        }
        
        // 重置状态
        this.previewRotationAngle = 0;
        this.isPreviewVisible = false;
        this.currentPlacementNormal.set(0, 1, 0);
        this.currentPlacementTangent.set(1, 0, 0);
        this.currentSurfacePoint.set(0, 0, 0);
        

        
        console.log("ScaleBarTool preview reset for new model.");
    }

    dispose(): void {
        super.dispose();
        if (this.previewScaleBar) {
            this.sceneController.scene.remove(this.previewScaleBar);
            this.previewScaleBar.traverse((child: THREE.Object3D) => {
                const mesh = child as THREE.Mesh;
                if (mesh.isMesh) {
                    mesh.geometry?.dispose();
                    if (Array.isArray(mesh.material)) {
                        mesh.material.forEach((m: THREE.Material) => m.dispose());
                    } else {
                        mesh.material?.dispose();
                    }
                }
            });
            this.previewScaleBar = null;
        }
    }

    // 将预览位置更新逻辑提取为单独方法
    private updatePreviewPosition(intersection: THREE.Intersection): void {
        const point = intersection.point;
        const intersectedObject = intersection.object as THREE.Mesh;
        const faceNormal = intersection.face!.normal.clone();

        const normalMatrix = new THREE.Matrix3().getNormalMatrix(intersectedObject.matrixWorld);
        faceNormal.applyMatrix3(normalMatrix).normalize();

        // 存储当前表面点
        this.currentPlacementNormal.copy(faceNormal);
        this.currentSurfacePoint.copy(point);

        // 将法线转换到世界坐标系
        const worldQuaternion = new THREE.Quaternion();
        if (intersection.object instanceof THREE.Object3D) { 
            intersection.object.getWorldQuaternion(worldQuaternion);
        }
        faceNormal.applyQuaternion(worldQuaternion).normalize();
        this.currentPlacementNormal.copy(faceNormal);

        // 计算切线 (确保与法线垂直)
        let tangent = new THREE.Vector3(1, 0, 0);
        tangent.sub(faceNormal.clone().multiplyScalar(tangent.dot(faceNormal))).normalize();
        if (tangent.lengthSq() < 0.001) {
            tangent.set(0, 0, 1).sub(faceNormal.clone().multiplyScalar(new THREE.Vector3(0, 0, 1).dot(faceNormal))).normalize();
        }
        if (tangent.lengthSq() < 0.001) {
            tangent.set(0, 1, 0).sub(faceNormal.clone().multiplyScalar(new THREE.Vector3(0, 1, 0).dot(faceNormal))).normalize();
        }
        this.currentPlacementTangent.copy(tangent);

        // 更新预览位置和姿态
        this.updatePreviewTransform(point);
    }
}