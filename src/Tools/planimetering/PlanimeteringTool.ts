import { BaseTool, ITool } from '../../components/Base-tools/BaseTool';
import { ToolMode, InteractionEvent, ISceneController, IAnnotationManager, IEventEmitter, PlanimeteringAnnotation, IContextProvider, IPlanimetering } from '../../types/webgl-marking';
import { Planimetering } from '../../third-party/selection/Planimetering';

//@ts-ignore
import * as THREE from 'three';
//@ts-ignore
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

import { EnhancedIntelligentHighlightSystem } from '../../utils/BasedHighlight/integrated_highlight_system'

/**
 * Planimetering 工具 - 用于测量选定区域的面积
 * 这是一个适配器类，将 Planimetering 函数式工具适配为符合 ITool 接口的类
 */
export class PlanimeteringTool extends BaseTool implements ITool {
    private planimetering!: IPlanimetering | null;
    private isActive: boolean = false;
    private isInitialized: boolean = false;
    private animationFrameId: number | null = null;
    private workGroup: THREE.Group | null = null;
    private currentMeasurement: { triangles: number[]; area: number } | null = null;
    // 用于处理连续ESC按键的标志
    private shouldExitOnNextEsc: boolean = false;
    // 新增：跟踪第一次点击位置
    private firstClickPosition: THREE.Vector3 | null = null;
    //新增：跟踪延迟重启调用的id
    private restartTimeoutId: number | null = null;

    //添加几何体缓存
    private geometryCache: {
        originalGeometry?: THREE.BufferGeometry;
        indexedGeometry?: THREE.BufferGeometry;
        isProcessed?: boolean;
    } = {};

    private highlightSystem: EnhancedIntelligentHighlightSystem | null = null;

    private contextProvider: IContextProvider;

    constructor(sceneController: ISceneController, annotationManager: IAnnotationManager, eventEmitter: IEventEmitter, contextProvider: IContextProvider) {
        super(sceneController, annotationManager, eventEmitter);
        this.contextProvider = contextProvider
    }

    // 监听标注被删除的事件，以维护内部状态的一致性
    private handleAnnotationRemoved = (data: { id: string }) => {
        console.log("PlanimeteringTool: Received annotation removal notification for:", data.id);
    };

    getMode(): ToolMode {
        return ToolMode.Planimetering;
    }

    activate(): void {
        console.log("PlanimeteringTool: activate() 被调用");

        //修正
        const activeModel = this.sceneController.activeModelForRaycasting;
        if (!activeModel) {
            console.error('PlanimeteringTool: Cannot activate, no active model for raycasting found.');
            this.eventEmitter.emit('error', { message: '面积测量工具无法激活,未找到可测量的模型' })
            //切换回空闲模式
            this.eventEmitter.emit('toolModeChangeRequested', { mode: ToolMode.Idle })
            return;
        }

        if (this.isActive) {
            return;
        }

        this.isActive = true;

        // 监听标注删除事件
        this.eventEmitter.on('annotationRemoved', this.handleAnnotationRemoved);

        if (!this.isInitialized) {
            this.initializePlanimetering();
        }

        //预处理几何体和预创建高亮网格池
        this.preProcessGeometry();

        //初始化高亮优化器
        this.initializeHighlightOptimizer();

        // 启用实时高亮反馈
        if (this.planimetering) {
            this.enableOptimizedRealTimeHighlight();
        }

        // 暂停相机控制以避免冲突
        this.sceneController.orbitControls.mouseButtons.RIGHT = null;

        // 启动渲染循环
        this.startOptimizedRenderLoop();//使用优化后的渲染循环

        console.log("PlanimeteringTool: Activated successfully.");
        this.eventEmitter.emit('modeChanged', { mode: this.getMode(), enabled: true });

    }

