//@ts-ignore
import * as THREE from 'three';
import { ITool } from '../utils/BaseTool';
import { InteractionEvent, ToolMode, IInteractionManager, ISceneController, IEventEmitter } from '../types/webgl-marking';

/* 管理用户输入事件并分发给当前激活的工具 */
export class InteractionManager implements IInteractionManager {
    private canvas: HTMLCanvasElement;
    private sceneController: ISceneController;
    private tools: Map<ToolMode, ITool> = new Map();
    private activeTool: ITool | null = null;
    private eventEmitter: IEventEmitter;

    // 绑定事件处理器，确保 `this` 指向正确
    private _handlePointerDown = this.handlePointerDown.bind(this);
    private _handlePointerMove = this.handlePointerMove.bind(this);
    private _handlePointerUp = this.handlePointerUp.bind(this);
    private _handleMouseLeave = this.handleMouseLeave.bind(this);
    private _handleContextMenu = this.handleContextMenu.bind(this);
    private _handleWheel = this.handleWheel.bind(this);
    private _handleKeyDown = this.handleKeyDown.bind(this);

    constructor(sceneController: ISceneController, eventEmitter: IEventEmitter) {
        this.sceneController = sceneController;
        this.eventEmitter = eventEmitter;
        this.canvas = sceneController.renderer.domElement;
        this.addEventListeners();

        this.eventEmitter.on('toolModeChangeRequested', ({ mode }) => {
            this.setActiveTool(mode);
        });
    }

    /** 注册一个工具 */
    public registerTool(tool: ITool): void {
        this.tools.set(tool.getMode(), tool);
        // console.log(`Tool registered: ${tool.getMode()}`);
    }

    /** 激活指定的工具 */
    public setActiveTool(mode: ToolMode): void {
        const newTool = this.tools.get(mode);
        if (!newTool || newTool === this.activeTool) {
            return;
        }

        this.activeTool?.deactivate();
        this.activeTool = newTool;
        this.activeTool.activate();
        console.log(`Tool activated: ${mode}`);
    }

    /** 获取当前激活的工具 */
    public getActiveTool(): ITool | null {
        return this.activeTool;
    }

    /** 获取所有注册的工具 */
    public getAllTools(): Map<ToolMode, ITool> {
        return this.tools;
    }

    /** 重置所有工具的预览状态 - 在新模型加载后调用 */
    public resetAllToolPreviews(): void {
        this.tools.forEach((tool, mode) => {
            // 检查工具是否有 resetPreview 方法
            if (typeof (tool as any).resetPreview === 'function') {
                (tool as any).resetPreview();
                console.log(`Reset preview for tool: ${mode}`);
            }
        });
    }

    /** 添加事件监听器 */
    private addEventListeners(): void {
        this.canvas.addEventListener('pointerdown', this._handlePointerDown);
        this.canvas.addEventListener('pointermove', this._handlePointerMove);
        this.canvas.addEventListener('pointerup', this._handlePointerUp);
        this.canvas.addEventListener('mouseleave', this._handleMouseLeave);
        this.canvas.addEventListener('contextmenu', this._handleContextMenu);
        this.canvas.addEventListener('wheel', this._handleWheel, { passive: false });
        this.canvas.addEventListener('keydown', this._handleKeyDown);

    }

    /** 移除事件监听器 */
    private removeEventListeners(): void {
        this.canvas.removeEventListener('pointerdown', this._handlePointerDown);
        this.canvas.removeEventListener('pointermove', this._handlePointerMove);
        this.canvas.removeEventListener('pointerup', this._handlePointerUp);
        this.canvas.removeEventListener('mouseleave', this._handleMouseLeave);
        this.canvas.removeEventListener('contextmenu', this._handleContextMenu);
        this.canvas.removeEventListener('wheel', this._handleWheel);
        this.canvas.removeEventListener('keydown', this._handleKeyDown);
    }

    /** 创建交互事件对象 */
    private createInteractionEvent(event: MouseEvent | KeyboardEvent | WheelEvent): InteractionEvent {
        const interactionEvent: InteractionEvent = { originalEvent: event };

        if (event instanceof MouseEvent || event instanceof WheelEvent) {
            const rect = this.canvas.getBoundingClientRect();
            const pointer = new THREE.Vector2(
                ((event.clientX - rect.left) / rect.width) * 2 - 1,
                -((event.clientY - rect.top) / rect.height) * 2 + 1
            );
            interactionEvent.pointer = pointer;

            //获取当前应该被投射的激活模型
            const activeModel = this.sceneController.activeModelForRaycasting;
            // Perform Raycasting
            if (this.sceneController.camera && activeModel) {
                this.sceneController.raycaster.setFromCamera(pointer, this.sceneController.camera);

                const intersects = this.sceneController.raycaster.intersectObject(activeModel, true);
                if (intersects.length > 0) {
                    interactionEvent.intersection = intersects[0];
                } 
            }
        }
        return interactionEvent;
    }

    // --- 事件处理器 ---

    private handlePointerDown(event: MouseEvent): void {
        const interactionEvent = this.createInteractionEvent(event);
        this.activeTool?.onPointerDown(interactionEvent);
    }

    private handlePointerMove(event: MouseEvent): void {
        const interactionEvent = this.createInteractionEvent(event);
        this.activeTool?.onPointerMove(interactionEvent);
    }

    private handlePointerUp(event: MouseEvent): void {
        const interactionEvent = this.createInteractionEvent(event);
        this.activeTool?.onPointerUp?.(interactionEvent);
    }

    private handleContextMenu(event: MouseEvent): void {
        const interactionEvent = this.createInteractionEvent(event);
        this.activeTool?.onContextMenu?.(interactionEvent);
    }

    private handleWheel(event: WheelEvent): void {
        const interactionEvent = this.createInteractionEvent(event);
        this.activeTool?.onWheel?.(interactionEvent);
    }

    private handleKeyDown(event: KeyboardEvent): void {
        const interactionEvent = this.createInteractionEvent(event);
        this.activeTool?.onKeyDown?.(interactionEvent);
    }

    private handleMouseLeave(event: MouseEvent): void {
        const interactionEvent = this.createInteractionEvent(event);
        delete interactionEvent.intersection;
        this.activeTool?.onPointerMove(interactionEvent);
    }

    /** 释放资源 */
    public dispose(): void {
        this.removeEventListeners();
        this.tools.forEach(tool => tool.dispose());
        this.tools.clear();
        this.activeTool = null;
    }
}