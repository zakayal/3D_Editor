// Selection.js bvh库实现套索选面工具的应用示例
// @ts-nocheck
import * as THREE from 'three'
import {
    MeshBVHHelper,
    MeshBVH,
} from 'three-mesh-bvh';
import { LassoSelection, BoxSelection } from "../selection/src/Selection";
import { computeSelectedTriangles } from "../selection/src/computeSelectedTriangles.js";
import { getAreaCalculationManager } from "./workers/AreaCalculationManager.js";

const _LOG_TAG = '[Planimetering.js]';



export const Planimetering = (renderer, camera, scene, group) => {
    console.log(_LOG_TAG, '创建新的 Planimetering 实例');
    console.log(_LOG_TAG, 'Planimetering 实例参数:', { 
        renderer: !!renderer, 
        camera: !!camera, 
        scene: !!scene, 
        group: !!group 
    });

    // 事件处理函数引用
    let handlePointerDown;
    let handlePointerUp;
    let handlePointerMove;

    // console(MeshBVH)
    const params = {
        /** Selection tool: 'lasso' or 'box'. */
        toolMode: 'lasso',
        /**
         * How triangles are marked for selection:
         * - 'intersection': if any part of the triangle is within the selection shape.
         * - 'centroid': if the center of the triangle is within the selection shape.
         * - 'centroid-visible': if the center of the triangle is within the selection shape and the triangle is visible.
         */
        selectionMode: 'centroid-visible',
        // 套索选择时实时更新选择的面
        liveUpdate: false,
        selectWholeModel: false,
        wireframe: false,
        useBoundsTree: true,
        displayHelper: false,
        helperDepth: 10,
    };

    const configs = {
        highlightMeshConfig: {
            color: 0xff0000,
            opacity: 1.0,
        }
    }

    let mesh = group.children[4];
    let selectionShape, helper;
    let highlightMesh, highlightWireframeMesh;
    let selectionShapeNeedsUpdate = false;
    let selectionNeedsUpdate = false;
    let isRendering = false;
    let tool = new LassoSelection(renderer);
    let selectionShapeGroup;
    let lassoFinishedCallback = null;
    let trianglesData = [];  // 选中的三角形序号
    let areaCalculationManager = getAreaCalculationManager(); // Worker 管理器
    let isCalculatingArea = false; // 防止重复计算
    let eventEmitter = null; // 事件发射器，用于通知 UI
    let firstClickCallback = null; // 第一次点击回调
    let firstClickCaptured = false; // 是否已捕获第一次点击

    function registerLassoFinishedCall(callback) {
        lassoFinishedCallback = callback;
    }

    function registerEventEmitter(emitter) {
        eventEmitter = emitter;
    }

    function registerFirstClickCallback(callback) {
        firstClickCallback = callback;
    }
    function startMeasurement() {
        console.log(_LOG_TAG, 'startMeasurement 被调用');
        console.log(_LOG_TAG, 'startMeasurement: isRendering当前状态:', isRendering);
        
        isRendering = true;
        selectionShape.visible = true;

        console.log(_LOG_TAG, 'startMeasurement: 开始添加事件监听器...');

        const handleContextMenu = (e) => {
            console.log(_LOG_TAG, 'Context menu event triggered');
            e.preventDefault();
        };

        handlePointerDown = (e) => {
            console.log(_LOG_TAG, 'Right mouse button down - starting lasso');
            // 修复：检查右键按下 (button === 2)
            if(e.button === 2) {
                e.preventDefault();
                tool.handlePointerDown(e);
            }
        };
    
        handlePointerUp = (e) => {  // 修复：添加事件参数 e
            // 修复：检查右键释放 (button === 2)
            if(e.button === 2) {
                console.log(_LOG_TAG, 'Right mouse button up - finishing lasso');
                tool.handlePointerUp();
                selectionShape.visible = false;
                if (tool.points.length) {
                    selectionNeedsUpdate = true;
                }
            }
        };
    
        handlePointerMove = (e) => {
            // 修复：检查右键是否按住 - 应该是 (e.buttons & 2) !== 0，表示右键正在按下
            if ((e.buttons & 2) === 0) {
                return;
            }
    
            const { changed } = tool.handlePointerMove(e);
    
            // 捕获套索绘制的第一个点位置（当真正开始绘制时）
            if (changed && !firstClickCaptured && firstClickCallback && tool.points.length >= 3) {
                // 获取套索的第一个点（屏幕坐标转世界坐标）
                const rect = renderer.domElement.getBoundingClientRect();
                const firstPoint = tool.points.slice(0, 2); // 前两个值是x, y屏幕坐标（归一化的）
                
                // 将归一化坐标转换为屏幕坐标
                const screenX = (firstPoint[0] + 1) * rect.width / 2;
                const screenY = (-firstPoint[1] + 1) * rect.height / 2;
                
                // 创建鼠标位置向量（标准化设备坐标）
                const mouse = new THREE.Vector2();
                mouse.x = firstPoint[0];  // 已经是归一化的坐标
                mouse.y = firstPoint[1];  // 已经是归一化的坐标
                
                // 创建射线
                const raycaster = new THREE.Raycaster();
                raycaster.setFromCamera(mouse, camera);
                
                // 检测与目标网格的交点
                const intersects = raycaster.intersectObject(mesh, true);
                if (intersects.length > 0) {
                    const intersectionPoint = intersects[0].point.clone();
                    firstClickCallback(intersectionPoint);
                    firstClickCaptured = true;
                    console.log(_LOG_TAG, 'Lasso first point position captured:', intersectionPoint);
                }
            }
    
            if (changed) {
                selectionShapeNeedsUpdate = true;
                selectionShape.visible = true;
                if (params.liveUpdate) {
                    selectionNeedsUpdate = true;
                }
            }
        };
    
        // 存储 handleContextMenu 的引用，以便后续正确移除
        handlePointerDown.handleContextMenu = handleContextMenu;
    
        // add event listeners
        console.log(_LOG_TAG, 'startMeasurement: 添加mousedown事件监听器');
        renderer.domElement.addEventListener('mousedown', handlePointerDown);
        console.log(_LOG_TAG, 'startMeasurement: 添加mouseup事件监听器');
        renderer.domElement.addEventListener('mouseup', handlePointerUp);
        console.log(_LOG_TAG, 'startMeasurement: 添加mousemove事件监听器');
        renderer.domElement.addEventListener('mousemove', handlePointerMove);
        console.log(_LOG_TAG, 'startMeasurement: 添加contextmenu事件监听器');
        renderer.domElement.addEventListener('contextmenu', handleContextMenu); // 修复：使用存储的函数引用
        
        console.log(_LOG_TAG, 'startMeasurement: 所有事件监听器添加完成，isRendering =', isRendering);
    }

    async function showMeasurement() {
        console.log(_LOG_TAG, 'showMeasurement');
        if (tool.clearPoints) {
            tool.clearPoints();
        }
        selectionShape.visible = false;
        
        // 防止重复计算
        if (isCalculatingArea) {
            console.log(_LOG_TAG, 'Area calculation already in progress, skipping...');
            return;
        }
        
        isCalculatingArea = true;
        
        // 立即通知回调，显示高亮但不包含面积计算结果
        const lassoPath = tool.points && tool.points.length > 0 ? [...tool.points] : null;
        console.log(_LOG_TAG, '套索路径点数量:', lassoPath ? Math.floor(lassoPath.length / 3) : 0);
        
        // 先回调高亮显示，面积设为 null 表示正在计算
        if (lassoFinishedCallback) {
            lassoFinishedCallback({
                triangles: trianglesData, // 选中的三角面
                area: null, // 面积正在计算中
                lassoPath: lassoPath, // 套索路径数据
                isCalculating: true // 标记正在计算
            });
        }
        
        // 通知 UI 开始计算
        if (eventEmitter) {
            eventEmitter.emit('areaCalculationStarted', { 
                triangleCount: highlightMesh.geometry.drawRange.count / 3 
            });
        }
        
        // 使用 setTimeout 异步执行计算，确保不阻塞高亮显示
        setTimeout(async () => {
            try {
                // 使用 Worker 进行面积计算
                const result = await calculateAreaAsync(highlightMesh.geometry);
                
                // 通知 UI 计算完成
                if (eventEmitter) {
                    eventEmitter.emit('areaCalculationCompleted', { 
                        area: result.area, 
                        triangleCount: result.triangleCount 
                    });
                }
                
                // 再次回调，这次包含计算结果
                if (lassoFinishedCallback) {
                    lassoFinishedCallback({
                        triangles: trianglesData, // 选中的三角面
                        area: result.area, // 使用 Worker 计算的面积
                        lassoPath: lassoPath, // 套索路径数据
                        isCalculating: false // 计算完成
                    });
                }
            } catch (error) {
                console.error(_LOG_TAG, 'Area calculation failed:', error);
                
                // 如果 Worker 失败，异步执行同步计算避免阻塞
                setTimeout(() => {
                    const fallbackArea = calculateAreaSync(highlightMesh.geometry);
                    
                    if (lassoFinishedCallback) {
                        lassoFinishedCallback({
                            triangles: trianglesData,
                            area: fallbackArea,
                            lassoPath: lassoPath,
                            isCalculating: false
                        });
                    }
                }, 0);
            } finally {
                isCalculatingArea = false;
            }
        }, 0);
    }

    function exitMeasurement() {
        console.log(_LOG_TAG, 'exitMeasurement');
        isRendering = false;
        selectionShape.visible = false;

        console.log(_LOG_TAG, 'exitMeasurement: 开始移除事件监听器...');
        console.log(_LOG_TAG, 'exitMeasurement: handlePointerDown存在:', !!handlePointerDown);
        console.log(_LOG_TAG, 'exitMeasurement: handlePointerUp存在:', !!handlePointerUp);
        console.log(_LOG_TAG, 'exitMeasurement: handlePointerMove存在:', !!handlePointerMove);

        // 移除事件监听器（现在可以安全地访问处理函数）
        if (handlePointerDown) {
            renderer.domElement.removeEventListener('mousedown', handlePointerDown);
            console.log(_LOG_TAG, 'exitMeasurement: 已移除mousedown事件监听器');
            // 修复：正确移除右键菜单事件监听器
            if (handlePointerDown.handleContextMenu) {
                renderer.domElement.removeEventListener('contextmenu', handlePointerDown.handleContextMenu);
                console.log(_LOG_TAG, 'exitMeasurement: 已移除contextmenu事件监听器');
            }
        }
        if (handlePointerUp) {
            renderer.domElement.removeEventListener('mouseup', handlePointerUp);
            console.log(_LOG_TAG, 'exitMeasurement: 已移除mouseup事件监听器');
        }
        if (handlePointerMove) {
            renderer.domElement.removeEventListener('mousemove', handlePointerMove);
            console.log(_LOG_TAG, 'exitMeasurement: 已移除mousemove事件监听器');
        }

        console.log(_LOG_TAG, 'exitMeasurement: 所有事件监听器移除完成');
    }

    function cancelMeasurement() {
        console.log(_LOG_TAG, 'cancelMeasurement');
        exitMeasurement();

        trianglesData = [];

        // 隐藏高亮网格
        if (highlightMesh) {
            highlightMesh.geometry.drawRange.count = 0;
            if (highlightWireframeMesh) {
                highlightWireframeMesh.geometry = highlightMesh.geometry;
            } 
        }  

        //清楚选择工具的点数据
        if(tool && tool.clearPoints)
        {
            tool.clearPoints();
        }

        //隐藏选择物体
        if(selectionShape)
        {
            selectionShape.visible = false;
        }

        //重置计算状态
        isCalculatingArea = false;
        selectionNeedsUpdate = false;
        selectionShapeNeedsUpdate = false;
        
        // 重置第一次点击状态，为下一次绘制做准备
        firstClickCaptured = false;
  
    }

    function saveMeasurement() {
        console.log(_LOG_TAG, 'saveMeasurement');
        exitMeasurement();

        // 重置第一次点击状态，为下一个组做准备
        firstClickCaptured = false;
        
        // 清除当前保存的测量数据，避免影响下一次测量
        trianglesData = [];
        
        // 重置高亮网格，避免显示已保存的测量结果
        if (highlightMesh) {
            highlightMesh.geometry.drawRange.count = 0;
            if (highlightWireframeMesh) {
                highlightWireframeMesh.geometry = highlightMesh.geometry;
            }
        }

        if (tool && typeof tool.clearPoints === 'function') {
        tool.clearPoints();
        console.log(_LOG_TAG, 'saveMeasurement: Cleared tool points.');
        
        // 同时强制更新 selectionShape 的几何体为空，防止下一帧渲染旧数据
        if (selectionShape) {
            selectionShape.geometry.setAttribute(
                'position',
                new THREE.Float32BufferAttribute([], 3)
            );
        }
    }
        
        console.log(_LOG_TAG, 'saveMeasurement: 清除了工具内部状态，为下一次测量做准备');
    }

    function init() {
        // selection shape
        selectionShapeGroup = new THREE.Group();
        scene.add(selectionShapeGroup);

        selectionShape = new THREE.Line();
        selectionShape.material.color.set(0xff9800);
        selectionShape.renderOrder = 9999;

        selectionShape.position.set(0, 0, -0.2);
        selectionShape.depthTest = false;

        selectionShapeGroup.add(selectionShape);
        selectionShape.visible = false;

        // test mesh
        // mesh = new THREE.Mesh(
        //     new THREE.TorusKnotGeometry( 1.5, 0.5, 500, 60 ).toNonIndexed(),
        //     new THREE.MeshStandardMaterial( {
        //         polygonOffset: true,
        //         polygonOffsetFactor: 1,
        //     } )
        // );
        // mesh.geometry.boundsTree = new MeshBVH( mesh.geometry );
        // mesh.geometry.setAttribute( 'color', new THREE.Uint8BufferAttribute(
        //     new Array( mesh.geometry.index.count * 3 ).fill( 255 ), 3, true
        // ) );
        // mesh.castShadow = true;
        // mesh.receiveShadow = true;
        // group.add( mesh );

        // base mesh
        mesh.geometry.boundsTree = new MeshBVH(mesh.geometry);

        helper = new MeshBVHHelper(mesh, params.helperDepth);
        group.add(helper);
        // 动态设置helper的深度
        // helper.depth = params.helperDepth;
        // helper.update();

        // meshes for selection highlights
        highlightMesh = new THREE.Mesh();
        highlightMesh.geometry = mesh.geometry.clone();
        highlightMesh.geometry.drawRange.count = 0;
        highlightMesh.material = new THREE.MeshBasicMaterial({
            opacity: configs.highlightMeshConfig.opacity,
            transparent: true,
            depthWrite: false,
        });
        highlightMesh.material.color.set(configs.highlightMeshConfig.color);
        highlightMesh.renderOrder = 1;
        group.add(highlightMesh);

        // 高亮面内部线框
        highlightWireframeMesh = new THREE.Mesh();
        highlightWireframeMesh.geometry = highlightMesh.geometry;
        highlightWireframeMesh.material = new THREE.MeshBasicMaterial({
            opacity: 0.25,
            transparent: true,
            wireframe: true,
            depthWrite: false,
        });
        highlightWireframeMesh.material.color.copy(highlightMesh.material.color);
        highlightWireframeMesh.renderOrder = 2;
        group.add(highlightWireframeMesh);

        console.log(_LOG_TAG, 'Planimetering init end');
    }

    function update() {
        if (!isRendering) return;


        mesh.material.wireframe = params.wireframe;
        helper.visible = params.displayHelper;
        const selectionPoints = tool.points;

        // Update the selection lasso lines
        if (selectionShapeNeedsUpdate) {
            selectionShape.geometry.setAttribute(
                'position',
                new THREE.Float32BufferAttribute(
                    selectionPoints.concat(selectionPoints.slice(0, 3)),
                    3,
                    false
                )
            );

            selectionShape.frustumCulled = false;
            selectionShapeNeedsUpdate = false;
        }

        if (selectionNeedsUpdate) {
            selectionNeedsUpdate = false;
            if (selectionPoints.length > 0) {
                updateSelection();
                // 使用 setTimeout 确保高亮显示先渲染，然后再执行耗时计算
                setTimeout(() => {
                    showMeasurement();
                }, 0);
            }
        }

        const yScale = Math.tan(THREE.MathUtils.DEG2RAD * camera.fov / 2) * selectionShape.position.z;
        selectionShape.scale.set(- yScale * camera.aspect, - yScale, 1);
        selectionShapeGroup.position.copy(camera.position);
        selectionShapeGroup.quaternion.copy(camera.quaternion);
    }

    /**
     * Compute selected triangles:
     *
     * 1. Construct a list of screen space line segments that represent the lasso shape drawn by the user.
     * 2. For every triangle in the geometry check if any part is within the lasso. If it is then consider the triangle selected.
     *
     * @see https://github.com/gkjohnson/three-mesh-bvh/issues/166#issuecomment-752194034
     */
    // 移除优化的网格更新器 - 已被二级混合策略替代

    function updateSelection() {

        const indices = computeSelectedTriangles(mesh, camera, tool, params);
        
        // 过滤掉在当前测量中已经存在的三角形索引（避免单次测量中的重叠计算）
        const newIndices = indices.filter(index => !trianglesData.includes(index));
        
        // 如果没有新的三角形索引,直接返回
        if (newIndices.length === 0) {
            return;
        }

        console.log(_LOG_TAG, 'updateSelection - 总索引:', indices.length, '新索引:', newIndices.length);

        // 直接使用原始更新方法（优化器已被二级混合策略替代）
        updateSelectionLegacy(indices, newIndices);
    }
    
    function updateSelectionLegacy(indices, newIndices) {
        const indexAttr = mesh.geometry.index;
        const newIndexAttr = highlightMesh.geometry.index;
        console.log(_LOG_TAG, 'updateSelection indexAttr', indexAttr);
        console.log(_LOG_TAG, 'updateSelection newIndexAttr', newIndexAttr);
        if (indices.length && params.selectWholeModel) {

            // if we found indices and we want to select the whole model
            for (let i = 0, l = indexAttr.count; i < l; i++) {

                const i2 = indexAttr.getX(i);
                newIndexAttr.setX(i, i2);

            }

            highlightMesh.geometry.drawRange.count = Infinity;
            newIndexAttr.needsUpdate = true;

        } else {
            let currentIndex = trianglesData.length;
            // update the highlight mesh - 只添加新的三角形
            for (let i = 0, l = newIndices.length; i < l; i++) {

                const i2 = indexAttr.getX(newIndices[i]);
                newIndexAttr.setX(currentIndex, i2);
                currentIndex++;
            }
            
            // 只添加新的三角形索引到 trianglesData
            trianglesData = [...trianglesData, ...newIndices];
            highlightMesh.geometry.drawRange.count = trianglesData.length;
            newIndexAttr.needsUpdate = true;

        }

    }

    /**
     * 使用 Worker 异步计算面积
     * @param {THREE.BufferGeometry} geometry - 几何体
     * @returns {Promise<{area: number, triangleCount: number}>}
     */
    async function calculateAreaAsync(geometry) {
        const vertices = geometry.attributes.position.array;
        const triangles = geometry.index.array;
        const indexCount = geometry.drawRange.count;
        
        console.log(_LOG_TAG, `Calculating area for ${indexCount / 3} triangles using Worker...`);
        
        return await areaCalculationManager.calculateArea(vertices, triangles, indexCount);
    }

    /**
     * 同步计算面积（备用方案）
     * @param {THREE.BufferGeometry} geometry - 几何体
     * @returns {number}
     */
    function calculateAreaSync(geometry) {
        const vertices = geometry.attributes.position.array;
        const triangles = geometry.index.array;
        const indexCount = geometry.drawRange.count;
        
        console.log(_LOG_TAG, `Calculating area for ${indexCount / 3} triangles synchronously (fallback)...`);
        
        const result = areaCalculationManager.calculateAreaSync(vertices, triangles, indexCount);
        return result.area;
    }



    function dispose() {
        exitMeasurement();

        // 清理选择工具
        tool = null;


        // 从场景中移除物体
        if (selectionShapeGroup) {
            scene.remove(selectionShapeGroup);
        }
        if (helper) {
            group.remove(helper);
        }
        if (highlightMesh) {
            group.remove(highlightMesh);
        }
        if (highlightWireframeMesh) {
            group.remove(highlightWireframeMesh);
        }

        // 清理几何体和材质
        if (selectionShape) {
            selectionShape.geometry.dispose();
            selectionShape.material.dispose();
        }
        if (helper) {
            helper.dispose();
        }
        if (highlightMesh) {
            highlightMesh.geometry.dispose();
            highlightMesh.material.dispose();
        }
        if (highlightWireframeMesh) {
            highlightWireframeMesh.material.dispose();
        }

        // 清理引用
        selectionShape = null;
        selectionShapeGroup = null;
        helper = null;
        highlightMesh = null;
        highlightWireframeMesh = null;
        mesh = null;
        areaCalculationManager = null;
    }

    // 初始化
    init();

    // 返回公共方法
    return {
        registerLassoFinishedCall,
        registerEventEmitter,
        registerFirstClickCallback,
        startMeasurement,
        exitMeasurement,
        cancelMeasurement,
        saveMeasurement,
        dispose,
        update
    };
}

