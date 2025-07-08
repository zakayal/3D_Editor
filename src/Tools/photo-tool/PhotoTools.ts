import { BaseTool, ITool } from '../../components/Base-tools/BaseTool'
import { InteractionEvent, ToolMode, ISceneController, IAnnotationManager, IEventEmitter, IContextProvider } from '../../types/webgl-marking'
import { StandardView } from '../../types/webgl-marking';
// @ts-ignore
import * as THREE from '@ys/three'

export class PhotoTool extends BaseTool implements ITool {
    private contextProvider: IContextProvider;
    constructor(
        sceneController: ISceneController,
        annotationManager: IAnnotationManager,
        eventEmitter: IEventEmitter,
        contextProvider: IContextProvider) {
        super(sceneController, annotationManager, eventEmitter)
        this.contextProvider = contextProvider
    }

    getMode(): ToolMode {
        return ToolMode.Photo
    }

    activate(): void {
        super.activate()
        console.log('PhotoTool activated');
        this.sceneController.orbitControls.enabled = true
        this.eventEmitter.emit('photoToolStateChanged', { visible: true })
    }

    deactivate(): void {
        console.log('photoTool deactivate');
        this.sceneController.orbitControls.enabled = true
        this.eventEmitter.emit('photoToolStateChanged', { visible: false })
    }

    onPointerDown(_event: InteractionEvent): void {
    }

    onPointerMove(_event: InteractionEvent): void {
    }

    public setCameraPhotoMode(mode: 'wide' | 'default'): void {
        this.sceneController.adjustCameraForPhoto(mode)
    }

