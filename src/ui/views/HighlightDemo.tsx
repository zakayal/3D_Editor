import React, { useRef, useState, useEffect } from 'react';
import { WebGLMarkingAPI } from '../../api/WebGLMarkingAPI';
import { WebGLMarkingAPIConfig, CanvasConfig, ToolMode, InjuryContext } from '../../types/webgl-marking';
//@ts-ignore
import * as THREE from 'three'

interface MarkingDemoProps {
    apiConfig: WebGLMarkingAPIConfig;
    canvasConfig: CanvasConfig;
}

const HighLightDemo: React.FC<MarkingDemoProps> = ({ apiConfig, canvasConfig }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const apiRef = useRef<WebGLMarkingAPI | null>(null);
    const [isApiReady, setIsApiReady] = useState(false);
    const [statusMessage, setStatusMessage] = useState("初始化中...");

    const [isAddContextButtonDisabled, setIsAddContextButtonDisabled] = useState(true);
    const [selectedPartsForAddition, setSelectedPartsForAddition] = useState<any[]>([])
    // const [lastSelectedPart, setLastSelectedPart] = useState<{ partId: string; name: string; anchorPoint: THREE.Vector3; mesh: THREE.Mesh } | null>(null);

    // --- 新增 ---: 状态来存储和管理所有鉴伤上下文
    const [injuryContexts, setInjuryContexts] = useState<InjuryContext[]>([]);
    // --- 新增 ---: 状态来跟踪每个上下文的模型加载状态
    const [modelLoadStatus, setModelLoadStatus] = useState<Record<string, boolean>>({});

    const [isInHumanModelView, setIsHumanModelView] = useState(true)

    useEffect(() => {
        if (!containerRef.current) return;

        const webglContainer = document.createElement('div');
        webglContainer.id = 'webgl-container';
        webglContainer.style.width = '100%';
        webglContainer.style.height = '100%';
        webglContainer.style.position = 'absolute';
        webglContainer.style.top = '0';
        webglContainer.style.left = '0';
        containerRef.current.appendChild(webglContainer);

        const finalCanvasConfig = {
            ...canvasConfig,
            container: webglContainer,
        }

        let cleanupFunctions: (() => void)[] = [];

        try {
            const api = new WebGLMarkingAPI(finalCanvasConfig, apiConfig);
            apiRef.current = api;

            const unsubscribePartsSelection = api.on('partsSelectionChanged', (data) => {
                console.log(`ui监听到多选变化事件，当前选择：`, data.selectedParts.length, '个')
                setSelectedPartsForAddition(data.selectedParts)
                setIsAddContextButtonDisabled(data.selectedParts.length === 0);
            });
            cleanupFunctions.push(unsubscribePartsSelection);

            const unsubscribeInjuryContextAdded = api.on('injuryContextAdded', ({ context }) => {
                setInjuryContexts(prevContexts => {
                    // 防止重复添加
                    if (prevContexts.find(c => c.id === context.id)) {
                        return prevContexts;
                    }
                    return [...prevContexts, context];
                });
                console.log('创建的上下文详情', context);
                console.groupEnd();
            });
            cleanupFunctions.push(unsubscribeInjuryContextAdded);

            const unsubscribeInjuryContextRemoved = api.on('injuryContextRemoved', ({ id }) => {
                console.log(`监听到上下文移除事件，id:${id}`);
                setInjuryContexts(preContexts => preContexts.filter(c => c.id !== id))
                setModelLoadStatus(preStatus => {
                    const newStatus = { ...preStatus };
                    delete newStatus[id];
                    return newStatus
                })
            })
            cleanupFunctions.push(unsubscribeInjuryContextRemoved)

            const unsubscribeInjuryModelLoaded = api.on('injuryModelLoaded', ({ contextId }) => {
                console.log(`UI监听到模型加载成功事件，部位ID: ${contextId}`);
                setModelLoadStatus(prevStatus => ({ ...prevStatus, [contextId]: true }));
            });
            cleanupFunctions.push(unsubscribeInjuryModelLoaded);


            const unsubscribeReady = api.on('ready', (readyStatus) => {
                setIsApiReady(readyStatus);
                setStatusMessage(readyStatus ? "API 已就绪" : "API 初始化失败");
                if (readyStatus) {
                    const isInInjuryView = apiRef.current?.getCurrentContextPartId() !== null;
                    const targetMode = isInInjuryView ? ToolMode.Idle : ToolMode.Highlight;
                    api.setToolMode(targetMode);
                }

            });
            cleanupFunctions.push(unsubscribeReady);

            const unsubscribeError = api.on('error', (errorData) => {
                setStatusMessage(`API 错误: ${errorData.message || '未知错误'}`);
                console.error("API Error:", errorData);
            });
            cleanupFunctions.push(unsubscribeError);

            const unsubscirbeViewChanged = api.on('viewChanged', ({ isHumanModelView }) => {
                console.log(`UI监听到视图变化事件，当前是否在主模型视图：${isHumanModelView}`);
                setIsHumanModelView(isHumanModelView);

            })
            cleanupFunctions.push(unsubscirbeViewChanged);

            (window as any).myAppAPI = api;
            (window as any).THREE = THREE;

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '未知错误';
            setStatusMessage(`初始化失败: ${errorMessage}`);
            console.error("WebGLMarkingAPI 初始化失败:", error);
        }

        return () => {
            console.log("Cleaning up MarkingDemo...");
            cleanupFunctions.forEach(cleanup => cleanup());
            cleanupFunctions = [];
            if (apiRef.current) {
                apiRef.current.dispose();
                apiRef.current = null;
            }
            if (containerRef.current && webglContainer.parentElement) {
                containerRef.current.removeChild(webglContainer);
            }
            if ((window as any).myAppAPI) {
                delete (window as any).myAppAPI;
            }
            console.log("MarkingDemo cleanup completed.");
        };
    }, []);

    const handleAddContextClick = () => {
        if (apiRef.current && selectedPartsForAddition.length > 0) {
            selectedPartsForAddition.forEach(part => {
                apiRef.current!.addInjuryContext(part)

            })
            if ((apiRef.current?.interactionManager.getActiveTool() as any)?.clearTemporaryHighlights) {
                (apiRef.current?.interactionManager.getActiveTool() as any).clearTemporaryHighlights()
            }
            setSelectedPartsForAddition([])
            setIsAddContextButtonDisabled(true)
        }
    }

    // --- 新增 ---: "导入模型" 按钮的事件处理器
    const handleImportModel = (contextId: string) => {
        if (!apiRef.current) return;
        // 实际应用中，这里会弹出一个文件选择框
        // const fileInput = document.createElement('input');
        // fileInput.type = 'file';
        // fileInput.onchange = (e) => { ... };
        // fileInput.click();

        // 我们在这里用 prompt 模拟
        const modelUrl = prompt("请输入损伤模型的OBJ文件URL:");
        if (modelUrl) {
            const mtlUrl = prompt("请输入损伤模型的MTL文件URL (可选):");
            apiRef.current.loadInjuryModelForContext(contextId, modelUrl, mtlUrl || undefined)
                .catch((err: any) => alert(`模型加载失败: ${err.message}`));
        }
    };

    // --- 新增 ---: "编辑" 按钮的事件处理器
    const handleEditModel = (contextId: string) => {
        if (!apiRef.current) return;
        apiRef.current.viewInjuryModelForContext(contextId);
    };

    // --- 新增 ---: "返回主模型" 按钮的事件处理器
    const handleReturnToHumanModel = () => {
        if (!apiRef.current) return;
        apiRef.current.returnToHumanModelView();
    };

    const handleDeleteContext = (contextId: string) => {
        if (!apiRef.current) return

        if (window.confirm(`确定要删除这个部位(ID:${contextId})吗？删除后所有相关数据将无法恢复`)) {
            apiRef.current.removeInjuryContext(contextId)
        }
    }


    return (
        <div style={{
            width: '100%',
            height: 'calc(100vh - 100px)',
            position: 'relative',
        }}>
            <div
                ref={containerRef}
                style={{ width: '100%', height: '100%', position: 'relative' }}
            />
            <div style={{
                position: 'absolute', top: '20px', right: '20px', zIndex: 1002,
                background: 'rgba(255, 255, 255, 0.9)', padding: '15px', borderRadius: '8px',
                boxShadow: '0 4px 12px rgba(0,0,0,0.15)', width: '280px', fontFamily: 'sans-serif'
            }}>
                {/* 1. 添加上下文的UI */}
                <div style={{ marginBottom: '20px', borderBottom: '1px solid #eee', paddingBottom: '15px' }}>
                    <h4 style={{ margin: '0 0 10px 0' }}>添加新部位</h4>
                    <button onClick={handleAddContextClick} disabled={isAddContextButtonDisabled}>
                        + 添加鉴伤上下文
                    </button>

                    <div style={{ fontSize: '12px', color: '#666', marginTop: '5px', minHeight: '16px' }}>
                        {isAddContextButtonDisabled
                            ? '请先在3D模型上选择一个或多个部位'
                            : `已选择: ${selectedPartsForAddition.map(p => p.name).join(', ')}`}
                    </div>

                </div>

                {/* 2. 上下文列表 */}
                <div>
                    <h4 style={{ margin: '0 0 10px 0' }}>已添加部位列表</h4>
                    <button
                        onClick={handleReturnToHumanModel}
                        style={{ marginBottom: '10px', width: '100%' }}
                    >
                        返回主模型视图
                    </button>
                    <ul style={{ listStyle: 'none', padding: 0, margin: 0, maxHeight: '300px', overflowY: 'auto' }}>
                        {injuryContexts.length === 0 && (
                            <li style={{ color: '#888', fontSize: '14px' }}>暂无数据</li>
                        )}
                        {injuryContexts.map(context => (
                            <li key={context.id} style={{
                                background: '#f9f9f9', padding: '10px', borderRadius: '4px',
                                marginBottom: '8px', display: 'flex', flexDirection: 'column', gap: '8px'
                            }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <strong style={{ fontSize: '16px' }}>{context.name}</strong>
                                    {/* 将删除按钮放在这里 */}
                                    <button onClick={() => handleDeleteContext(context.id)} style={{ color: 'red', border: 'none', background: 'transparent', cursor: 'pointer' }}>删除</button>
                                </div>
                                <div style={{ display: 'flex', gap: '8px' }}>

                                    {modelLoadStatus[context.id] ? (
                                        // 模型已加载时显示的按钮
                                        <>
                                            <button style={{ flex: 1 }}>+ 下载模型</button>
                                            <button
                                                onClick={() => handleEditModel(context.id)}
                                                disabled={
                                                    !isInHumanModelView ||
                                                    !modelLoadStatus[context.id]}
                                                style={{ flex: 1 }}
                                            >
                                                编辑
                                            </button>
                                        </>
                                    ) : (
                                        // 模型未加载时显示的按钮
                                        <>
                                            <button onClick={() => handleImportModel(context.id)} style={{ flex: 1 }}>
                                                + 导入模型
                                            </button>
                                            <button style={{ flex: 1 }}>+ 下载模型</button>
                                            <button style={{ flex: 1 }}>+ 开始扫描</button>
                                        </>
                                    )}
                                </div>
                            </li>
                        ))}
                    </ul>
                </div>
            </div>

            <div style={{ position: 'absolute', bottom: '10px', left: '10px', background: 'rgba(0,0,0,0.5)', color: 'white', padding: '5px 10px', borderRadius: '4px' }}>
                状态: {statusMessage} {isApiReady ? ' (就绪)' : ' (加载中...)'}
            </div>
        </div>
    );
};

export default HighLightDemo;