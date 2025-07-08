
//@ts-ignore
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { BaseTool, ITool } from '../../utils/BaseTool';
import { InteractionEvent, ToolMode, ISceneController, IAnnotationManager, IEventEmitter } from '../../types/webgl-marking';

/**
 * 一个专门用于操作当前激活的损伤模型的工具，提供移动、旋转和缩放功能。
 */
export class TransformTool extends BaseTool implements ITool {
    private transformControls: TransformControls | null = null;

    // 绑定事件处理器以确保 `this` 指向正确
    private onDraggingChanged = this.handleDraggingChanged.bind(this);

    constructor(sceneController: ISceneController, annotationManager: IAnnotationManager, eventEmitter: IEventEmitter) {
        super(sceneController, annotationManager, eventEmitter);
    }

    getMode(): ToolMode {
        return ToolMode.Transform;
    }

    /**
     * 【新增】获取当前的 TransformControls 实例。
     * @returns {TransformControls | null}
     */
    public getControls(): TransformControls | null {
        return this.transformControls;
    }

    /**
     * 激活工具。
     * 工具被激活时，会自动尝试附加到当前激活的损伤模型上。
     */
    activate(): void {
        super.activate();
        console.log("TransformTool activated.");

        // 1. 获取目标对象
        const targetObject = this.sceneController.activeModelForRaycasting;

        console.log("TransformTool: 尝试附加的目标对象是:", targetObject);
        if (targetObject) {
            console.log("目标对象的名称:", targetObject.name);
            console.log("目标对象的类型:", targetObject.type); 
            console.log("目标对象是否可见:", targetObject.visible);
        }

        // 2. 验证目标对象
        if (!targetObject || targetObject === this.sceneController.humanModel) {
            console.warn("TransformTool: 目标不是一个有效的损伤模型，无法激活。");
            this.eventEmitter.emit('notification', { message: '请先进入一个损伤模型的"编辑"视图', type: 'warn' });
            this.eventEmitter.emit('toolModeChangeRequested', { mode: ToolMode.Idle });
            return;
        }

        // 3. 创建和配置 TransformControls
        this.transformControls = new TransformControls(this.sceneController.camera, this.sceneController.renderer.domElement);
        this.transformControls.addEventListener('dragging-changed', this.onDraggingChanged);

        // 4. 【关键修正】添加 helper 到场景中，而不是 TransformControls 本身
        this.sceneController.scene.add((this.transformControls as any).getHelper());
        
        // 5. 将控制器附加到目标对象上
        this.transformControls.attach(targetObject);

        // 默认设置为旋转模式
        this.transformControls.setMode('rotate');
    }

    /**
     * 停用工具。
     * 清理所有与 TransformControls 相关的资源和事件监听。
     */
    deactivate(): void {
        console.log("TransformTool deactivated.");

        if (this.transformControls) {
            this.transformControls.removeEventListener('dragging-changed', this.onDraggingChanged);
            this.transformControls.detach();
            this.sceneController.scene.remove((this.transformControls as any).getHelper());
            this.transformControls.dispose();
            this.transformControls = null;
        }

        this.sceneController.orbitControls.enabled = true;
    }

    /**
     * 处理 TransformControls 的拖拽状态变化事件，以解决与 OrbitControls 的控制权冲突。
     */
    private handleDraggingChanged(event: any): void {
        const isDragging = event.value;
        this.sceneController.orbitControls.enabled = !isDragging;
    }

    /**
     * 监听键盘事件，用于切换变换模式（移动/旋转/缩放）。
     */
    onKeyDown(event: InteractionEvent): void {
        if (!this.transformControls) return;

        const keyEvent = event.originalEvent as KeyboardEvent;
        switch (keyEvent.key.toLowerCase()) {
            case 't': // 移动
                this.transformControls.setMode('translate');
                break;
            case 'r': // 旋转
                this.transformControls.setMode('rotate');
                break;
            case 's': // 缩放
                this.transformControls.setMode('scale');
                break;
            case 'escape':
                // 按下 ESC 键退出变换工具，返回到 Idle 模式
                this.eventEmitter.emit('toolModeChangeRequested', { mode: ToolMode.Idle });
                break;
        }
    }

    onPointerDown(_event: InteractionEvent): void { }
    onPointerMove(_event: InteractionEvent): void { }
    onPointerUp(_event: InteractionEvent): void { }

    dispose(): void {
        super.dispose();
        this.deactivate();
    }
}