// src/Tools/hightLight/HighLightTool.ts

//@ts-ignore
import * as THREE from 'three';
import { BaseTool, ITool } from '../../Components/Base-tools/BaseTool';
import { InteractionEvent, ToolMode, ISceneController, IAnnotationManager, IEventEmitter } from '../../types/webgl-marking';
//@ts-ignore
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

export class HighlightTool extends BaseTool implements ITool {
    private raycaster = new THREE.Raycaster();
    private readonly hoverHighlightMaterial: THREE.Material;
    private readonly selectHighlightMaterial: THREE.Material;

    // --- 状态管理 ---

    private hoveredMaterialInfo: { mesh: THREE.Mesh; materialIndex: number } | null = null;

    // 1. 用于管理所有视觉上的高亮（包括耳朵和普通部位）
    private selectedMaterials: Map<string, { mesh: THREE.Mesh; materialIndex: number }> = new Map();
    
    // 2. 用于管理已添加标签的永久标注
    private materialToAnnotationIdMap: Map<string, string> = new Map();
    
    // 3. 用于管理"待定"状态的普通部位高亮
    private pendingHighlights: Map<string, { name: string; position: THREE.Vector3; }> = new Map();

    // 4. 用于管理"待定"状态的耳廓高亮
    private pendingEarHighlights: Map<string, { name: string; position: THREE.Vector3; }> = new Map();

    // 耳廓材质的索引（请根据您的模型进行配置）
    private readonly EAR_MATERIAL_INDICES = [23, 24]; // 左耳廓, 右耳廓

    // 部位名称映射表：序列号 -> 中文名称
    private readonly PART_NAME_MAP: Record<number, string> = {
        0: '左耳',
        1: '右耳',
        2: '左耳',
        3: '右耳',
        4: '头发',
        5: '右胸',
        6: '右肩',
        7: '右臂',
        8: '右前臂',
        9: '左胸',
        10: '左肩',
        11: '左臂',
        12: '左骨',
        13: '左腿',
        14: '右腿',
        15: '右腿',
        16: '右腿',
        17: '左手',
        18: '背',
        19: '腰带',
        20: '颈',
        21: '面',
        22: '右脚',
        23: '左耳廓',
        24: '右耳廓'
    };

    private cleanupCreateAnnotationListener: (() => void) | null = null;

    constructor(sceneController: ISceneController, annotationManager: IAnnotationManager, eventEmitter: IEventEmitter) {
        super(sceneController, annotationManager, eventEmitter);

        // 悬浮高亮材质
        this.hoverHighlightMaterial = new THREE.MeshPhongMaterial({
            color: 0xF56958,
            transparent: true,
            opacity: 0.2,
            shininess: 80,
        });

        // 选中高亮材质
        this.selectHighlightMaterial = new THREE.MeshPhongMaterial({
            color: 0xF56958,
            emissive: 0x110000,
            shininess: 60,
        });
    }

    getMode(): ToolMode {
        return ToolMode.Highlight;
    }

    activate(): void {
        super.activate();
        this.sceneController.orbitControls.enabled = true;
        // 监听UI指令，一次性为所有待定高亮创建标注
        this.cleanupCreateAnnotationListener = this.eventEmitter.on('createHighlightAnnotation', () => {
            this.createAnnotationsForAllPending();
        });
    }

    deactivate(): void {
        this.clearAllHighlightsAndAnnotations();
        if (this.cleanupCreateAnnotationListener) {
            this.cleanupCreateAnnotationListener();
            this.cleanupCreateAnnotationListener = null;
        }
    }

    onPointerMove(event: InteractionEvent): void {
        const intersection = this.getIntersection(event);

        if (intersection && typeof intersection.face?.materialIndex !== 'undefined') {
            const mesh = intersection.object as THREE.Mesh;
            const materialIndex = intersection.face.materialIndex;
            const key = `${mesh.uuid}-${materialIndex}`;

            if (this.hoveredMaterialInfo?.mesh !== mesh || this.hoveredMaterialInfo?.materialIndex !== materialIndex) {
                this.clearHoverState();
                this.setHoverState(mesh, materialIndex, key);
            }
        } else {
            this.clearHoverState();
        }
    }

