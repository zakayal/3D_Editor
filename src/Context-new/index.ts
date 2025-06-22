//@ts-ignore
import * as THREE from 'three';
import { SceneController } from '../components/Scene-management/SceneController';
import { InteractionManager } from '../Utils/Interaction-management/InteractionManager';
import { AnnotationManager } from '../components/Annotation-management/AnnotationManager';
import { DijkstraService } from '../Utils/Dijkstra/DijkstraService';
import { IdleTool } from '../Tools/idle/IdleTool';
import { ScaleBarTool } from '../Tools/scale-bar-marking/ScaleBarTool';
import { SurfaceMeasurementTool } from '../Tools/surface-measurement/SurfaceMeasurementTool';
import { StraightMeasurementTool } from '../Tools/straight-measurement/StraightMeasurementTool';
import { HighlightTool } from '../Tools/highLight/HighLightTool';
import { PlanimeteringTool } from '../Tools/planimetering/PlanimeteringTool';
import { EventEmitter } from '../Utils/EventEmitter/EventEmitter';

import {
    WebGLMarkingAPIConfig,
    ToolMode,
    Annotation,
    CanvasConfig,
    ISceneController,
    IAnnotationManager,
    IDijkstraService,
    IInteractionManager,
    IEventEmitter,
    ApiListeners,
    EventCallback,
    InjuryContext,
} from '../types/webgl-marking';


/**
 * WebGLMarkingAPI Facade
 * 提供了与 3D 标注和测量系统交互的高级接口。
 * 它协调 SceneController, InteractionManager, AnnotationManager, DijkstraService 和各种 Tools。
 */
export class WebGLMarkingAPI implements IEventEmitter {
    public readonly sceneController: ISceneController;
    public readonly interactionManager: IInteractionManager;
    public readonly annotationManager: IAnnotationManager;
    public readonly dijkstraService: IDijkstraService;

    private canvas!: HTMLCanvasElement; // 使用断言操作符，这些属性会在构造函数中被初始化
    private container!: HTMLElement;
    private canvasConfig: CanvasConfig;
    private eventEmitter: IEventEmitter;
    private injuryContexts:Map<string, InjuryContext> = new Map();

    private apiReadyStatus: { core: boolean, dijkstra: boolean } = { core: false, dijkstra: false };

    //声明初始化ResizeObserver
    private _resizeObserver: ResizeObserver | null = null;

    constructor(canvasConfig: CanvasConfig, config: WebGLMarkingAPIConfig) {
        this.canvasConfig = canvasConfig;

        // 1. 创建事件发射器
        this.eventEmitter = new EventEmitter();

        // 2. 创建画布并添加到容器里
        this._createCanvas();

        // 3. 初始化核心模块，通过接口传递依赖
        this.sceneController = new SceneController(this.canvas, config.modelPath, config.scaleBarModelPath, config.mtlPath);
        this.annotationManager = new AnnotationManager(this.sceneController);
        this.dijkstraService = new DijkstraService(this.eventEmitter); // DijkstraService 的初始化放在 _onAssetsLoaded
        this.interactionManager = new InteractionManager(this.sceneController, this.eventEmitter);


        // 4. 初始化并注册工具
        this._registerTools();

        // 监听 DijkstraService 发出的 dijkstraReady 事件
        this.eventEmitter.on('dijkstraReady', (isReady: boolean) => { // 假设 dijkstraReady 事件传递 boolean
            this.apiReadyStatus.dijkstra = isReady;
            this._checkAndEmitApiReady();
            if (!isReady) {
                this.eventEmitter.emit('error', { message: "API initialization failed: DijkstraService could not be initialized after assets loaded." });
            }
        });

        // 5. 开始加载资源
        this.sceneController.loadAssets(
            () => this._onAssetsLoaded(),
            (error) => {
                this.eventEmitter.emit('error', { message: "Failed to load core assets.", details: error });
                this.apiReadyStatus.core = false;
                this.apiReadyStatus.dijkstra = false; // 核心资源加载失败，Dijkstra 也无法准备好
                this._checkAndEmitApiReady(); // 触发 ready: false
            }
        );
    }

