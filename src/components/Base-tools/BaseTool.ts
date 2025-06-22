import { InteractionEvent, ToolMode, ISceneController, IAnnotationManager, IEventEmitter } from '../../types/webgl-marking'; 

/**
 * 定义所有工具必须实现的接口。
 */
export interface ITool {
    /** 获取工具的模式 */
    getMode(): ToolMode;

    /** 激活工具时调用 */
    activate(): void;

    /** 停用工具时调用 */
    deactivate(): void;

    /** 鼠标/指针按下时调用 */
    onPointerDown(event: InteractionEvent): void;

    /** 鼠标/指针移动时调用 */
    onPointerMove(event: InteractionEvent): void;

    /** 鼠标/指针抬起时调用 (可选) */
    onPointerUp?(event: InteractionEvent): void;

    /** 鼠标滚轮滚动时调用 (可选) */
    onWheel?(event: InteractionEvent): void;

    /** 键盘按下时调用 (可选) */
    onKeyDown?(event: InteractionEvent): void;

    /** 右键点击时调用 (可选) */
    onContextMenu?(event: InteractionEvent): void;

    /** 释放资源时调用 */
    dispose(): void;
}

/**
 * 提供工具所需的基本依赖和一些通用功能。
 * 具体工具可以继承此类，也可以直接实现 ITool 接口。
 */
export abstract class BaseTool implements ITool {
    protected sceneController: ISceneController;
    protected annotationManager: IAnnotationManager;
    protected eventEmitter: IEventEmitter;

    constructor(sceneController: ISceneController, annotationManager: IAnnotationManager, eventEmitter: IEventEmitter) {
        this.sceneController = sceneController;
        this.annotationManager = annotationManager;
        this.eventEmitter = eventEmitter;
    }

    abstract getMode(): ToolMode;
    
    // 修改 activate 方法以请求 canvas 焦点
    activate(): void {
        this.sceneController.renderer.domElement.focus();
    }

    abstract deactivate(): void;
    abstract onPointerDown(event: InteractionEvent): void;
    abstract onPointerMove(event: InteractionEvent): void;

    // 提供可选方法的默认空实现
    onPointerUp(_event: InteractionEvent): void {}
    onWheel(_event: InteractionEvent): void {}
    onKeyDown(_event: InteractionEvent): void {}
    // 当右键菜单事件发生时调用
    onContextMenu(event: InteractionEvent): void {
        // 默认阻止右键菜单
         (event.originalEvent as MouseEvent).preventDefault();
    }
    dispose(): void {}
}