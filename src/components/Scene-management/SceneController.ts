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


// 这个模块负责 Three.js 的基础设置、模型加载和渲染循环。


export class SceneController implements ISceneController {
    public renderer: THREE.WebGLRenderer;
    public css2dRenderer: CSS2DRenderer;
    public scene: THREE.Scene;
    public camera: THREE.PerspectiveCamera;
    public orbitControls: OrbitControls;
    public raycaster: THREE.Raycaster = new THREE.Raycaster();

    private canvas: HTMLCanvasElement;
    private modelPath: string;
    private mtlPath?: string; // 新增：MTL材质文件路径
    private scaleBarModelPath: string;

    public targetModel: THREE.Group | null = null;
    public scaleBarBaseModel: THREE.Group | null = null;

    private objLoader = new OBJLoader();
    private mtlLoader = new MTLLoader(); // 新增：MTL加载器
    private gltfLoader = new GLTFLoader();

    private onLoadCallback?: () => void;
    private onErrorCallback?: (error: any) => void;

    constructor(canvas: HTMLCanvasElement, modelPath: string, scaleBarModelPath: string, mtlPath?: string) {
        this.canvas = canvas;
        this.modelPath = modelPath;
        this.mtlPath = mtlPath; // 新增：存储MTL路径
        this.scaleBarModelPath = scaleBarModelPath;

        this.renderer = this._initRenderer();
        this.css2dRenderer = this._initCSS2DRenderer();
        this.scene = this._initScene();
        this.camera = this._initCamera();
        this.orbitControls = this._initControls();

        this._addLights();

        window.addEventListener('resize', this._handleResize.bind(this));
    }

