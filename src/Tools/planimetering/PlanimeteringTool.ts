import { BaseTool, ITool } from '../../components/Base-tools/BaseTool';
import { ToolMode, InteractionEvent, ISceneController, IAnnotationManager, IEventEmitter, PlanimeteringAnnotation } from '../../types/webgl-marking';
import { Planimetering } from '../../third-party/selection/Planimetering';
//@ts-ignore
import * as THREE from 'three';
//@ts-ignore
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

/**
 * Planimetering 工具 - 用于测量选定区域的面积
 * 这是一个适配器类，将 Planimetering 函数式工具适配为符合 ITool 接口的类
 */
export class PlanimeteringTool extends BaseTool implements ITool {
    private planimetering: any;
    private isActive: boolean = false;
    private isInitialized: boolean = false;
    private animationFrameId: number | null = null;
    private workGroup: THREE.Group | null = null;
    private currentMeasurement: { triangles: number[]; area: number } | null = null;
    // 用于处理连续ESC按键的标志
    private shouldExitOnNextEsc: boolean = false;
    // 新增：跟踪第一次点击位置
    private firstClickPosition: THREE.Vector3 | null = null;

    constructor(sceneController: ISceneController, annotationManager: IAnnotationManager, eventEmitter: IEventEmitter) {
        super(sceneController, annotationManager, eventEmitter);
        console.log("PlanimeteringTool: Constructed.");
    }

    // 监听标注被删除的事件，以维护内部状态的一致性
    private handleAnnotationRemoved = (data: { id: string }) => {
        console.log("PlanimeteringTool: Received annotation removal notification for:", data.id);
        // 简化：不需要维护内部列表，删除逻辑由AnnotationManager处理
    };

    getMode(): ToolMode {
        return ToolMode.Planimetering;
    }

    activate(): void {
        console.log("PlanimeteringTool: Activating...");
        this.isActive = true;

        // 监听标注删除事件
        this.eventEmitter.on('annotationRemoved', this.handleAnnotationRemoved);

        if (!this.isInitialized) {
            this.initializePlanimetering();
        }

        // 启动Planimetering工具的测量功能
        if (this.planimetering) {
            console.log("PlanimeteringTool: Starting measurement...");
            this.planimetering.startMeasurement();
        }

        // 暂停相机控制以避免冲突
        this.sceneController.orbitControls.mouseButtons.RIGHT = null;

        // 启动渲染循环
        this.startRenderLoop();

        console.log("PlanimeteringTool: Activated successfully.");
        this.eventEmitter.emit('modeChanged', { mode: this.getMode(), enabled: true });
    }

    deactivate(): void {
        console.log("PlanimeteringTool deactivated.");
        this.isActive = false;
        
        // 恢复相机控制
        this.sceneController.orbitControls.mouseButtons.RIGHT = THREE.MOUSE.PAN;

        this.sceneController.orbitControls.enabled = true;
        
        // 停止渲染循环
        this.stopRenderLoop();
        
        if (this.planimetering) {
            // 只取消当前的临时测量，不影响已保存的测量
            this.planimetering.cancelMeasurement();
        }
        
        // 清除临时测量数据
        this.currentMeasurement = null;
        this.shouldExitOnNextEsc = false;
        
        console.log("PlanimeteringTool: Deactivated. Saved measurements remain visible.");
        
        // 通知 UI 工具模式已停用
        this.eventEmitter.emit('modeChanged', { mode: this.getMode(), enabled: false });
    }