    /**
     * 核心交互逻辑：整合了耳廓点选和普通部位多选两种模式
     */
    onPointerDown(event: InteractionEvent): void {
        console.log('HighlightTool.onPointerDown 被调用')
        const intersection = this.getIntersection(event)

        if (intersection && typeof intersection.face?.materialIndex !== 'undefined') {
            const mesh = intersection.object as THREE.Mesh
            const materialIndex = intersection.face.materialIndex
            const key = `${mesh.uuid}-${materialIndex}`
            
            console.log(`点击了材质索引: ${materialIndex}, key: ${key}`)
            
            const isEarClicked = this.EAR_MATERIAL_INDICES.includes(materialIndex)
            console.log(`是否点击耳廓: ${isEarClicked}`)

            if (isEarClicked) {
                // --- 工作流1: 点击了耳廓 ---
                console.log('执行耳廓点击逻辑')
                // 1. 清除所有非耳廓的高亮（包括待定和已标注的未点击添加按钮的）
                this.deselectAllNonEarMaterials()
                
                // 2. 如果该耳廓已添加标签，则忽略操作
                if (this.materialToAnnotationIdMap.has(key)) {
                    console.log('该耳廓已添加标签，忽略操作')
                    return
                }
                
                // 3. 清除另一个耳廓的高亮（左右耳廓互斥）
                this.clearOtherEarHighlight(materialIndex)
                
                // 4. 切换当前耳廓的高亮状态
                if (this.pendingEarHighlights.has(key)) {
                    // 如果已在待定列表，则从中移除并取消高亮
                    console.log('耳廓已在待定列表，取消高亮')
                    this.pendingEarHighlights.delete(key)
                    this.deselectMaterial(key)
                    // 如果移除后列表为空，通知UI禁用按钮
                    if (this.pendingEarHighlights.size === 0) {
                        console.log('发送 highlightPartDeselected 事件 (耳廓)')
                        this.eventEmitter.emit('highlightPartDeselected', {})
                    }
                } else {
                    // 如果不在待定列表，则添加并高亮
                    console.log('耳廓不在待定列表，添加高亮')
                    this.selectMaterial(mesh, materialIndex, key)
                    
                    // 获取部位名称
                    const partName = this.getPartName(mesh, materialIndex)
                    console.log(`耳廓部位名称: ${partName}`)
                    
                    const position = intersection.point.clone()
                    this.pendingEarHighlights.set(key, { name: partName, position })
                    // 通知UI启用按钮
                    console.log('发送 highlightPartSelected 事件 (耳廓)')
                    this.eventEmitter.emit('highlightPartSelected', {})
                }
            } else {
                // --- 工作流2: 点击了普通部位 ---
                console.log('执行普通部位点击逻辑')
                // 1. 清除所有耳廓的高亮（指的是未点击添加按钮没有标注的高亮部位）
                this.deselectAllEarMaterials()

                // 2. 如果该部位已添加标签，则忽略操作
                if (this.materialToAnnotationIdMap.has(key)) {
                    console.log('该部位已添加标签，忽略操作')
                    return
                }

                // 3. 切换该部位在"待定高亮"列表中的状态
                if (this.pendingHighlights.has(key)) {
                    // 如果已在待定列表，则从中移除并取消高亮
                    console.log('普通部位已在待定列表，取消高亮')
                    this.pendingHighlights.delete(key)
                    this.deselectMaterial(key)
                    // 如果移除后列表为空，通知UI禁用按钮
                    if (this.pendingHighlights.size === 0) {
                        console.log('发送 highlightPartDeselected 事件 (普通部位)')
                        this.eventEmitter.emit('highlightPartDeselected', {})
                    }
                } else {
                    // 如果不在待定列表，则添加并高亮
                    console.log('普通部位不在待定列表，添加高亮')
                    this.selectMaterial(mesh, materialIndex, key)
                    
                    // 获取部位名称
                    const partName = this.getPartName(mesh, materialIndex)
                    console.log(`普通部位名称: ${partName}`)
                    
                    const position = intersection.point.clone()
                    this.pendingHighlights.set(key, { name: partName, position })
                    // 通知UI启用按钮
                    console.log('发送 highlightPartSelected 事件 (普通部位)')
                    this.eventEmitter.emit('highlightPartSelected', {})
                }
            }
        } else {
            console.log('没有检测到有效的交集')
        }
    }
    
    /**
     * 为所有待定高亮的部位创建永久标注
     */
    private createAnnotationsForAllPending(): void {
        if (this.pendingHighlights.size === 0 && this.pendingEarHighlights.size === 0) return;

        // 处理普通部位的待定高亮
        this.pendingHighlights.forEach(({ name, position }, key) => {
            this.createSingleAnnotation(key, name, position);
        });

        // 处理耳廓的待定高亮
        this.pendingEarHighlights.forEach(({ name, position }, key) => {
            this.createSingleAnnotation(key, name, position);
        });

        // 清空所有待定列表
        this.pendingHighlights.clear();
        this.pendingEarHighlights.clear();
        
        // 通知UI禁用按钮
        this.eventEmitter.emit('highlightPartDeselected', {});
    }

