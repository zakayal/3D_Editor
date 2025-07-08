// @ts-ignore
import * as THREE from 'three';
import {
    Annotation,
    ScaleBarAnnotation,
    SurfaceMeasurementAnnotation,
    StraightMeasurementAnnotation,
    PlanimeteringAnnotation,
    PhotoAnnotation,
    ToolMode,
    IAnnotationManager,
    ISceneController,
    HighlightAnnotation,
    InjuryContext,
    AnnotationFilter
} from '../types/webgl-marking';
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

        //标签的材料属性
        this.proxyGeometry = new THREE.PlaneGeometry(0.1, 0.05);
        this.proxyMaterial = new THREE.MeshBasicMaterial({
            transparent: true,
            opacity: 0,
            depthTest: false,
            depthWrite: false,
            side: THREE.DoubleSide,

        });
    }

    // #region --- 公共方法：添加标注 ---

    /**
     * 添加一个新的比例尺标注。
     * @param data - 比例尺标注所需数据。
     * @returns 创建的标注对象。
     */
    public addScaleBar(data: Omit<ScaleBarAnnotation, 'id' | 'type' | 'contextId'>, contextId: string): ScaleBarAnnotation {
        const id = `sb-${Date.now()}`;
        const scaleBar: ScaleBarAnnotation = { ...data, id, contextId, type: 'scale_bar' };
        scaleBar.object3D.userData = { annotationId: id, type: ToolMode.ScaleBar };
        scaleBar.object3D.traverse((child: THREE.Object3D) => {
            child.userData = { annotationId: id, type: ToolMode.ScaleBar };
        });
        this.annotations.set(id, scaleBar);
        this.sceneController.scene.add(scaleBar.object3D);
        return scaleBar;
    }

    /**
         * 添加一个新的表面测量标注。
         * @param data - 表面测量标注所需数据。
         * @returns 创建的标注对象。
         */
    public addSurfaceMeasurement(data: Omit<SurfaceMeasurementAnnotation, 'id' | 'type' | 'contextId'>, contextId: string): SurfaceMeasurementAnnotation {
        return this._createAndRegisterAnnotation(data, {
            idPrefix: 'sm',
            type: 'surface_curve',
            toolMode: ToolMode.SurfaceMeasure,
            contextId: contextId,

            getObjects: (anno) => [anno.curveLineObject, anno.savedLabelObject, anno.leaderLineObject],
            hasLabelProxy: true
        })
    }

    /**
     * 添加一个新的直线测量标注。
     * @param data - 直线测量标注所需数据。
     * @returns 创建的标注对象。
     */
    public addStraightMeasurement(data: Omit<StraightMeasurementAnnotation, 'id' | 'type' | 'contextId'>, contextId: string): StraightMeasurementAnnotation {
        return this._createAndRegisterAnnotation(data, {
            idPrefix: 'stm',
            type: 'straight_line',
            toolMode: ToolMode.StraightMeasure,
            contextId: contextId,

            getObjects: (anno) => [anno.lineObject, anno.startSphere, anno.endSphere, anno.lengthLabelObject],
            hasLabelProxy: true
        })
    }

    /**
     * 添加一个新的面积测量标注。
     * @param data - 面积测量标注所需数据。
     * @returns 创建的标注对象。
     */
    public addPlanimetering(data: Omit<PlanimeteringAnnotation, 'id' | 'type' | 'contextId'>, contextId: string): PlanimeteringAnnotation {
        return this._createAndRegisterAnnotation(data, {
            idPrefix: 'pm',
            type: 'planimetering',
            toolMode: ToolMode.Planimetering,
            contextId: contextId,

            getObjects: (anno) => [anno.highlightMesh, anno.areaLabelObject],
            hasLabelProxy: true
        })
    }

    /**
     * 添加一个新的高亮标注。
     * @param data - 高亮标注所需数据。
     * @returns 创建的标注对象。
     */
    public addHighlightAnnotation(data: Omit<HighlightAnnotation, 'id' | 'type' | 'contextId'>, contextId: string): HighlightAnnotation {
        const annotation = this._createAndRegisterAnnotation(data, {
            idPrefix: 'hl',
            type: 'highlight',
            toolMode: ToolMode.Highlight,
            contextId: contextId,

            getObjects: (anno) => [anno.labelObject, anno.leaderLineObject],
            hasLabelProxy: true
        })

        const userDataPayload = {
            annotationId: annotation.id,
            type: ToolMode.Highlight,
            materialKey: annotation.materialKey // 添加特殊字段
        };

        [annotation.labelObject, annotation.leaderLineObject, (annotation as any).proxyObject].forEach(obj => {
            if (obj) obj.traverse((child:THREE.Object3D) => { child.userData = userDataPayload; });
        });

        return annotation
    }

    public addOrUpdateSummaryHighlight(context: InjuryContext): void {
        const labelText = this._formatSummaryText(context);

        // 汇总标签的ID与context的ID（即partId）保持一致，方便查找
        const summaryId = context.id;
        const existingAnnotation = this.annotations.get(summaryId) as HighlightAnnotation | undefined;

        if (existingAnnotation && existingAnnotation.labelObject) {
            existingAnnotation.labelObject.element.innerHTML = labelText;
        } else {
            const labelDiv = document.createElement('div');
            labelDiv.className = 'measurement-label summary-label';
            labelDiv.innerHTML = labelText;

            const labelObject = new CSS2DObject(labelDiv);

            // --- 引导线和标签定位的复杂逻辑 START ---

            // 步骤1: 定义偏移量，您可以调整这些值来改变样式
            const horizontalOffset = 0.3; // 标签水平偏离锚点的距离
            const verticalOffset = 0.1;   // 标签垂直偏离锚点的距离
            const elbowHorizontalOffset = 0.05; // 拐点水平偏离锚点的距离

            // 步骤2: 根据锚点在身体的左侧还是右侧，决定标签的偏移方向
            const side = context.anchorPoint.x >= 0 ? 1 : -1; // 1代表右侧, -1代表左侧

            // 步骤3: 计算标签的最终摆放位置
            const labelPosition = new THREE.Vector3(
                context.anchorPoint.x + (horizontalOffset * side), // 水平偏移
                context.anchorPoint.y + verticalOffset,             // 垂直偏移
                context.anchorPoint.z                               // Z轴保持一致
            );
            labelObject.position.copy(labelPosition);

            // 步骤4: 计算“拐点”的位置
            const elbowPoint = new THREE.Vector3(
                context.anchorPoint.x + (elbowHorizontalOffset * side), // 水平偏移（较小）
                labelPosition.y,                                      // Y轴与标签位置平齐
                context.anchorPoint.z                                 // Z轴与锚点平齐
            );

            // 步骤5: 使用三个点来创建引导线几何体
            const leaderLinePoints = [labelPosition, elbowPoint, context.anchorPoint];

            // --- 引导线和标签定位的复杂逻辑 END ---

            const lineMaterial = new THREE.LineBasicMaterial({ color: 0x000000, depthTest: false }); // 使用之前修改的黑色
            const lineGeometry = new THREE.BufferGeometry().setFromPoints(leaderLinePoints);
            const leaderLine = new THREE.Line(lineGeometry, lineMaterial);
            leaderLine.renderOrder = 997;

            const newAnnotation = this.addHighlightAnnotation({
                name: context.name,
                labelObject,
                leaderLineObject: leaderLine,
                materialKey: context.id,
            }, 'human_model');

            // 使用与context.id相同的ID覆盖自动生成的ID，以确保能正确找到并更新它
            this.annotations.delete(newAnnotation.id); // 删除自动生成的
            newAnnotation.id = summaryId; // 设置为确定性ID
            this.annotations.set(summaryId, newAnnotation); // 重新插入
        }
    }

    public addPhotoAnnotation(data: Omit<PhotoAnnotation, 'id' | 'type'>): PhotoAnnotation {
        const id = `photo-${Date.now()}`

        const annotation: PhotoAnnotation = { ...data, id, type: 'photo' }
        this.annotations.set(id, annotation)
        console.log(`photo annatation added: ${id}`);
        return annotation
    }

    private _formatSummaryText(context: InjuryContext): string {
        const measurements = context.measurements;
        let html = `<strong>${context.name}</strong><br>`;
        if (measurements.cumulativeArea > 0) {
            html += `累计损伤面积: ${measurements.cumulativeArea.toFixed(2)} cm²<br>`;
        }
        if (measurements.cumulativeCurveLength > 0) {
            html += `累计曲线长度: ${measurements.cumulativeCurveLength.toFixed(2)} cm<br>`;
        }
        if (measurements.cumulativeStraightLength > 0) {
            html += `累计直线长度: ${measurements.cumulativeStraightLength.toFixed(2)} cm<br>`;
        }
        if (measurements.bsaPercentage > 0) {
            html += `占体表面积: ${measurements.bsaPercentage.toFixed(2)}%`;
        }
        if (html.endsWith('<br>')) html = html.slice(0, -4);
        return html;
    }
    // #endregion


    // #region --- 公共方法：移除标注 ---
    /**
    * 移除指定上下文id的所有关联标注
    * @params contextId 要清楚的上下文id
    */
    public removeAnnotationsForContext(contextId: string): void {
        const idsToRemove: string[] = []
        this.annotations.forEach((annotation, id) => {
            if (annotation.contextId === contextId || id === contextId) {
                idsToRemove.push(id)
            }
        })
        console.log(`AnnotationManager found ${idsToRemove.length} annotations to remove for context:${contextId}`);
        idsToRemove.forEach(id => this.removeAnnotation(id))

    }
    /**
     * 根据 ID 移除一个标注物。
     * @param id - 要移除的标注物的 ID。
     * @returns 如果成功移除返回 true，否则返回 false。
     */
    public removeAnnotation(id: string): boolean {
        const annotation = this.annotations.get(id);
        if (!annotation) {
            return false;
        }

        // --- 核心修正：遍历对象数组并逐个删除 ---
        const visualObjects = this._getVisualObjects(annotation);
        visualObjects.forEach(obj => this.removeObject(obj));
        // --- 核心修正结束 ---

        this.annotations.delete(id);
        console.log(`Annotation with ID ${id} and its visual objects removed.`);
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

    public setAnnotationsVisibility(visibleContextId: string | null): void {
        const targetId = visibleContextId === null ? 'human_model' : visibleContextId;
        this.annotations.forEach((annotation) => {
            const objects = this._getVisualObjects(annotation);
            // 规则：如果标注的contextId与当前可见的contextId匹配，则显示
            const isVisible = annotation.contextId === targetId;
            objects.forEach(obj => {
                obj.visible = isVisible;
            });
        });
    }

    /**
     * 设置一个全局的可见性过滤器，可以仅显示比例尺或显示所有。
     * @param showOnlyScaleBar - 如果为 true，则只显示比例尺，隐藏所有其他标注。如果为 false，则恢复正常的可见性逻辑。
     */
    public setGlobalVisibility(filter: AnnotationFilter, visibleContextId: string | null): void {
        const targetContextId = visibleContextId === null ? 'human_model' : visibleContextId;

        this.annotations.forEach((annotation) => {
            const visualObjects = this._getVisualObjects(annotation);

            // 1. 先判断标注是否属于当前上下文
            const isVisibleByContext = annotation.contextId === targetContextId;

            // 2. 如果属于当前上下文，再应用外部传入的过滤器函数
            const isVisibleByFilter = filter(annotation);

            // 3. 最终的可见性是两者的交集
            const finalVisibility = isVisibleByContext && isVisibleByFilter;

            visualObjects.forEach(obj => {
                if (obj) {
                    obj.visible = finalVisibility;
                }
            });
        });
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
        if (!object) {
            console.log('对象不存在，跳过移除');
            return;
        }

        // 1. 单独处理 CSS2DObject
        if (object instanceof CSS2DObject) {
            console.log('移除 CSS2D 对象');
            if (object.element && object.element.parentElement) {
                object.element.parentElement.removeChild(object.element);
            }
            // 从父节点移除
            if (object.parent) {
                object.parent.remove(object);
            }
            return;
        }

        // 2. 对于所有 THREE.Object3D 类型的对象（包括其子类）
        // 使用 traverse 遍历自身及其所有子孙节点
        console.log('开始移除 Three.js 对象及其子对象:', object);
        object.traverse((child: THREE.Object3D) => {

            if ((child as THREE.Mesh).isMesh) {
                const mesh = child as THREE.Mesh

                if (mesh.geometry) mesh.geometry.dispose()
                if (mesh.material) this._cleanMaterial(mesh.material)
            }
        });

        // 3. 最后，在清理完所有子孙节点的资源后，再将顶层对象从其父节点中断开连接
        if (object.parent) {
            console.log('将对象从父节点移除:', object);
            object.parent.remove(object);
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
    private isTexture(value: unknown): value is THREE.Texture {
        return value !== null
            && typeof value === 'object'
            && 'dispose' in value
            && 'isTexture' in value
            && (value as THREE.Texture).isTexture;
    }

    /**
     * 用于获取标注的所有视觉对象
     * @param annotation 
     * @returns THREE.Object3D[]
     */
    private _getVisualObjects(annotation: Annotation): THREE.Object3D[] {
        const objects: (THREE.Object3D | CSS2DObject | null | undefined)[] = [];
        switch (annotation.type) {
            case 'scale_bar':
                objects.push(annotation.object3D);
                break;
            case 'surface_curve':
                objects.push(annotation.curveLineObject, annotation.savedLabelObject, annotation.leaderLineObject, annotation.proxyObject);
                break;
            case 'straight_line':
                objects.push(annotation.lineObject, annotation.startSphere, annotation.endSphere, annotation.lengthLabelObject, annotation.proxyObject);
                break;
            case 'planimetering':
                objects.push(annotation.highlightMesh, annotation.areaLabelObject, annotation.proxyObject);
                break;
            case 'highlight':
                // 对于高亮标注，我们只控制标签和引导线的显隐，高亮效果由HighlightTool管理
                objects.push(annotation.labelObject, annotation.leaderLineObject, annotation.proxyObject);
                break;
        }
        return objects.filter((obj): obj is THREE.Object3D => obj != null);
    }

    private _createAndRegisterAnnotation<T extends Annotation>(
        baseData: Omit<T, 'id' | 'type' | 'contextId'>,
        options: {
            idPrefix: string;
            type: T['type'];
            toolMode: ToolMode;
            contextId: string;
            getObjects: (annotation: T) => (THREE.Object3D | null | undefined)[];
            hasLabelProxy?: boolean;
        }
    ): T {
        // 1.生成唯一id
        const id = `${options.idPrefix}-${Date.now()}`

        // 2.创建完整的标注数据对象
        const annotation = {
            ...baseData,
            id,
            type: options.type,
            contextId: options.contextId
        } as T;

        // 准备userData
        const userDataPayload = { annotationId: annotation.id, type: options.toolMode }

        // 3.将所有相关对象的3D对象添加到场景，并设置userData
        const allObjects = options.getObjects(annotation)
        allObjects.forEach(obj => {
            if (obj) {
                obj.traverse((child: THREE.Object3D) => {
                    child.userData = userDataPayload
                })

                this.sceneController.scene.add(obj)
            }
        })

        // 4.处理代理对象
        const labelObject = (annotation as any).labelObject ||
            (annotation as any).lengthLabelObject ||
            (annotation as any).areaLabelObject ||
            (annotation as any).savedLabelObject;

        if (options.hasLabelProxy && labelObject) {
            const proxyMesh = new THREE.Mesh(this.proxyGeometry, this.proxyMaterial)
            proxyMesh.position.copy(labelObject.position)
            proxyMesh.userData = userDataPayload
            this.sceneController.scene.add(proxyMesh);

            (annotation as any).proxyObject = proxyMesh
        }

        // 5.注册到Map
        this.annotations.set(id, annotation)

        return annotation
    }
    // #endregion
}