    private initializePlanimetering(): void {
        try {
            // 检查是否有有效的目标模型
            if (!this.sceneController.targetModel) {
                throw new Error("No target model available for planimetering");
            }

            // 查找第一个有效的网格对象
            let targetMesh: THREE.Mesh | null = null;
            this.sceneController.targetModel.traverse((child: THREE.Object3D) => {
                if (!targetMesh && (child as THREE.Mesh).isMesh && (child as THREE.Mesh).geometry) {
                    targetMesh = child as THREE.Mesh;
                }
            });

            if (!targetMesh) {
                throw new Error("No valid mesh object found in target model for planimetering");
            }

            console.log("PlanimeteringTool: Found target mesh:", targetMesh);
            console.log("PlanimeteringTool: Target model children count:", this.sceneController.targetModel.children.length);
            console.log("PlanimeteringTool: Target model children:", this.sceneController.targetModel.children);

            // 创建一个专门的工作组，确保网格在正确的位置
            this.workGroup = new THREE.Group();
            
            // 创建新的网格对象，避免克隆时的循环引用问题
            const meshClone = new THREE.Mesh();
            meshClone.geometry = (targetMesh as THREE.Mesh).geometry; // 共享几何体，避免重复数据
            meshClone.material = (targetMesh as THREE.Mesh).material; // 共享材质
            
            // 拷贝变换信息
            meshClone.position.copy((targetMesh as THREE.Mesh).position);
            meshClone.rotation.copy((targetMesh as THREE.Mesh).rotation);
            meshClone.scale.copy((targetMesh as THREE.Mesh).scale);
            
            // 不拷贝 userData，避免循环引用
            
            // 确保工作组有5个子对象，第4个是我们的网格
            for (let i = 0; i < 4; i++) {
                this.workGroup.add(new THREE.Group());
            }
            this.workGroup.add(meshClone);

            // 确保工作组的变换与目标模型同步
            this.workGroup.position.copy(this.sceneController.targetModel.position);
            this.workGroup.rotation.copy(this.sceneController.targetModel.rotation);
            this.workGroup.scale.copy(this.sceneController.targetModel.scale);
            
            // 将工作组添加到场景中
            this.sceneController.scene.add(this.workGroup);
            
            // 更新矩阵
            this.workGroup.updateMatrixWorld(true);

            console.log("PlanimeteringTool: Work group created with", this.workGroup.children.length, "children");
            console.log("PlanimeteringTool: Mesh clone at index 4:", this.workGroup.children[4]);
            
            // 检查网格的几何体信息
            const meshAt4 = this.workGroup.children[4] as THREE.Mesh;
            console.log("PlanimeteringTool: Mesh geometry:", meshAt4.geometry);
            console.log("PlanimeteringTool: Geometry has index:", !!meshAt4.geometry.index);
            console.log("PlanimeteringTool: Geometry vertex count:", meshAt4.geometry.attributes.position?.count);
            console.log("PlanimeteringTool: Geometry is indexed:", meshAt4.geometry.index ? "Yes" : "No");
            
            // Planimetering需要索引几何体来进行高亮显示
            // 如果几何体没有索引，需要创建索引
            if (!meshAt4.geometry.index) {
                console.log("PlanimeteringTool: Creating index for non-indexed geometry...");
                // 为非索引几何体创建索引
                const positionCount = meshAt4.geometry.attributes.position.count;
                const indices = [];
                for (let i = 0; i < positionCount; i++) {
                    indices.push(i);
                }
                meshAt4.geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
                console.log("PlanimeteringTool: Created index with", indices.length, "indices");
            } else {
                console.log("PlanimeteringTool: Geometry already has index with", meshAt4.geometry.index.count, "indices");
            }
            
            // 确保几何体有颜色属性（Planimetering需要）
            if (!meshAt4.geometry.attributes.color) {
                console.log("PlanimeteringTool: Adding color attribute to geometry...");
                const vertexCount = meshAt4.geometry.attributes.position.count;
                const colors = new Array(vertexCount * 3).fill(255);
                meshAt4.geometry.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(colors), 3, true));
            }
            
            // 确保几何体计算了边界盒
            if (!meshAt4.geometry.boundingBox) {
                meshAt4.geometry.computeBoundingBox();
            }
            
            // 确保几何体计算了边界球
            if (!meshAt4.geometry.boundingSphere) {
                meshAt4.geometry.computeBoundingSphere();
            }

