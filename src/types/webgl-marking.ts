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

/** API 事件监听器映射类型 */
export interface ApiListeners {
    annotationAdded: Annotation;
    annotationRemoved: { id: string };
    annotationSelected: { id: string; type: ToolMode; position: THREE.Vector3 };
    annotationDeselected: { id: string };
    modeChanged: { mode: ToolMode; enabled: boolean };
    measurementCompleted: Annotation | { area: number; triangles: number[]; isTempMeasurement?: boolean };
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

    highlightPartSelected: {}; // 载荷为空，仅用于通知UI按钮应变为“可用”
    highlightPartDeselected: {}; // 载荷为空，仅用于通知UI按钮应变为“禁用”
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
    targetModel: THREE.Group | null;
    scaleBarBaseModel: THREE.Group | null;

    loadAssets(onLoad: () => void, onError: (error: any) => void): Promise<void>;
    removeTargetModel(): void;
    loadNewTargetModel(modelUrl: string, mtlUrl?: string): Promise<THREE.Group>;
    loadNewGLBTargetModel(modelUrl: string): Promise<THREE.Group>; // <<< 新增这一行：用于加载 GLB/glTF
    startRendering(): void;
    dispose(): void;
    updateRenderSize(width: number, height: number): void;
    getTargetMeshGeometry(): THREE.BufferGeometry | null; // 新增：获取主模型几何体
    getTargetMeshWorldMatrix(): THREE.Matrix4 | null; // 新增：获取主模型世界矩阵
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
    initialize(sceneController: ISceneController): boolean; // 传入接口
    isReady(): boolean;
    getClosestVertexIndex(pointInWorld: THREE.Vector3): number | null;
    getClosestGraphVertexNearIntersection(intersection: THREE.Intersection): number | null;
    findShortestPath(startVertexIndex: number, endVertexIndex: number): THREE.Vector3[] | null;
    getGraphData(): MeshGraphData | null;
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
