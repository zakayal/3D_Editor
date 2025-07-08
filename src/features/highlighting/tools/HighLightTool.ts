// HighlightTool.ts - 最终的、经过精校的完整版本

//@ts-ignore
import * as THREE from 'three';
import { BaseTool, ITool } from '../../../utils/BaseTool';
import { InteractionEvent, ToolMode, ISceneController, IAnnotationManager, IEventEmitter } from '../../../types/webgl-marking';

export class HighlightTool extends BaseTool implements ITool {
    private readonly hoverHighlightMaterial: THREE.Material;
    private readonly selectHighlightMaterial: THREE.Material;

    private hoveredMaterialInfo: { mesh: THREE.Mesh; materialIndex: number } | null = null;
    private selectedParts: Map<string, { mesh: THREE.Mesh; materialIndex: number; name: string; anchorPoint: THREE.Vector3 }> = new Map();
    private persistentHighlights: Map<string, { mesh: THREE.Mesh; materialIndex: number }> = new Map();

    // 成为工具内部的权威“部位注册表”
    private partRegistry: Map<string, { mesh: THREE.Mesh; materialIndex: number }> = new Map();

    private readonly EAR_MATERIAL_INDICES = [23, 24];
    private readonly PART_NAME_MAP: Record<number, string> = {
        0: '右颞', 1: '左颞', 2: '左大臂', 3: '左小腿', 4: '头顶', 5: '右小腿',
        6: '右小臂', 7: '左小臂', 8: '右大臂', 9: '左大腿', 10: '右大腿',
        11: '右臀', 12: '左臀', 13: '下体', 14: '右脚', 15: '左脚', 16: '右手',
        17: '左手', 18: '背', 19: '胸腹', 20: '颈', 21: '面', 22: '后脑',
        23: '左耳廓', 24: '右耳廓'
    };


    constructor(sceneController: ISceneController, annotationManager: IAnnotationManager, eventEmitter: IEventEmitter) {
        super(sceneController, annotationManager, eventEmitter);

        this.hoverHighlightMaterial = new THREE.MeshPhongMaterial({
            color: 0xF56958, transparent: true, opacity: 0.6, shininess: 80,
        });
        this.selectHighlightMaterial = new THREE.MeshPhongMaterial({
            color: 0xF56958, emissive: 0x110000, shininess: 60,
        });

    }

    getMode(): ToolMode {
        return ToolMode.Highlight;
    }

    activate(): void {
        super.activate();
        this.sceneController.orbitControls.enabled = true;
        this.sceneController.orbitControls.mouseButtons.RIGHT = null
        setTimeout(() => this._initializeOriginalMaterials(), 100)
    }

    deactivate(): void {
        this.clearTemporaryHighlights();
        this.clearHoverState();
    }

    onPointerDown(event: InteractionEvent): void {
        const intersection = event.intersection;
        if (!intersection || typeof intersection.face?.materialIndex === 'undefined') return;

        const mesh = intersection.object as THREE.Mesh;
        if (!this.isHumanModelPart(mesh)) return;

        const materialIndex = intersection.face.materialIndex;
        const key = `${mesh.uuid}-${materialIndex}`;

        if (this.persistentHighlights.has(key)) {
            console.log(`%c[HighlightTool] Action BLOCKED: Part ${key} is a persistent highlight.`, 'color: orange; font-weight: bold;');
            return;
        }

        const partName = this.getPartName(mesh, materialIndex);
        const anchorPoint = intersection.point.clone();
        const isEarClicked = this.EAR_MATERIAL_INDICES.includes(materialIndex);

        if (this.selectedParts.has(key)) {
            this.deselectMaterial(key);
        } else {
            if (isEarClicked) {
                this.clearTemporaryHighlights();
            } else {
                this.clearTemporaryEarHighlights();
            }
            this.selectMaterial(mesh, materialIndex, key, { name: partName, anchorPoint: anchorPoint });
        }

        this.eventEmitter.emit('partsSelectionChanged', {
            selectedParts: Array.from(this.selectedParts.entries()).map(([partId, data]) => ({
                partId,
                ...data
            }))
        });
    }

    onPointerMove(event: InteractionEvent): void {
        const intersection = event.intersection;
        if (intersection && typeof intersection.face?.materialIndex !== 'undefined') {
            const mesh = intersection.object as THREE.Mesh;
            const materialIndex = intersection.face.materialIndex;
            const key = `${mesh.uuid}-${materialIndex}`;

            if (!this.hoveredMaterialInfo || this.hoveredMaterialInfo.mesh !== mesh || this.hoveredMaterialInfo.materialIndex !== materialIndex) {
                this.clearHoverState();
                this.setHoverState(mesh, materialIndex, key);
            }
        } else {
            this.clearHoverState();
        }
    }

    private isHumanModelPart(mesh: THREE.Mesh): boolean {
        let isPart = false;
        this.sceneController.humanModel?.traverse((child: THREE.Object3D) => {
            if (child === mesh) isPart = true;
        });
        return isPart;
    }