            // 初始化 Planimetering 工具
            this.planimetering = Planimetering(
                this.sceneController.renderer,
                this.sceneController.camera,
                this.sceneController.scene,
                this.workGroup
            );

            // 注册事件发射器
            this.planimetering.registerEventEmitter(this.eventEmitter);

            // 注册第一次点击位置捕获回调
            this.planimetering.registerFirstClickCallback((position: THREE.Vector3) => {
                // 每次套索绘制都捕获第一个点的位置
                this.firstClickPosition = position.clone();
                console.log("PlanimeteringTool: Lasso first point position captured:", this.firstClickPosition);
            });

            // 注册回调函数，处理测量完成事件
            this.planimetering.registerLassoFinishedCall((data: { triangles: number[]; area: number }) => {
                console.log("Planimetering measurement completed:", data);
                
                // 存储当前测量数据，但不立即保存
                this.currentMeasurement = { triangles: data.triangles, area: data.area };
                
                // 检查高亮网格状态
                this.debugHighlightMesh();
                
                // 通知系统测量完成，但不创建annotation（等待用户保存）
                this.eventEmitter.emit('measurementCompleted', {
                    area: data.area,
                    triangles: data.triangles,
                    isTempMeasurement: true // 标记为临时测量
                });
                
                // 不自动调用saveMeasurement，等待用户主动按Enter键保存
                console.log("PlanimeteringTool: Measurement completed. Press Enter to save or ESC to cancel.");
                console.log("PlanimeteringTool: Current measurement - Area:", data.area, "Triangles:", data.triangles.length);
            });

            this.isInitialized = true;
            console.log("Planimetering tool initialized successfully.");
            
