import React, { useEffect, useRef } from 'react';
//@ts-ignore
import * as THREE from 'three';
//@ts-ignore
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { WebGLMarkingAPI } from '../../api/WebGLMarkingAPI';

interface DeleteButtonProps {
    api: WebGLMarkingAPI;
    selection: {
        id: string;
        position: THREE.Vector3;
    } | null;
}

const DeleteButton: React.FC<DeleteButtonProps> = ({ api, selection }) => {
    const buttonRef = useRef<CSS2DObject | null>(null);

    useEffect(() => {
        const scene = api.getScene();

        // 清理旧按钮
        if (buttonRef.current && buttonRef.current.parent) {
             if (buttonRef.current.element.parentElement) {
                buttonRef.current.element.parentElement.removeChild(buttonRef.current.element);
             }
            buttonRef.current.parent.remove(buttonRef.current);
            buttonRef.current = null;
        }

        // 如果有新的选择，则创建新按钮
        if (selection) {
            const buttonElement = document.createElement('button');
            buttonElement.className = 'delete-button'; // 使用 CSS 样式
            buttonElement.innerHTML = `<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`;
            buttonElement.style.pointerEvents = 'auto'; // 确保按钮本身可点击

            buttonElement.onclick = (e: Event) => {
                console.log('删除按钮被点击');
                console.log('Selection id:', selection.id);
                
                e.stopPropagation(); // 阻止事件冒泡到 canvas
                api.removeAnnotation(selection.id);
                console.log('删除成功');
                
            };

            const deleteButtonObject = new CSS2DObject(buttonElement);
            deleteButtonObject.position.copy(selection.position);
            deleteButtonObject.layers.set(0); // 确保 CSS2DRenderer 渲染

            buttonRef.current = deleteButtonObject;
            scene.add(deleteButtonObject);
        }

        // 组件卸载时的清理函数
        return () => {
            if (buttonRef.current && buttonRef.current.parent) {
                 if (buttonRef.current.element.parentElement) {
                    buttonRef.current.element.parentElement.removeChild(buttonRef.current.element);
                 }
                buttonRef.current.parent.remove(buttonRef.current);
                buttonRef.current = null;
            }
        };

    }, [api, selection]); // 依赖 api 和 selection，当它们变化时重新运行 effect

    return null; // 这个组件不渲染任何直接的 JSX，它通过 Effect 操作 Three.js 场景
};

export default DeleteButton;