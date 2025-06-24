//@ts-ignore
import * as THREE from 'three';
//@ts-ignore
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

import { ITool } from '../components/Base-tools/BaseTool'; 

//@ts-ignore
declare module 'three/examples/jsm/renderers/CSS2DRenderer.js' {
    interface CSS2DObject {
        userData: any;
    }
}


/** 比例尺条目类型 */
export interface ScaleBarAnnotation {
    id: string;
    type: 'scale_bar';
    object3D: THREE.Group;
    normal: THREE.Vector3;
    tangent: THREE.Vector3;
    accumulatedRotation: number;
    deleteButton?: CSS2DObject; // UI 元素引用，考虑是否保留或移至 UI 层管理
}

/** 表面测量路径点 */
export interface SurfacePathPoint {
    position: THREE.Vector3;
    isMeshVertex: boolean;
    meshVertexIndex?: number;
}

/** 表面测量 (曲线) 类型 */
export interface SurfaceMeasurementAnnotation {
    id: string;
    type: 'surface_curve';
    userClickedPoints: THREE.Vector3[];

    pathPoints: THREE.Vector3[];
    visualCurvePoints?: THREE.Vector3[];
    length: number;
    savedLabelObject: CSS2DObject | null; // 新增：保存后的长度标签
    leaderLineObject: THREE.Line | null; // 新增：指示线
    curveLineObject: THREE.Line | null;
    deleteButton?: CSS2DObject;
    proxyObject?:THREE.Mesh;
}

/** 直线测量 (贯穿伤) 类型 */
export interface StraightMeasurementAnnotation {
    id: string;
    type: 'straight_line';
    startPoint: THREE.Vector3;
    endPoint: THREE.Vector3;
    length: number;
    lineObject: THREE.Line | null;
    startSphere: THREE.Mesh | null;
    endSphere: THREE.Mesh | null;
    lengthLabelObject: CSS2DObject | null;
    proxyObject?:THREE.Mesh;
    deleteButton?: CSS2DObject;
}

/** 面积测量 (Planimetering) 类型 */
export interface PlanimeteringAnnotation {
    id: string;
    type: 'planimetering';
    area: number;
    triangles: number[];
    timestamp: string;
    highlightMesh?: THREE.Mesh; // 高亮显示的网格
    deleteButton?: CSS2DObject;
    proxyObject?: THREE.Mesh; // 面积标签的代理对象
    groupProxyObject?: THREE.Mesh; // 组标签的代理对象
    firstClickPosition?: THREE.Vector3; // 第一次点击的位置
    areaLabelObject?: CSS2DObject; // 面积标签对象
    groupLabel?: CSS2DObject; // 组标签对象
    totalArea?: number; // 总面积（累计）
}

export interface HighlightAnnotation{
    id: string;
    type: 'highlight';
    name: string;
    labelObject: CSS2DObject | null;
    leaderLineObject: THREE.Line | null;
    proxyObject?: THREE.Mesh;
    materialKey: string;
}

/** 所有标注类型的联合 */
export type Annotation = ScaleBarAnnotation | SurfaceMeasurementAnnotation | StraightMeasurementAnnotation | PlanimeteringAnnotation | HighlightAnnotation;

/** 网格图数据结构 */
export interface MeshGraphData {
    vertices: THREE.Vector3[];
    adjacency: Map<number, { neighborIndex: number, weight: number }[]>;
}

/** 事件回调函数类型 */
export type EventCallback<T = any> = (data: T) => void;

export interface InjuryContext{
    id:string; //部位的唯一id，即partId
    name:string;
    creationTime:Date;//创建时间
    measurements:{
        //用于未来存储的累计测量数据
        cumulativeArea: number;
        cumulativeCurveLength: number;
        cumulativeStraightLength: number;
        bsaPercentage: number;
    }
}

