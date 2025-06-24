//@ts-ignore
import * as THREE from 'three';
//@ts-ignore
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
//@ts-ignore
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
//@ts-ignore
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
//@ts-ignore
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
//@ts-ignore
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { ISceneController } from '../../types/webgl-marking';

import Stats from 'stats.js';
import {
    MeshBVH,
    acceleratedRaycast,
    computeBoundsTree,
    disposeBoundsTree,
    SAH
} from 'three-mesh-bvh';

// 这个模块负责 Three.js 的基础设置、模型加载和渲染循环。
interface RenderOptimization {
    skipFrames: number;
    lowQualityMode: boolean;
    dynamicPixelRatio: boolean;
    cullingDistance: number;
}

export class SceneController implements ISceneController {
    public renderer: THREE.WebGLRenderer;
    public css2dRenderer: CSS2DRenderer;
    public scene: THREE.Scene;
    public camera: THREE.PerspectiveCamera;
    public orbitControls: OrbitControls;
    public raycaster: THREE.Raycaster = new THREE.Raycaster();

    //新属性实现
    public humanModel: THREE.Group | null = null;
    public scaleBarBaseModel: THREE.Group | null = null;
    public damageModels: Map<string, THREE.Group> = new Map();
    public activeModelForRaycasting: THREE.Object3D | null = null;

    private canvas: HTMLCanvasElement;
    private modelPath: string;
    private mtlPath?: string;
    private scaleBarModelPath: string;

    private gltfLoader = new GLTFLoader();

    private onLoadCallback?: () => void;
    private onErrorCallback?: (error: any) => void;

    // 优化性能相关属性
    private frustumCulling: boolean = true;

    private renderQualityCheckInterval: number = 0;
    private renderQualityCheckThreshold: number = 500;
    private adaptivePixelRatio: number = 1;
    private performanceMode: 'high' | 'medium' | 'low' = 'high';
    private lastFrameTime: number = 0;
    private frameTimeHistory: number[] = [];
    private frameTimeHistorySize: number = 30;

    // BVH 性能优化相关
    private bvhEnabled: boolean = true;
    private geometryBVH: Map<string, MeshBVH> = new Map();
    private bvhPatched: boolean = false;


    // 新增：渲染优化相关
    private renderOptimization: RenderOptimization = {
        skipFrames: 0,
        lowQualityMode: false,
        dynamicPixelRatio: true,
        cullingDistance: 100
    };

    // 新增：相机控制优化
    private controlsOptimization = {
        isDragging: false,
        isMoving: false,
        moveTimeout: null as number | null,
        throttleMs: 8, // 进一步降低阈值以提高响应性
        lastControlUpdate: 0,
        dampingEnabled: false, // 初始禁用阻尼
        adaptiveDamping: true
    };

    // 新增：几何体池化管理
    private materialPool: Map<string, THREE.Material> = new Map();

    // 新增：视锥体裁剪优化
    private frustumCullingOptimization = {
        enabled: true,
        checkInterval: 3, // 每3帧检查一次
        frameCounter: 0,
        lastVisibilityMap: new Map<string, boolean>()
    };


    private stats: Stats;

    constructor(canvas: HTMLCanvasElement, modelPath: string, scaleBarModelPath: string, mtlPath?: string) {
        this.canvas = canvas;
        this.modelPath = modelPath;
        this.mtlPath = mtlPath;
        this.scaleBarModelPath = scaleBarModelPath;

        this.renderer = this._initRenderer();
        this.css2dRenderer = this._initCSS2DRenderer();
        this.scene = this._initScene();
        this.camera = this._initCamera();
        this.orbitControls = this._initControls();

        this._addLights();
        this._initializeBVHSafely();
        this._initializeAdvancedOptimizations();

        window.addEventListener('resize', this._handleResize.bind(this));

        this.stats = new Stats();
        this.stats.showPanel(0);
        if (this.canvas.parentElement) {
            this.canvas.parentElement.appendChild(this.stats.dom);
            this.stats.dom.style.position = 'absolute';
            this.stats.dom.style.top = '0px';
            this.stats.dom.style.left = '0px';
            this.stats.dom.style.zIndex = '10000';
        }
    }

    // #region 公共API方法

