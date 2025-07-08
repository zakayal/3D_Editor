//@ts-ignore
import * as THREE from 'three';
//核心依赖
import { SceneController } from '../core/SceneController';
import { InteractionManager } from '../core/InteractionManager';
import { AnnotationManager } from '../core/AnnotationManager';
import { DijkstraService } from '../core/DijkstraService';

import { EventEmitter } from '../utils/EventEmitter';

import { IdleTool } from '../features/selection/tools/IdleTool';
import { ScaleBarTool } from '../features/measurement/tools/ScaleBarTool';
import { SurfaceMeasurementTool } from '../features/measurement/tools/SurfaceMeasurementTool';
import { StraightMeasurementTool } from '../features/measurement/tools/StraightMeasurementTool';
import { HighlightTool } from '../features/highlighting/tools/HighLightTool';
import { PlanimeteringTool } from '../features/measurement/tools/PlanimeteringTool';
import { PhotoTool } from '../capture/tools/PhotoTools';
import { TransformTool } from '../transform/tools/TransformTool';

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
    IContextProvider,
    ApiListeners,
    EventCallback,
    InjuryContext,
    PlanimeteringAnnotation,
    StraightMeasurementAnnotation,
    SurfaceMeasurementAnnotation,
} from '../types/webgl-marking';


/**
 * WebGLMarkingAPI Facade
 * 提供了与 3D 标注和测量系统交互的高级接口。
 * 它协调 SceneController, InteractionManager, AnnotationManager, DijkstraService 和各种 Tools。
 */
export class WebGLMarkingAPI implements IEventEmitter, IContextProvider {
    //核心模块引用
    public readonly sceneController: ISceneController;
    public readonly interactionManager: IInteractionManager;
    public readonly annotationManager: IAnnotationManager;
    public readonly dijkstraService: IDijkstraService;

    //私有状态属性
    private canvas!: HTMLCanvasElement; // 使用断言操作符，这些属性会在构造函数中被初始化
    private container!: HTMLElement;
    private canvasConfig: CanvasConfig;
    private eventEmitter: IEventEmitter;
    private injuryContexts: Map<string, InjuryContext> = new Map();

    //新增：用于追踪当前测量上下文的属性
    private currentMeasurementContextPartId: string | null = null;
    private apiReadyStatus: { core: boolean, dijkstra: boolean } = { core: false, dijkstra: false };
    //声明初始化ResizeObserver
    private _resizeObserver: ResizeObserver | null = null;
    // 存储取消订阅的函数
    private _unsubscribeMeasurementCompleted: (() => void) | null = null;

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

        this._unsubscribeMeasurementCompleted = this.eventEmitter.on(
            'measurementCompleted',
            this._handleMeasurementCompleted.bind(this)
        );

        // 监听 DijkstraService 发出的 dijkstraReady 事件
        this.eventEmitter.on('dijkstraReady', (isReady: boolean) => { // 假设 dijkstraReady 事件传递 boolean
            this.apiReadyStatus.dijkstra = isReady;
            this._checkAndEmitApiReady();
            if (!isReady) {
                this.eventEmitter.emit('error', { message: "API initialization failed: DijkstraService could not be initialized after assets loaded." });
            }
        });

        this.eventEmitter.on('injuryDataUpdated', ({ partId }) => {
            const context = this.injuryContexts.get(partId);
            if (context) {
                this.annotationManager.addOrUpdateSummaryHighlight(context);
            }
        })

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

    //#region 公共API方法
    //#region 工具管理
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
    //#endregion