            // 初始化完成后立即启动测量
            console.log("PlanimeteringTool: Starting initial measurement...");
            this.planimetering.startMeasurement();
        } catch (error) {
            console.error("Failed to initialize Planimetering tool:", error);
            this.eventEmitter.emit('error', { 
                message: "Failed to initialize Planimetering tool", 
                details: error 
            });
        }
    }

    // 这些方法由于 Planimetering 工具自己处理鼠标事件，所以我们不需要在这里实现
    onPointerDown(_event: InteractionEvent): void {
        // Planimetering 工具自己处理鼠标事件
        // 这里我们可以添加一些额外的逻辑，比如日志记录
        if (this.isActive) {
            console.log("PlanimeteringTool: Pointer down event (handled by internal tool)");
        }
    }

    onPointerMove(_event: InteractionEvent): void {
        // Planimetering 工具自己处理鼠标事件
        if (this.isActive) {
            // 可以在这里添加一些状态更新逻辑
        }
    }

    onPointerUp(_event: InteractionEvent): void {
        // Planimetering 工具自己处理鼠标事件
        if (this.isActive) {
            console.log("PlanimeteringTool: Pointer up event (handled by internal tool)");
        }
    }

    onKeyDown(event: InteractionEvent): void {
        if (!this.isActive) return;

        const keyEvent = event.originalEvent as KeyboardEvent;
        
        // ESC 键取消当前测量或退出工具
        if (keyEvent.key === 'Escape') {
            // 如果标记了应该退出，则切换到空闲模式
            if (this.shouldExitOnNextEsc) {
                console.log("PlanimeteringTool: Exiting tool mode due to second ESC press.");
                this.eventEmitter.emit('toolModeChangeRequested', { mode: ToolMode.Idle });
                this.shouldExitOnNextEsc = false;
            } else {
                this.cancelCurrentMeasurement();
            }
        }
        // Enter 键确认当前测量
        else if (keyEvent.key === 'Enter') {
            this.confirmCurrentMeasurement();
        }
    }

    /**
     * 取消当前测量 - 只清除未保存的测量
     */
    public cancelCurrentMeasurement(): void {
        console.log("PlanimeteringTool: Cancelling current measurement.");
        
        const hadCurrentMeasurement = this.currentMeasurement !== null;
        const previousArea = this.currentMeasurement?.area || 0;
        
        if (this.planimetering) {
            // 调用原始的cancelMeasurement会清除所有数据
            this.planimetering.cancelMeasurement();
        }
        
        // 清除当前临时测量
        this.currentMeasurement = null;
        
        // 如果之前有临时测量，发送专门的取消事件
        if (hadCurrentMeasurement) {
            console.log("PlanimeteringTool: Cancelled temporary measurement with area:", previousArea);
            
            // 发送测量取消事件，UI可以据此更新显示
            this.eventEmitter.emit('measurementCancelled', {
                cancelledArea: previousArea,
                remainingArea: 0,
                savedCount: 0
            });
            
            // 额外发送通知
            this.eventEmitter.emit('notification', {
                message: `已取消临时测量（面积: ${previousArea.toFixed(2)}）`,
                type: 'info'
            });
        } else {
            // 如果没有当前测量但用户按了ESC，可能是想要退出工具
            this.eventEmitter.emit('notification', {
                message: "当前没有测量数据。再次按ESC退出测量工具",
                type: 'info'
            });
            
            // 标记下次ESC应该退出
            this.shouldExitOnNextEsc = true;
            
            setTimeout(() => {
                this.shouldExitOnNextEsc = false;
            }, 3000); // 3秒内有效
        }

        //重新启动下一次测量
        setTimeout(()=>{
            if(this.isActive && this.planimetering)
            {
                this.planimetering.startMeasurement();
            }
        },100)
    }

    /**
     * 确认当前测量 - 将当前测量加入已保存列表
     */
    public confirmCurrentMeasurement(): void {
        console.log("PlanimeteringTool: Confirming current measurement.");
        
        if (!this.currentMeasurement) {
            console.warn("PlanimeteringTool: No current measurement to save.");
            return;
        }
        
        // 创建持久化的高亮网格（独立于工具生命周期）
        const persistentHighlightMesh = this.createPersistentHighlightMesh(this.currentMeasurement.triangles);
        
        // 计算当前高亮图形的中心位置作为标签位置
        const highlightCenter = new THREE.Vector3();
        if (this.firstClickPosition) {
            highlightCenter.copy(this.firstClickPosition);
        } else {
            // 如果无法计算边界盒，使用默认位置
            highlightCenter.set(0, 0, 0);
        }
        
        // 为当前测量创建面积标签
        const areaLabel = this._createAreaLabel(this.currentMeasurement.area, highlightCenter);
        console.log("PlanimeteringTool: Area label created for measurement:", this.currentMeasurement.area);
        
        // 创建标注对象
        const annotationData: Omit<PlanimeteringAnnotation, 'id' | 'type'> = {
            area: this.currentMeasurement.area,
            triangles: this.currentMeasurement.triangles,
            timestamp: new Date().toISOString(),
            highlightMesh: persistentHighlightMesh,
            areaLabelObject: areaLabel,
            totalArea: this.currentMeasurement.area // 单个测量，总面积就是当前面积
        };

        const annotation = this.annotationManager.addPlanimetering(annotationData);
        
        console.log("PlanimeteringTool: Measurement saved successfully.");
        console.log("PlanimeteringTool: Area:", this.currentMeasurement.area);
        console.log("PlanimeteringTool: Persistent highlight mesh created and added to scene.");
        
        // 通知系统测量已保存
        this.eventEmitter.emit('measurementSaved', {
            ...annotation,
            area: this.currentMeasurement.area,
            triangles: this.currentMeasurement.triangles,
            totalArea: this.currentMeasurement.area,
            savedCount: 1
        });
        this.eventEmitter.emit('annotationAdded', annotation);
        
        // 调用第三方工具的保存方法
        if (this.planimetering) {
            this.planimetering.saveMeasurement();
        }
        
        // 清除当前测量引用
        this.currentMeasurement = null;
        
        // 通知用户测量已完成
        this.eventEmitter.emit('notification', {
            message: `面积测量已完成：${annotation.area.toFixed(2)} m²`,
            type: 'info'
        });
        
        // 重新开始测量状态以支持下一次操作
        setTimeout(() => {
            if (this.isActive && this.planimetering) {
                console.log("PlanimeteringTool: Restarting measurement for next selection...");
                this.planimetering.startMeasurement();
            }
        }, 100);
    }
    
    /**
     * 创建持久化的高亮网格，独立于工具生命周期
     * @param triangleIndices 三角形索引数组
     * @returns 持久化的高亮网格
     */
    private createPersistentHighlightMesh(triangleIndices: number[]): THREE.Mesh {
        if (!this.sceneController.targetModel) {
            throw new Error("No target model available for creating persistent highlight mesh");
        }
        
        // 查找目标网格
        let targetMesh: THREE.Mesh | null = null;
        this.sceneController.targetModel.traverse((child: THREE.Object3D) => {
            if (!targetMesh && (child as THREE.Mesh).isMesh && (child as THREE.Mesh).geometry) {
                targetMesh = child as THREE.Mesh;
            }
        });
        
        if (!targetMesh) {
            throw new Error("No valid mesh found for creating persistent highlight mesh");
        }
        
        console.log("PlanimeteringTool: Creating persistent highlight mesh for", triangleIndices.length, "triangles");
        
        // 创建新的几何体用于高亮显示
        const highlightGeometry = (targetMesh as THREE.Mesh).geometry.clone();
        
        // 创建新的索引缓冲区，只包含选中的三角形
        const originalIndex = (targetMesh as THREE.Mesh).geometry.index;
        if (!originalIndex) {
            throw new Error("Target mesh must have indexed geometry for highlight creation");
        }
        
        const newIndexArray = new Uint32Array(triangleIndices.length);
        for (let i = 0; i < triangleIndices.length; i++) {
            newIndexArray[i] = originalIndex.getX(triangleIndices[i]);
        }
        
        highlightGeometry.setIndex(new THREE.BufferAttribute(newIndexArray, 1));
        highlightGeometry.drawRange.count = triangleIndices.length;
        
        // 创建高亮材质
        const highlightMaterial = new THREE.MeshBasicMaterial({
            color: 0xff0000,
            opacity: 0.7,
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide
        });
        
        // 创建高亮网格（确保每个测量都有独立的网格和材质）
        const highlightMesh = new THREE.Mesh(highlightGeometry, highlightMaterial);
        highlightMesh.renderOrder = 1;
        
        // 添加唯一标识以避免混乱
        highlightMesh.userData = {
            measurementId: `measurement-${Date.now()}-${Math.random()}`,
            createdAt: Date.now(),
            triangleCount: triangleIndices.length
        };
        
        // 应用与目标模型相同的变换
        highlightMesh.position.copy(this.sceneController.targetModel.position);
        highlightMesh.rotation.copy(this.sceneController.targetModel.rotation);
        highlightMesh.scale.copy(this.sceneController.targetModel.scale);
        
        // 更新矩阵
        highlightMesh.updateMatrix();
        highlightMesh.updateMatrixWorld(true);
        
        console.log("PlanimeteringTool: Persistent highlight mesh created successfully");
        return highlightMesh;
    }

    /**
     * 调试高亮网格状态
     */
    private debugHighlightMesh(): void {
        if (!this.workGroup) {
            console.log("PlanimeteringTool: No work group found");
            return;
        }

        console.log("PlanimeteringTool: Work group children count:", this.workGroup.children.length);
        
        // 查找高亮网格
        const highlightMesh = this.workGroup.children.find((child: THREE.Object3D) => {
            const mesh = child as THREE.Mesh;
            if (!mesh.isMesh || !mesh.material) return false;
            
            const material = mesh.material as any;
            return material.color && material.color.getHex() === 0xff0000;
        });

        if (highlightMesh) {
            const mesh = highlightMesh as THREE.Mesh;
            console.log("PlanimeteringTool: Found highlight mesh:", mesh);
            console.log("PlanimeteringTool: Highlight mesh visible:", mesh.visible);
            console.log("PlanimeteringTool: Highlight mesh geometry drawRange:", mesh.geometry.drawRange);
            console.log("PlanimeteringTool: Highlight mesh material:", mesh.material);
            console.log("PlanimeteringTool: Highlight mesh renderOrder:", mesh.renderOrder);
            
            // 确保高亮网格可见
            if (!mesh.visible) {
                console.log("PlanimeteringTool: Making highlight mesh visible");
                mesh.visible = true;
            }
        } else {
            console.log("PlanimeteringTool: No highlight mesh found in work group");
            console.log("PlanimeteringTool: Work group children:", this.workGroup.children.map((child: THREE.Object3D) => child.type));
        }
    }

    /**
     * 完全清理所有保存的测量数据（包括删除持久化高亮网格）
     * 这个方法通常在用户明确要求清除所有测量时调用
     */
    public clearAllSavedMeasurements(): void {
        // 简化：不再维护内部列表
        console.log("PlanimeteringTool: Clear all saved measurements - no internal list to clear");
    }

    /**
     * 获取当前保存的测量数据统计信息
     */
    public getSavedMeasurementsInfo(): { count: number; totalArea: number; measurements: Array<{ area: number; triangles: number[] }> } {
        // 简化：返回空信息
        return {
            count: 0,
            totalArea: 0,
            measurements: []
        };
    }

    /**
     * 启动渲染循环，用于更新 Planimetering 工具的可视化效果
     */
    private startRenderLoop(): void {
        if (this.animationFrameId !== null) {
            return; // 已经在运行
        }

        const renderLoop = () => {
            if (this.isActive && this.planimetering) {
                this.planimetering.update();
            }
            
            if (this.isActive) {
                this.animationFrameId = requestAnimationFrame(renderLoop);
            } else {
                this.animationFrameId = null;
            }
        };

        this.animationFrameId = requestAnimationFrame(renderLoop);
    }

    /**
     * 停止渲染循环
     */
    private stopRenderLoop(): void {
        if (this.animationFrameId !== null) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
    }

    /**
     * 创建面积标签，样式与直线测距一致
     * @param area 面积值
     * @param position 标签位置
     * @returns CSS2DObject 标签对象
     */
    private _createAreaLabel(area: number, position: THREE.Vector3): CSS2DObject {
        const labelDiv = document.createElement('div');
        labelDiv.className = 'measurement-label straight-label'; // 使用与直线测距一致的样式
        labelDiv.textContent = `${area.toFixed(2)} m²`;

        const labelObject = new CSS2DObject(labelDiv);
        labelObject.position.copy(position);
        labelObject.layers.set(0);

        return labelObject;
    }

    dispose(): void {
        console.log("PlanimeteringTool: Disposing...");
        
        // 确保恢复相机控制
        this.sceneController.orbitControls.enabled = true;
        
        // 停止渲染循环
        this.stopRenderLoop();
        
        if (this.planimetering) {
            this.planimetering.dispose();
            this.planimetering = null;
        }
        
        // 清理工作组（只清理临时的工作组，不影响已保存的高亮网格）
        if (this.workGroup && this.workGroup.parent) {
            this.workGroup.parent.remove(this.workGroup);
            this.workGroup = null;
        }
        
        // 注意：不清理已保存的测量数据，因为它们的高亮网格已经被AnnotationManager管理
        // 只清理工具状态相关的数据
        this.currentMeasurement = null;
        this.shouldExitOnNextEsc = false;
        
        console.log("PlanimeteringTool: Disposed. All measurements are managed by AnnotationManager.");
        console.log("PlanimeteringTool: Saved measurements remain visible.");
        
        this.isActive = false;
        this.isInitialized = false;
        
        super.dispose();
    }
} 