    // #region 模型与资源管理
    /**
     * 加载场景所需要的所有3D资源并初始化渲染环境
     * @param onLoad 资源加载成功时的回调函数
     * @param onload 资源加载失败时的回调函数
     * @returns Promise<void>
     * @see {@link loadModelFromFile} - 单独加载obj模型文件的方法
     * @see {@link loadNewTargetModel} - 动态替换目标模型的方法
     * @see {@link startRendering} - 启动渲染循环的方法
     */
    public async loadAssets(onLoad: () => void, onError: (error: any) => void): Promise<void> {
        this.onLoadCallback = onLoad;
        this.onErrorCallback = onError;

        try {
            const initialHumanModel = await this.loadModelFromFile(this.modelPath, this.mtlPath);
            this.humanModel = initialHumanModel;
            this._setupModel(this.humanModel, true);
            this.scene.add(this.humanModel);
            this.activeModelForRaycasting = this.humanModel;
            this.resetCameraToFitModel(this.humanModel);

            const gltf = await this.gltfLoader.loadAsync(this.scaleBarModelPath);
            this.scaleBarBaseModel = gltf.scene;
            this._setupModel(this.scaleBarBaseModel, false);

            console.log('Assets loaded successful');
            this.onLoadCallback?.();
            this.startRendering();
            this._forceInitialRender();

        } catch (error) {
            console.error("Error loading assets:", error);
            this.onErrorCallback?.(error);
        }
    }

    /**
     * 加载obj模型，支持可选的mtl材质文件
     * @param modelUrl obj模型路径
     * @param mtlUrl 可选的mtl路径
     * @returns 返回加载模型的THREE.Group对象
     */
    public async loadModelFromFile(modelUrl: string, mtlUrl?: string): Promise<THREE.Group> {
        // 创建新的加载器实例以避免状态污染
        const objLoader = new OBJLoader();
        const mtlLoader = new MTLLoader();

        if (mtlUrl) {
            const materials = await mtlLoader.loadAsync(mtlUrl);
            materials.preload();
            (objLoader as any).setMaterials(materials);
        }
        return await objLoader.loadAsync(modelUrl) as THREE.Group;
    }

    /**
     * 动态替换目标模型
     * @param modelUrl 新目标模型的obj模型路径
     * @param mtlUrl 可选的mtl材质文件路径
     * @returns 返回加载模型的THREE.Group对象
     */
    public async loadNewTargetModel(modelUrl: string, mtlUrl?: string): Promise<THREE.Group> {
        this.removeHumanModel();
        this.damageModels.forEach((_, partId) => this.removeDamageModel(partId));

        console.log(`Loading new human model from: ${modelUrl}`);
        THREE.Cache.clear();

        try {
            const loadedModel = await this.loadModelFromFile(modelUrl, mtlUrl);
            this.humanModel = loadedModel;
            this._setupModel(this.humanModel, true);
            this.scene.add(this.humanModel);
            this.activeModelForRaycasting = this.humanModel; // 重置激活模型
            this.resetCameraToFitModel(this.humanModel);

            console.log('New human model loaded successfully.');
            return this.humanModel;
        } catch (error) {
            console.error("Error loading new human model:", error);
            this.humanModel = null;
            throw error;
        }
    }

    /**
     * 添加损伤模型到场景中并进行优化配置
     * @param partId 损伤部位的唯一标识符
     * @param model  要添加的损伤模型THREE.Group对象
     * @returns void
     */
    public addDamageModel(partId: string, model: THREE.Group): void {
        if (this.damageModels.has(partId)) {
            console.warn(`Damage model for partId "${partId}" already exists. Replacing it.`);
            this.removeDamageModel(partId);
        }
        this._setupModel(model, true);
        this.scene.add(model);
        this.damageModels.set(partId, model);
        console.log(`Damage model for partId "${partId}" added to the scene.`);
    }

    /**
     * 移除损伤模型
     * @param partId  损伤部位的唯一标识符
     */
    public removeDamageModel(partId: string): void {
        const modelToRemove = this.damageModels.get(partId);
        if (modelToRemove) {
            this.scene.remove(modelToRemove);
            modelToRemove.traverse((child: any) => {
                if (child.isMesh) {
                    child.geometry?.dispose();
                    if (child.material) {
                        Array.isArray(child.material) ? child.material.forEach((m: THREE.Material) => m.dispose()) : child.material.dispose();
                    }
                }
            });
            this.damageModels.delete(partId);
            if (this.activeModelForRaycasting === modelToRemove) {
                this.activeModelForRaycasting = null;
            }
            console.log(`Damage model for partId "${partId}" removed.`);
        }
    }