    //#region 模型与视图管理
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
            console.log("Re-initializing DijkstraService for new human model...");
            if (this.sceneController.humanModel) {
                const dijkstraReInitStarted = this.dijkstraService.initializeForContext(
                    'human_model',
                    this.sceneController.humanModel
                );
                if (!dijkstraReInitStarted) {
                    this.apiReadyStatus.dijkstra = false;
                    this._checkAndEmitApiReady();
                    this.eventEmitter.emit('error', { message: "New model loaded, but DijkstraService re-initialization failed to start." });
                }
            } else {
                console.warn("New human model not available for Dijkstra re-initialization");
                this.apiReadyStatus.dijkstra = false;
                this._checkAndEmitApiReady();
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
     * 为指定部位加载、添加并显示损伤模型，然后切换到测量工具
     * @param partId 部位的唯一ID
     * @param modelUrl 损伤模型的URL
     * @param mtlUrl (可选) 材质文件的URL
     */
    public async loadInjuryModelForPart(partId: string, modelUrl: string, mtlUrl: string): Promise<void> {
        try {
            console.log(`[API] 为部位 ${partId} 加载损伤模型...`);
            this.eventEmitter.emit('notification', { message: `正在加载模型${partId}` })

            //1.加载模型
            const model = await this.sceneController.loadModelFromFile(modelUrl, mtlUrl);

            //2.命令SceneController添加并显示模型
            this.sceneController.addInjuryModel(partId, model);
            this.sceneController.showInjuryModel(partId);

            //3.设置当前的测量上下文
            this.currentMeasurementContextPartId = partId;

            this.annotationManager.setAnnotationsVisibility(partId)

            //4.为该部位初始化Dijkstra图数据
            console.log(`[API] 为部位 ${partId} 初始化Dijkstra图数据...`);
            const dijkstraInitStarted = this.dijkstraService.initializeForContext(partId, model);
            if (!dijkstraInitStarted) {
                console.warn(`[API] 部位 ${partId} 的Dijkstra初始化启动失败`);
                this.eventEmitter.emit('notification', {
                    message: `模型已加载，但图数据初始化失败，部分测量功能可能不可用`,
                    type: 'warn'
                });
            }

            //5.自动切换到默认的测量工具（空闲模式）
            console.log(`[API] 损伤模型加载并显示完毕，自动切换到 ${ToolMode.Idle} 工具。`);
            this.interactionManager.setActiveTool(ToolMode.Idle);

            this.eventEmitter.emit('notification', { message: '模型加载完毕，正在构建图数据，请稍候...' })
        } catch (error) {
            console.error(`[API] 加载部位 ${partId} 的损伤模型失败:`, error);
            this.eventEmitter.emit('error', { message: "加载损伤模型失败", details: error });
        }
    }

    public showInjuryModelForPart(partId: string): void {
        const model = this.sceneController.injuryModels.get(partId);
        if (!model) {
            console.warn(`[API] showDamageModelForPart: No damage model found for partId "${partId}".`);
            return;
        }

        // 确认模型存在后，再执行后续操作
        this.sceneController.showInjuryModel(partId);

        this.currentMeasurementContextPartId = partId;

        this.annotationManager.setAnnotationsVisibility(partId);

        console.log(`[API] Switched view to damage model: ${partId}`);
    }

    /**
     * 移除完整的鉴伤上下文及其所有关联数据
     * ui 层需要调用的方法
     * @param partId 要移出的部位
     */
    public removeInjuryContext(partId: string): void {
        if (!this.injuryContexts.has(partId)) {
            console.warn(`[API] Attempted to remove a non-existent context: ${partId}`);
            return;
        }
        console.log(`[API] Removing full injury context for partId: ${partId}`);

        this.injuryContexts.delete(partId)
        this.updatePersistentHighlights();

        this.annotationManager.removeAnnotationsForContext(partId);

        this.removeInjuryModelForPart(partId);

        this.eventEmitter.emit('injuryContextRemoved', { id: partId });
    }

    /**
     * 移除指定部位的损伤模型及其相关数据
     * @param partId 要移除的部位ID
     */
    public removeInjuryModelForPart(partId: string): void {
        try {
            console.log(`[API] 移除部位 ${partId} 的损伤模型...`);

            // 1. 如果当前正在查看这个模型，切换回主模型
            if (this.currentMeasurementContextPartId === partId) {
                this.returnToHumanModelView();
            }

            // 2. 移除Scene中的损伤模型
            this.sceneController.removeInjuryModel(partId);

            // 3. 清理Dijkstra上下文
            this.dijkstraService.disposeContext(partId);

            // 4. 移除鉴伤上下文数据
            this.injuryContexts.delete(partId);

            console.log(`[API] 部位 ${partId} 的所有相关资源已清理`);

        } catch (error) {
            console.error(`[API] 移除部位 ${partId} 失败:`, error);
            this.eventEmitter.emit('error', {
                message: `移除部位 ${partId} 失败`,
                details: error
            });
        }
    }

    /**
     * 将视图切换回主的人体模型
     */
    public returnToHumanModelView(): void {
        this.sceneController.showHumanModel();
        this.interactionManager.setActiveTool(ToolMode.Highlight);
        this.currentMeasurementContextPartId = null;

        this.annotationManager.setAnnotationsVisibility('human_model')

        this.updatePersistentHighlights()

        this.eventEmitter.emit('viewChanged', { isHumanModelView: true });
        console.log("[API] 已返回主模型视图。");
    }

    /**
     * 【高层API】为指定的鉴伤上下文加载并关联一个损伤模型。
     * 这个方法对应用户的“导入模型”操作。
     * @param contextId 要关联的鉴伤上下文的ID (即 partId)。
     * @param modelUrl 损伤模型的URL。
     * @param mtlUrl (可选) 材质文件的URL。
     * @returns Promise，在模型加载和初始化完成后解决。
     */
    public async loadInjuryModelForContext(contextId: string, modelUrl: string, mtlUrl?: string): Promise<void> {
        const context = this.injuryContexts.get(contextId);
        if (!context) {
            const message = `加载失败：无法找到ID为 ${contextId} 的鉴伤上下文。`;
            this.eventEmitter.emit('error', { message });
            return Promise.reject(new Error(message));
        }

        try {
            await this.loadInjuryModelForPart(contextId, modelUrl, mtlUrl || '');
            // 可以在这里发出一个专门的事件，通知前端某个部位的模型已成功加载
            this.eventEmitter.emit('injuryModelLoaded', { contextId });
        } catch (error) {
            return Promise.reject(error);
        }
    }


    /**
     * 【高层API】将视图切换到指定鉴伤上下文的损伤模型。
     * 这个方法对应用户的“编辑”操作。
     * @param contextId 要查看的鉴伤上下文的ID (即 partId)。
     */
    public viewInjuryModelForContext(contextId: string): void {
        const context = this.injuryContexts.get(contextId);
        if (!context) {
            this.eventEmitter.emit('error', { message: `视图切换失败：无法找到ID为 ${contextId} 的鉴伤上下文。` });
            return;
        }

        // 检查模型是否已加载，提供更友好的错误提示
        const injuryModel = this.sceneController.injuryModels.get(contextId);
        if (!injuryModel) {
            this.eventEmitter.emit('error', { message: `视图切换失败：部位“${context.name}”的损伤模型尚未加载。请先导入模型。` });
            return;
        }

        this.showInjuryModelForPart(contextId);
        this.eventEmitter.emit('viewChanged', { isHumanModelView: false })
    }

    public isInHumanModelView(): boolean {
        return this.currentMeasurementContextPartId === null;
    }
    //#endregion

    //#region 标注物管理

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
     * 切换全局标注的可见性模式。
     * 可以设置为只显示比例尺，或者恢复正常显示。
     * @param {boolean} show - true 表示仅显示比例尺，false 表示恢复正常。
     */
    public showScaleBarOnly(): void {
        // 我们传递一个只允许 scale_bar 通过的箭头函数
        const filter = (annotation: Annotation): boolean => annotation.type === 'scale_bar';

        this.annotationManager.setGlobalVisibility(filter, this.currentMeasurementContextPartId);
        this.eventEmitter.emit('notification', { message: "仅显示比例尺", type: 'info' });
    }

    public showMeasurementsOnly(): void {
        const measurementTypes = ['surface_curve', 'straight_line', 'planimetering'];
        // 我们传递一个只允许测量类型通过的箭头函数
        const filter = (annotation: Annotation): boolean => measurementTypes.includes(annotation.type);

        this.annotationManager.setGlobalVisibility(filter, this.currentMeasurementContextPartId);
        this.eventEmitter.emit('notification', { message: "仅显示测量标注", type: 'info' });
    }

    public showAllAnnotations(): void {
        // 我们传递一个允许所有东西通过的 "万能" 函数
        const filter = (_annotation: Annotation): boolean => true;

        this.annotationManager.setGlobalVisibility(filter, this.currentMeasurementContextPartId);
        this.eventEmitter.emit('notification', { message: "已显示所有标注", type: 'info' });
    }
    //#endregion

    //#region 鉴伤上下文管理
    /**
     * 为指定部位创建一个新的鉴伤上下文（模拟“添加”按钮功能）
     * @param partData - 从 partSelected 事件获取的部位信息
     */
    public addInjuryContext(partData: { partId: string, name: string, anchorPoint: THREE.Vector3, mesh: THREE.Mesh }): InjuryContext | null {
        //检查是否已经存在，放置重复创建
        if (this.injuryContexts.has(partData.partId)) {
            console.warn(`WebGLMarkingAPI 部位 "${partData.name}" 的鉴伤上下文已经存在`);
            return this.injuryContexts.get(partData.partId) || null;
        }
        //创建新的上下文对象
        const newContext: InjuryContext = {
            id: partData.partId,
            name: partData.name,
            creationTime: new Date(),
            anchorPoint: partData.anchorPoint,
            measurements: {
                cumulativeArea: 0,
                cumulativeCurveLength: 0,
                cumulativeStraightLength: 0,
                bsaPercentage: 0,
            }
        }

        //存入map中进行管理
        this.injuryContexts.set(newContext.id, newContext);

        //发出事件，通知外部上下文已创建
        this.eventEmitter.emit('injuryContextAdded', { context: newContext });

        this.annotationManager.addOrUpdateSummaryHighlight(newContext);

        this.updatePersistentHighlights()

        return newContext;

    }

    /* 提供一个获取所有上下文的方法，便于调试 */
    public getAllInjuryContexts(): Map<string, InjuryContext> {
        return this.injuryContexts;
    }

    /**
     * 获取当前正在测量的部位ID
     */
    public getCurrentContextPartId(): string | null {
        return this.currentMeasurementContextPartId;
    }

    public getCurrentInjuryContext(): InjuryContext | null {
        if (!this.currentMeasurementContextPartId) {
            return null
        }
        return this.injuryContexts.get(this.currentMeasurementContextPartId) || null
    }
    //#endregion

    //#region 事件系统
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
    //#endregion

    //#region 核心访问
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
    //#endregion

    //#region 照片事件方法

    /**
     * 开启或关闭相机模式
     * @param enable 
     */
    public togglePhotoTool(enable: boolean): void {
        const targetMode = enable ? ToolMode.Photo : ToolMode.Idle
        this.interactionManager.setActiveTool(targetMode)
    }

    /**
     * 设计相机拍照模式(广角/默认)
     * @param mode 
     */
    public setCameraPhotoMode(mode: 'wide' | 'default'): void {
        const tool = this.interactionManager.getActiveTool()
        if (tool instanceof PhotoTool) {
            tool.setCameraPhotoMode(mode)
        } else {
            console.warn('PhotoTool is not activate');
        }
    }


    public async capturePhoto(
        userName: string = '用户',
        resolutionMultiplier: number = 5,
        orientation: 'landscape' | 'portrait' = 'landscape'
    ): Promise<void> {
        const tool = this.interactionManager.getActiveTool()
        if (tool instanceof PhotoTool) {
            await tool.capturePhoto(userName, resolutionMultiplier, orientation)
        } else {
            this.eventEmitter.emit('error', { message: '当前工具不是拍摄工具' })
            console.warn('PhotoTool is not activate');
        }
    }

    /**
     * 【新增】触发自动进行六视图标准照拍摄
     * @param userName 用于文件命名的用户名
     */
    public async captureStandardViews(userName: string = '用户'): Promise<void> {
        // 先确保进入了拍照模式
        this.setToolMode(ToolMode.Photo);

        // 等待一帧，确保工具已成功激活
        await new Promise(resolve => requestAnimationFrame(resolve));

        const tool = this.interactionManager.getActiveTool();
        if (tool instanceof PhotoTool) {
            await tool.captureStandardViews(userName);
        } else {
            this.eventEmitter.emit('error', { message: '无法激活拍照工具，自动拍摄失败' });
        }
    }

    /**
     * 【核心实现】将当前激活的损伤模型的变换固化（烘焙）到其几何体中。
     * 这通常在手动调整完模型位姿后，拍摄标准六面图之前调用。
     * @returns {boolean} 操作是否成功。
     */
    public applyCurrentTransformAsBase(): boolean {
        // 步骤 1: 获取当前激活的工具，并验证它是不是 TransformTool。
        const activeTool = this.interactionManager.getActiveTool();

        if (!(activeTool instanceof TransformTool)) {
            this.eventEmitter.emit('error', { message: '应用变换失败：请先激活变换工具并调整模型。' });
            return false;
        }

        // 步骤 2: 从 TransformTool 获取 TransformControls 实例及其正在操作的对象。
        const controls = activeTool.getControls();
        if (!controls || !controls.object) {
            this.eventEmitter.emit('error', { message: '应用变换失败：未找到有效的变换控制器或附加对象。' });
            return false;
        }

        const targetObject = controls.object;

        try {
            // 步骤 3: 命令 SceneController 执行核心的烘焙方法。
            // 此时，targetObject 的几何体顶点被更新，但它自身的 .position, .quaternion, .scale 被重置。
            this.sceneController.bakeTransformToObject(targetObject);

            // 步骤 4: 【非常重要的一步】刷新 TransformControls 的状态。
            // 因为 targetObject 的变换已经被重置，我们需要让 TransformControls 重新“认识”它。
            // 先分离再重新附加，是强制更新其内部状态的最可靠方法。
            controls.detach();
            controls.attach(targetObject);

            this.eventEmitter.emit('notification', { message: '当前位姿已保存为默认状态。', type: 'info' });

            // 烘焙成功后，可以考虑自动切换回 Idle 模式，这是一个好的用户体验。
            this.setToolMode(ToolMode.Idle);

            return true;
        } catch (error) {
            console.error("Failed to apply transform as base:", error);
            const errorMessage = error instanceof Error ? error.message : '未知错误';
            this.eventEmitter.emit('error', { message: `应用变换失败: ${errorMessage}`, details: error });
            return false;
        }
    }

    //#endregion

    //#region 生命周期
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

        if (this._unsubscribeMeasurementCompleted) {
            this._unsubscribeMeasurementCompleted();
            this._unsubscribeMeasurementCompleted = null;
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
    //#endregion
    //#endregion

    //#region 私有辅助方法

    /**
     * 处理测量完成事件，并进行数据累加
     */
    private _handleMeasurementCompleted(data: ApiListeners['measurementCompleted']): void {
        if (!('id' in data && 'type' in data)) {
            return;
        }

        const annotation: Annotation = data;

        const partId = this.getCurrentContextPartId();

        if (!partId) {
            // 在主模型上测量，不计入任何上下文
            return;
        }

        const context = this.injuryContexts.get(partId);

        if (!context) {
            console.warn(`[API] Measurement completed, but no injury context found for partId: ${partId}.`);
            return;
        }

        // 数据累加
        switch (annotation.type) {
            case ToolMode.Planimetering:
                context.measurements.cumulativeArea += ((annotation as PlanimeteringAnnotation).area || 0) * 10000;
                break;
            case ToolMode.SurfaceMeasure:
                context.measurements.cumulativeCurveLength += ((annotation as SurfaceMeasurementAnnotation).length || 0) * 100;
                break;
            case ToolMode.StraightMeasure:
                context.measurements.cumulativeStraightLength += ((annotation as StraightMeasurementAnnotation).length || 0) * 100;
                break;
            default:
                // 其他类型的标注不参与累加
                return;
        }

        // BSA 计算
        this._calculateBSA(context);

        // 发出 injuryDataUpdated 事件
        this.eventEmitter.emit('injuryDataUpdated', {
            partId: partId,
            measurements: context.measurements
        });

        console.log(`[API] Injury context for partId "${partId}" updated:`, context.measurements);
    }

    /**
     * 计算并更新上下文中的BSA百分比
     * @param context - 需要鉴伤的百分比
     */
    private _calculateBSA(context: InjuryContext): void {
        // TODO: 将来需要从外部（如用户资料）获取真实的身高体重
        const heightCm = 175; // 假设身高 175cm
        const weightKg = 70;  // 假设体重 70kg

        // 使用 Du Bois 公式估算总基础体表面积 (BSA)
        // BSA (m^2) = 0.007184 * (height_cm ^ 0.725) * (weight_kg ^ 0.425)
        const totalBSA = 0.007184 * Math.pow(heightCm, 0.725) * Math.pow(weightKg, 0.425);

        if (totalBSA > 0) {
            const cumulativeAreaInM2 = context.measurements.cumulativeArea / 10000;
            context.measurements.bsaPercentage = (cumulativeAreaInM2 / totalBSA) * 100;
        } else {
            context.measurements.bsaPercentage = 0;
        }
    }
    //#region 初始化与设置
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

    /** 注册所有可用的工具 */
    private _registerTools(): void {
        // 将必要的依赖通过构造函数传递给工具
        const idleTool = new IdleTool(this.sceneController, this.annotationManager, this.eventEmitter);
        const scaleBarTool = new ScaleBarTool(this.sceneController, this.annotationManager, this.eventEmitter, this);
        const photoTool = new PhotoTool(this.sceneController, this.annotationManager, this.eventEmitter, this);

        const surfaceTool = new SurfaceMeasurementTool(
            this.sceneController,
            this.annotationManager,
            this.dijkstraService,
            this.eventEmitter,
            this
        );

        const straightTool = new StraightMeasurementTool(this.sceneController, this.annotationManager, this.eventEmitter, this);
        const hightLight = new HighlightTool(this.sceneController, this.annotationManager, this.eventEmitter);
        const planimeteringTool = new PlanimeteringTool(this.sceneController, this.annotationManager, this.eventEmitter, this);
        const transformTool = new TransformTool(this.sceneController, this.annotationManager, this.eventEmitter)

        this.interactionManager.registerTool(idleTool);
        this.interactionManager.registerTool(scaleBarTool);
        this.interactionManager.registerTool(surfaceTool);
        this.interactionManager.registerTool(straightTool);
        this.interactionManager.registerTool(hightLight);
        this.interactionManager.registerTool(planimeteringTool);
        this.interactionManager.registerTool(photoTool)
        this.interactionManager.registerTool(transformTool)

        // 默认设置为 IdleTool
        this.interactionManager.setActiveTool(ToolMode.Highlight);
    }
    //#endregion

    //#region 资源加载与状态处理

    private updatePersistentHighlights(): void {
        // --- ↓↓↓ 新增的诊断日志 ↓↓↓ ---

        const highlightTool = this.interactionManager.getAllTools().get(ToolMode.Highlight) as HighlightTool | undefined;

        // --- ↑↑↑ 结束诊断日志 ↑↑↑ ---

        if (highlightTool && typeof highlightTool.setPersistentHighlights === 'function') {
            const keysToHighlight = Array.from(this.injuryContexts.keys())
            console.log('[API] Updating persistent highlights with keys:', keysToHighlight);
            // 发出指令，更新视觉
            highlightTool.setPersistentHighlights(keysToHighlight);
        } else {
            console.error('%c[API] Conditions FAILED. Did NOT call setPersistentHighlights.', 'color: red; font-weight: bold;');
        }

    }
    /** 资源加载成功后的回调 */
    private _onAssetsLoaded(): void {
        console.log("Assets loaded, initializing DijkstraService for human model...");

        this.apiReadyStatus.core = true; // 核心资源已加载

        // 为人体主模型初始化Dijkstra图数据
        if (this.sceneController.humanModel) {
            const dijkstraInitializationStarted = this.dijkstraService.initializeForContext(
                'human_model',
                this.sceneController.humanModel
            );
            if (!dijkstraInitializationStarted) {
                // 如果初始化启动失败 (例如，无法创建 Worker)
                this.apiReadyStatus.dijkstra = false;
                this._checkAndEmitApiReady();
                this.eventEmitter.emit('error', { message: "API initialization failed: DijkstraService could not start initialization for human model." });
            }
        } else {
            console.warn("Human model not available for Dijkstra initialization");
            this.apiReadyStatus.dijkstra = false;
            this._checkAndEmitApiReady();
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
    //#endregion

    //#region 内部响应
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
    //#endregion
    //#endregion
}