/** API 事件监听器映射类型 */
export interface ApiListeners {
    annotationAdded: Annotation;
    annotationRemoved: { id: string };
    annotationSelected: { id: string; type: ToolMode; position: THREE.Vector3 };
    annotationDeselected: { id: string };
    modeChanged: { mode: ToolMode; enabled: boolean };
    measurementCompleted: Annotation | { area: number; triangles: number[]; lassoPath?: number[]; isTempMeasurement?: boolean };
    measurementCancelled: { cancelledArea: number; remainingArea: number; savedCount: number };
    measurementSaved: Annotation & { area: number; triangles: number[]; totalArea: number; savedCount: number };
    measurementsRestored: { count: number; totalArea: number; measurements: Array<{ triangles: number[]; area: number }> };
    error: { message: string; details?: any };
    notification: { message: string; type?: 'info' | 'warn' | 'error' };
    ready: boolean; 
    measurementUpdated: { length?: number; showControls: boolean; isMeasuring?: boolean; };
    toolModeChangeRequested: { mode: ToolMode };
    dijkstraReady: boolean;
    areaCalculationStarted: { triangleCount: number };
    areaCalculationCompleted: { area: number; triangleCount: number };
    
    //新增：当用户在主模型上选择一个有效的身体部位时触发
    partSelected: {partId: string; name: string};
    injuryContextAdded:{context:InjuryContext},

    createHighlightAnnotation: {}; // 载荷为空，仅作为一个指令
}

/** API 配置选项 */
export interface WebGLMarkingAPIConfig {
    modelPath: string;
    mtlPath?:string;
    scaleBarModelPath: string;
    // 可以添加更多配置项，如颜色、阈值等
    snapThreshold?: number;
    sphereRadius?: number;
}

/** 工具模式枚举 */
export enum ToolMode {
    Idle = 'idle', 
    ScaleBar = 'scale_bar',
    SurfaceMeasure = 'surface_curve',
    StraightMeasure = 'straight_line',
    Highlight = 'highlight',
    Planimetering = 'planimetering',
}

/** 交互事件数据 */
export interface InteractionEvent {
    originalEvent: MouseEvent | KeyboardEvent | WheelEvent;
    pointer?: THREE.Vector2; // 归一化的鼠标坐标
    intersection?: THREE.Intersection; // 与主模型的交点
}

// ============== 新增接口定义 ==============

// CanvasConfig 接口已在此文件中定义并导出

export interface CanvasConfig {
    container: string | HTMLElement;
    width?: number;
    height?: number;
    style?: {
        backgroundColor?: string;
        border?: string;
        borderRadius?: string;
        boxShadow?: string;
        /** 其他自定义样式 */
        [key: string]: string | undefined;
    };
    /** 画布HTML属性 */
    attributes?: {
        className?: string;
        id?: string;
        /** 其他HTML属性 */
        [key: string]: string | undefined;
    };
}

export interface ISceneController {
    renderer: THREE.WebGLRenderer;
    css2dRenderer: CSS2DRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    orbitControls: any; //类型设置为any，避免在接口文件中直接导入具体的控制器实现
    raycaster: THREE.Raycaster;
    scaleBarBaseModel: THREE.Group | null;

    //接口更新
    humanModel:THREE.Group | null;
    damageModels:Map<string,THREE.Group>;
    activeModelForRaycasting:THREE.Object3D | null;

    //签名方法
    loadAssets(onLoad: () => void, onError: (error: any) => void): Promise<void>;
    loadNewTargetModel(modelUrl: string, mtlUrl?: string): Promise<THREE.Group>;
    loadModelFromFile(modelUrl:string,mtlUrl?:string):Promise<THREE.Group>;

    //核心管理方法
    addDamageModel(partId:string,model:THREE.Group):void;
    removeDamageModel(partId:string):void;
    showHumanModel():void;
    showDamageModel(partId:string):void;

