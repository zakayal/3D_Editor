/*
 * @Author: Kaze 3243442830@qq.com
 * @Date: 2025-05-27 21:38:36
 * @LastEditors: Kaze 3243442830@qq.com
 * @LastEditTime: 2025-06-17 22:21:41
 * @FilePath: \marking\src\main.tsx
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
// src/main.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
// 修正了 WebGLMarkingAPI 和类型的导入路径
import { WebGLMarkingAPI } from './Context-new/index';
import { WebGLMarkingAPIConfig, CanvasConfig } from './types/webgl-marking';
import ControlPanel from './UI/ControlPanel';

import './style.css';

document.addEventListener('DOMContentLoaded', () => {
    // 获取容器元素，API 将在其中创建 Canvas
    const appRootElement = document.getElementById('root'); 
    const controlPanelRootElement = document.getElementById('control-panel-root');

    if (!appRootElement || !controlPanelRootElement) {
        console.error("Failed to find '#root' or '#control-panel-root' element.");
        return;
    }

    // API 的功能配置
    const apiConfig: WebGLMarkingAPIConfig = {
        modelPath: '/man.obj',
        mtlPath: '', // 如果有 mtl 文件，请提供路径
        scaleBarModelPath: "/12cm不干胶比例尺(1).glb",
    };

    // 新增：创建 Canvas 配置对象
    const canvasConfig: CanvasConfig = {
        container: appRootElement, // 指定 API 在哪个容器里创建 Canvas
    };

    try {
        // 使用正确的配置来实例化 API
        const api = new WebGLMarkingAPI(canvasConfig, apiConfig);

        const controlPanelRoot = ReactDOM.createRoot(controlPanelRootElement);
        controlPanelRoot.render(
            <React.StrictMode>
                <ControlPanel api={api} />
            </React.StrictMode>
        );

        api.on('ready', (isReady) => {
            if (isReady) {
                console.log("API reported ready.");
            } else {
                 console.error("API reported NOT ready.");
            }
        });

         api.on('error', (errorData) => {
             console.error("API Error:", errorData);
         });

        (window as any).myAppAPI = api;

    } catch (error) {
        console.error("Failed to initialize WebGLMarkingAPI:", error);
        controlPanelRootElement.innerHTML = `<p style="color: red; background: white; padding: 10px;">创建 API 时发生严重错误。</p>`;
    }
});