    deactivate(): void {
        console.log("PlanimeteringTool deactivated.");
        this.isActive = false;

        // 清除任何待执行的重启调用
        if (this.restartTimeoutId !== null) {
            clearTimeout(this.restartTimeoutId);
            this.restartTimeoutId = null;
            console.log("PlanimeteringTool: 已清除待执行的重启调用");
        }

        // 停止渲染循环
        this.stopRenderLoop();
        console.log("PlanimeteringTool: 渲染循环已停止");

        // 完全停用套索工具
        if (this.planimetering) {
            console.log("PlanimeteringTool: 开始停用套索工具...");
            // 使用 exitMeasurement 来完全停用套索工具的事件监听
            if (typeof this.planimetering.exitMeasurement === 'function') {
                console.log("PlanimeteringTool: 调用 exitMeasurement...");
                this.planimetering.exitMeasurement();
                console.log("PlanimeteringTool: 套索工具事件监听已完全移除");
            } else {
                console.log("PlanimeteringTool: exitMeasurement 不可用，使用 cancelMeasurement...");
                this.planimetering.cancelMeasurement();
                console.log("PlanimeteringTool: 使用备用方案取消测量");
            }
            if (typeof this.planimetering.dispose === 'function') {
                this.planimetering.dispose();
            }

            this.planimetering = null;

        } else {
            console.log("PlanimeteringTool: planimetering 对象不存在");
        }

        //清理workGroup
        if (this.workGroup && this.workGroup.parent) {
            this.workGroup.parent.remove(this.workGroup);
            this.workGroup = null;
            console.log("PlanimeteringTool: Work group removed from scene");
        }

        // 恢复相机控制
        this.sceneController.orbitControls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
        this.sceneController.orbitControls.enabled = true;
        console.log("PlanimeteringTool: 相机控制已恢复");

        // 清除临时测量数据
        this.currentMeasurement = null;
        this.shouldExitOnNextEsc = false;

        //初始化重置状态，强制下次激活时重新初始化
        this.isInitialized = false;

        // 通知 UI 工具模式已停用
        this.eventEmitter.emit('modeChanged', { mode: this.getMode(), enabled: false });
    }