    startRendering(): void;
    dispose(): void;
    updateRenderSize(width: number, height: number): void;
    getTargetMeshGeometry(): THREE.BufferGeometry | null; // 新增：获取主模型几何体
    getTargetMeshWorldMatrix(): THREE.Matrix4 | null; // 新增：获取主模型世界矩阵
    
    // 性能优化相关方法
    setPerformanceMode(mode: 'high' | 'medium' | 'low'): void; // 手动设置性能模式
    getPerformanceStats(): { // 获取性能统计信息
        mode: string;
        avgFPS: number;
        triangles: number;
        pixelRatio: number;
        lodEnabled: boolean;
        bvhEnabled: boolean;
        activeBVHCount: number;
    };
    
    // BVH和LOD控制方法
    setBVHEnabled(enabled: boolean): void; // 启用/禁用BVH加速
}

export interface IAnnotationManager {
    addScaleBar(data: Omit<ScaleBarAnnotation, 'id' | 'type'>): ScaleBarAnnotation;
    addSurfaceMeasurement(data: Omit<SurfaceMeasurementAnnotation, 'id' | 'type'>): SurfaceMeasurementAnnotation;
    addStraightMeasurement(data: Omit<StraightMeasurementAnnotation, 'id' | 'type'>): StraightMeasurementAnnotation;
    addPlanimetering(data: Omit<PlanimeteringAnnotation, 'id' | 'type'>): PlanimeteringAnnotation;
    addHighlightAnnotation(data: Omit<HighlightAnnotation, 'id' | 'type'>): HighlightAnnotation;
    removeAnnotation(id: string): boolean;
    getAnnotation(id: string): Annotation | undefined;
    getAllAnnotations(): Annotation[];
    findAnnotationIdByObject(object3D: THREE.Object3D): string | null;
    removeAllAnnotations(): void;
    dispose(): void;
}

export interface IDijkstraService {
    // 为特定部位ID初始化图数据
    initializeForContext(partId: string, model: THREE.Group): boolean;
    
    // 检查特定上下文是否准备就绪
    isContextReady(partId: string): boolean;
    
    // 检查是否有任何图数据可用
    isReady(): boolean;
    
    // 上下文感知的方法，需要传入partId参数
    getClosestVertexIndex(pointInWorld: THREE.Vector3, partId: string): number | null;
    getClosestGraphVertexNearIntersection(intersection: THREE.Intersection, partId: string): number | null;
    findShortestPath(startVertexIndex: number, endVertexIndex: number, partId: string): THREE.Vector3[] | null;
    getGraphData(partId: string): MeshGraphData | null;
    
    // 上下文管理方法
    disposeContext(partId: string): void;
    getAllContexts(): string[];
    
    // 清理所有资源
    dispose(): void;
}

export interface IInteractionManager {
    registerTool(tool: ITool): void; 
    setActiveTool(mode: ToolMode): void;
    getActiveTool(): ITool | null;
    getAllTools(): Map<ToolMode, ITool>;
    resetAllToolPreviews(): void;
    dispose(): void;
}

export interface IEventEmitter {
    on<T extends keyof ApiListeners>(eventName: T, callback: EventCallback<ApiListeners[T]>): () => void;
    off<T extends keyof ApiListeners>(eventName: T, callback: EventCallback<ApiListeners[T]>): void;
    emit<T extends keyof ApiListeners>(eventName: T, data: ApiListeners[T]): void;
}

export interface IContextProvider {
    getCurrentContextPartId(): string | null;
}

export interface IPlanimetering {
    registerLassoFinishedCall(callback: (data: { triangles: number[]; area: number }) => void): void;
    registerEventEmitter(emitter: IEventEmitter): void;
    registerFirstClickCallback(callback: (position: THREE.Vector3) => void): void;
    startMeasurement(): void;
    exitMeasurement(): void;
    cancelMeasurement(): void;
    saveMeasurement(): void;
    dispose(): void;
    update(): void;
}
