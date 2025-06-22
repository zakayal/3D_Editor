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

    private canvas: HTMLCanvasElement;
    private modelPath: string;
    private mtlPath?: string;
    private scaleBarModelPath: string;

    public targetModel: THREE.Group | null = null;
    public scaleBarBaseModel: THREE.Group | null = null;

    private objLoader = new OBJLoader();
    private mtlLoader = new MTLLoader();
    private gltfLoader = new GLTFLoader();

    private onLoadCallback?: () => void;
    private onErrorCallback?: (error: any) => void;

    // 优化性能相关属性
    private frustumCulling: boolean = true;
    private lastCameraUpdate: number = 0;
    private cameraUpdateThreshold: number = 16;
    private isControlsChanged: boolean = false;
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
    private bvhPatched:boolean = false;
    
    // 高级LOD相关
    private lodEnabled: boolean = false;
    private lodDistanceThreshold: number = 15;
    private lodLevels: { [key: string]: number } = {
        high: 1.0,
        medium: 0.6,
        low: 0.3
    };
    
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

    private _initScene(): THREE.Scene {
        const scene = new THREE.Scene();
        // 新增：场景优化
        scene.matrixAutoUpdate = false; // 禁用自动矩阵更新
        return scene;
    }

    private _initCamera(): THREE.PerspectiveCamera {
        const aspectRatio = this.canvas.clientWidth / this.canvas.clientHeight;
        const camera = new THREE.PerspectiveCamera(45, aspectRatio, 0.1, 1000);
        camera.position.set(-4, 3, 6);
        
        // 新增：相机优化
        camera.matrixAutoUpdate = true; // 相机需要自动更新
        this.scene.add(camera);
        return camera;
    }

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
            this.isControlsChanged = true;
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
            (THREE.Mesh.prototype as any).raycast = function(raycaster: THREE.Raycaster, intersects: THREE.Intersection[]) {
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

    private _initializeAdvancedOptimizations(): void {
        this._setupAdaptiveRendering();
        
    }
    
    private _setupAdaptiveRendering(): void {
        if ('memory' in performance) {
            const memInfo = (performance as any).memory;
            if (memInfo.usedJSHeapSize / memInfo.totalJSHeapSize > 0.8) {
                this.performanceMode = 'medium';
                console.log('检测到内存压力，切换到中等性能模式');
            }
        }
    }

    private _addLights(): void {
        const ambientLight = new THREE.AmbientLight(0xffffff, 2);
        this.scene.add(ambientLight);
        const directionalLight = new THREE.DirectionalLight(0xffffff, 2);
        directionalLight.position.set(1, 2, 3);
        directionalLight.castShadow = false;
        this.scene.add(directionalLight);
    }

    public async loadAssets(onLoad: () => void, onError: (error: any) => void): Promise<void> {
        this.onLoadCallback = onLoad;
        this.onErrorCallback = onError;

        const objLoader = this.objLoader;
        const gltfLoader = this.gltfLoader;

        try {
            let loadedObjectModel: THREE.Group;

            if (this.mtlPath) {
                const materials = await this.mtlLoader.loadAsync(this.mtlPath);
                materials.preload();
                (objLoader as any).setMaterials(materials);
            }

            loadedObjectModel = await objLoader.loadAsync(this.modelPath) as THREE.Group;
            this.targetModel = loadedObjectModel;
            this._setupModel(this.targetModel, true);
            this.scene.add(this.targetModel);

            this.resetCameraToFitModel();

            const gltf = await gltfLoader.loadAsync(this.scaleBarModelPath);
            this.scaleBarBaseModel = gltf.scene;
            this._setupModel(this.scaleBarBaseModel, false);

            
            
            this.onLoadCallback?.();
            this.startRendering();

            this.isControlsChanged = true;
            this._forceInitialRender();
        } catch (error) {
            console.error("Error loading assets:", error);
            this.onErrorCallback?.(error);
        }
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

    public removeTargetModel(): void {
        if (this.targetModel) {
            
            this.targetModel.traverse((child: any) => {
                if (child.isMesh) {
                    child.geometry?.dispose();
                    this._cleanMaterial(child.material);
                }
            });
            this.scene.remove(this.targetModel);
            this.targetModel = null;
        }
    }

    public resetCameraToFitModel(): void {
        if (this.targetModel) {
            const box = new THREE.Box3().setFromObject(this.targetModel);
            const size = box.getSize(new THREE.Vector3());
            const center = box.getCenter(new THREE.Vector3());

            const maxDim = Math.max(size.x, size.y, size.z);
            const distance = maxDim * 2.5;

            const cameraY = Math.max(center.y + distance * 0.4, distance * 0.3);

            this.camera.position.set(
                center.x - distance * 0.8,
                cameraY,
                center.z + distance * 1.2
            );

            const lookAtTarget = new THREE.Vector3(center.x, center.y * 0.3, center.z);
            this.camera.lookAt(lookAtTarget);

            this.orbitControls.target.copy(lookAtTarget);
            this.orbitControls.update();
        }
    }

    public async loadNewTargetModel(modelUrl: string, mtlUrl?: string): Promise<THREE.Group> {
        this.removeTargetModel();
        console.log(`Loading new model from: ${modelUrl}`);
        if (mtlUrl) console.log(`With MTL materials from: ${mtlUrl}`);

        THREE.Cache.clear();

        try {
            const objLoader = new OBJLoader();

            if (mtlUrl) {
                const materials = await this.mtlLoader.loadAsync(mtlUrl);
                materials.preload();
                (objLoader as any).setMaterials(materials);
            }

            const loadedObjectModel = await objLoader.loadAsync(modelUrl);
            this.targetModel = loadedObjectModel as THREE.Group;

            this._setupModel(this.targetModel, true);
            this.scene.add(this.targetModel);
            this.resetCameraToFitModel();

            console.log('New model loaded successfully.');
            return this.targetModel;

        } catch (error) {
            console.error("Error loading new target model:", error);
            this.targetModel = null;
            throw error;
        }
    }

    public async loadNewGLBTargetModel(modelUrl: string): Promise<THREE.Group> {
        this.removeTargetModel();
        console.log(`Loading new GLB model from: ${modelUrl}`);

        try {
            const gltf = await this.gltfLoader.loadAsync(modelUrl);
            this.targetModel = gltf.scene;

            this._setupModel(this.targetModel, true);
            this.scene.add(this.targetModel);
            this.resetCameraToFitModel();

            console.log('New GLB model loaded successfully.');
            return this.targetModel;

        } catch (error) {
            console.error("Error loading new GLB target model:", error);
            this.targetModel = null;
            throw error;
        }
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

        this.optimizeMeshes(meshes, model === this.targetModel);
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

            if (isMainModel) {
                mesh.userData.mainModel = this.targetModel;
                this._setupBVHForMesh(mesh);
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
    
    private _getMaterialKey(material: any): string {
        if (material.isMeshStandardMaterial) {
            return `standard_${material.color.getHexString()}_${material.metalness}_${material.roughness}`;
        } else if (material.isMeshBasicMaterial) {
            return `basic_${material.color.getHexString()}`;
        }
        return `material_${material.uuid}`;
    }

    private _handleResize(): void {
        this.updateRenderSize(this.canvas.clientWidth, this.canvas.clientHeight);
    }

    public updateRenderSize(width: number, height: number): void {
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(width, height);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
        this.css2dRenderer.setSize(width, height);
    }

    public getTargetMeshGeometry(): THREE.BufferGeometry | null {
        if (this.targetModel) {
            let mesh: THREE.Mesh | null = null;
            this.targetModel.traverse((child: any) => {
                if (!mesh && child.isMesh && child.geometry?.isBufferGeometry) {
                    mesh = child;
                }
            });
            return mesh ? (mesh as THREE.Mesh).geometry as THREE.BufferGeometry : null;
        }
        console.warn("[SceneController] getTargetMeshGeometry: targetModel is null.");
        return null;
    }

    public getTargetMeshWorldMatrix(): THREE.Matrix4 | null {
        if (this.targetModel) {
            let mesh: THREE.Mesh | null = null;
            this.targetModel.traverse((child: any) => {
                if (!mesh && child.isMesh && child.geometry?.isBufferGeometry) {
                    mesh = child;
                }
            });
            return mesh ? (mesh as THREE.Mesh).matrixWorld : null;
        }
        console.warn("[SceneController] getTargetMeshWorldMatrix: targetModel is null.");
        return null;
    }
    
    // --- Render Loop and Optimizations ---

    public startRendering(): void {
        this._initializePerformanceOptimizations();
        this._renderLoop();
    }

    private _renderLoop = (): void => {
        const currentTime = performance.now();
        
        this.stats.begin();
        
        if (this._shouldSkipFrame(currentTime)) {
            this.stats.end();
            requestAnimationFrame(this._renderLoop);
            return;
        }
        
        this._smartCameraUpdate(currentTime);
        this._performanceMonitoring(currentTime);
        this._smartRenderQualityAdjustment(currentTime);
        this._optimizedFrustumCulling();
        this._manageLOD();
        this._conditionalRender();
        
        this.stats.end();
        requestAnimationFrame(this._renderLoop);
    }
    
    //currentTime 设计是用来实现帧率控制的，但是目前没有实现
    private _shouldSkipFrame(_currentTime: number): boolean {
        // 当相机控制被禁用时（工具激活时）不跳过帧，确保工具预览正常显示
        if (!this.orbitControls.enabled) {
            return false;
        }
        
        if (this.controlsOptimization.isMoving && this.renderOptimization.skipFrames > 0) {
            if (this.renderOptimization.skipFrames % 2 === 0) {
                this.renderOptimization.skipFrames--;
                return true;
            }
            this.renderOptimization.skipFrames--;
        }
        return false;
    }
    
    private _smartCameraUpdate(currentTime: number): void {
        if (!this.orbitControls.enabled) return;
        if (this.isControlsChanged || currentTime - this.lastCameraUpdate > this.cameraUpdateThreshold) {
            this.orbitControls.update();
            this.lastCameraUpdate = currentTime;
            this.isControlsChanged = false;
        }
    }
    
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

    private _conditionalRender(): void {
        const shouldRender = this.isControlsChanged || 
                           this.controlsOptimization.isMoving ||
                           this.controlsOptimization.isDragging ||
                           this.renderOptimization.lowQualityMode ||
                           !this.orbitControls.enabled; // 新增：当相机控制被禁用时（工具激活时）强制渲染
        
        if (shouldRender) {
            this.renderer.render(this.scene, this.camera);
        }
        
        this.css2dRenderer.render(this.scene, this.camera);
    }
    
    private _optimizedFrustumCulling(): void {
        if (!this.frustumCullingOptimization.enabled) return;
        
        // 当相机控制被禁用时（工具激活时）跳过视锥体裁剪，避免工具预览被隐藏
        if (!this.orbitControls.enabled) return;
        
        this.frustumCullingOptimization.frameCounter++;
        if (this.frustumCullingOptimization.frameCounter % this.frustumCullingOptimization.checkInterval !== 0) {
            return;
        }

        const frustum = new THREE.Frustum();
        const cameraMatrix = new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
        frustum.setFromProjectionMatrix(cameraMatrix);

        this.scene.traverse((child: THREE.Object3D) => {
            if ((child as THREE.Mesh).isMesh) {
                const mesh = child as THREE.Mesh;
                if (mesh.geometry?.boundingSphere) {
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

    private _setupBVHForMesh(mesh: THREE.Mesh): void {
        if (!this.bvhEnabled || !mesh.geometry) return;
        
        try {

            if(!this.bvhPatched)
            {
                const geoProto = Object.getPrototypeOf(mesh.geometry);
                if (typeof geoProto.computeBoundsTree !== 'function') {
                    console.log("Applying BVH functions to BufferGeometry prototype at runtime.")
                    geoProto.computeBoundsTree = computeBoundsTree;
                    geoProto.disposeBoundsTree = disposeBoundsTree;
                }

                const meshProto = Object.getPrototypeOf(mesh);
                if(meshProto.raycast !== acceleratedRaycast)
                {
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
            if (this.lodEnabled) this._setupAdvancedLODForMesh(mesh);
        } catch (error) {
            console.warn('BVH setup failed:', error);
            mesh.userData.hasBVH = false;
        }
    }
    
    private _setupAdvancedLODForMesh(mesh: any): void {
        if (!this.lodEnabled || !mesh.geometry) return;
        mesh.userData.originalGeometry = mesh.geometry;
        mesh.userData.currentLOD = 'high';
        mesh.userData.lodCache = new Map();
        this._precomputeLODLevels(mesh);
    }
    
    private _precomputeLODLevels(mesh: any): void {
        const originalGeometry = mesh.geometry;
        const lodCache = mesh.userData.lodCache;
        Object.keys(this.lodLevels).forEach(level => {
            if (level === 'high') {
                lodCache.set(level, originalGeometry);
                return;
            }
            const targetRatio = this.lodLevels[level];
            const simplifiedGeometry = this._createSimplifiedGeometry(originalGeometry, targetRatio);
            if (simplifiedGeometry) {
                try {
                    (simplifiedGeometry as any).computeBoundsTree({ strategy: SAH, maxLeafTris: 5, verbose: false });
                } catch (error) {
                    console.warn(`LOD level ${level} BVH build failed:`, error);
                }
                lodCache.set(level, simplifiedGeometry);
            }
        });
    }
    
    private _createSimplifiedGeometry(originalGeometry: THREE.BufferGeometry, targetRatio: number): THREE.BufferGeometry | null {
       // Placeholder for a proper mesh simplification algorithm (like one from three.js examples)
       // This is a naive implementation for demonstration purposes.
       if (targetRatio >= 1.0) return originalGeometry;
       const originalPositions = originalGeometry.attributes.position.array;
       const vertexCount = originalPositions.length / 3;
       const targetVertexCount = Math.floor(vertexCount * targetRatio);
       const step = Math.floor(vertexCount / targetVertexCount);
       const newPositions = [];
       for (let i = 0; i < vertexCount; i+= step) {
           newPositions.push(originalPositions[i*3], originalPositions[i*3+1], originalPositions[i*3+2]);
       }
       const simplifiedGeometry = new THREE.BufferGeometry();
       simplifiedGeometry.setAttribute('position', new THREE.Float32BufferAttribute(newPositions, 3));
       simplifiedGeometry.computeVertexNormals();
       return simplifiedGeometry;
    }
    
    private _manageLOD(): void {
        if (!this.lodEnabled || !this.targetModel) return;
        
        const cameraPosition = this.camera.position;
        this.targetModel.traverse((child: any) => {
            if (child.isMesh && child.userData.hasBVH && child.userData.lodCache) {
                const distance = cameraPosition.distanceTo(child.position);
                this._updateMeshLODLevel(child, distance);
            }
        });
    }
    
    private _updateMeshLODLevel(mesh: any, distance: number): void {
        let targetLOD: string;
        if (distance < this.lodDistanceThreshold) targetLOD = 'high';
        else if (distance < this.lodDistanceThreshold * 2.5) targetLOD = 'medium';
        else targetLOD = 'low';
        
        if (mesh.userData.currentLOD !== targetLOD) {
            this._applyLODToMesh(mesh, targetLOD);
            mesh.userData.currentLOD = targetLOD;
        }
    }
    
    private _applyLODToMesh(mesh: any, lodLevel: string): void {
        const lodCache = mesh.userData.lodCache;
        if (!lodCache) return;
        const targetGeometry = lodCache.get(lodLevel);
        if (targetGeometry && targetGeometry !== mesh.geometry) {
            mesh.geometry = targetGeometry;
        }
    }
    
    private _initializePerformanceOptimizations(): void {
        this._applyPerformanceMode();
        this.renderer.info.autoReset = false;
        console.log('Performance optimizations initialized. Mode:', this.performanceMode);
    }
    
    private _temporaryPerformanceMode(mode: 'high' | 'medium' | 'low') {
        // A method to temporarily set a mode without changing the base `performanceMode`
    }
    private _restorePerformanceMode() {
        this._applyPerformanceMode(); // Restore to the original mode
    }

    public setPerformanceMode(mode: 'high' | 'medium' | 'low'): void {
        if (this.performanceMode !== mode) {
            this.performanceMode = mode;
            this._applyPerformanceMode();
            console.log('Performance mode manually set to:', mode);
        }
    }
    
    private _applyPerformanceMode(): void {
        switch (this.performanceMode) {
            case 'low':
                this.adaptivePixelRatio = 0.75;
                this.cameraUpdateThreshold = 32;
                this.renderer.setPixelRatio(Math.min(1, window.devicePixelRatio * this.adaptivePixelRatio));
                break;
            case 'medium':
                this.adaptivePixelRatio = 1.0;
                this.cameraUpdateThreshold = 20;
                this.renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio * this.adaptivePixelRatio));
                break;
            case 'high':
                this.adaptivePixelRatio = 1.0;
                this.cameraUpdateThreshold = 16;
                this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
                break;
        }
    }

    public getPerformanceStats(): any {
        const avgFrameTime = this.frameTimeHistory.length > 0 ? this.frameTimeHistory.reduce((a, b) => a + b, 0) / this.frameTimeHistory.length : 16;
        return {
            mode: this.performanceMode,
            avgFPS: Math.round(1000 / avgFrameTime),
            triangles: this.renderer.info.render.triangles,
            pixelRatio: this.renderer.getPixelRatio(),
            lodEnabled: this.lodEnabled,
            bvhEnabled: this.bvhEnabled,
            activeBVHCount: this.geometryBVH.size,
        };
    }
    
    public setBVHEnabled(enabled: boolean): void {
        this.bvhEnabled = enabled;
    }
    
    public setLODEnabled(enabled: boolean): void {
        this.lodEnabled = enabled;
    }
    
    public setLODDistanceThreshold(distance: number): void {
        this.lodDistanceThreshold = Math.max(5, distance);
    }
    
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
        this.removeTargetModel();
    }
    
    /**
     * 强制进行一次渲染 - 供工具在更新预览时调用
     */
    public forceRender(): void {
        this.renderer.render(this.scene, this.camera);
        this.css2dRenderer.render(this.scene, this.camera);
    }

    private _disposeBVHResources(): void {
        this.geometryBVH.clear();
        if (this.targetModel) {
            this.targetModel.traverse((child: any) => {
                if (child.isMesh) {
                    if (child.userData.hasBVH && child.geometry?.disposeBoundsTree) {
                        child.geometry.disposeBoundsTree();
                    }
                    if (child.userData.lodCache) {
                        child.userData.lodCache.forEach((geometry: any) => {
                            if (geometry !== child.userData.originalGeometry) {
                                geometry.dispose();
                            }
                        });
                        child.userData.lodCache.clear();
                    }
                }
            });
        }
        
    }
}