    private initializePlanimetering(): void {
        console.log("PlanimeteringTool: initializePlanimetering() 被调用");
        console.log("PlanimeteringTool: 当前 planimetering 实例:", !!this.planimetering);


        try {

            const activeModel = this.sceneController.activeModelForRaycasting;
            if (!activeModel) {
                throw new Error('no active model available for planimetering');
            }

            const targetMesh = this.findFirstMeshInModel(activeModel);
            // 检查是否有有效的目标模型
            if (!targetMesh) {
                throw new Error("No vaild mesh object found in active model for planimetering");
            }
            // 创建一个专门的工作组，确保网格在正确的位置
            this.workGroup = new THREE.Group();

            // 创建新的网格对象，避免克隆时的循环引用问题
            const meshClone = new THREE.Mesh();
            meshClone.geometry = targetMesh.geometry; // 共享几何体，避免重复数据
            meshClone.material = targetMesh.material; // 共享材质

            // 拷贝变换信息
            meshClone.position.copy(targetMesh.position);
            meshClone.rotation.copy(targetMesh.rotation);
            meshClone.scale.copy(targetMesh.scale);

            // 确保工作组有5个子对象，第4个是我们的网格
            for (let i = 0; i < 4; i++) {
                this.workGroup.add(new THREE.Group());
            }
            this.workGroup.add(meshClone);

            // 确保工作组的变换与目标模型同步
            this.workGroup.position.copy(activeModel.position);
            this.workGroup.rotation.copy(activeModel.rotation);
            this.workGroup.scale.copy(activeModel.scale);

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
            this.planimetering.registerLassoFinishedCall((data: { triangles: number[]; area: number | null; lassoPath?: number[]; isCalculating?: boolean }) => {
                console.log("Planimetering measurement callback:", data);

                // 如果是第一次回调（高亮显示）
                if (data.isCalculating) {
                    console.log("PlanimeteringTool: 高亮显示已就绪，面积计算中...");

                    // 立即更新高亮显示
                    if (this.highlightSystem) {
                        if (data.lassoPath && data.lassoPath.length > 6) {
                            // 使用性能最高的路径
                            this.highlightSystem.updateHighlightWithLassoPath(data.lassoPath);
                        } else {
                            this.highlightSystem.updateHighlight(data.triangles);
                        }
                    }

                    // 检查高亮网格状态
                    this.debugHighlightMesh();

                    // 通知系统高亮显示已完成，但面积计算正在进行
                    this.eventEmitter.emit('notification', {
                        message: '高亮显示已完成，正在计算面积...',
                        type: 'info'
                    });

                    return; // 第一次回调结束，等待第二次回调
                }

                // 第二次回调（计算结果）
                if (data.area !== null) {
                    console.log("PlanimeteringTool: 面积计算完成:", data.area);

                    // 存储当前测量数据
                    this.currentMeasurement = { triangles: data.triangles, area: data.area };

                    // 通知系统测量完成，但不创建annotation（等待用户保存）
                    this.eventEmitter.emit('measurementCompleted', {
                        area: data.area,
                        triangles: data.triangles,
                        lassoPath: data.lassoPath,
                        isTempMeasurement: true // 标记为临时测量
                    });

                    // 不自动调用saveMeasurement，等待用户主动按Enter键保存
                    console.log("PlanimeteringTool: Measurement completed. Press Enter to save or ESC to cancel.");
                    console.log("PlanimeteringTool: Current measurement - Area:", data.area, "Triangles:", data.triangles.length);
                    if (data.lassoPath) {
                        console.log("PlanimeteringTool: Lasso path points:", Math.floor(data.lassoPath.length / 3));
                    }
                }
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

        if (this.restartTimeoutId !== null) {
            clearTimeout(this.restartTimeoutId);
            this.restartTimeoutId = null;
        }

        //重新启动下一次测量
        // this.restartTimeoutId = window.setTimeout(() => {
        //     if (this.isActive && this.planimetering) {
        //         this.planimetering.startMeasurement();
        //     }
        //     this.restartTimeoutId = null;
        // }, 100)
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

        const rawArea = this.currentMeasurement.area;
        let correctedArea = rawArea;

        if (this.workGroup && this.workGroup.scale) {
            const scale = this.workGroup.scale;
            console.log('scale', scale.x, scale.y);

            correctedArea = rawArea * scale.x * scale.y;
            console.log(`PlanimeteringTool: Area corrected. Raw: ${rawArea}, Corrected: ${correctedArea}, Scale: {x: ${scale.x}, y: ${scale.y}}`);
        } else {
            console.warn("PlanimeteringTool: Could not find measured mesh or its scale for area correction. Using raw area.");
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
        const areaLabel = this._createAreaLabel(correctedArea, highlightCenter);
        console.log("PlanimeteringTool: Area label created for measurement:", this.currentMeasurement.area);

        // 获取当前的contextId
        const contextId = this.contextProvider.getCurrentContextPartId() || 'human_model'
        // 创建标注对象
        const annotationData: Omit<PlanimeteringAnnotation, 'id' | 'type' | 'contextId'> = {
            area: correctedArea,
            triangles: this.currentMeasurement.triangles,
            timestamp: new Date().toISOString(),
            highlightMesh: persistentHighlightMesh,
            areaLabelObject: areaLabel,
            totalArea: correctedArea // 单个测量，总面积就是当前面积
        };

        const annotation = this.annotationManager.addPlanimetering(annotationData, contextId);

        console.log("PlanimeteringTool: Measurement saved successfully.");
        console.log("PlanimeteringTool: Area:", this.currentMeasurement.area);
        console.log("PlanimeteringTool: Persistent highlight mesh created and added to scene.");

        this.eventEmitter.emit('measurementCompleted', annotation);

        // 通知系统测量已保存
        this.eventEmitter.emit('measurementSaved', {
            ...annotation,
            area: correctedArea,
            triangles: this.currentMeasurement.triangles,
            totalArea: correctedArea,
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
        const areaInCm2 = correctedArea * 10000;
        this.eventEmitter.emit('notification', {
            message: `面积测量已完成：${areaInCm2.toFixed(2)} cm²`,
            type: 'info'
        });

        if (this.restartTimeoutId !== null) {
            clearTimeout(this.restartTimeoutId);
            this.restartTimeoutId = null;
        }

        // 重新开始测量状态以支持下一次操作
        this.restartTimeoutId = window.setTimeout(() => {
            if (this.isActive && this.planimetering) {
                console.log("PlanimeteringTool: Restarting measurement for next selection...");
                this.planimetering.startMeasurement();
            }
            this.restartTimeoutId = null;
        }, 100);
    }

    /**
     * 创建持久化高亮网格（使用高级管理器或基础方法）
     */
    private createPersistentHighlightMesh(triangleIndices: number[]): THREE.Mesh {
        console.log("PlanimeteringTool: 创建持久高亮网格，三角形数量:", triangleIndices.length);

        // 直接使用基础方法创建持久化网格（简化逻辑）
        console.log("PlanimeteringTool: 使用基础方法创建持久高亮网格");
        return this.createFallbackPersistentMesh(triangleIndices);
    }

    /**
    * 降级方法：传统的持久化网格创建
    */
    private createFallbackPersistentMesh(triangleIndices: number[]): THREE.Mesh {

        const activeModel = this.sceneController.activeModelForRaycasting;
        if (!activeModel || !this.geometryCache.indexedGeometry) {
            throw new Error("无法创建持久化高亮网格：缺少必要的几何体数据");
        }

        // 查找目标网格
        let targetMesh: THREE.Mesh | null = null;
        activeModel.traverse((child: THREE.Object3D) => {
            if (!targetMesh && (child as THREE.Mesh).isMesh && (child as THREE.Mesh).geometry) {
                targetMesh = child as THREE.Mesh;
            }
        });

        if (!targetMesh) {
            throw new Error("未找到有效的目标网格");
        }

        // 创建传统的高亮网格
        const highlightGeometry = this.geometryCache.indexedGeometry.clone();
        const originalIndex = this.geometryCache.indexedGeometry.index!;

        const newIndexArray = new Uint32Array(triangleIndices.length);
        const originalArray = originalIndex.array as Uint32Array;

        for (let i = 0; i < triangleIndices.length; i++) {
            newIndexArray[i] = originalArray[triangleIndices[i]];
        }

        highlightGeometry.setIndex(new THREE.BufferAttribute(newIndexArray, 1));
        highlightGeometry.drawRange.count = triangleIndices.length;

        const highlightMaterial = new THREE.MeshBasicMaterial({
            color: 0xff0000,
            opacity: 0.7,
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide
        });

        const highlightMesh = new THREE.Mesh(highlightGeometry, highlightMaterial);
        highlightMesh.renderOrder = 1;

        // 应用变换
        highlightMesh.position.copy(activeModel.position);
        highlightMesh.rotation.copy(activeModel.rotation);
        highlightMesh.scale.copy(activeModel.scale);
        highlightMesh.updateMatrix();
        highlightMesh.updateMatrixWorld(true);

        highlightMesh.userData = {
            measurementId: `measurement-${Date.now()}-${Math.random()}`,
            createdAt: Date.now(),
            triangleCount: triangleIndices.length,
            fallback: true
        };

        return highlightMesh;
    }

    /**
    * 初始化高亮系统（仅使用新的高级管理器）
    */
    private initializeHighlightOptimizer(): void {
        const activeModel = this.sceneController.activeModelForRaycasting;
        if (!activeModel || !this.geometryCache.indexedGeometry) {
            console.warn('PlanimeteringTool: 无法初始化高亮系统，缺少必要组件');
            return;
        }

        try {
            // 初始化二级混合高亮系统（替代AdvancedHighlightManager）
            this.highlightSystem = new EnhancedIntelligentHighlightSystem(
                this.sceneController.renderer,
                this.sceneController.scene,
                this.sceneController.camera
            );

            let targetMesh: THREE.Mesh | null = null;

            activeModel.traverse((child: THREE.Object3D) => {
                if (!targetMesh && (child as THREE.Mesh).isMesh && (child as THREE.Mesh).geometry) {
                    targetMesh = child as THREE.Mesh;
                }
            });

            if (targetMesh) {
                this.highlightSystem.setTargetMesh(targetMesh);
                console.log('PlanimeteringTool: 高亮系统初始化完成');

            }


        } catch (error) {
            console.error('PlanimeteringTool: 高亮系统初始化失败:', error);
            this.highlightSystem = null;
        }
    }


    /**
     * 启用优化的实时高亮反馈
     */
    // 新方案: 直接调用新的 highlightSystem
    private enableOptimizedRealTimeHighlight(): void {
        if (!this.planimetering) return;

        if (typeof this.planimetering.registerRealTimeSelectionCallback === 'function') {
            this.planimetering.registerRealTimeSelectionCallback(
                (triangles: number[]) => {
                    this.highlightSystem?.updateHighlight(triangles);
                }
            );
            console.log("PlanimeteringTool: 优化的实时高亮反馈已启用（智能系统）");
        } else {
            console.log("PlanimeteringTool: 第三方工具不支持实时高亮回调，使用传统模式");
        }
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
            if (!(child as THREE.Mesh).isMesh) {
                return false;
            }

            const mesh = child as THREE.Mesh;
            const material = mesh.material;

            if (Array.isArray(material)) {
                return false;
            }

            if (material && 'color' in material && (material as any).color instanceof THREE.Color) {
                const materialColor = (material as { color: THREE.Color }).color;
                return materialColor.getHex() === 0xff0000;
            }

            return false;
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
    * 优化的渲染循环，降低更新频率
    */
    // 1. 替换原有的优化渲染循环函数
    private startOptimizedRenderLoop(): void {
        if (this.animationFrameId !== null) {
            return;
        }

        let lastUpdateTime = 0;
        let adaptiveInterval = 16; // 初始60FPS，提供更高响应性
        let consecutiveFrames = 0;
        let frameTimeHistory: number[] = [];

        const adaptiveRenderLoop = (currentTime: number) => {
            const deltaTime = currentTime - lastUpdateTime;

            if (deltaTime >= adaptiveInterval) {
                if (this.isActive && this.planimetering) {
                    const startTime = performance.now();
                    this.planimetering.update();
                    const updateTime = performance.now() - startTime;

                    // 记录帧时间历史
                    frameTimeHistory.push(updateTime);
                    if (frameTimeHistory.length > 10) {
                        frameTimeHistory.shift();
                    }

                    // 动态调整更新间隔
                    const avgFrameTime = frameTimeHistory.reduce((a, b) => a + b, 0) / frameTimeHistory.length;

                    if (avgFrameTime > 12) {
                        // 如果平均处理时间超过12ms，降低频率
                        adaptiveInterval = Math.min(16, adaptiveInterval + 2);
                    } else if (consecutiveFrames > 20 && avgFrameTime < 6 && adaptiveInterval > 4) {
                        // 如果连续多帧处理时间很短，提高频率
                        adaptiveInterval = Math.max(4, adaptiveInterval - 1);
                    }

                    consecutiveFrames++;

                    const activeModel = this.sceneController.activeModelForRaycasting;
                    // 定期检查原始模型可见性（每60帧检查一次）
                    if (consecutiveFrames % 60 === 0 && activeModel && !activeModel.visible) {
                        console.log("PlanimeteringTool: Detected hidden target model, restoring visibility");
                        activeModel.visible = true;
                        activeModel.traverse((child: THREE.Object3D) => {
                            if ((child as THREE.Mesh).isMesh) {
                                child.visible = true;
                            }
                        });
                    }

                }
                lastUpdateTime = currentTime;
            }

            if (this.isActive) {
                this.animationFrameId = requestAnimationFrame(adaptiveRenderLoop);
            } else {
                this.animationFrameId = null;
            }
        };

        this.animationFrameId = requestAnimationFrame(adaptiveRenderLoop);
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

        const areaInCm2 = area * 10000;
        labelDiv.textContent = `${areaInCm2.toFixed(2)} cm²`;

        const labelObject = new CSS2DObject(labelDiv);
        labelObject.position.copy(position);
        labelObject.layers.set(0);

        return labelObject;
    }

    /* 预处理几何体，避免运行时处理延迟 */
    private preProcessGeometry(): void {

        const activeModel = this.sceneController.activeModelForRaycasting

        if (!activeModel) return;

        const targetMesh = this.findFirstMeshInModel(activeModel)

        if (!targetMesh) return;

        console.log('PlanimeteringTool:预处理几何体');

        //缓存原始几何体
        this.geometryCache.originalGeometry = targetMesh.geometry;

        //预处理索引几何体
        if (!targetMesh.geometry.index) {
            console.log('PlanimeteringTool:为非索引几何体创建索引');
            const positionCount = targetMesh.geometry.attributes.position.count;
            const indices = new Uint32Array(positionCount);
            for (let i = 0; i < positionCount; i++) {
                indices[i] = i;
            }

            //创建预处理的几何副本
            this.geometryCache.indexedGeometry = targetMesh.geometry.clone();
            this.geometryCache.indexedGeometry.setIndex(new THREE.BufferAttribute(indices, 1));
        } else {
            this.geometryCache.indexedGeometry = targetMesh.geometry;
        }

        //确保有颜色属性
        if (!this.geometryCache.indexedGeometry.attributes.color) {
            const vertexCount = this.geometryCache.indexedGeometry.attributes.position.count;
            const color = new Uint8Array(vertexCount * 3).fill(255);
            this.geometryCache.indexedGeometry.setAttribute('color',
                new THREE.BufferAttribute(color, 3, true)
            );
        }

        //预计算边界信息
        this.geometryCache.indexedGeometry.computeBoundingBox();
        this.geometryCache.indexedGeometry.computeBoundingSphere();

        this.geometryCache.isProcessed = true;
        console.log('PlanimeteringTool:几何体预处理完成');


    }

    private findFirstMeshInModel(model: THREE.Object3D): THREE.Mesh | null {
        let foundMesh: THREE.Mesh | null = null;
        model.traverse((child: THREE.Object3D) => {
            if (foundMesh) { // Optimization: stop searching once found
                return;
            }
            if ((child as THREE.Mesh).isMesh && (child as THREE.Mesh).geometry) {
                foundMesh = child as THREE.Mesh;
            }
        });
        return foundMesh;
    }


    dispose(): void {
        console.log("PlanimeteringTool: Disposing...");

        // 清除任何待执行的重启调用
        if (this.restartTimeoutId !== null) {
            clearTimeout(this.restartTimeoutId);
            this.restartTimeoutId = null;
            console.log("PlanimeteringTool: 已清除待执行的重启调用");
        }

        // 停止优化的渲染循环
        this.stopRenderLoop();

        // 清理几何体缓存
        if (this.geometryCache.indexedGeometry && this.geometryCache.indexedGeometry !== this.geometryCache.originalGeometry) {
            this.geometryCache.indexedGeometry.dispose();
        }
        this.geometryCache = {};

        // 恢复相机控制
        this.sceneController.orbitControls.enabled = true;
        this.sceneController.orbitControls.mouseButtons.RIGHT = THREE.MOUSE.PAN;

        if (this.planimetering) {
            this.planimetering.dispose();
            this.planimetering = null;
        }

        if (this.workGroup && this.workGroup.parent) {
            this.workGroup.parent.remove(this.workGroup);
            this.workGroup = null;
        }

        this.currentMeasurement = null;
        this.shouldExitOnNextEsc = false;
        this.firstClickPosition = null;
        this.isActive = false;
        this.isInitialized = false;

        super.dispose();
    }
} 