    /**
     * 移除人体模型
     * @returns void
     */
    public removeHumanModel(): void {
        const modelToRemove = this.humanModel;
        if (modelToRemove) {
            this.scene.remove(modelToRemove);
            modelToRemove.traverse((child: any) => {
                if (child.isMesh) {
                    child.geometry?.dispose();
                    if (child.material) {
                        Array.isArray(child.material) ? child.material.forEach((m: THREE.Material) => m.dispose()) : child.material.dispose();
                    }
                }
            })

            this.humanModel = null;

            if (this.activeModelForRaycasting === modelToRemove) {
                this.activeModelForRaycasting = null;
            }

            console.log('humanModel has been removed and its resources disposed');

        }
    }

    /**
     * 获取当前激活模型的目标网格几何体
     * @returns {THREE.BufferGeometry | null} 返回激活模型的几何对象，没有找到则返回null
     */
    public getTargetMeshGeometry(): THREE.BufferGeometry | null {

        const activeModel = this.activeModelForRaycasting;
        if (!activeModel) {
            console.warn("[SceneController] getTargetMeshGeometry: No active model for raycasting.");
            return null;
        }

        const mesh = this.findFirstMeshInModel(activeModel);
        if (mesh) {
            return mesh.geometry as THREE.BufferGeometry;
        }

        return null;
    }


    /**
     * 获取当前激活模型的世界变化矩阵
     * @returns {THREE.Matrix4 | null} 返回激活模型的世界变化矩阵，没有则返回null
     */
    public getTargetMeshWorldMatrix(): THREE.Matrix4 | null {

        const activeModel = this.activeModelForRaycasting;
        if (!activeModel) {
            console.warn("[SceneController] getTargetMeshWorldMatrix: No active model for raycasting.");
            return null;

        }
        const mesh = this.findFirstMeshInModel(activeModel)
        return mesh ? mesh.matrixWorld : null;
    }

    /**
     * 控制BVH（边界体积层结构）模式的开启或关闭
     * @param enabled true:启用；false:关闭
     */
    public setBVHEnabled(enabled: boolean): void {
        this.bvhEnabled = enabled;
    }
    // #endregion

    // #region 视图与显示控制
    /**
     * 显示指定的损伤模型并隐藏其他所有模型
     * @param partId 要显示的损伤部位的唯一标识符
     * @returns {void}
     */
    public showDamageModel(partId: string): void {
        const modelToShow = this.damageModels.get(partId);
        if (!modelToShow) {
            console.error(`No damage model found for partId "${partId}".`);
            return;
        }
        if (this.humanModel) this.humanModel.visible = false;
        this.damageModels.forEach((model, id) => {
            model.visible = id === partId;
        });
        this.activeModelForRaycasting = modelToShow;
        this.resetCameraToFitModel(modelToShow);
        console.log(`Showing damage model for partId "${partId}". Raycasting target updated.`);

    }

    /**
     * 显示人体模型并隐藏所有的损伤模型
     * @returns {void}
     */
    public showHumanModel(): void {
        if (this.humanModel) this.humanModel.visible = true;
        this.damageModels.forEach(model => {
            model.visible = false;
        });
        this.activeModelForRaycasting = this.humanModel;
        this.resetCameraToFitModel(this.humanModel);
        console.log("Showing human model. Raycasting target updated.");

    }

    /**
     * 重置相机位置和角度以最佳角度显示指定模型
     * @param model 需要适配的目标模型对象
     * @returns {void}
     */
    public resetCameraToFitModel(model: THREE.Group | null = this.humanModel): void {
        if (!model) return;
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        const distance = maxDim * 2.5;
        const cameraY = Math.max(center.y + distance * 0.4, distance * 0.3);
        this.camera.position.set(center.x - distance * 0.8, cameraY, center.z + distance * 1.2);
        const lookAtTarget = new THREE.Vector3(center.x, center.y * 0.3, center.z);
        this.camera.lookAt(lookAtTarget);
        this.orbitControls.target.copy(lookAtTarget);
        this.orbitControls.update();
    }

    /**
     * 更新渲染器尺寸和相机参数以适应新的画布大小
     * @param width 新的渲染画布宽度（像素）
     * @param height 新的渲染画布长度（像素）
     */
    public updateRenderSize(width: number, height: number): void {
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(width, height);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
        this.css2dRenderer.setSize(width, height);
    }
    // #endregion

    // #region 渲染与生命周期
    /**
     * 启动3D环境的渲染循环
     * @returns {void}
     */
    public startRendering(): void {
        this._initializePerformanceOptimizations();
        this._renderLoop();
    }

