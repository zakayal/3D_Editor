//@ts-ignore
import * as THREE from 'three';
import {
    Annotation,
    ScaleBarAnnotation,
    SurfaceMeasurementAnnotation,
    StraightMeasurementAnnotation,
    PlanimeteringAnnotation,
    ToolMode,
    IAnnotationManager, 
    ISceneController,
    HighlightAnnotation  
} from '../../types/webgl-marking';
//@ts-ignore
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

/**
 * 管理场景中所有标注物的生命周期（添加、删除、查找）。
 */
export class AnnotationManager implements IAnnotationManager { 
    private sceneController: ISceneController;  
    private annotations: Map<string, Annotation> = new Map();

    private proxyGeometry: THREE.PlaneGeometry;
    private proxyMaterial: THREE.MeshBasicMaterial;

    constructor(sceneController: ISceneController) {  
        this.sceneController = sceneController;

        this.proxyGeometry = new THREE.PlaneGeometry(0.1, 0.05);
        this.proxyMaterial = new THREE.MeshBasicMaterial({
            transparent: true,
            opacity:0,
            depthTest:false,
            depthWrite:false,
            side:THREE.DoubleSide,
            
        });
    }

    // #region --- 公共方法：添加标注 ---

    /**
     * 添加一个新的比例尺标注。
     * @param data - 比例尺标注所需数据。
     * @returns 创建的标注对象。
     */
    public addScaleBar(data: Omit<ScaleBarAnnotation, 'id' | 'type'>): ScaleBarAnnotation {
        const id = `sb-${Date.now()}`;
        const scaleBar: ScaleBarAnnotation = {
            ...data,
            id,
            type: 'scale_bar',
        };

        // 为所有子对象设置 userData，以便于拾取
        scaleBar.object3D.userData = { annotationId: id, type: ToolMode.ScaleBar };
        scaleBar.object3D.traverse((child: THREE.Object3D) => {
            child.userData = { annotationId: id, type: ToolMode.ScaleBar };
        });


        this.annotations.set(id, scaleBar);
        this.sceneController.scene.add(scaleBar.object3D);
        console.log("Scale bar added:", id);
        return scaleBar;
    }

    /**
         * 添加一个新的表面测量标注。
         * @param data - 表面测量标注所需数据。
         * @returns 创建的标注对象。
         */
    public addSurfaceMeasurement(data: Omit<SurfaceMeasurementAnnotation, 'id' | 'type'>): SurfaceMeasurementAnnotation {
        const id = `sm-${Date.now()}`;
        const measurement: SurfaceMeasurementAnnotation = {
            ...data,
            id,
            type: 'surface_curve',
        };

        const userDataPayload = { annotationId: id, type: ToolMode.SurfaceMeasure };

        if (measurement.curveLineObject) {
            measurement.curveLineObject.userData = userDataPayload;
            this.sceneController.scene.add(measurement.curveLineObject);
        }
        if (measurement.savedLabelObject) {
            measurement.savedLabelObject.userData = userDataPayload;
            this.sceneController.scene.add(measurement.savedLabelObject);

            // 为表面测量标签创建代理对象
            const proxyMesh = new THREE.Mesh(this.proxyGeometry, this.proxyMaterial);
            proxyMesh.position.copy(measurement.savedLabelObject.position);

            proxyMesh.renderOrder = 996; // 比标签低一点，不遮挡标签，但确保在场景中
            proxyMesh.userData = userDataPayload; 
            this.sceneController.scene.add(proxyMesh);
            measurement.proxyObject = proxyMesh; 
        }
        if (measurement.leaderLineObject) {
            measurement.leaderLineObject.userData = userDataPayload;
            this.sceneController.scene.add(measurement.leaderLineObject);
        }

        this.annotations.set(id, measurement);
        console.log("Surface measurement added:", id);
        return measurement;
    }

