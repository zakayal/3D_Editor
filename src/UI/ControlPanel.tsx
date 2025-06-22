// src/components/controls/ControlPanel.tsx
import React, { useState, useEffect } from 'react';
import { WebGLMarkingAPI } from '../Context-new/index';
import { ToolMode } from '../types/webgl-marking';
import DeleteButton from './DeleteButton'; // 导入删除按钮组件
//@ts-ignore
import * as THREE from 'three';

import { SurfaceMeasurementTool } from '../Tools/surface-measurement/SurfaceMeasurementTool';

interface AnnotationSelectedEvent {
    id: string;
    position: THREE.Vector3;
}

interface ModeChangedEvent {
    mode: ToolMode;
}

interface AnnotationRemovedEvent {
    id: string;
}

interface MeasurementUpdatedEvent {
    length?: number;
    showControls: boolean;
    isMeasuring?: boolean;
}



export interface ControlPanelProps {
    api: WebGLMarkingAPI | null;
}

const ControlPanel: React.FC<ControlPanelProps> = ({ api }) => {
    const [currentMode, setCurrentMode] = useState<ToolMode>(ToolMode.Idle);
    const [selectedAnnotation, setSelectedAnnotation] = useState<{ id: string, position: THREE.Vector3 } | null>(null);
    const [isApiReady, setIsApiReady] = useState<boolean>(false); // <-- 新增状态：API 是否就绪

    // 新增状态：用于表面测距的实时长度和控制按钮可见性
    const [currentSurfaceLength, setCurrentSurfaceLength] = useState<number>(0);
    const [showSurfaceMeasureControls, setShowSurfaceMeasureControls] = useState<boolean>(false);
    
    // 修改状态：用于面积测量的总面积显示 - 改为所有已保存面积标签的总和
    const [currentTotalArea, setCurrentTotalArea] = useState<number>(0);
    const [triangleCount, setTriangleCount] = useState<number>(0);
    const [isCalculatingArea, setIsCalculatingArea] = useState<boolean>(false);

    // 计算所有已保存面积标注的总和
    const calculateTotalSavedArea = (): number => {
        if (!api) return 0;
        
        const allAnnotations = api.getAllAnnotations();
        const planimeteringAnnotations = allAnnotations.filter(annotation => annotation.type === 'planimetering');
        
        const totalArea = planimeteringAnnotations.reduce((sum, annotation) => {
            // 类型断言：确保我们处理的是面积标注，它有area属性
            const areaAnnotation = annotation as { area?: number };
            return sum + (areaAnnotation.area || 0);
        }, 0);
        
        console.log('ControlPanel: Calculated total saved area:', totalArea, 'from', planimeteringAnnotations.length, 'annotations');
        return totalArea;
    };

    useEffect(() => {
        if (!api) return;

        // 设置初始模式
        setCurrentMode(api.getCurrentToolMode());

        // 监听 API 就绪事件
        const unsubReady = api.on('ready', (readyStatus: boolean) => {
            console.log('api ready status in ControlPanel:', readyStatus);
            
            setIsApiReady(readyStatus);
            if (!readyStatus) {
                setCurrentMode(ToolMode.Idle);
            }
        });

        // 监听模式变化
        const unsubMode = api.on('modeChanged', (data: ModeChangedEvent) => {
            console.log("ControlPanel received modeChanged:", data);
            setCurrentMode(data.mode);
            if (data.mode !== ToolMode.SurfaceMeasure) {
                setShowSurfaceMeasureControls(false);
                setCurrentSurfaceLength(0);
            }
            if (data.mode !== ToolMode.Planimetering) {
                // 当退出面积测量模式时，重新计算总面积
                setCurrentTotalArea(calculateTotalSavedArea());
                setTriangleCount(0);
            }
        });
        
        // 监听选择变化
        const unsubSelect = api.on('annotationSelected', (data: AnnotationSelectedEvent) => {
            console.log("ControlPanel received annotationSelected:", data);
            setSelectedAnnotation({ id: data.id, position: data.position.clone() });
        });

        // 监听取消选择变化
        const unsubDeselect = api.on('annotationDeselected', (data: AnnotationRemovedEvent) => {
            console.log("ControlPanel received annotationDeselected:", data);
            setSelectedAnnotation(null);
        });

        // 监听移除变化 (确保如果删除了选中的对象，按钮也消失)
        const unsubRemoved = api.on('annotationRemoved', (data: AnnotationRemovedEvent) => {
            setSelectedAnnotation(prev => (prev && prev.id === data.id ? null : prev));
            // 当删除面积标注时，重新计算总面积
            setTimeout(() => {
                setCurrentTotalArea(calculateTotalSavedArea());
            }, 100);
        });

        // 新增：监听实时测量更新事件
        const unsubMeasurementUpdated = api.on('measurementUpdated', (data: MeasurementUpdatedEvent) => {
            setCurrentSurfaceLength(data.length || 0);
            setShowSurfaceMeasureControls(data.showControls);
        });

        // 修改：监听面积测量更新事件 - 区分临时测量和已保存测量
        const unsubPlanimeteringUpdated = api.on('measurementCompleted', (data: unknown) => {
            console.log("ControlPanel received planimetering update:", data);
            if (data && typeof data === 'object' && 'area' in data && typeof (data as { area: unknown }).area === 'number') {
                const measurementData = data as { area: number; triangles?: number[]; isTempMeasurement?: boolean };
                if (measurementData.isTempMeasurement) {
                    // 临时测量：只更新三角形数量，不更新总面积
                    setTriangleCount(measurementData.triangles ? measurementData.triangles.length : 0);
                } else {
                    // 已保存测量：重新计算所有已保存面积的总和
                    setCurrentTotalArea(calculateTotalSavedArea());
                    setTriangleCount(measurementData.triangles ? measurementData.triangles.length : 0);
                }
                setIsCalculatingArea(false); // 计算完成
            }
        });

        // 新增：监听面积测量保存事件
        const unsubMeasurementSaved = api.on('measurementSaved', (data: unknown) => {
            console.log("ControlPanel received measurement saved:", data);
            // 重新计算所有已保存面积的总和
            setTimeout(() => {
                setCurrentTotalArea(calculateTotalSavedArea());
            }, 100);
        });

        // 新增：监听标注添加事件
        const unsubAnnotationAdded = api.on('annotationAdded', (data: unknown) => {
            if (data && typeof data === 'object' && 'type' in data && (data as { type: unknown }).type === 'planimetering') {
                console.log("ControlPanel received planimetering annotation added:", data);
                // 重新计算所有已保存面积的总和
                setTimeout(() => {
                    setCurrentTotalArea(calculateTotalSavedArea());
                }, 100);
            }
        });

        // 监听面积计算开始事件
        const unsubCalculationStarted = api.on('areaCalculationStarted', (data: unknown) => {
            if (data && typeof data === 'object' && 'triangleCount' in data) {
                const eventData = data as { triangleCount: number };
                console.log("面积计算开始，三角形数量:", eventData.triangleCount);
                setIsCalculatingArea(true);
            }
        });

        // 监听面积计算完成事件
        const unsubCalculationCompleted = api.on('areaCalculationCompleted', (data: unknown) => {
            console.log("面积计算完成:", data);
            setIsCalculatingArea(false);
        });

        // 初始化时计算总面积
        setTimeout(() => {
            setCurrentTotalArea(calculateTotalSavedArea());
        }, 500);

        // 清理监听器
        return () => {
            unsubReady();
            unsubMode();
            unsubSelect();
            unsubDeselect();
            unsubRemoved();
            unsubMeasurementUpdated();
            unsubPlanimeteringUpdated();
            unsubMeasurementSaved();
            unsubAnnotationAdded();
            unsubCalculationStarted();
            unsubCalculationCompleted();
        };
    }, [api]); // 依赖 api

    const handleModeChange = (modeToSet: ToolMode) => {
        if (!api || !isApiReady) return;
        // 如果点击的是当前已激活的按钮，则切换回 Idle 模式，否则切换到指定模式
        const nextMode = currentMode === modeToSet ? ToolMode.Idle : modeToSet;
        api.setToolMode(nextMode);
    };

    const handleSurfaceMeasureSave = () => {
        if (api && currentMode === ToolMode.SurfaceMeasure) {
            const tool = api.interactionManager.getActiveTool();
            if (tool instanceof SurfaceMeasurementTool) {
                tool.saveCurrentMeasurement();
                setShowSurfaceMeasureControls(false); // 保存后隐藏控制
                setCurrentSurfaceLength(0); // 重置长度显示
            }
        }
    };

    const handleSurfaceMeasureCancel = () => {
        if (api && currentMode === ToolMode.SurfaceMeasure) {
            const tool = api.interactionManager.getActiveTool();
            if (tool instanceof SurfaceMeasurementTool) {
                tool.cancelCurrentMeasurement();
                setShowSurfaceMeasureControls(false); // 取消后隐藏控制
                setCurrentSurfaceLength(0); // 重置长度显示
            }
        }
    };

    // 面积测量完成当前测量
    const handleAreaMeasurementComplete = () => {
        if (api && currentMode === ToolMode.Planimetering) {
            const tool = api.interactionManager.getActiveTool();
            if (tool && typeof (tool as unknown) === 'object' && 'confirmCurrentMeasurement' in (tool as object)) {
                const planimeteringTool = (tool as unknown) as { confirmCurrentMeasurement: () => void };
                planimeteringTool.confirmCurrentMeasurement();
            }
        }
    };

    // 获取按钮样式
    const getButtonStyle = (mode: ToolMode) => ({
        padding: '8px 16px',
        color: 'white',
        border: 'none',
        borderRadius: '4px',
        cursor: !isApiReady ? 'not-allowed' : 'pointer', // <-- 未就绪时显示禁用光标
        fontSize: '14px',
        fontWeight: 'bold',
        transition: 'background-color 0.3s ease, opacity 0.3s ease', // 添加 opacity 过渡
        background: currentMode === mode ? '#4CAF50' : '#555', // 激活为绿色，非激活为深灰色
        opacity: !isApiReady || (currentMode !== ToolMode.Idle && currentMode !== mode) ? 0.5 : 1, // <-- 未就绪时也半透明
        pointerEvents: !isApiReady || (currentMode !== ToolMode.Idle && currentMode !== mode) ? 'none' : 'auto' as 'none' | 'auto',
    });

    // 获取提示信息
    const getInstructions = () => {

        if (!isApiReady) {
            return "正在加载模型数据，请稍候...";
        }
        switch (currentMode) {
            case ToolMode.ScaleBar:
                return "点击模型表面添加比例尺, 滚轮调整朝向. (ESC 退出)";
            case ToolMode.SurfaceMeasure:
                return "点击模型表面添加点, 右键结束测量. (ESC 退出)";
            case ToolMode.StraightMeasure:
                return "点击模型表面两点进行测量. (ESC 退出)";
            case ToolMode.Planimetering:
                return "拖拽套索选择区域进行面积测量 (支持累加). 按ESC退出";
            case ToolMode.Idle:
                return "选择模式: 点击标注物可选择/删除.";
            default:
                return "";
        }
    };


    return  (
        <>
            {api && <DeleteButton api={api} selection={selectedAnnotation} />}

            <div style={{
                background: 'rgba(0, 0, 0, 0.7)',
                padding: '10px',
                borderRadius: '5px',
                color: 'white',
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
                minWidth: '150px',
                boxShadow: '0 2px 10px rgba(0, 0, 0, 0.3)',
                pointerEvents: 'auto',
            }}>
                {/* 添加加载状态显示 */}
                {!isApiReady && (
                    <div style={{ fontSize: '12px', color: '#FFD700', paddingBottom: '5px', borderBottom: '1px solid #555', marginBottom: '5px' }}>
                        正在加载...
                    </div>
                )}

                <button
                    onClick={() => handleModeChange(ToolMode.ScaleBar)}
                    style={getButtonStyle(ToolMode.ScaleBar)}
                    disabled={!isApiReady} // <-- 禁用按钮
                >
                    {currentMode === ToolMode.ScaleBar ? '比例尺标注中...' : '比例尺标注'}
                </button>

                <button
                    onClick={() => handleModeChange(ToolMode.SurfaceMeasure)}
                    style={getButtonStyle(ToolMode.SurfaceMeasure)}
                    disabled={!isApiReady} // <-- 禁用按钮
                >
                    {currentMode === ToolMode.SurfaceMeasure ? '表面测距中...' : '表面测距'}
                </button>

                <button
                    onClick={() => handleModeChange(ToolMode.StraightMeasure)}
                    style={getButtonStyle(ToolMode.StraightMeasure)}
                    disabled={!isApiReady} // <-- 禁用按钮
                >
                    {currentMode === ToolMode.StraightMeasure ? '直线测距中...' : '直线测距'}
                </button>

                <button
                    onClick={() => handleModeChange(ToolMode.Planimetering)}
                    style={getButtonStyle(ToolMode.Planimetering)}
                    disabled={!isApiReady} // <-- 禁用按钮
                >
                    {currentMode === ToolMode.Planimetering ? '面积测量中...' : '面积测量'}
                </button>

                {/* 表面测距的实时长度和控制按钮 */}
                {currentMode === ToolMode.SurfaceMeasure && showSurfaceMeasureControls && (
                    <div className="measurement-controls">
                        <div className="current-length-display">
                            总长度: {currentSurfaceLength.toFixed(2)} cm
                        </div>
                        <div className="control-buttons">
                            <button onClick={handleSurfaceMeasureCancel} className="control-button cancel-button">
                                取消
                            </button>
                            <button onClick={handleSurfaceMeasureSave} className="control-button save-button"
                                disabled={currentSurfaceLength === 0}> {/* 长度为0时禁用保存 */}
                                保存
                            </button>
                        </div>
                    </div>
                )}

                {/* 面积测量的总面积显示 - 显示所有已保存面积标签的总和 */}
                {currentMode === ToolMode.Planimetering && (
                    <div style={{
                        background: 'rgba(76, 175, 80, 0.1)',
                        border: '1px solid #4CAF50',
                        borderRadius: '4px',
                        padding: '8px',
                        marginTop: '5px'
                    }}>
                        <div style={{ fontSize: '14px', fontWeight: 'bold', color: '#4CAF50' }}>
                            {isCalculatingArea ? '正在计算面积...' : '所有已保存面积总和'}
                        </div>
                        <div style={{ fontSize: '16px', color: 'white', marginTop: '2px' }}>
                            {isCalculatingArea ? '计算中...' : `${currentTotalArea.toFixed(2)} 平方单位`}
                        </div>
                        <div style={{ fontSize: '12px', color: '#ccc', marginTop: '2px' }}>
                            {isCalculatingArea ? '正在处理三角形数据...' : (triangleCount > 0 ? `当前选择 ${triangleCount} 个三角形` : '准备进行面积测量')}
                        </div>
                        <div style={{ fontSize: '11px', color: '#aaa', marginTop: '4px' }}>
                            {currentTotalArea > 0 ? '拖拽套索新增面积测量，或按ESC退出' : '拖拽套索选择区域进行面积测量'}
                        </div>
                        
                        {/* 完成测量按钮 */}
                        {currentTotalArea > 0 && !isCalculatingArea && (
                            <button 
                                onClick={handleAreaMeasurementComplete}
                                style={{
                                    width: '100%',
                                    marginTop: '8px',
                                    padding: '6px 12px',
                                    backgroundColor: '#FF9800',
                                    color: 'white',
                                    border: 'none',
                                    borderRadius: '4px',
                                    fontSize: '12px',
                                    fontWeight: 'bold',
                                    cursor: 'pointer',
                                    transition: 'background-color 0.2s ease'
                                }}
                                onMouseEnter={(e) => {
                                    e.currentTarget.style.backgroundColor = '#F57C00';
                                }}
                                onMouseLeave={(e) => {
                                    e.currentTarget.style.backgroundColor = '#FF9800';
                                }}
                            >
                                完成测量
                            </button>
                        )}
                    </div>
                )}


                 {/* 显示提示信息 */}
                {(currentMode !== ToolMode.Idle || !isApiReady || selectedAnnotation) && (
                     <div style={{ fontSize: '12px', color: '#ccc', marginTop: '10px' }}>
                        {getInstructions()}
                         {currentMode === ToolMode.Idle && selectedAnnotation && (
                            <><br/><span>标注物已选择，按 'Delete' 键删除。</span></>
                         )}
                     </div>
                )}
            </div>
        </>
    );
};

export default ControlPanel;