    /*
   *创建画布元素并添加到制定容器
   */
    private _createCanvas(): void {
        //获取容器元素
        if (typeof this.canvasConfig.container === 'string') {
            const containerElement = document.querySelector(this.canvasConfig.container);
            if (!containerElement) {
                throw new Error(`Container element not found: ${this.canvasConfig.container}`);
            }
            this.container = containerElement as HTMLElement;
        } else {
            this.container = this.canvasConfig.container;
        }

        //创建画布元素
        this.canvas = document.createElement('canvas');
        this.canvas.tabIndex = 0;//使画布可聚焦

        //设置画布尺寸
        const width = this.canvasConfig.width || this.container.clientWidth || 800;
        const height = this.canvasConfig.height || this.container.clientHeight || 600;

        this.canvas.width = width;
        this.canvas.height = height;

        //应用样式
        if (this.canvasConfig.style) {
            Object.assign(this.canvas.style, this.canvasConfig.style);
        }

        //设置默认样式
        this.canvas.style.display = 'block'
        this.canvas.style.width = `${width}px`;
        this.canvas.style.height = `${height}px`;

        //应用html属性
        if (this.canvasConfig.attributes) {
            Object.entries(this.canvasConfig.attributes).forEach(([key, value]) => {
                if (value !== undefined) {
                    this.canvas.setAttribute(key, value);
                }
            })

        }

        //将画布添加到容器
        this.container.appendChild(this.canvas);

        //添加窗口大小变化监听器
        this._setResizeListener();
    }