    public setPersistentHighlights(keysToHighlight: string[]): void {
        console.group(`[HighlightTool] Executing setPersistentHighlights`);
        this.clearHoverState();

        const newHighlightsSet = new Set(keysToHighlight);
        const allAffectedKeys = new Set([...this.persistentHighlights.keys(), ...keysToHighlight]);

        // 【核心修改】我们不再需要复杂的清理逻辑，
        // 只需要告诉所有受影响的部位重新计算它们的视觉状态即可。

        // 更新内部的持久化高亮列表
        this.persistentHighlights.clear();
        newHighlightsSet.forEach(key => {
            const info = this.partRegistry.get(key);
            if (info) {
                this.persistentHighlights.set(key, info);
                if (this.selectedParts.has(key)) {
                    this.selectedParts.delete(key);
                }
            }
        });

        // 遍历所有曾经或现在需要高亮的部位，让它们调用新的 updateMaterialDisplay
        allAffectedKeys.forEach(key => {
            const info = this.partRegistry.get(key);
            if (info) {
                this.updateMaterialDisplay(info.mesh, info.materialIndex, key);
            }
        });

        console.groupEnd();
    }



    private updateMaterialDisplay(mesh: THREE.Mesh, materialIndex: number, key: string): void {
        if (!Array.isArray(mesh.material)) return;

        // 1. 获取模型上当前正在使用的那个材质对象。
        const currentMaterial = (mesh.material as THREE.Material[])[materialIndex];
        if (!currentMaterial) return;

        // 2. 从我们备份的 userData 中，获取这个部位“纯净”的原始材质。
        const originalMaterial = this.getOriginalMaterial(mesh, materialIndex);
        if (!originalMaterial) {
            // 如果找不到备份，就无法恢复，直接返回避免错误。
            console.warn(`Original material not found for key ${key}. Cannot update display.`);
            return;
        }

        const isPersistentlyHighlighted = this.persistentHighlights.has(key);
        const isTemporarilySelected = this.selectedParts.has(key);
        const isHovered = this.hoveredMaterialInfo?.mesh === mesh && this.hoveredMaterialInfo?.materialIndex === materialIndex;

        // 3. 【核心逻辑】根据状态，使用 .copy() 方法来修改当前材质的属性。
        if (isPersistentlyHighlighted || isTemporarilySelected) {
            // 让当前材质的属性“复制”高亮材质的属性。
            currentMaterial.copy(this.selectHighlightMaterial);
        } else if (isHovered) {
            // 让当前材质的属性“复制”悬浮材质的属性。
            currentMaterial.copy(this.hoverHighlightMaterial);
        } else {
            // 恢复：让当前材质的属性“复制”纯净的原始材质的属性。
            currentMaterial.copy(originalMaterial);
        }

        // 4. 告诉 Three.js，这个材质的属性已经被修改，需要在下一帧更新。
        currentMaterial.needsUpdate = true;
    }


    private selectMaterial(mesh: THREE.Mesh, materialIndex: number, key: string, data: { name: string; anchorPoint: THREE.Vector3 }): void {
        this.selectedParts.set(key, { mesh, materialIndex, ...data });
        this.updateMaterialDisplay(mesh, materialIndex, key);
    }

    private deselectMaterial(key: string): void {
        const info = this.selectedParts.get(key);
        if (info) {
            this.selectedParts.delete(key);
            this.updateMaterialDisplay(info.mesh, info.materialIndex, key);
        }
    }

    private clearTemporaryHighlights(): void {
        Array.from(this.selectedParts.keys()).forEach(key => this.deselectMaterial(key));
    }

    private clearTemporaryEarHighlights(): void {
        this.selectedParts.forEach((value, key) => {
            if (this.EAR_MATERIAL_INDICES.includes(value.materialIndex)) {
                this.deselectMaterial(key);
            }
        });
    }



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

    // 这是唯一负责填充注册表和存储原始材质的地方
    private _initializeOriginalMaterials(): void {
        if (!this.sceneController.humanModel) return;

        console.log('[HighlightTool] Initializing part registry and storing original materials...');

        // 清理旧数据，以防模型重载
        this.partRegistry.clear();

        this.sceneController.humanModel.traverse((child: THREE.Object3D) => {
            if ((child as THREE.Mesh).isMesh) {
                const mesh = child as THREE.Mesh;

                // 确保 userData.originalMaterials 只被设置一次
                if (!mesh.userData.originalMaterials) {
                    const materials = mesh.material;
                    if (Array.isArray(materials)) {
                        mesh.userData.originalMaterials = materials.map((material: THREE.Material) => material.clone());
                    } else if (materials) {
                        mesh.userData.originalMaterials = [(materials as THREE.Material).clone()];
                    }
                }

                // 填充注册表
                if (Array.isArray(mesh.material)) {
                    // 显式声明类型来解决TS错误
                    mesh.material.forEach((_material: THREE.Material, materialIndex: number) => {
                        const key = `${mesh.uuid}-${materialIndex}`;
                        this.partRegistry.set(key, { mesh, materialIndex });
                    });
                }
            }
        });
        console.log(`[HighlightTool] Initialization complete. Part registry has ${this.partRegistry.size} entries.`);
    }

    private getOriginalMaterial(mesh: THREE.Mesh, materialIndex: number): THREE.Material | null {
        const originalMaterials = mesh.userData.originalMaterials as THREE.Material[] | undefined;
        return originalMaterials?.[materialIndex] ?? null; // 使用可选链和空值合并，更简洁
    }

    private getPartName(mesh: THREE.Mesh, materialIndex: number): string {
        let materialName = '';
        if (Array.isArray(mesh.material)) {
            const material = mesh.material[materialIndex];
            materialName = material?.name || '';
        }
        if (materialName.trim()) return materialName.trim();
        return this.PART_NAME_MAP[materialIndex] || `部位${materialIndex}`;
    }

    dispose(): void {
        super.dispose();
        this.deactivate();
    }
}