    /**
     * 添加一个新的直线测量标注。
     * @param data - 直线测量标注所需数据。
     * @returns 创建的标注对象。
     */
    public addStraightMeasurement(data: Omit<StraightMeasurementAnnotation, 'id' | 'type'>): StraightMeasurementAnnotation {
        const id = `stm-${Date.now()}`;
        const measurement: StraightMeasurementAnnotation = {
            ...data,
            id,
            type: 'straight_line',
        };

        const userDataPayload = { annotationId: id, type: ToolMode.StraightMeasure };

        if (measurement.lineObject) {
            measurement.lineObject.userData = userDataPayload;
            this.sceneController.scene.add(measurement.lineObject);
        }
        if (measurement.startSphere) {
            measurement.startSphere.userData = userDataPayload;
            this.sceneController.scene.add(measurement.startSphere);
        }
        if (measurement.endSphere) {
            measurement.endSphere.userData = userDataPayload;
            this.sceneController.scene.add(measurement.endSphere);
        }
        if (measurement.lengthLabelObject) {
            this.sceneController.scene.add(measurement.lengthLabelObject);

            // 为直线测量标签创建代理对象
            const proxyMesh = new THREE.Mesh(this.proxyGeometry, this.proxyMaterial);
            proxyMesh.position.copy(measurement.lengthLabelObject.position);
            proxyMesh.renderOrder = 996;
            proxyMesh.userData = userDataPayload;
            this.sceneController.scene.add(proxyMesh);
            measurement.proxyObject = proxyMesh; // 存储代理对象引用
        }

        this.annotations.set(id, measurement);
        console.log("Straight measurement added:", id);
        return measurement;
    }

    /**
     * 添加一个新的面积测量标注。
     * @param data - 面积测量标注所需数据。
     * @returns 创建的标注对象。
     */
    public addPlanimetering(data: Omit<PlanimeteringAnnotation, 'id' | 'type'>): PlanimeteringAnnotation {
        const id = `pm-${Date.now()}`;
        const planimetering: PlanimeteringAnnotation = {
            ...data,
            id,
            type: 'planimetering',
        };

        const userDataPayload = { annotationId: id, type: ToolMode.Planimetering };
        
        // 为高亮网格设置 userData，以便于拾取
        if (planimetering.highlightMesh) {
            planimetering.highlightMesh.userData = userDataPayload;
            this.sceneController.scene.add(planimetering.highlightMesh);
        }
        
        // 添加面积标签到场景
        if (planimetering.areaLabelObject) {
            this.sceneController.scene.add(planimetering.areaLabelObject);

            // 为面积标签创建代理对象以支持点击删除
            const proxyMesh = new THREE.Mesh(this.proxyGeometry, this.proxyMaterial);
            proxyMesh.position.copy(planimetering.areaLabelObject.position);
            proxyMesh.renderOrder = 996;
            proxyMesh.userData = userDataPayload; // 使用同一个标注ID
            this.sceneController.scene.add(proxyMesh);
            planimetering.proxyObject = proxyMesh; // 存储代理对象引用
        }
        
        // 添加组标签到场景（如果有的话）
        if (planimetering.groupLabel) {
            this.sceneController.scene.add(planimetering.groupLabel);
            
            // 为组标签创建代理对象以支持点击删除
            const groupProxyMesh = new THREE.Mesh(this.proxyGeometry, this.proxyMaterial);
            groupProxyMesh.position.copy(planimetering.groupLabel.position);
            groupProxyMesh.renderOrder = 996;
            
            // 关键修改：组标签使用同一个标注ID，而不是创建独立的ID
            groupProxyMesh.userData = userDataPayload; // 使用同一个标注ID
            this.sceneController.scene.add(groupProxyMesh);
            
            // 将组标签的代理对象也存储在主标注中，而不是创建独立标注
            // 这样可以通过主标注一次性删除所有相关对象
            if (!planimetering.proxyObject) {
                planimetering.proxyObject = groupProxyMesh;
            } else {
                // 如果已经有面积标签的代理对象，将组标签代理对象存储在专用字段中
                planimetering.groupProxyObject = groupProxyMesh;
            }
            
            console.log("Group label added with same annotation ID:", id);
        }

        this.annotations.set(id, planimetering);
        console.log("Planimetering measurement added:", id, "Area:", planimetering.area, "Total Area:", planimetering.totalArea);
        return planimetering;
    }