    /* 设置窗口大小监视器 */
    private _setResizeListener(): void {
        const resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                if (entry.target === this.container) {
                    this._handleResize()
                    break;
                }

            }
        });

        // 将 ResizeObserver 实例存储在私有属性中，以便在 dispose 时断开连接
        this._resizeObserver = resizeObserver;
        resizeObserver.observe(this.container);
    }

    /* 处理容器大小变化 */
    private _handleResize(): void {
        if (!this.canvasConfig.width && !this.canvasConfig.height) {
            const newWidth = this.container.clientWidth;
            const newHeight = this.container.clientHeight;

            if (newWidth > 0 && newHeight > 0) {
                this.canvas.width = newWidth;
                this.canvas.height = newHeight;
                this.canvas.style.width = `${newWidth}px`;
                this.canvas.style.height = `${newHeight}px`;

                //通知SceneController更新视图
                if (this.sceneController) {
                    this.sceneController.updateRenderSize(newWidth, newHeight);
                }
            }
        }
    }

    /** 注册所有可用的工具 */
    private _registerTools(): void {
        // 将必要的依赖通过构造函数传递给工具
        const idleTool = new IdleTool(this.sceneController, this.annotationManager, this.eventEmitter);
        const scaleBarTool = new ScaleBarTool(this.sceneController, this.annotationManager, this.eventEmitter);
        const surfaceTool = new SurfaceMeasurementTool(this.sceneController, this.annotationManager, this.dijkstraService, this.eventEmitter);
        const straightTool = new StraightMeasurementTool(this.sceneController, this.annotationManager, this.eventEmitter);
        const hightLight = new HighlightTool(this.sceneController, this.annotationManager, this.eventEmitter);
        const planimeteringTool = new PlanimeteringTool(this.sceneController, this.annotationManager, this.eventEmitter);

        this.interactionManager.registerTool(idleTool);
        this.interactionManager.registerTool(scaleBarTool);
        this.interactionManager.registerTool(surfaceTool);
        this.interactionManager.registerTool(straightTool);
        this.interactionManager.registerTool(hightLight);
        this.interactionManager.registerTool(planimeteringTool);

        // 默认设置为 IdleTool
        this.interactionManager.setActiveTool(ToolMode.Idle);
    }

    /** 资源加载成功后的回调 */
    private _onAssetsLoaded(): void {
        console.log("Assets loaded, initializing DijkstraService...");

        this.apiReadyStatus.core = true; // 核心资源已加载

        // DijkstraService 的初始化现在是启动 Worker，它自己会在完成后通过事件通知
        const dijkstraInitializationStarted = this.dijkstraService.initialize(this.sceneController);
        if (!dijkstraInitializationStarted) {
            // 如果初始化启动失败 (例如，无法创建 Worker)
            this.apiReadyStatus.dijkstra = false;
            this._checkAndEmitApiReady();
            this.eventEmitter.emit('error', { message: "API initialization failed: DijkstraService could not start initialization." });
        }
    }

    private _checkAndEmitApiReady(): void {
        // 修正:
        const isFullyReady = this.apiReadyStatus.core && this.apiReadyStatus.dijkstra;
        this.eventEmitter.emit('ready', isFullyReady);
        if (isFullyReady) {
            console.log("API is fully ready (core assets and Dijkstra graph).");
        } else {
            console.log(`API readiness: Core=${this.apiReadyStatus.core}, Dijkstra=${this.apiReadyStatus.dijkstra}`);
        }
    }

    // --- 公共 API 方法 ---
    // 这些方法将直接委托给 InteractionManager 或 AnnotationManager

    /**
     * 设置当前的交互工具模式。
     * @param mode - 要激活的工具模式。
     */
    public setToolMode(mode: ToolMode): void {
        this.interactionManager.setActiveTool(mode);
    }

    /**
     * 获取当前激活的工具模式。
     * @returns 当前的 ToolMode。
     */
    public getCurrentToolMode(): ToolMode {
        return this.interactionManager.getActiveTool()?.getMode() ?? ToolMode.Idle;
    }


    /**
     * 移除指定 ID 的标注物。
     * @param id - 要移除的标注物的 ID。
     */
    public removeAnnotation(id: string): void {
        console.log('API 开始删除标注:', id);
        const removed = this.annotationManager.removeAnnotation(id);
        console.log('标注管理器删除结果:', removed);
        if (removed) {
            this.eventEmitter.emit('annotationRemoved', { id });
            console.log('已发送 annotationRemoved 事件');

        }
    }

    /**
     * 获取所有标注物的信息。
     * @returns 包含所有标注物对象的数组。
     */
    public getAllAnnotations(): Annotation[] {
        return this.annotationManager.getAllAnnotations();
    }

    /**
     * 允许外部（如 UI 层）访问场景以添加/移除 CSS2D 对象。
     * @returns Three.js 场景实例。
     */
    public getScene(): THREE.Scene {
        return this.sceneController.scene;
    }

    /**
     * 允许外部（如 UI 层）访问相机以进行坐标转换。
     * @returns Three.js 相机实例。
     */
    public getCamera(): THREE.PerspectiveCamera {
        return this.sceneController.camera;
    }

    /**
    * 清理当前场景并加载一个新的 OBJ 模型。
    * @param modelUrl - 新 OBJ 模型的 URL。这可以是一个服务器路径，
    * 也可以是通过 URL.createObjectURL() 创建的本地文件 URL。
    * @param mtlUrl - 可选的 MTL 材质文件 URL。
    */
    public async loadNewModel(modelUrl: string, mtlUrl?: string): Promise<void> {
        this.eventEmitter.emit('notification', { message: "开始加载新模型..." });
        this.apiReadyStatus = { core: false, dijkstra: false }; // 重置就绪状态
        this.eventEmitter.emit('ready', false);

        try {
            // 1. 清理标注
            this.annotationManager.removeAllAnnotations();

            // 2. 切换回 Idle 模式
            this.setToolMode(ToolMode.Idle);

            // 3. 重置所有工具的预览状态
            this.interactionManager.resetAllToolPreviews();

            // 在 SceneController 加载新模型之前，先处理 DijkstraService
            if (this.dijkstraService && typeof (this.dijkstraService as DijkstraService).dispose === 'function') {
                (this.dijkstraService as DijkstraService).dispose(); // 确保 Worker 被终止
            }


            // 5. 加载新模型 (通过 SceneController)，现在支持MTL材质
            await this.sceneController.loadNewTargetModel(modelUrl, mtlUrl);
            this.apiReadyStatus.core = true;

            // 6. 重新初始化 Dijkstra 服务
            console.log("Re-initializing DijkstraService...");
            const dijkstraReInitStarted = this.dijkstraService.initialize(this.sceneController);
            if (!dijkstraReInitStarted) {
                this.apiReadyStatus.dijkstra = false;
                this._checkAndEmitApiReady();
                this.eventEmitter.emit('error', { message: "New model loaded, but DijkstraService re-initialization failed to start." });
            }

            this.eventEmitter.emit('notification', { message: "新模型加载完成,路径服务初始化中..." });
            // this.eventEmitter.emit('ready', true);

        } catch (error) {
            console.error("Failed to load new model:", error);
            this.eventEmitter.emit('error', { message: "加载新模型失败。", details: error });
            this.apiReadyStatus = { core: false, dijkstra: false };
            this.eventEmitter.emit('ready', false);

        }
    }

    /**
    * 清理当前场景并加载一个新的 GLB/glTF 模型。
    * @param modelUrl - 新 GLB/glTF 模型的 URL。
    */
    public async loadNewGLBModel(modelUrl: string): Promise<void> {
        console.log("Attempting to load new GLB model...");

        this.eventEmitter.emit('notification', { message: "开始加载新 GLB 模型..." });
        this.apiReadyStatus = { core: false, dijkstra: false }; // 重置就绪状态
        this.eventEmitter.emit('ready', false);

        try {
            // 1. 清理标注
            this.annotationManager.removeAllAnnotations();

            // 2. 切换回 Idle 模式
            this.setToolMode(ToolMode.Idle);

            // 3. 重置所有工具的预览状态
            this.interactionManager.resetAllToolPreviews();

            if (this.dijkstraService && typeof (this.dijkstraService as DijkstraService).dispose === 'function') {
                (this.dijkstraService as DijkstraService).dispose();
            }

            // 5. 加载新 GLB 模型 (通过 SceneController)
            await this.sceneController.loadNewGLBTargetModel(modelUrl); // 调用 SceneController 中的新方法

            // 6. 重新初始化 Dijkstra 服务
            console.log("Re-initializing DijkstraService for new GLB model...");
            const dijkstraReInitStarted = this.dijkstraService.initialize(this.sceneController);
            if (!dijkstraReInitStarted) {
                this.apiReadyStatus.dijkstra = false;
                this._checkAndEmitApiReady();
                this.eventEmitter.emit('error', { message: "New GLB model loaded, but DijkstraService re-initialization failed to start." });
            }

            this.eventEmitter.emit('notification', { message: "新 GLB 模型加载完成,路径服务初始化中..." });

        } catch (error) {
            console.error("Failed to load new GLB model:", error);
            this.apiReadyStatus = { core: false, dijkstra: false };
            this.eventEmitter.emit('error', { message: "加载新 GLB 模型失败。", details: error });
            this.eventEmitter.emit('ready', false);
        }
    }

    /**
     * 为指定部位创建一个新的鉴伤上下文（模拟“添加”按钮功能）
     * @param partData - 从 partSelected 事件获取的部位信息
     */
    public addInjuryContext(partData: {partId:string, name: string}):InjuryContext | null {
        //检查是否已经存在，放置重复创建
        if(this.injuryContexts.has(partData.partId))
        {
            console.warn(`WebGLMarkingAPI 部位 "${partData.name}" 的鉴伤上下文已经存在`);
            return this.injuryContexts.get(partData.partId) || null;
        }
        //创建新的上下文对象
        const newContext:InjuryContext = {
            id: partData.partId,
            name:partData.name,
            creationTime:new Date(),
            measurements:{
                cumulativeArea:0,
                cumulativeCurveLength:0,
                cumulativeStraightLength:0,
                bsaPercentage:0,
            }
        }

        //存入map中进行管理
        this.injuryContexts.set(newContext.id,newContext);

        console.log(`WebGLMarkingAPI 新的鉴伤上下文已创建`, newContext);

        //发出事件，通知外部上下文已创建
        this.eventEmitter.emit('injuryContextAdded',{context:newContext});

        return newContext;
        
    }

    /* 提供一个获取所有上下文的方法，便于调试 */
    public getAllInjuryContexts():Map<string,InjuryContext>
    {
        return this.injuryContexts;
    }
    // --- 事件系统 ---
    // 直接委托给 EventEmitter 实例

    /**
     * 注册事件监听器。
     * @param eventName - 事件名称。
     * @param callback - 回调函数。
     * @returns 一个用于取消监听的函数。
     */
    public on<T extends keyof ApiListeners>(eventName: T, callback: EventCallback<ApiListeners[T]>): () => void {
        return this.eventEmitter.on(eventName, callback);
    }

    /**
     * 注销事件监听器。
     * @param eventName - 事件名称。
     * @param callback - 要注销的回调函数。
     */
    public off<T extends keyof ApiListeners>(eventName: T, callback: EventCallback<ApiListeners[T]>): void {
        this.eventEmitter.off(eventName, callback);
    }

    /**
     * 触发一个事件。
     * (这个方法是公开的，以便工具和管理器可以触发事件)
     * @param eventName - 事件名称。
     * @param data - 传递给回调函数的数据。
     */
    public emit<T extends keyof ApiListeners>(eventName: T, data: ApiListeners[T]): void {
        this.eventEmitter.emit(eventName, data);
    }

    /**
     * 释放所有资源。
     */
    public dispose(): void {
        console.log("Disposing WebGLMarkingAPI...");

        //清理ResizeObserver
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }

        //清理核心模块
        this.interactionManager.dispose();
        this.annotationManager.dispose();
        this.sceneController.dispose();

        if (this.dijkstraService && typeof (this.dijkstraService as DijkstraService).dispose === 'function') {
            (this.dijkstraService as DijkstraService).dispose();
        }

        //移出画布元素
        if (this.canvas && this.canvas.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
        }

        console.log("WebGLMarkingAPI disposed.");
    }
}