    private _initRenderer(): THREE.WebGLRenderer {
        const renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            antialias: true,
            alpha: true
        });
        renderer.setSize(this.canvas.clientWidth, this.canvas.clientHeight);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.shadowMap.enabled = true;

        renderer.outputColorSpace = THREE.SRGBColorSpace;

        renderer.toneMapping = THREE.ACESFilmicToneMapping; // 模拟Filmic效果，或尝试 THREE.ReinhardToneMapping, THREE.LinearToneMapping 等
        renderer.toneMappingExposure = 1.0;
        return renderer;
    }

    private _initCSS2DRenderer(): CSS2DRenderer {
        const cssRenderer = new CSS2DRenderer();
        cssRenderer.setSize(this.canvas.clientWidth, this.canvas.clientHeight);
        cssRenderer.domElement.style.position = 'absolute';
        cssRenderer.domElement.style.top = '0px';
        cssRenderer.domElement.style.pointerEvents = 'none'; // Default to none
        if (this.canvas.parentElement) {
            this.canvas.parentElement.appendChild(cssRenderer.domElement);
        }
        return cssRenderer;
    }

    private _initScene(): THREE.Scene {
        return new THREE.Scene();
    }

    private _initCamera(): THREE.PerspectiveCamera {
        const aspectRatio = this.canvas.clientWidth / this.canvas.clientHeight;
        const camera = new THREE.PerspectiveCamera(45, aspectRatio, 0.1, 1000);
        camera.position.set(-4, 3, 6);
        this.scene.add(camera);
        return camera;
    }

    private _initControls(): OrbitControls {
        const controls = new OrbitControls(this.camera, this.renderer.domElement);
        controls.enableDamping = true;
        return controls;
    }

    private _addLights(): void {
        const ambientLight = new THREE.AmbientLight(0xffffff, 2);
        this.scene.add(ambientLight);
        const directionalLight = new THREE.DirectionalLight(0xffffff, 2);
        directionalLight.position.set(1, 2, 3);
        directionalLight.castShadow = true;
        directionalLight.shadow.normalBias = 0.04;
        this.scene.add(directionalLight);

    }


    public async loadAssets(onLoad: () => void, onError: (error: any) => void): Promise<void> {
        this.onLoadCallback = onLoad;
        this.onErrorCallback = onError;

        const objLoader = this.objLoader;
        const gltfLoader = this.gltfLoader;

        try {
            // Load Main Model with optional MTL materials
            let loadedObjectModel: THREE.Group;

            if (this.mtlPath) {
                // console.log('Loading MTL materials from:', this.mtlPath);
                // 加载MTL材质
                const materials = await this.mtlLoader.loadAsync(this.mtlPath);
                materials.preload(); // 预加载材质

                // 设置OBJ加载器使用MTL材质
                objLoader.setMaterials(materials);
            }

            // console.log('Loading OBJ model from:', this.modelPath);
            loadedObjectModel = await objLoader.loadAsync(this.modelPath) as THREE.Group;

            this.targetModel = loadedObjectModel;
            this._setupModel(this.targetModel, true);
            this.scene.add(this.targetModel);
            // console.log('OBJ model loaded successfully.', this.targetModel);


            // 重置相机位置以适合初始模型（重要：确保大体积模型能被看到）
            this.resetCameraToFitModel();

            // Load Scale Bar Model
            const gltf = await gltfLoader.loadAsync(this.scaleBarModelPath);
            this.scaleBarBaseModel = gltf.scene;
            this._setupModel(this.scaleBarBaseModel, false); // Don't add base to scene

            console.log('Assets loaded successfully.');
            this.onLoadCallback?.();
            this.startRendering();

        } catch (error) {
            console.error("Error loading assets:", error);
            //使用类型守卫

            this.onErrorCallback?.(error);

        }
    }

    /** 释放材质及其所有纹理 */
    private _cleanMaterial(material: THREE.Material | THREE.Material[]): void {
        if (!material) return;
        if (Array.isArray(material)) {
            material.forEach(mat => this._cleanMaterial(mat));
        } else {
            material.dispose();
            // 释放所有纹理属性
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

    /**
    * 移除当前的目标模型并释放其资源。
    */
    public removeTargetModel(): void {
        if (this.targetModel) {
            console.log("Removing current target model...");
            this.scene.remove(this.targetModel);

            // 释放几何体和材质
            this.targetModel.traverse((child: THREE.Object3D) => {
                const mesh = child as THREE.Mesh;
                if (mesh.isMesh) {
                    mesh.geometry?.dispose();
                    this._cleanMaterial(mesh.material);
                }
            });

            this.targetModel = null;
        }
    }

    /**
    * 重置相机位置以适合当前模型
    */
    public resetCameraToFitModel(): void {
        if (this.targetModel) {
            const box = new THREE.Box3().setFromObject(this.targetModel);
            const size = box.getSize(new THREE.Vector3());
            const center = box.getCenter(new THREE.Vector3());

            const maxDim = Math.max(size.x, size.y, size.z);
            const distance = maxDim * 2.5; // 增加距离以便更好地查看

            // 调整相机位置，确保能看到地面和模型
            // 相机位置要考虑到地面在y=0，模型底部也在y=0附近
            const cameraY = Math.max(center.y + distance * 0.4, distance * 0.3); // 确保相机有足够高度

            // 重置相机位置
            this.camera.position.set(
                center.x - distance * 0.8,
                cameraY,
                center.z + distance * 1.2
            );

            // 设置相机看向稍微偏下的位置，以便同时看到模型和地面
            const lookAtTarget = new THREE.Vector3(center.x, center.y * 0.3, center.z);
            this.camera.lookAt(lookAtTarget);

            // 重置控制器目标到调整后的位置
            this.orbitControls.target.copy(lookAtTarget);
            this.orbitControls.update();

            // console.log("[resetCameraToFitModel] Camera reset. Position:", this.camera.position.toArray(),
            //     "Target:", lookAtTarget.toArray(),
            //     "Distance:", distance,
            //     "Model center:", center.toArray(),
            //     "Model size:", size.toArray());
        }
    }

    /**
    * 加载并设置新的目标模型。
    * @param modelUrl - 新 OBJ 模型的 URL 或路径。
    * @param mtlUrl - 可选的 MTL 材质文件 URL 或路径。
    * @returns 返回一个 Promise，成功时解析为加载的模型，失败时拒绝。
    */
    public async loadNewTargetModel(modelUrl: string, mtlUrl?: string): Promise<THREE.Group> {
        // 1. 移除旧模型
        this.removeTargetModel();
        console.log(`Loading new model from: ${modelUrl}`);
        if (mtlUrl) {


            console.log(`With MTL materials from: ${mtlUrl}`);

        }

        //清空全局缓存,主要针对的mtl材质包
        THREE.Cache.clear();

        try {
            const objLoader = new OBJLoader();

            // 2. 如果有MTL文件，先加载材质
            if (mtlUrl) {
                console.log('Loading MTL materials for new model...');
                const materials = await this.mtlLoader.loadAsync(mtlUrl);
                materials.preload(); // 预加载材质
                objLoader.setMaterials(materials);
                console.log('MTL materials loaded and applied to new model loader');
            }

            // 3. 加载新模型
            const loadedObjectModel = await objLoader.loadAsync(modelUrl);
            this.targetModel = loadedObjectModel as THREE.Group;

            // 4. 设置新模型
            this._setupModel(this.targetModel, true); // 使用现有的设置方法
            this.scene.add(this.targetModel);

            // 5. 重置相机位置以适合新模型
            this.resetCameraToFitModel();

            console.log('New model loaded successfully.');
            return this.targetModel;

        } catch (error) {
            console.error("Error loading new target model:", error);
            this.targetModel = null; // 确保失败时 targetModel 为 null
            throw error;
        }
    }

    /**
* 加载并设置新的目标 GLB/glTF 模型。
* @param modelUrl - 新 GLB/glTF 模型的 URL 或路径。
* @returns 返回一个 Promise，成功时解析为加载的模型，失败时拒绝。
*/
    public async loadNewGLBTargetModel(modelUrl: string): Promise<THREE.Group> {
        // 1. 移除旧模型
        this.removeTargetModel();
        console.log(`Loading new GLB model from: ${modelUrl}`);

        try {
            // 2. 加载新 GLB/glTF 模型
            const gltf = await this.gltfLoader.loadAsync(modelUrl); // 使用成员变量 this.gltfLoader
            this.targetModel = gltf.scene;

            // 3. 设置新模型
            this._setupModel(this.targetModel, true); // 使用现有的设置方法
            this.scene.add(this.targetModel);

            // 4. 重置相机位置以适合新模型
            this.resetCameraToFitModel();

            console.log('New GLB model loaded successfully.');
            return this.targetModel;

        } catch (error) {
            console.error("Error loading new GLB target model:", error);
            this.targetModel = null; // 确保失败时 targetModel 为 null
            throw error;
        }
    }

    private _setupModel(model: THREE.Group, centerAndScale: boolean): void {
        // console.log("[_setupModel] Setting up model. centerAndScale:", centerAndScale);

        if (centerAndScale) {
            const box = new THREE.Box3().setFromObject(model);
            const center = box.getCenter(new THREE.Vector3());
            const size = box.getSize(new THREE.Vector3());
            const maxDim = Math.max(size.x, size.y, size.z);
            const scale = 1 / maxDim;

            // 先将模型中心移到原点
            model.position.sub(center);
            // console.log("[_setupModel] After centering, model position:", model.position.toArray());

            // 缩放模型
            model.scale.multiplyScalar(scale);
            // console.log("[_setupModel] After scaling, model scale:", model.scale.toArray());

            model.updateMatrixWorld(true);

            // 重新计算缩放后的边界框
            const newBox = new THREE.Box3().setFromObject(model);

            // 确保模型底部对齐到地面 (y = 0)
            const yOffset = newBox.min.y;
            model.position.y -= yOffset;
            model.updateMatrixWorld(true);
        }

        model.traverse((child: THREE.Object3D) => {
            if ((child as THREE.Mesh).isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;

                if (model === this.targetModel) {
                    child.userData.mainModel = this.targetModel;
                }
            }
        });
    }

    private _handleResize(): void {
        this.updateRenderSize(window.innerWidth, window.innerHeight);
    }

    public updateRenderSize(width: number, height: number): void {
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(width, height);
        this.renderer.setPixelRatio(Math.max(window.devicePixelRatio, 2));
        this.css2dRenderer.setSize(width, height);
    }

    public getTargetMeshGeometry(): THREE.BufferGeometry | null {
        if (this.targetModel) {
            let foundMesh: THREE.Mesh | null = null;
            this.targetModel.traverse((child: THREE.Object3D) => {
                if (foundMesh) return; // 找到后就退出

                if (child instanceof THREE.Mesh && child.geometry?.isBufferGeometry) {
                    foundMesh = child;
                }
            });
            return foundMesh ? (foundMesh as THREE.Mesh).geometry : null;
        }
        console.warn("[SceneController] getTargetMeshGeometry: targetModel is null.");
        return null;
    }

    public getTargetMeshWorldMatrix(): THREE.Matrix4 | null {
        if (this.targetModel) {
            let mesh: THREE.Mesh | null = null;
            this.targetModel.traverse((child: THREE.Object3D) => {
                if (!mesh && (child as THREE.Mesh).isMesh && (child as THREE.Mesh).geometry?.isBufferGeometry) {
                    mesh = child as THREE.Mesh;
                }
            });

            return mesh ? (mesh as THREE.Mesh).matrixWorld : null;
        }
        console.warn("[SceneController] getTargetMeshWorldMatrix: targetModel is null.");
        return null;
    }

    private _renderLoop = (): void => {
        this.orbitControls.update();
        this.renderer.render(this.scene, this.camera);
        this.css2dRenderer.render(this.scene, this.camera);
        requestAnimationFrame(this._renderLoop);
    }

    public startRendering(): void {
        this._renderLoop();
    }

    public dispose(): void {
        window.removeEventListener('resize', this._handleResize);

        this.renderer.dispose();
        if (this.css2dRenderer.domElement.parentElement) {
            this.css2dRenderer.domElement.parentElement.removeChild(this.css2dRenderer.domElement);
        }

        this.removeTargetModel();
        if (this.scaleBarBaseModel) {
            this.scaleBarBaseModel.traverse((child: THREE.Object3D) => {
                const mesh = child as THREE.Mesh;
                if (mesh.isMesh) {
                    mesh.geometry?.dispose();
                    if (Array.isArray(mesh.material)) {
                        mesh.material.forEach((m: THREE.Material) => m.dispose());
                    } else {
                        mesh.material?.dispose();
                    }
                }
            });
            // Note: scaleBarBaseModel is just a reference to a cloned scene, no need to remove from scene
            this.scaleBarBaseModel = null;
        }
    }
}