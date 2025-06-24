//@ts-ignore
import * as THREE from 'three';
import { BaseTool, ITool } from '../../components/Base-tools/BaseTool';
import { InteractionEvent, ToolMode, ISceneController, IAnnotationManager, IEventEmitter } from '../../types/webgl-marking';
//@ts-ignore
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

export class HighlightTool extends BaseTool implements ITool {
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
        0: '右颞',
        1: '左颞',
        2: '左大臂',
        3: '左小腿',
        4: '头顶',
        5: '右小腿',
        6: '右小臂',
        7: '左小臂',
        8: '右大臂',
        9: '左大腿',
        10: '右大腿',
        11: '右臀',
        12: '左臀',
        13: '下体',
        14: '右脚',
        15: '左脚',
        16: '右手',
        17: '左手',
        18: '背',
        19: '胸腹',
        20: '颈',
        21: '面',
        22: '后脑',
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

        //预初始化所有模型的原始材料
        this.preInitializeMaterials();


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
        const intersection = event.intersection;

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
                // 验证收到的事件是否包含正确的交点信息

        const intersection = event.intersection

        if (intersection && typeof intersection.face?.materialIndex !== 'undefined') {
            const mesh = intersection.object as THREE.Mesh

            //核心修改：检查交点是否属于人体模型
            let isHumanModelPart = false;
            this.sceneController.humanModel?.traverse((child:THREE.Object3D)=>{
                if(child === mesh)
                {
                    isHumanModelPart = true;
                }
            })

            if(!isHumanModelPart)
            {
                return;
            }
            
            const materialIndex = intersection.face.materialIndex
            const key = `${mesh.uuid}-${materialIndex}`

            //在处理高亮逻辑之前，立即识别部位并发送事件
            const partName = this.getPartName(mesh, materialIndex);
            this.eventEmitter.emit('partSelected',{partId:key,name:partName});
            
            const isEarClicked = this.EAR_MATERIAL_INDICES.includes(materialIndex)

            if (isEarClicked) {
                // --- 工作流1: 点击了耳廓 ---
                // 1. 清除所有非耳廓的高亮（包括待定和已标注的未点击添加按钮的）
                this.deselectAllNonEarMaterials()
                
                // 2. 如果该耳廓已添加标签，则忽略操作
                if (this.materialToAnnotationIdMap.has(key)) {
                    return
                }
                
                // 3. 清除另一个耳廓的高亮（左右耳廓互斥）
                this.clearOtherEarHighlight(materialIndex)
                
                // 4. 切换当前耳廓的高亮状态
                if (this.pendingEarHighlights.has(key)) {
                    // 如果已在待定列表，则从中移除并取消高亮
                    this.pendingEarHighlights.delete(key)
                    this.deselectMaterial(key)
                } else {
                    // 如果不在待定列表，则添加并高亮
                    this.selectMaterial(mesh, materialIndex, key)
                    
                    // 获取部位名称
                    const partName = this.getPartName(mesh, materialIndex)
                    
                    const position = intersection.point.clone()
                    this.pendingEarHighlights.set(key, { name: partName, position })
                    
                }
            } else {
                // --- 工作流2: 点击了普通部位 ---
                // 1. 清除所有耳廓的高亮（指的是未点击添加按钮没有标注的高亮部位）
                this.deselectAllEarMaterials()

                // 2. 如果该部位已添加标签，则忽略操作
                if (this.materialToAnnotationIdMap.has(key)) {
                    return
                }

                // 3. 切换该部位在"待定高亮"列表中的状态
                if (this.pendingHighlights.has(key)) {
                    // 如果已在待定列表，则从中移除并取消高亮
                    this.pendingHighlights.delete(key)
                    this.deselectMaterial(key)

                } else {
                    // 如果不在待定列表，则添加并高亮
                    this.selectMaterial(mesh, materialIndex, key)
                    
                    // 获取部位名称
                    const partName = this.getPartName(mesh, materialIndex)
                    
                    const position = intersection.point.clone()
                    this.pendingHighlights.set(key, { name: partName, position })

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
        
    }

    /**
     * 创建单个标注
     */
    private createSingleAnnotation(key: string, name: string, position: THREE.Vector3): void {
        //创建DOM元素
        const labelDiv = document.createElement('div');
        labelDiv.className = 'measurement-label highlight-label';
        labelDiv.textContent = name;
        const labelObject = new CSS2DObject(labelDiv);
        
        //设置标签位置
        const labelPosition = position.clone().add(new THREE.Vector3(0, 0.1, 0));
        labelObject.position.copy(labelPosition);
        
        //创建指引线
        const lineMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false });
        const lineGeometry = new THREE.BufferGeometry().setFromPoints([labelPosition, position]);
        const leaderLine = new THREE.Line(lineGeometry, lineMaterial);
        leaderLine.renderOrder = 997;

        //添加到标注管理器
        const annotation = this.annotationManager.addHighlightAnnotation({
            name,
            labelObject,
            leaderLineObject: leaderLine,
            materialKey: key,
        });

        //记录映射关系
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

    /**
     * 预初始化所有模型的原始材料，避免首次点击时的延迟
     **/
    private preInitializeMaterials(): void {
        if(!this.sceneController.humanModel) return;

        this.sceneController.humanModel.traverse((child:THREE.Object3D) => {
            if((child as THREE.Mesh).isMesh){
                const mesh = child as THREE.Mesh;
                this.ensureOriginalMaterialsStored(mesh);
            }
        })
    }


    private updateMaterialDisplay(mesh: THREE.Mesh, materialIndex: number, key: string): void {
        if (!Array.isArray(mesh.material)) return;
        
        this.ensureOriginalMaterialsStored(mesh);// 确保原始材质已存储
        
        const isSelected = this.selectedMaterials.has(key);
        const isHovered = this.hoveredMaterialInfo?.mesh === mesh && 
                         this.hoveredMaterialInfo?.materialIndex === materialIndex;
        
        let targetMaterial: THREE.Material;
        
        //优先级：选中》悬停》原始
        if (isSelected) {
            targetMaterial = this.selectHighlightMaterial;
        } else if (isHovered) {
            targetMaterial = this.hoverHighlightMaterial;
        } else {
            targetMaterial = this.getOriginalMaterial(mesh, materialIndex);
        }
        
        (mesh.material as THREE.Material[])[materialIndex] = targetMaterial;
        this.forceUpdate(mesh);

        requestAnimationFrame(()=>{
            //空操作，仅确保渲染循环执行
        })
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
    
    //原始材质保存机制
    private ensureOriginalMaterialsStored(mesh: THREE.Mesh): void {
        if (!mesh.userData.originalMaterials) {
            const materials = mesh.material;
            if (Array.isArray(materials)) {
                //首次点击时，需要对所有材质进行克隆
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
            return materialName.trim()
        }
        
        // 否则使用映射表
        if (this.PART_NAME_MAP[materialIndex]) {
            return this.PART_NAME_MAP[materialIndex]
        }
        
        // 最后使用默认名称
        const defaultName = `部位${materialIndex}`
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

    }
    
    dispose(): void {
        super.dispose();
        this.deactivate();
    }

    /**
     * 清除另一个耳廓的高亮（左右耳廓互斥）
     */
    private clearOtherEarHighlight(currentMaterialIndex: number): void {
        
        // 确定另一个耳廓的材质索引
        const otherEarIndex = currentMaterialIndex === 23 ? 24 : 23
        
        // 遍历待定的耳廓高亮，找到另一个耳廓并清除
        const keysToRemove: string[] = []
        this.pendingEarHighlights.forEach((_value, key) => {
            // 通过 selectedMaterials 获取材质索引
            const materialInfo = this.selectedMaterials.get(key)
            if (materialInfo && materialInfo.materialIndex === otherEarIndex) {
                keysToRemove.push(key)
            }
        })
        
        // 清除找到的其他耳廓
        keysToRemove.forEach(key => {
            this.pendingEarHighlights.delete(key)
            this.deselectMaterial(key)
        })
    }

}