    /**
     * 清理并释放SceneController的所有资源
     * @returns {void}
     */
    public dispose(): void {
        window.removeEventListener('resize', this._handleResize);
        this._disposeBVHResources();
        if (this.stats.dom.parentElement) {
            this.stats.dom.parentElement.removeChild(this.stats.dom);
        }
        this.renderer.dispose();
        if (this.css2dRenderer.domElement.parentElement) {
            this.css2dRenderer.domElement.parentElement.removeChild(this.css2dRenderer.domElement);
        }

        this.removeHumanModel();
        this.damageModels.forEach((_, partId) => this.removeDamageModel(partId));
    }

    // #endregion

    // #endregion

    // #region 私有辅助方法

    // #region初始化方法
    /**
     * 安全初始化BVH（边界体积层次结构）加速功能
     * @private
     * @returns {void}
     */
    private _initializeBVHSafely(): void {
        try {
            // 检查是否已经应用过
            if ((THREE.BufferGeometry.prototype as any)._bvhPatched) {
                return;
            }

            // 保存原始方法
            const originalRaycast = THREE.Mesh.prototype.raycast;

            // 安全地扩展原型
            if (typeof (THREE.BufferGeometry.prototype as any).computeBoundsTree !== 'function') {
                (THREE.BufferGeometry.prototype as any).computeBoundsTree = computeBoundsTree;
                (THREE.BufferGeometry.prototype as any).disposeBoundsTree = disposeBoundsTree;
            }

            // 包装raycast方法而不是直接替换
            (THREE.Mesh.prototype as any).raycast = function (raycaster: THREE.Raycaster, intersects: THREE.Intersection[]) {
                // 只对有BVH的网格使用加速射线投射
                if (this.userData?.hasBVH && this.geometry?.boundsTree) {
                    try {
                        return acceleratedRaycast.call(this, raycaster, intersects);
                    } catch (error) {
                        console.warn('BVH raycast failed, using original method:', error);
                        return originalRaycast.call(this, raycaster, intersects);
                    }
                } else {
                    return originalRaycast.call(this, raycaster, intersects);
                }
            };

            (THREE.BufferGeometry.prototype as any)._bvhPatched = true;
            console.log('BVH extensions applied safely');

        } catch (error) {
            console.error('Failed to initialize BVH safely:', error);
            this.bvhEnabled = false;
        }
    }

    /**
     * 初始化高级渲染优化策略
     * @private
     * @returns {void}
     */
    private _initializeAdvancedOptimizations(): void {
        this._setupAdaptiveRendering();

    }