    /**
     * 添加一个新的高亮标注。
     * @param data - 高亮标注所需数据。
     * @returns 创建的标注对象。
     */
    public addHighlightAnnotation(data: Omit<HighlightAnnotation, 'id' | 'type'>): HighlightAnnotation {
        const id = `hl-${Date.now()}`;
        const annotation: HighlightAnnotation = {
            ...data,
            id,
            type: 'highlight',
        };

        const userDataPayload = { annotationId: id, type: ToolMode.Highlight, materialKey: annotation.materialKey };

        // 添加标签
        if (annotation.labelObject) {
            this.sceneController.scene.add(annotation.labelObject);
            
            // 为标签创建代理对象以便拾取
            const proxyMesh = new THREE.Mesh(this.proxyGeometry, this.proxyMaterial);
            proxyMesh.position.copy(annotation.labelObject.position);
            proxyMesh.renderOrder = 996;
            proxyMesh.userData = userDataPayload;
            this.sceneController.scene.add(proxyMesh);
            annotation.proxyObject = proxyMesh;
        }

        // 添加指示线
        if (annotation.leaderLineObject) {
            annotation.leaderLineObject.userData = userDataPayload;
            this.sceneController.scene.add(annotation.leaderLineObject);
        }

        this.annotations.set(id, annotation);
        console.log("Highlight annotation added:", id);
        return annotation;
    }
    // #endregion

    // #region --- 公共方法：移除标注 ---
    /**
     * 根据 ID 移除一个标注物。
     * @param id - 要移除的标注物的 ID。
     * @returns 如果成功移除返回 true，否则返回 false。
     */
    public removeAnnotation(id: string): boolean {
        console.log('开始删除标注:', id);
        console.log('当前场景中的标注数量:', this.annotations.size);
        
        const annotation = this.annotations.get(id);
        if (!annotation) {
            console.warn(`Annotation with ID ${id} not found.`);
            return false;
        }

        console.log('找到标注:', annotation.type);

        switch (annotation.type) {
            case 'scale_bar':
                console.log('比例尺对象详情:', {
                    object3D: annotation.object3D,
                    type: annotation.object3D.type,
                    children: annotation.object3D.children,
                    parent: annotation.object3D.parent,
                    userData: annotation.object3D.userData
                });
                // 检查子对象
                annotation.object3D.traverse((child: THREE.Object3D) => {
                    console.log('比例尺子对象:', {
                        type: child.type,
                        name: child.name,
                        parent: child.parent,
                        userData: child.userData
                    });
                    // 确保每个子对象都被正确清理
                    if ((child as THREE.Mesh).isMesh) {
                        const mesh = child as THREE.Mesh;
                        mesh.geometry?.dispose();
                        this._cleanMaterial(mesh.material);
                    }
                });
                // 从场景中移除整个比例尺对象
                if (annotation.object3D.parent) {
                    annotation.object3D.parent.remove(annotation.object3D);
                }
                break;
            case 'surface_curve':
                this.removeObject(annotation.curveLineObject);
                this.removeObject(annotation.savedLabelObject); // 新增：移除保存后的标签
                this.removeObject(annotation.leaderLineObject); // 新增：移除指示线
                this.removeObject(annotation.proxyObject);
                break;
            case 'straight_line':
                this.removeObject(annotation.lineObject);
                this.removeObject(annotation.startSphere);
                this.removeObject(annotation.endSphere);
                this.removeObject(annotation.lengthLabelObject);
                this.removeObject(annotation.proxyObject);
                break;
            case 'planimetering':
                console.log('删除面积测量标注:', id);
                
                // 删除所有相关对象，确保一次性删除所有视觉元素
                this.removeObject(annotation.highlightMesh);
                this.removeObject(annotation.areaLabelObject);
                this.removeObject(annotation.groupLabel);
                this.removeObject(annotation.proxyObject);
                
                // 删除组标签的代理对象（如果存在）
                if (annotation.groupProxyObject) {
                    this.removeObject(annotation.groupProxyObject);
                    console.log('删除组标签代理对象');
                }
                
                console.log('面积测量标注及其所有相关对象已删除');
                break;
        }

        this.annotations.delete(id);
        console.log('标注已从 Map 中删除');
        console.log('删除后场景中的标注数量:', this.annotations.size);
        return true;
    }

