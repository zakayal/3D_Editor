import React from 'react';
import ReactDOM from 'react-dom/client';
import { WebGLMarkingAPIConfig, CanvasConfig } from './types/webgl-marking';
import HighLightDemo from './ui/views/HighlightDemo'; // 导入 HighLightDemo 组件

import './style.css';

document.addEventListener('DOMContentLoaded', () => {
    // 1. 获取应用的主容器
    const appRootElement = document.getElementById('root');

    if (!appRootElement) {
        console.error("未能找到ID为 'root' 的元素。");
        return;
    }

    // 2. 定义 API 和 Canvas 的配置
    // API 的功能配置
    const apiConfig: WebGLMarkingAPIConfig = {
        modelPath: '/man.obj',
        mtlPath: '', // 如果有 mtl 文件，请提供路径
        scaleBarModelPath: "/12cm不干胶比例尺(1).glb",
    };

    // Canvas 的配置，HighLightDemo 会使用这个配置来创建 WebGL 环境
    const canvasConfig: CanvasConfig = {
        container: appRootElement, // HighLightDemo 将在其内部处理 canvas 的创建
    };

    // 3. 渲染 HighLightDemo 组件
    // HighLightDemo 会在其内部创建 WebGLMarkingAPI 实例和所有必要的UI元素
    const root = ReactDOM.createRoot(appRootElement);
    root.render(
        <React.StrictMode>
            <HighLightDemo apiConfig={apiConfig} canvasConfig={canvasConfig} />
        </React.StrictMode>
    );
});