    /**
     * 初始化渲染器
     * @private
     * @returns THREE.WebGLRenderTarget
     */
    private _initRenderer(): THREE.WebGLRenderer {
        const renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            antialias: false, // 初始禁用抗锯齿以提高性能
            alpha: true,
            powerPreference: 'high-performance',
            logarithmicDepthBuffer: false,
            preserveDrawingBuffer: false, // 提高性能
            premultipliedAlpha: false,
            stencil: false // 禁用模板缓冲区
        });

        renderer.setSize(this.canvas.clientWidth, this.canvas.clientHeight);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5)); // 限制像素比率
        renderer.shadowMap.enabled = false;
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.0;

        // 新增：性能优化设置
        renderer.sortObjects = false;
        renderer.info.autoReset = false; // 手动控制信息重置

        return renderer;
    }

    /**
     * 初始化CSS2D渲染器并配置其样式与挂载位置
     * @returns CSS2DRenderer
     */
    private _initCSS2DRenderer(): CSS2DRenderer {
        const cssRenderer = new CSS2DRenderer();
        cssRenderer.setSize(this.canvas.clientWidth, this.canvas.clientHeight);
        cssRenderer.domElement.style.position = 'absolute';
        cssRenderer.domElement.style.top = '0px';
        cssRenderer.domElement.style.pointerEvents = 'none';
        if (this.canvas.parentElement) {
            this.canvas.parentElement.appendChild(cssRenderer.domElement);
        }
        return cssRenderer;
    }

    /**
     * 初始化场景
     * @returns THREE.Scene
     */
    private _initScene(): THREE.Scene {
        const scene = new THREE.Scene();
        // 新增：场景优化
        scene.matrixAutoUpdate = false; // 禁用自动矩阵更新
        return scene;
    }

    /**
     * 初始化相机
     * @returns THREE.PerspectiveCamera
     */
    private _initCamera(): THREE.PerspectiveCamera {
        const aspectRatio = this.canvas.clientWidth / this.canvas.clientHeight;
        const camera = new THREE.PerspectiveCamera(45, aspectRatio, 0.1, 1000);
        camera.position.set(-4, 3, 6);

        // 新增：相机优化
        camera.matrixAutoUpdate = true; // 相机需要自动更新
        this.scene.add(camera);
        return camera;
    }

    /**
     * 初始化相机控制
     * @returns OrbitControls
     */
    private _initControls(): OrbitControls {
        const controls = new OrbitControls(this.camera, this.renderer.domElement);

        // 优化控制器设置
        controls.enableDamping = this.controlsOptimization.dampingEnabled;
        controls.dampingFactor = 0.05;
        controls.panSpeed = 1.2; // 稍微提高平移速度
        controls.rotateSpeed = 0.5; // 稍微提高旋转速度
        controls.zoomSpeed = 1.0;

        // 新增：控制器事件优化
        controls.addEventListener('start', () => {
            this.controlsOptimization.isDragging = true;
            this.controlsOptimization.isMoving = true;

            // 拖拽时启用低质量模式
            this.renderOptimization.lowQualityMode = true;

            // 动态调整性能模式
            if (this.performanceMode === 'high') {
                this._temporaryPerformanceMode('medium');
            }
        });

        controls.addEventListener('change', () => {
            this.controlsOptimization.lastControlUpdate = performance.now();
        });

        controls.addEventListener('end', () => {
            this.controlsOptimization.isDragging = false;

            // 延迟恢复高质量模式
            if (this.controlsOptimization.moveTimeout) {
                clearTimeout(this.controlsOptimization.moveTimeout);
            }

            this.controlsOptimization.moveTimeout = setTimeout(() => {
                this.controlsOptimization.isMoving = false;
                this.renderOptimization.lowQualityMode = false;
                this._restorePerformanceMode();
            }, 150);
        });

        return controls;
    }

    /**
     * 初始化灯光
     * @returns {void}
     */
    private _addLights(): void {
        const ambientLight = new THREE.AmbientLight(0xffffff, 2);
        this.scene.add(ambientLight);
        const directionalLight = new THREE.DirectionalLight(0xffffff, 2);
        directionalLight.position.set(1, 2, 3);
        directionalLight.castShadow = false;
        this.scene.add(directionalLight);
    }

    /**
     * 根据浏览器内存使用情况自适应调整渲染性能模式
     * @private
     * @returns {void}
     */
    private _setupAdaptiveRendering(): void {
        if ('memory' in performance) {
            const memInfo = (performance as any).memory;
            if (memInfo.usedJSHeapSize / memInfo.totalJSHeapSize > 0.8) {
                this.performanceMode = 'medium';
                console.log('检测到内存压力，切换到中等性能模式');
            }
        }
    }

    /**
     * 初始化渲染性能优化相关设置
     * @private
     * @returns {void}
     */
    private _initializePerformanceOptimizations(): void {
        this._applyPerformanceMode();
        this.renderer.info.autoReset = false;
        console.log('Performance optimizations initialized. Mode:', this.performanceMode);
    }
    // #endregion

    // #region 渲染循环与优化

    /**
     * 核心渲染循环，通过requestAnimationFrame 持续调用
     * 
     * 实现双模式渲染策略：1.交互模型；2.静止模式
     * @returns {void}
     */
    private _renderLoop = (): void => {
        requestAnimationFrame(this._renderLoop);

        const currentTime = performance.now();
        this.stats.begin();

        //双模渲染优化
        if (this.controlsOptimization.isMoving) {
            //交互模式：相机正在被控制
            this._smartCameraUpdate();
            this.renderer.render(this.scene, this.camera);
        } else {
            this._smartCameraUpdate();
            this._performanceMonitoring(currentTime);
            this._smartRenderQualityAdjustment(currentTime);
            this._optimizedFrustumCulling();
            this.renderer.render(this.scene, this.camera);
        }

        this.css2dRenderer.render(this.scene, this.camera);
        this.stats.end();
    }

    /**
     * 智能更新相机状态
     * @returns {void}
     */
    private _smartCameraUpdate(): void {
        if (this.orbitControls.enabled) {
            this.orbitControls.update()
        }
    }

    /**
     * 性能监控函数，用于跟踪和记录帧渲染时间
     * @param currentTime 当前帧的时间戳
     * @returns {void}
     */
    private _performanceMonitoring(currentTime: number): void {
        if (this.lastFrameTime > 0) {
            const frameTime = currentTime - this.lastFrameTime;
            this.frameTimeHistory.push(frameTime);
            if (this.frameTimeHistory.length > this.frameTimeHistorySize) {
                this.frameTimeHistory.shift();
            }
            if (this.frameTimeHistory.length >= this.frameTimeHistorySize) {
                this._analyzeAndAdjustPerformance();
            }
        }
        this.lastFrameTime = currentTime;
    }

    /**
     * 分析收集的性能数据，并据此调整应用的性能模式
     * @returns {void}
     */
    private _analyzeAndAdjustPerformance(): void {
        const avgFrameTime = this.frameTimeHistory.reduce((a, b) => a + b, 0) / this.frameTimeHistory.length;
        const avgFPS = 1000 / avgFrameTime;

        if (avgFPS < 30 && this.performanceMode !== 'low') {
            this.setPerformanceMode('low');
        } else if (avgFPS < 50 && this.performanceMode === 'high') {
            this.setPerformanceMode('medium');
        } else if (avgFPS > 55 && this.performanceMode !== 'high') {
            this.setPerformanceMode('high');
        }
    }

    /**
     * 根据当前场景的复杂度（渲染的三角形数量），智能调整渲染质量。
     * @param currentTime 当前帧的时间戳
     * @returns {void}
     */
    private _smartRenderQualityAdjustment(currentTime: number): void {
        if (currentTime - this.renderQualityCheckInterval < this.renderQualityCheckThreshold) return;

        const info = this.renderer.info;
        const currentPixelRatio = this.renderer.getPixelRatio();

        if (info.render.triangles > 500000 && currentPixelRatio > 1.2) {
            this.renderer.setPixelRatio(Math.max(0.8, currentPixelRatio - 0.2));
        } else if (info.render.triangles < 100000 && currentPixelRatio < window.devicePixelRatio) {
            this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, currentPixelRatio + 0.1));
        }
        this.renderQualityCheckInterval = currentTime;
    }

    /**
     * 执行优化的，手动的视椎体剔除
     * @returns {void}
     */
    private _optimizedFrustumCulling(): void {
        if (!this.frustumCullingOptimization.enabled) return;

        // 当有工具激活时（例如正在测量），我们通常不希望模型因为移出视锥而突然消失
        if (!this.orbitControls.enabled) return;

        this.frustumCullingOptimization.frameCounter++;
        if (this.frustumCullingOptimization.frameCounter % this.frustumCullingOptimization.checkInterval !== 0) {
            return;
        }

        // --- 核心修正 ---
        // 只对当前激活的模型（activeModelForRaycasting）进行视锥体裁剪
        const activeModel = this.activeModelForRaycasting;
        if (!activeModel) return;

        const frustum = new THREE.Frustum();
        const cameraMatrix = new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
        frustum.setFromProjectionMatrix(cameraMatrix);

        // 只遍历当前激活的模型，而不是整个 this.scene
        activeModel.traverse((child: THREE.Object3D) => {
            if ((child as THREE.Mesh).isMesh) {
                const mesh = child as THREE.Mesh;

                // 我们不应该隐藏模型组的根对象本身
                if (mesh === activeModel) return;

                if (mesh.geometry?.boundingSphere) {
                    // 这个 lastVisibilityMap 逻辑可能也需要重新审视，
                    // 但核心是，现在的作用范围被限定在了 activeModel 内部，不会影响到 humanModel
                    const previouslyVisible = this.frustumCullingOptimization.lastVisibilityMap.get(mesh.uuid);
                    const isVisible = frustum.intersectsObject(mesh);
                    if (isVisible !== previouslyVisible) {
                        mesh.visible = isVisible;
                        this.frustumCullingOptimization.lastVisibilityMap.set(mesh.uuid, isVisible);
                    }
                }
            }
        });
    }

    /**
     * 应用当前设定的性能模式
     * @returns {void}
     */
    private _applyPerformanceMode(): void {
        switch (this.performanceMode) {
            case 'low':
                this.adaptivePixelRatio = 0.75;
                this.renderer.setPixelRatio(Math.min(1, window.devicePixelRatio * this.adaptivePixelRatio));
                break;
            case 'medium':
                this.adaptivePixelRatio = 1.0;
                this.renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio * this.adaptivePixelRatio));
                break;
            case 'high':
                this.adaptivePixelRatio = 1.0;
                this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
                break;
        }
    }

    //#endregion

    //#region 模型处理辅助

    /**
    * 辅助方法：在模型中查找并返回第一个有效的网格对象。
    * @param model 要搜索的 Object3D 对象。
    * @returns 返回找到的第一个 THREE.Mesh，如果找不到则返回 null。
    */
    private findFirstMeshInModel(model: THREE.Object3D): THREE.Mesh | null {
        let foundMesh: THREE.Mesh | null = null;

        model.traverse((child: THREE.Object3D) => {
            // 如果已经找到，就提前终止后续不必要的检查
            if (foundMesh) {
                return;
            }

            // 使用类型守卫检查 child 是否为 Mesh
            if ((child as THREE.Mesh).isMesh) {
                const potentialMesh = child as THREE.Mesh;
                // 进一步检查 geometry 是否存在且是 BufferGeometry
                if (potentialMesh.geometry?.isBufferGeometry) {
                    foundMesh = potentialMesh; // 在函数内部作用域赋值
                }
            }
        });

        return foundMesh; // 返回查找结果
    }

    private _setupModel(model: THREE.Group, centerAndScale: boolean): void {
        if (centerAndScale) {
            const box = new THREE.Box3().setFromObject(model);
            const center = box.getCenter(new THREE.Vector3());
            const size = box.getSize(new THREE.Vector3());
            const maxDim = Math.max(size.x, size.y, size.z);
            const scale = 1 / maxDim;

            model.position.sub(center);
            model.scale.multiplyScalar(scale);
            model.updateMatrixWorld(true);

            const newBox = new THREE.Box3().setFromObject(model);
            const yOffset = newBox.min.y;
            model.position.y -= yOffset;
            model.updateMatrixWorld(true);
        }

        const meshes: THREE.Mesh[] = [];
        model.traverse((child: any) => {
            if (child.isMesh) {
                meshes.push(child);
            }
        });

        this.optimizeMeshes(meshes, model === this.humanModel);
    }

    private optimizeMeshes(meshes: THREE.Mesh[], isMainModel: boolean): void {
        const batchSize = 50;
        for (let i = 0; i < meshes.length; i += batchSize) {
            const batch = meshes.slice(i, i + batchSize);
            if ('requestIdleCallback' in window) {
                (window as any).requestIdleCallback(() => this._processMeshBatch(batch, isMainModel));
            } else {
                setTimeout(() => this._processMeshBatch(batch, isMainModel), 0);
            }
        }
    }

    private _processMeshBatch(meshes: THREE.Mesh[], isMainModel: boolean): void {
        meshes.forEach(mesh => {
            mesh.castShadow = false;
            mesh.receiveShadow = false;
            mesh.frustumCulled = this.frustumCulling;
            mesh.matrixAutoUpdate = false;
            mesh.updateMatrix();

            if (!isMainModel) {
                this._setupBVHForMesh(mesh);
            } else {
                mesh.userData.mainModel = this.humanModel;
            }

            if (mesh.geometry) {
                this._optimizeGeometry(mesh.geometry);
                if (mesh.material) {
                    this._optimizeMaterial(mesh.material);
                }
            }
        });
    }

    private _optimizeGeometry(geometry: THREE.BufferGeometry): void {
        if (!geometry.boundingSphere) geometry.computeBoundingSphere();
        if (!geometry.boundingBox) geometry.computeBoundingBox();
        if (!geometry.attributes.normal) geometry.computeVertexNormals();
        if ((geometry.attributes as any).uv2) geometry.deleteAttribute('uv2');
    }

    private _optimizeMaterial(material: THREE.Material | THREE.Material[]): void {
        const materials = Array.isArray(material) ? material : [material];
        materials.forEach(mat => {
            mat.needsUpdate = true;
            if (mat instanceof THREE.MeshStandardMaterial || mat instanceof THREE.MeshPhysicalMaterial) {
                if (!mat.transparent) mat.alphaTest = 0;
                (mat as any).precision = 'mediump';
                mat.dithering = false;
            }
            const materialKey = this._getMaterialKey(mat);
            if (!this.materialPool.has(materialKey)) {
                this.materialPool.set(materialKey, mat);
            }
        });
    }

    private _setupBVHForMesh(mesh: THREE.Mesh): void {
        if (!this.bvhEnabled || !mesh.geometry) return;

        try {

            if (!this.bvhPatched) {
                const geoProto = Object.getPrototypeOf(mesh.geometry);
                if (typeof geoProto.computeBoundsTree !== 'function') {
                    console.log("Applying BVH functions to BufferGeometry prototype at runtime.")
                    geoProto.computeBoundsTree = computeBoundsTree;
                    geoProto.disposeBoundsTree = disposeBoundsTree;
                }

                const meshProto = Object.getPrototypeOf(mesh);
                if (meshProto.raycast !== acceleratedRaycast) {
                    meshProto.raycast = acceleratedRaycast;
                }
                this.bvhPatched = true;
            }
            const geometry = mesh.geometry as any;


            if (!geometry.boundsTree) {
                geometry.computeBoundsTree({ strategy: SAH, maxLeafTris: 10, verbose: false });
                if (geometry.boundsTree) {
                    this.geometryBVH.set(mesh.uuid, geometry.boundsTree);
                    mesh.userData.hasBVH = true;
                } else {
                    console.warn('failed to create bounds tree');
                    mesh.userData.hasBVH = false;
                }
            } else {
                mesh.userData.hasBVH = true;
            }
        } catch (error) {
            console.warn('BVH setup failed:', error);
            mesh.userData.hasBVH = false;
        }
    }

    private _disposeBVHResources(): void {
        this.geometryBVH.clear();

        // 定义一个可重用的清理函数
        const disposeModelBVH = (model: THREE.Group | null) => {
            if (!model) return;

            model.traverse((child: any) => {
                if (child.isMesh) {
                    // 检查并释放BVH资源
                    if (child.geometry?.boundsTree) {
                        child.geometry.disposeBoundsTree();
                    }
                }
            });
        };

        // 1. 清理主模型的BVH（以防万一有）
        disposeModelBVH(this.humanModel);

        // 2.【核心修正】遍历并清理所有损伤模型的BVH
        this.damageModels.forEach((damageModel, partId) => {
            console.log(`Disposing BVH resources for damage model: ${partId}`);
            disposeModelBVH(damageModel);
        });

        console.log('All BVH resources disposed.');
    }

    private _forceInitialRender(): void {

        this.renderer.render(this.scene, this.camera);
        this.css2dRenderer.render(this.scene, this.camera);
    }

    private _cleanMaterial(material: THREE.Material | THREE.Material[]): void {
        if (!material) return;
        if (Array.isArray(material)) {
            material.forEach(mat => this._cleanMaterial(mat));
        } else {
            material.dispose();
            for (const key of Object.keys(material)) {
                const value = material[key as keyof typeof material]
                if (this.isTexture(value)) {
                    value.dispose();
                }
            }
        }
    }

    private isTexture(value: unknown): value is THREE.Texture {
        return value !== null
            && typeof value === 'object'
            && 'dispose' in value
            && 'isTexture' in value
            && (value as THREE.Texture).isTexture;
    }

    private _getMaterialKey(material: any): string {
        if (material.isMeshStandardMaterial) {
            return `standard_${material.color.getHexString()}_${material.metalness}_${material.roughness}`;
        } else if (material.isMeshBasicMaterial) {
            return `basic_${material.color.getHexString()}`;
        }
        return `material_${material.uuid}`;
    }
    //#endregion

    //#region 事件处理与杂项   
    private _handleResize(): void {
        this.updateRenderSize(this.canvas.clientWidth, this.canvas.clientHeight);
    }

    private _temporaryPerformanceMode(_mode: 'high' | 'medium' | 'low') {
        // A method to temporarily set a mode without changing the base `performanceMode`
    }
    private _restorePerformanceMode() {
        this._applyPerformanceMode(); // Restore to the original mode
    }

    public getPerformanceStats(): any {
        const avgFrameTime = this.frameTimeHistory.length > 0 ? this.frameTimeHistory.reduce((a, b) => a + b, 0) / this.frameTimeHistory.length : 16;
        return {
            mode: this.performanceMode,
            avgFPS: Math.round(1000 / avgFrameTime),
            triangles: this.renderer.info.render.triangles,
            pixelRatio: this.renderer.getPixelRatio(),
            bvhEnabled: this.bvhEnabled,
            activeBVHCount: this.geometryBVH.size,
        };
    }

    public setPerformanceMode(mode: 'high' | 'medium' | 'low'): void {
        if (this.performanceMode !== mode) {
            this.performanceMode = mode;
            this._applyPerformanceMode();
            console.log('Performance mode manually set to:', mode);
        }
    }
    //#endregion
    // #endregion
}