    /**
     * 移除所有标注物。
     */
    public removeAllAnnotations(): void {
        console.log("Removing all annotations...");
        const ids = Array.from(this.annotations.keys());
        ids.forEach(id => this.removeAnnotation(id));
        this.annotations.clear();
        console.log("All annotations removed.");
    }
    // #endregion

    // #region --- 公共方法：查询与查找 ---

    /**
     * 根据 ID 获取一个标注物。
     * @param id - 标注物的 ID。
     * @returns 返回标注物对象，如果找不到则返回 undefined。
     */
    public getAnnotation(id: string): Annotation | undefined {
        return this.annotations.get(id);
    }

    /**
     * 获取所有标注物的信息。
     * @returns 返回一个包含所有标注物信息的数组。
     */
    public getAllAnnotations(): Annotation[] {
        return Array.from(this.annotations.values());
    }

    /**
     * 根据 3D 对象查找其所属的标注物 ID。
     * @param object3D - 场景中的 3D 对象。
     * @returns 返回该对象所属标注物的 ID，如果找不到则返回 null。
     */
    public findAnnotationIdByObject(object3D: THREE.Object3D): string | null {
        let current: THREE.Object3D | null = object3D;
        while (current) {
            if (current.userData && current.userData.annotationId) {
                return current.userData.annotationId;
            }
            current = current.parent;
        }
        return null;
    }
    // #endregion

    // #region--- 公共方法：生命周期 ---
    /**
     * 释放所有标注物及其资源。
     */
    public dispose(): void {
        // 直接调用 removeAllAnnotations 会处理场景中移除和 Map 清理
        this.removeAllAnnotations();

        this.proxyGeometry.dispose();
        this.proxyMaterial.dispose();
        console.log("AnnotationManager disposed.");
    }
    // #endregion

    // #region--- 私有辅助方法 ---
    /**
     * 从场景中移除一个对象并释放其资源。
     * @param object - 要移除的对象 (可以是 3D 对象或 CSS2DObject)。
     */
    private removeObject(object: THREE.Object3D | CSS2DObject | null | undefined): void {
        console.log('开始移除对象:', object);
        if (!object || !object.parent) {
            console.log('对象不存在或没有父节点');
            return;
        }

        if (object instanceof CSS2DObject) {
            console.log('移除 CSS2D 对象');
            // 移除 CSS2D 对象的 DOM 元素
            if (object.element && object.element.parentElement) {
                object.element.parentElement.removeChild(object.element);
                console.log('CSS2D 元素的 DOM 节点已移除');
            }
            object.parent.remove(object);
            console.log('CSS2D 对象已从场景中移除');
        } else if (object instanceof THREE.Object3D) {
            console.log('移除 Three.js 对象');
            object.parent.remove(object);
            // 释放 3D 对象的几何体和材质
            console.log('Three.js 对象已从场景中移除');
            object.traverse((child: THREE.Object3D) => {
                const mesh = child as THREE.Mesh;
                if (mesh.isMesh) {
                    mesh.geometry?.dispose();
                    this._cleanMaterial(mesh.material);
                } else if ((child as THREE.Line).isLine) {
                    (child as THREE.Line).geometry?.dispose();
                    this._cleanMaterial((child as THREE.Line).material);
                }
            });
        }
    }


    /** 释放材质及其纹理 */
    private _cleanMaterial(material: THREE.Material | THREE.Material[]): void {
        if (!material) return;
        if (Array.isArray(material)) {
            material.forEach(mat => this._cleanMaterial(mat));
        } else {
            material.dispose();
            // 释放纹理
            for (const key of Object.keys(material)) {
                const value = material[key as keyof typeof material]
                if (this.isTexture(value)) {
                    value.dispose();
                }
            }
        }
    }

    //类型谓词+类型守卫
    private isTexture(value:unknown): value is THREE.Texture{
        return value !== null
            && typeof value === 'object'
            && 'dispose' in value
            && 'isTexture' in value
            && (value as THREE.Texture).isTexture;
    }
    // #endregion
}