    /**
     * 创建单个标注
     */
    private createSingleAnnotation(key: string, name: string, position: THREE.Vector3): void {
        const labelDiv = document.createElement('div');
        labelDiv.className = 'measurement-label highlight-label';
        labelDiv.textContent = name;
        const labelObject = new CSS2DObject(labelDiv);
        
        const labelPosition = position.clone().add(new THREE.Vector3(0, 0.1, 0));
        labelObject.position.copy(labelPosition);
        
        const lineMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false });
        const lineGeometry = new THREE.BufferGeometry().setFromPoints([labelPosition, position]);
        const leaderLine = new THREE.Line(lineGeometry, lineMaterial);
        leaderLine.renderOrder = 997;

        const annotation = this.annotationManager.addHighlightAnnotation({
            name,
            labelObject,
            leaderLineObject: leaderLine,
            materialKey: key,
        });

        this.materialToAnnotationIdMap.set(key, annotation.id);
    }

    // --- 基础高亮与状态方法 ---

    private setHoverState(mesh: THREE.Mesh, materialIndex: number, key: string): void {
        this.hoveredMaterialInfo = { mesh, materialIndex };
        this.updateMaterialDisplay(mesh, materialIndex, key);
    }
    
    private clearHoverState(): void {
        if (this.hoveredMaterialInfo) {
            const { mesh, materialIndex } = this.hoveredMaterialInfo;
            const key = `${mesh.uuid}-${materialIndex}`;
            this.hoveredMaterialInfo = null;
            this.updateMaterialDisplay(mesh, materialIndex, key);
        }
    }
    
    private selectMaterial(mesh: THREE.Mesh, materialIndex: number, key: string): void {
        this.selectedMaterials.set(key, { mesh, materialIndex });
        this.updateMaterialDisplay(mesh, materialIndex, key);
    }
    
    private deselectMaterial(key: string): void {
        const info = this.selectedMaterials.get(key);
        if (info) {
            this.selectedMaterials.delete(key);
            this.updateMaterialDisplay(info.mesh, info.materialIndex, key);
        }
    }

    private updateMaterialDisplay(mesh: THREE.Mesh, materialIndex: number, key: string): void {
        if (!Array.isArray(mesh.material)) return;
        
        this.ensureOriginalMaterialsStored(mesh);
        
        const isSelected = this.selectedMaterials.has(key);
        const isHovered = this.hoveredMaterialInfo?.mesh === mesh && 
                         this.hoveredMaterialInfo?.materialIndex === materialIndex;
        
        let targetMaterial: THREE.Material;
        
        if (isSelected) {
            targetMaterial = this.selectHighlightMaterial;
        } else if (isHovered) {
            targetMaterial = this.hoverHighlightMaterial;
        } else {
            targetMaterial = this.getOriginalMaterial(mesh, materialIndex);
        }
        
        (mesh.material as THREE.Material[])[materialIndex] = targetMaterial;
        this.forceUpdate(mesh);
    }
    
    private forceUpdate(mesh: THREE.Mesh): void {
        if (Array.isArray(mesh.material)) {
            mesh.material.forEach((material: THREE.Material) => {
                if (material.needsUpdate !== undefined) {
                    material.needsUpdate = true;
                }
            });
        }
    }

    private getIntersection(event: InteractionEvent): THREE.Intersection | null {
        if (!event.pointer || !this.sceneController.camera || !this.sceneController.targetModel) {
            return null;
        }
        this.raycaster.setFromCamera(event.pointer, this.sceneController.camera);
        const intersects = this.raycaster.intersectObject(this.sceneController.targetModel, true);
        return intersects.length > 0 ? intersects[0] : null;
    }
    
    private ensureOriginalMaterialsStored(mesh: THREE.Mesh): void {
        if (!mesh.userData.originalMaterials) {
            const materials = mesh.material;
            if (Array.isArray(materials)) {
                mesh.userData.originalMaterials = materials.map((material:THREE.Material) => material.clone());
            } else {
                mesh.userData.originalMaterials = [materials.clone()];
            }
        }
    }

    private getOriginalMaterial(mesh: THREE.Mesh, materialIndex: number): THREE.Material {
        const originalMaterials = mesh.userData.originalMaterials as THREE.Material[]
        return originalMaterials[materialIndex]
    }
    
    /**
     * 获取部位名称：优先使用材质的name属性，其次使用映射表，最后使用默认名称
     */
    private getPartName(mesh: THREE.Mesh, materialIndex: number): string {
        // 首先尝试从材质获取名称
        let materialName = ''
        if (Array.isArray(mesh.material)) {
            const material = mesh.material[materialIndex]
            materialName = material.name || ''
        }
        
        // 如果材质有名称且不为空，使用材质名称
        if (materialName && materialName.trim()) {
            console.log(`使用材质名称: ${materialName}`)
            return materialName.trim()
        }
        
        // 否则使用映射表
        if (this.PART_NAME_MAP[materialIndex]) {
            console.log(`使用映射表名称: ${this.PART_NAME_MAP[materialIndex]}`)
            return this.PART_NAME_MAP[materialIndex]
        }
        
        // 最后使用默认名称
        const defaultName = `部位${materialIndex}`
        console.log(`使用默认名称: ${defaultName}`)
        return defaultName
    }
    
    // --- 逻辑整合辅助方法 ---

    /**
     * 清除所有非耳廓的高亮（指的是未点击添加按钮没有标注的高亮部位）
     */
    private deselectAllNonEarMaterials(): void {
        // 清除所有待定的普通部位高亮
        this.pendingHighlights.forEach((_value, key) => {
            this.deselectMaterial(key);
        });
        this.pendingHighlights.clear();

        // 注意：不清除已标注的普通部位，只清除未标注的
        // 已标注的部位在 materialToAnnotationIdMap 中，但不需要在这里清除

        // 如果没有任何待定高亮了，通知UI禁用按钮
        if (this.pendingEarHighlights.size === 0) {
            this.eventEmitter.emit('highlightPartDeselected', {});
        }
    }

    /**
     * 清除所有耳廓的高亮（指的是未点击添加按钮没有标注的高亮部位）
     */
    private deselectAllEarMaterials(): void {
        // 清除所有待定的耳廓高亮
        this.pendingEarHighlights.forEach((_value, key) => {
            this.deselectMaterial(key);
        });
        this.pendingEarHighlights.clear();

        // 注意：不清除已标注的耳廓，只清除未标注的
        // 已标注的耳廓在 materialToAnnotationIdMap 中，但不需要在这里清除

        // 如果没有任何待定高亮了，通知UI禁用按钮
        if (this.pendingHighlights.size === 0) {
            this.eventEmitter.emit('highlightPartDeselected', {});
        }
    }
    
    /**
     * 清除所有高亮和标注（用于工具停用时的完全清理）
     */
    private clearAllHighlightsAndAnnotations(): void {
        // 清除所有待定高亮
        this.pendingHighlights.forEach((_value, key) => {
            this.deselectMaterial(key);
        });
        this.pendingHighlights.clear();

        this.pendingEarHighlights.forEach((_value, key) => {
            this.deselectMaterial(key);
        });
        this.pendingEarHighlights.clear();

        // 清除所有已标注的高亮
        this.materialToAnnotationIdMap.forEach((annotationId, key) => {
            this.annotationManager.removeAnnotation(annotationId);
            this.deselectMaterial(key);
        });
        this.materialToAnnotationIdMap.clear();

        this.eventEmitter.emit('highlightPartDeselected', {});
    }
    
    dispose(): void {
        super.dispose();
        this.deactivate();
    }

    /**
     * 清除另一个耳廓的高亮（左右耳廓互斥）
     */
    private clearOtherEarHighlight(currentMaterialIndex: number): void {
        console.log(`清除其他耳廓高亮，当前点击的是材质索引: ${currentMaterialIndex}`)
        
        // 确定另一个耳廓的材质索引
        const otherEarIndex = currentMaterialIndex === 23 ? 24 : 23
        console.log(`需要清除的耳廓材质索引: ${otherEarIndex}`)
        
        // 遍历待定的耳廓高亮，找到另一个耳廓并清除
        const keysToRemove: string[] = []
        this.pendingEarHighlights.forEach((_value, key) => {
            // 通过 selectedMaterials 获取材质索引
            const materialInfo = this.selectedMaterials.get(key)
            if (materialInfo && materialInfo.materialIndex === otherEarIndex) {
                keysToRemove.push(key)
                console.log(`找到需要清除的耳廓: key=${key}, materialIndex=${otherEarIndex}`)
            }
        })
        
        // 清除找到的其他耳廓
        keysToRemove.forEach(key => {
            this.pendingEarHighlights.delete(key)
            this.deselectMaterial(key)
            console.log(`已清除耳廓高亮: ${key}`)
        })
    }
}