    public sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms))
    }

    /**
    * 【新增】执行六个标准视图的自动批量拍照
    */
    public async captureStandardViews(userName: string = '用户'): Promise<void> {
        const views: StandardView[] = ['front', 'back', 'left', 'right', 'top', 'bottom'];
        const currentContext = this.contextProvider.getCurrentInjuryContext();
        if (!currentContext) {
            this.eventEmitter.emit('error', { message: '无法在主模型下进行自动拍照' });
            return;
        }

        // 暂时禁用相机控制器，防止用户在自动拍照时移动相机
        const wasControlsEnabled = this.sceneController.orbitControls.enabled;
        const originalTarget = this.sceneController.orbitControls.target.clone();
        const originalCameraPosition = this.sceneController.camera.position.clone();
        const originalCameraUp = this.sceneController.camera.up.clone();
        const originalCameraFov = this.sceneController.camera.fov;
        
        this.sceneController.orbitControls.enabled = false;

        console.log('[PhotoTool] 开始标准视图连拍，保存原始相机状态');

        // 循环执行拍照
        for (const view of views) {
            this.eventEmitter.emit('notification', { message: `正在拍摄: ${view}视图...` });

            try {
                // 1. 命令 SceneController 将相机移动到指定视图，并等待其完成
                await this.sceneController.setCameraToStandardView(view);

                // 2. 【改进】增加更长的等待时间，确保渲染完成
                await this.sleep(500);

                // 3. 【改进】确保获取最新的相机状态
                this.sceneController.camera.updateMatrixWorld(true);

                const explicitCameraState = {
                    position: this.sceneController.camera.position.clone(),
                    target: this.sceneController.orbitControls.target.clone(),
                    up: this.sceneController.camera.up.clone(),
                };

                console.log(`[PhotoTool] ${view}视图相机状态:`, {
                    position: explicitCameraState.position.toArray(),
                    target: explicitCameraState.target.toArray(),
                    up: explicitCameraState.up.toArray(),
                    fov: this.sceneController.camera.fov
                });

                // 4. 调用单次拍照逻辑，并传入视图名称用于命名
                await this.capturePhoto(userName, 5, 'landscape', view, explicitCameraState);
                
                this.eventEmitter.emit('notification', { message: `${view}视图拍摄完成` });
                
            } catch (error) {
                console.error(`[PhotoTool] ${view}视图拍摄失败:`, error);
                this.eventEmitter.emit('error', { 
                    message: `${view}视图拍摄失败: ${error instanceof Error ? error.message : '未知错误'}` 
                });
            }
        }

        console.log('[PhotoTool] 标准视图拍摄完成，正在重置相机状态');
        
        // 【改进】更完整的状态恢复
        try {
            // 步骤 1: 恢复 OrbitControls 的核心状态
            this.sceneController.orbitControls.target.copy(originalTarget);
            this.sceneController.orbitControls.enabled = wasControlsEnabled;

            // 步骤 2: 恢复相机的完整状态
            this.sceneController.camera.position.copy(originalCameraPosition);
            this.sceneController.camera.up.copy(originalCameraUp);
            this.sceneController.camera.fov = originalCameraFov;
            this.sceneController.camera.updateProjectionMatrix();
            this.sceneController.camera.lookAt(originalTarget);

            // 步骤 3: 更新控制器
            this.sceneController.orbitControls.update();

            // 步骤 4: 强制渲染以确保视图更新
            this.sceneController.renderer.render(this.sceneController.scene, this.sceneController.camera);
            
            console.log('[PhotoTool] 相机状态恢复完成', {
                position: originalCameraPosition.toArray(),
                target: originalTarget.toArray(),
                fov: originalCameraFov
            });
            
        } catch (error) {
            console.error('[PhotoTool] 相机状态恢复失败:', error);
            // 如果恢复失败，尝试重置到默认状态
            const activeModel = this.sceneController.activeModelForRaycasting as THREE.Group;
            if (activeModel) {
                this.sceneController.resetCameraToFitModel(activeModel);
            }
        }

        // 步骤 5: 发出通知和模式切换请求
        this.eventEmitter.emit('notification', { message: '所有标准视图拍摄完成！' });
        this.eventEmitter.emit('toolModeChangeRequested', { mode: ToolMode.Idle });
    }

    public async capturePhoto(
        userName: string = '用户',
        resolutionMultiplier: number = 5,
        orientation: 'landscape' | 'portrait' = 'landscape',
        viewName?: StandardView, // 接收可选的视图名称参数
        cameraState?: { // 接收这个可选参数
            position: THREE.Vector3;
            target: THREE.Vector3;
            up: THREE.Vector3;
        }
    ): Promise<void> {

        // 1. 获取上下文，这部分逻辑不变
        const currentContext = this.contextProvider.getCurrentInjuryContext();
        if (!currentContext) {
            this.eventEmitter.emit('error', { message: '无法在主模型下拍照' });
            return;
        }
        const contextId = currentContext.id;
        const partName = currentContext.name;

        // 2. 【核心修改】动态生成文件名
        const timestamp = new Date();
        const dateStr = `${timestamp.getFullYear()}${(timestamp.getMonth() + 1).toString().padStart(2, '0')}${timestamp.getDate().toString().padStart(2, '0')}`;
        const randomSuffix = Math.floor(1000 + Math.random() * 9000);

        // 如果 viewName 存在（意味着是自动拍照），就在文件名中加入视图后缀
        const viewSuffix = viewName ? `_${viewName}` : '';

        const fileName = `${userName}_${partName}${viewSuffix}_${dateStr}_${randomSuffix}.png`;

        // 3. 计算裁剪区域，这部分逻辑不变
        const canvas = this.sceneController.renderer.domElement;
        let frameHeight: number;
        let frameWidth: number;

        if (orientation === 'portrait') {
            frameHeight = canvas.height * 0.85;
            frameWidth = frameHeight * (9 / 16);
            if (frameWidth > canvas.width) {
                frameWidth = canvas.width * 0.9;
                frameHeight = frameWidth * (16 / 9);
            }
        } else {
            frameWidth = canvas.width * 0.8;
            frameHeight = canvas.height * 0.6;
        }

        const frameX = (canvas.width - frameWidth) / 2;
        const frameY = (canvas.height - frameHeight) / 2;

        const cropOptions = {
            transparentBackground: true,
            resolutionMultiplier,
            cropRegion: { x: frameX, y: frameY, width: frameWidth, height: frameHeight },
            cameraState
        };

        try {
            // 4. 调用截图，这部分逻辑不变
            const imageData = await this.sceneController.captureScreenshot(cropOptions);

            // 5. 创建标注和发出事件，这部分逻辑不变
            const photoAnnotation = this.annotationManager.addPhotoAnnotation({
                contextId,
                name: fileName,
                imageData,
                timestamp: timestamp.toISOString()
            });
            this.eventEmitter.emit('photoCaptured', { annotation: photoAnnotation });

            // 6. 下载图片，这部分逻辑不变
            const link = document.createElement('a');
            link.href = imageData;
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

            // 7. 【核心修改】流程控制
            // 只有当 viewName 不存在时（意味着是用户手动触发的单次拍照），才退出工具
            if (!viewName) {
                this.eventEmitter.emit('toolModeChangeRequested', { mode: ToolMode.Idle });
            }
            // 如果 viewName 存在，说明是自动流程的一部分，不在这里退出。
            // 退出逻辑将由调用它的 captureStandardViews 方法负责。

        } catch (error) {
            console.error('Capture photo failed:', error);
            this.eventEmitter.emit('error', { message: `截图失败: ${fileName}`, details: error });
        }
    }

    dispose(): void {
        super.dispose()
    }
}
