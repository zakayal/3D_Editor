// @ts-ignore
import * as THREE from 'three';

// 性能配置接口
interface PerformanceConfig {
    subdivisionThreshold: number;
    subdivisionSteps: number;
    proximityThreshold: number;
    maxConnectionsPerVertex: number;
    enableProximityConnections: boolean;
}

type Neighbor = {
    neighborIndex: number;
    weight: number;
}

type TransferableAdjacency = [ number , Neighbor[]][]

// 根据模型大小自动调整性能配置
const getPerformanceConfig = (vertexCount: number): PerformanceConfig => {
    console.log(`[Worker] Adjusting performance config for ${vertexCount} vertices`);
    
    if (vertexCount > 2000000) {
        // 极超大体积模型：最极端的优化设置，跳过大部分计算
        console.log(`[Worker] Using ultra-extreme optimization for massive model (${vertexCount} vertices)`);
        return {
            subdivisionThreshold: 0.2,      // 极高的阈值，基本不细分
            subdivisionSteps: 1,            // 最少的细分步数
            proximityThreshold: 0.2,        // 很大的邻近阈值
            maxConnectionsPerVertex: 3,     // 最少的连接
            enableProximityConnections: false // 禁用邻近连接
        };
    } else if (vertexCount > 1000000) {
        // 超大体积模型：最极端的优化设置
        console.log(`[Worker] Using extreme optimization for very large model (${vertexCount} vertices)`);
        return {
            subdivisionThreshold: 0.1,      // 极高的阈值，几乎不细分
            subdivisionSteps: 1,            // 最少的细分步数
            proximityThreshold: 0.1,        // 很大的邻近阈值
            maxConnectionsPerVertex: 4,     // 最少的连接
            enableProximityConnections: false // 对超大模型禁用邻近连接以节省时间
        };
    } else if (vertexCount > 100000) {
        // 大体积模型：更保守的设置
        return {
            subdivisionThreshold: 0.05,     // 更高的阈值，减少细分
            subdivisionSteps: 2,            // 更少的细分步数
            proximityThreshold: 0.05,       // 更大的邻近阈值
            maxConnectionsPerVertex: 6,     // 更少的连接
            enableProximityConnections: true // 仍然启用，但参数更保守
        };
    } else if (vertexCount > 50000) {
        // 中等体积模型：平衡设置
        return {
            subdivisionThreshold: 0.03,
            subdivisionSteps: 3,
            proximityThreshold: 0.04,
            maxConnectionsPerVertex: 8,
            enableProximityConnections: true
        };
    } else {
        // 小体积模型：更精细的设置
        return {
            subdivisionThreshold: 0.02,
            subdivisionSteps: 3,
            proximityThreshold: 0.03,
            maxConnectionsPerVertex: 8,
            enableProximityConnections: true
        };
    }
};

// 定义 buildMeshGraphWorker 函数的返回类型，明确包含 vertexMapping
interface BuildMeshGraphWorkerResult {
    vertices: THREE.Vector3[]; // 图的最终顶点列表
    adjacency: Map<number, { neighborIndex: number, weight: number }[]>; // 邻接表
    vertexMapping: number[]; // 原始顶点索引到图顶点索引的映射
}

const buildMeshGraphWorker = (geometryData: {
    position: Float32Array;
    index?: Uint16Array | Uint32Array;
}, worldMatrixArray: number[]): BuildMeshGraphWorkerResult => {
    console.log("[Worker] Starting graph construction.");
    const startTime = performance.now();
    
    // 进度报告函数
    const reportProgress = (stage: string, current: number, total: number) => {
        const percentage = Math.floor((current / total) * 100);
        // console.log(`[Worker] ${stage}: ${percentage}% (${current}/${total})`);
        // 每10%报告一次进度
        if (percentage % 10 === 0 && current > 0) {
            self.postMessage({
                type: 'PROGRESS',
                stage,
                percentage,
                current,
                total
            });
        }
    };

    const originalVertices: THREE.Vector3[] = [];
    const worldMatrix = new THREE.Matrix4().fromArray(worldMatrixArray);

    const positionAttributeCount = geometryData.position.length / 3;
    // console.log(`[Worker] Processing ${positionAttributeCount} vertices`);
    
    // 根据模型大小获取性能配置
    const config = getPerformanceConfig(positionAttributeCount);
    // console.log(`[Worker] Using performance config:`, config);
    
    // 阶段1：构建顶点
    const vertexBuildStart = performance.now();
    for (let i = 0; i < positionAttributeCount; i++) {
        if (i % Math.floor(positionAttributeCount / 10) === 0) {
            reportProgress("Building vertices", i, positionAttributeCount);
        }
        
        const v = new THREE.Vector3(
            geometryData.position[i * 3],
            geometryData.position[i * 3 + 1],
            geometryData.position[i * 3 + 2]
        );
        v.applyMatrix4(worldMatrix);
        originalVertices.push(v);
    }
    const vertexBuildTime = performance.now() - vertexBuildStart;
    console.log(`[Worker] Vertex building completed in ${vertexBuildTime.toFixed(2)}ms`);
    
    reportProgress("Building vertices", positionAttributeCount, positionAttributeCount);

    const vertices: THREE.Vector3[] = []; // 图的最终顶点数组 (会被 findOrAddVertex 填充)
    const adjacency = new Map<number, { neighborIndex: number, weight: number }[]>(); // 图的邻接表
    const vertexMapping: number[] = []; // 原始顶点索引 -> 图顶点索引 的映射
    const edgeSet = new Set<string>(); // 用于防止重复添加边
    const subdividedEdges = new Map<string, number[]>(); // 缓存已细分的边

    const DUPLICATE_THRESHOLD_SQ = 1e-9; // 判断顶点是否重复的阈值 (平方)
    const VERTEX_MERGE_THRESHOLD = 0.001;

    // 内部辅助函数：添加边到邻接表
    const addEdge = (v1Index: number, v2Index: number) => {
        if (v1Index === v2Index) return;
        // 确保索引在 vertices 数组的有效范围内
        if (v1Index < 0 || v1Index >= vertices.length || v2Index < 0 || v2Index >= vertices.length) {
            console.warn(`[Worker.addEdge] Invalid vertex index. v1: ${v1Index}, v2: ${v2Index}, vertices.length: ${vertices.length}`);
            return;
        }

        const edgeKey = `${Math.min(v1Index, v2Index)}-${Math.max(v1Index, v2Index)}`;
        if (edgeSet.has(edgeKey)) return; // 避免重复边
        edgeSet.add(edgeKey);

        const weight = vertices[v1Index].distanceTo(vertices[v2Index]);

        if (!adjacency.has(v1Index)) adjacency.set(v1Index, []);
        if (!adjacency.has(v2Index)) adjacency.set(v2Index, []);
        adjacency.get(v1Index)!.push({ neighborIndex: v2Index, weight });
        adjacency.get(v2Index)!.push({ neighborIndex: v1Index, weight });
    };

    // 内部辅助函数：查找或添加顶点到 `vertices` 数组，返回其在 `vertices` 中的索引
    const findOrAddVertex = (point: THREE.Vector3): number => {
        // 对于超大模型，跳过重复检查以提升性能
        if (originalVertices.length > 2000000) {
            // 直接添加，不检查重复（因为前面的合并步骤已经处理了大部分重复）
            vertices.push(point.clone());
            return vertices.length - 1;
        }
        
        // 对于中小模型，进行重复检查
        for (let i = 0; i < vertices.length; i++) {
            if (vertices[i].distanceToSquared(point) < DUPLICATE_THRESHOLD_SQ) {
                return i; // 找到现有顶点
            }
        }
        vertices.push(point.clone()); // 添加新顶点
        return vertices.length - 1; // 返回新顶点的索引
    };

    // 内部辅助函数：获取或创建（并细分）一条边，返回组成这条边的图顶点索引序列
    const getOrCreateSubdividedEdge = (
        v1_graph_idx: number, // 第一个顶点的图索引
        v2_graph_idx: number, // 第二个顶点的图索引
        p1_world: THREE.Vector3, // 第一个顶点的世界坐标 (用于细分计算)
        p2_world: THREE.Vector3  // 第二个顶点的世界坐标 (用于细分计算)
    ): number[] => {
        const edgeKey = `${Math.min(v1_graph_idx, v2_graph_idx)}-${Math.max(v1_graph_idx, v2_graph_idx)}`;
        if (subdividedEdges.has(edgeKey)) {
            return subdividedEdges.get(edgeKey)!;
        }

        const edgePoints_graph_indices = [v1_graph_idx]; // 路径点序列，存储图索引
        const edgeLength = p1_world.distanceTo(p2_world);
        // 使用配置中的细分参数
        const subdivisionThreshold = config.subdivisionThreshold;
        const subdivisionSteps = config.subdivisionSteps;

        if (edgeLength > subdivisionThreshold) {
            let prev_graph_idx = v1_graph_idx;
            for (let s = 1; s <= subdivisionSteps; s++) {
                const t = s / (subdivisionSteps + 1);
                const newPoint_world = new THREE.Vector3().lerpVectors(p1_world, p2_world, t);
                const current_subdivision_graph_idx = findOrAddVertex(newPoint_world); // 添加细分点到图

                addEdge(prev_graph_idx, current_subdivision_graph_idx); // 连接前一个点和当前细分点
                edgePoints_graph_indices.push(current_subdivision_graph_idx);
                prev_graph_idx = current_subdivision_graph_idx;
            }
            addEdge(prev_graph_idx, v2_graph_idx); // 连接最后一个细分点和边的终点
        } else {
            addEdge(v1_graph_idx, v2_graph_idx); // 边很短，不细分，直接连接
        }
        edgePoints_graph_indices.push(v2_graph_idx);
        subdividedEdges.set(edgeKey, edgePoints_graph_indices);
        return edgePoints_graph_indices;
    };

    const indexData = geometryData.index;

    if (indexData) {
        // --- 索引几何体处理逻辑 ---
        console.log(`[Worker] Processing indexed geometry with ${indexData.length / 3} faces`);
        const indexedGeometryStart = performance.now();
        
        // 1. 遍历所有原始顶点，通过 findOrAddVertex 将它们（或它们的唯一版本）添加到 `vertices` 数组中，
        //    并填充 `vertexMapping`，将原始索引映射到它们在 `vertices` 数组中的图索引。
        originalVertices.forEach((vertex, originalIdx) => {
            const graphIdx = findOrAddVertex(vertex.clone()); // findOrAddVertex 会处理去重并填充 `vertices`
            vertexMapping[originalIdx] = graphIdx;
        });

        // 2. 遍历面 (face)，使用图索引构建边
        const faceCount = indexData.length / 3;
        console.log(`[Worker] Building edges for ${faceCount} faces`);
        
        for (let i = 0; i < indexData.length; i += 3) {
            if (i % Math.floor(indexData.length / 10) === 0) {
                reportProgress("Building face edges", i / 3, faceCount);
            }
            
            const v1_original_idx = indexData[i];
            const v2_original_idx = indexData[i + 1];
            const v3_original_idx = indexData[i + 2];

            // 从 vertexMapping 获取这些原始顶点在 `vertices` 数组中的图索引
            const v1_graph_idx = vertexMapping[v1_original_idx];
            const v2_graph_idx = vertexMapping[v2_original_idx];
            const v3_graph_idx = vertexMapping[v3_original_idx];

            // 获取顶点的世界坐标用于细分计算
            const p1_world = originalVertices[v1_original_idx];
            const p2_world = originalVertices[v2_original_idx];
            const p3_world = originalVertices[v3_original_idx];

            // 检查获取的索引和坐标是否有效
            if (p1_world === undefined || p2_world === undefined || p3_world === undefined ||
                v1_graph_idx === undefined || v2_graph_idx === undefined || v3_graph_idx === undefined) {
                console.warn(`[Worker] Invalid vertex data for face (original indices: ${v1_original_idx},${v2_original_idx},${v3_original_idx}). Skipping face.`);
                continue;
            }
            // 确保顶点索引有效
            if (v1_graph_idx >= vertices.length || v2_graph_idx >= vertices.length || v3_graph_idx >= vertices.length) {
                console.warn(`[Worker] Graph index out of bounds for face. Skipping face.`);
                continue;
            }

            // 对于超大模型，简化边构建逻辑
            if (config.subdivisionThreshold >= 0.1) {
                // 超大模型：直接连接，不细分
                addEdge(v1_graph_idx, v2_graph_idx);
                addEdge(v2_graph_idx, v3_graph_idx);
                addEdge(v3_graph_idx, v1_graph_idx);
            } else {
                // 使用图索引和世界坐标调用 getOrCreateSubdividedEdge
                const edge12_graph_indices = getOrCreateSubdividedEdge(v1_graph_idx, v2_graph_idx, p1_world, p2_world);
                const edge23_graph_indices = getOrCreateSubdividedEdge(v2_graph_idx, v3_graph_idx, p2_world, p3_world);
                const edge31_graph_indices = getOrCreateSubdividedEdge(v3_graph_idx, v1_graph_idx, p3_world, p1_world);

                // 连接细分点到对面顶点 (使用图索引)
                edge12_graph_indices.slice(1, -1).forEach(sub_graph_idx => addEdge(sub_graph_idx, v3_graph_idx));
                edge23_graph_indices.slice(1, -1).forEach(sub_graph_idx => addEdge(sub_graph_idx, v1_graph_idx));
                edge31_graph_indices.slice(1, -1).forEach(sub_graph_idx => addEdge(sub_graph_idx, v2_graph_idx));

                // 连接三角形内所有（包括细分）顶点 (使用图索引)
                const allTrianglePoints_graph_indices = [...new Set([...edge12_graph_indices, ...edge23_graph_indices, ...edge31_graph_indices])];
                for (let j = 0; j < allTrianglePoints_graph_indices.length; j++) {
                    for (let k = j + 1; k < allTrianglePoints_graph_indices.length; k++) {
                        addEdge(allTrianglePoints_graph_indices[j], allTrianglePoints_graph_indices[k]);
                    }
                }
            }
        }
        
        reportProgress("Building face edges", faceCount, faceCount);
        const indexedGeometryTime = performance.now() - indexedGeometryStart;
        console.log(`[Worker] Indexed geometry processing completed in ${indexedGeometryTime.toFixed(2)}ms`);
    } else {
        // --- 非索引几何体处理逻辑 (修改部分) ---
        console.log(`[Worker] Processing non-indexed geometry`);
        const nonIndexedStart = performance.now();
        
        const tempVertexMap = new Map<string, number>(); // 用于合并顶点的临时映射 (key: stringified coords, value: index in mergedOriginalVertices)
        const mergedOriginalVertices: THREE.Vector3[] = []; // 存储合并后的原始顶点

        // 这个映射表将存储：originalVertices中的索引 -> mergedOriginalVertices中的索引
        const originalToMergedIndexMap: number[] = new Array(originalVertices.length);

        // 1. 填充 mergedOriginalVertices 和 originalToMergedIndexMap
        // console.log(`[Worker] Merging ${originalVertices.length} vertices`);
        const mergeStart = performance.now();
        
        // 对于超大模型，使用优化的合并策略
        if (originalVertices.length > 1000000) {
            // console.log(`[Worker] Using fast merge strategy for very large model`);
            // 超大模型：只使用字符串键合并，跳过距离比较以节省时间
            for (let i = 0; i < originalVertices.length; i++) {
                if (i % Math.floor(originalVertices.length / 10) === 0) {
                    reportProgress("Merging vertices (fast)", i, originalVertices.length);
                }
                
                const vertex = originalVertices[i];
                // 使用更粗糙的精度来增加合并率
                const key = `${vertex.x.toFixed(4)}_${vertex.y.toFixed(4)}_${vertex.z.toFixed(4)}`;
                
                const existingMergedIdx = tempVertexMap.get(key);
                if (existingMergedIdx !== undefined) {
                    originalToMergedIndexMap[i] = existingMergedIdx;
                } else {
                    const newMergedIdx = mergedOriginalVertices.length;
                    mergedOriginalVertices.push(vertex.clone());
                    tempVertexMap.set(key, newMergedIdx);
                    originalToMergedIndexMap[i] = newMergedIdx;
                }
            }
        } else {
            // 中小模型：使用空间网格优化的合并策略
            // console.log(`[Worker] Using spatial grid merge strategy`);
            const gridSize = VERTEX_MERGE_THRESHOLD * 2; // 网格大小基于合并阈值
            const spatialGrid = new Map<string, number[]>();
            
            const getSpatialKey = (v: THREE.Vector3) => {
                const x = Math.floor(v.x / gridSize);
                const y = Math.floor(v.y / gridSize);
                const z = Math.floor(v.z / gridSize);
                return `${x},${y},${z}`;
            };
            
            for (let i = 0; i < originalVertices.length; i++) {
                if (i % Math.floor(originalVertices.length / 10) === 0) {
                    reportProgress("Merging vertices (spatial)", i, originalVertices.length);
                }
                
                const vertex = originalVertices[i];
                const key = `${vertex.x.toFixed(6)}_${vertex.y.toFixed(6)}_${vertex.z.toFixed(6)}`;
                
                const existingMergedIdx = tempVertexMap.get(key);
                if (existingMergedIdx !== undefined) {
                    originalToMergedIndexMap[i] = existingMergedIdx;
                } else {
                    // 使用空间网格查找邻近顶点
                    let foundByDistance = false;
                    let distanceMergedIdx = -1;
                    
                    const spatialKey = getSpatialKey(vertex);
                    const coords = spatialKey.split(',').map(Number);
                    
                    // 检查当前网格及其邻近网格
                    for (let dx = -1; dx <= 1 && !foundByDistance; dx++) {
                        for (let dy = -1; dy <= 1 && !foundByDistance; dy++) {
                            for (let dz = -1; dz <= 1 && !foundByDistance; dz++) {
                                const neighborKey = `${coords[0] + dx},${coords[1] + dy},${coords[2] + dz}`;
                                const neighborIndices = spatialGrid.get(neighborKey);
                                
                                if (neighborIndices) {
                                    for (const j of neighborIndices) {
                                        if (mergedOriginalVertices[j].distanceToSquared(vertex) < VERTEX_MERGE_THRESHOLD * VERTEX_MERGE_THRESHOLD) {
                                            distanceMergedIdx = j;
                                            foundByDistance = true;
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                    }
                    
                    if (foundByDistance) {
                        originalToMergedIndexMap[i] = distanceMergedIdx;
                    } else {
                        const newMergedIdx = mergedOriginalVertices.length;
                        mergedOriginalVertices.push(vertex.clone());
                        tempVertexMap.set(key, newMergedIdx);
                        originalToMergedIndexMap[i] = newMergedIdx;
                        
                        // 添加到空间网格
                        if (!spatialGrid.has(spatialKey)) {
                            spatialGrid.set(spatialKey, []);
                        }
                        spatialGrid.get(spatialKey)!.push(newMergedIdx);
                    }
                }
            }
        }
        
        reportProgress("Merging vertices", originalVertices.length, originalVertices.length);
        const mergeTime = performance.now() - mergeStart;
        console.log(`[Worker] Vertex merging completed in ${mergeTime.toFixed(2)}ms, reduced from ${originalVertices.length} to ${mergedOriginalVertices.length} vertices`);

        // 2. 将 mergedOriginalVertices 中的顶点添加到最终的全局 `vertices` 数组中，
        //    并建立从 mergedOriginalVertices 索引到全局 `vertices` 索引的映射。
        //    同时，更新 vertexMapping 以直接映射 originalVertices 索引到全局 `vertices` 索引。
        // console.log(`[Worker] Building vertex mapping for ${mergedOriginalVertices.length} merged vertices`);
        const mappingStart = performance.now();
        
        const mergedToGlobalGraphIndexMap: number[] = new Array(mergedOriginalVertices.length);
        for (let i = 0; i < mergedOriginalVertices.length; i++) {
            if (i % Math.floor(mergedOriginalVertices.length / 10) === 0) {
                reportProgress("Building vertex mapping", i, mergedOriginalVertices.length);
            }
            mergedToGlobalGraphIndexMap[i] = findOrAddVertex(mergedOriginalVertices[i]);
        }

        // 更新 vertexMapping，使其直接从 originalVertices 的索引映射到全局 `vertices` 的索引
        // console.log(`[Worker] Updating vertex mapping for ${originalVertices.length} original vertices`);
        for (let i = 0; i < originalVertices.length; i++) {
            if (i % Math.floor(originalVertices.length / 10) === 0) {
                reportProgress("Updating vertex mapping", i, originalVertices.length);
            }
            const mergedIdx = originalToMergedIndexMap[i];
            vertexMapping[i] = mergedToGlobalGraphIndexMap[mergedIdx];
        }
        
        reportProgress("Updating vertex mapping", originalVertices.length, originalVertices.length);
        const mappingTime = performance.now() - mappingStart;
        console.log(`[Worker] Vertex mapping completed in ${mappingTime.toFixed(2)}ms, final graph has ${vertices.length} vertices`);

        // 3. 构建边 (现在 vertexMapping 中的索引是相对于全局 `vertices` 数组的，可以直接用于 addEdge)
        const triangleCount = Math.floor(positionAttributeCount / 3);
        // console.log(`[Worker] Building triangle edges for ${triangleCount} triangles`);
        const triangleEdgeStart = performance.now();
        
        // 对于极超大模型，完全跳过三角形边构建以获得最快速度
        if (originalVertices.length > 2000000) {
            // console.log(`[Worker] Skipping triangle edge building for massive model to ensure fast loading`);
            // console.log(`[Worker] Building minimal connectivity instead...`);
            
            // 为极超大模型构建最小连接：只连接临近的顶点
            const step = Math.max(1, Math.floor(vertices.length / 1000)); // 只连接1000个顶点
            for (let i = 0; i < vertices.length; i += step) {
                if (i % Math.floor(vertices.length / step / 10) === 0) {
                    reportProgress("Building minimal connections", i / step, Math.floor(vertices.length / step));
                }
                
                // 连接到下一个顶点（如果存在）
                if (i + step < vertices.length) {
                    addEdge(i, i + step);
                }
                
                // 连接到附近的几个顶点以保证连通性
                for (let j = 1; j <= 3 && i + j < vertices.length; j++) {
                    addEdge(i, i + j);
                }
            }
            
            reportProgress("Building minimal connections", Math.floor(vertices.length / step), Math.floor(vertices.length / step));
        } else {
            // 对于超大模型，使用采样策略减少处理的三角形数量
            let actualTriangleCount = triangleCount;
            let skipStep = 1;
            
            if (originalVertices.length > 1000000) {
                // 超大模型：只处理每N个三角形，大幅减少计算量
                skipStep = Math.max(1, Math.floor(triangleCount / 200000)); // 限制最多处理20万个三角形
                actualTriangleCount = Math.floor(triangleCount / skipStep);
                // console.log(`[Worker] Using triangle sampling for very large model: processing every ${skipStep} triangles (${actualTriangleCount} out of ${triangleCount})`);
            }
            
            for (let i = 0; i < triangleCount; i += skipStep) {
                if (i % Math.floor(actualTriangleCount / 10) === 0) {
                    reportProgress("Building triangle edges", i / skipStep, actualTriangleCount);
                }
                
                const baseOriginalIdx = i * 3;
                if (baseOriginalIdx + 2 >= positionAttributeCount) break;

                const v1_graph_idx = vertexMapping[baseOriginalIdx];
                const v2_graph_idx = vertexMapping[baseOriginalIdx + 1];
                const v3_graph_idx = vertexMapping[baseOriginalIdx + 2];

                if (v1_graph_idx === v2_graph_idx ||
                    v2_graph_idx === v3_graph_idx ||
                    v3_graph_idx === v1_graph_idx) {
                    continue;
                }
                
                addEdge(v1_graph_idx, v2_graph_idx);
                addEdge(v2_graph_idx, v3_graph_idx);
                addEdge(v3_graph_idx, v1_graph_idx);
            }
        }
        
        reportProgress("Building triangle edges", triangleCount, triangleCount);
        const triangleEdgeTime = performance.now() - triangleEdgeStart;
        console.log(`[Worker] Triangle edge building completed in ${triangleEdgeTime.toFixed(2)}ms`);

        // 4. 优化：使用空间分割提升邻近连接算法的性能
        if (config.enableProximityConnections) {
            // console.log("[Worker] Starting proximity-based connections with spatial optimization...");
            const proximityStart = performance.now();
            
            const PROXIMITY_THRESHOLD = config.proximityThreshold;
            const MAX_CONNECTIONS_PER_VERTEX = config.maxConnectionsPerVertex;

            const buildSpatialGrid = (vertices: THREE.Vector3[], gridSize: number) => {
                const grid = new Map<string, number[]>();
                const getGridKey = (v: THREE.Vector3) => {
                    const x = Math.floor(v.x / gridSize);
                    const y = Math.floor(v.y / gridSize);
                    const z = Math.floor(v.z / gridSize);
                    return `${x},${y},${z}`;
                };

                vertices.forEach((vertex, index) => {
                    const key = getGridKey(vertex);
                    if (!grid.has(key)) {
                        grid.set(key, []);
                    }
                    grid.get(key)!.push(index);
                });

                return { grid, getGridKey };
            };

            const { grid, getGridKey } = buildSpatialGrid(vertices, PROXIMITY_THRESHOLD);
            
            for (let i = 0; i < vertices.length; i++) {
                if (i % Math.floor(vertices.length / 10) === 0) {
                    reportProgress("Building proximity connections", i, vertices.length);
                }
                
                const currentConnections = adjacency.get(i)?.length || 0;
                if (currentConnections >= MAX_CONNECTIONS_PER_VERTEX) continue;

                const vertex = vertices[i];
                const gridKey = getGridKey(vertex);
                const candidateNeighbors: { index: number, distance: number }[] = [];

                const coords = gridKey.split(',').map(Number);
                for (let dx = -1; dx <= 1; dx++) {
                    for (let dy = -1; dy <= 1; dy++) {
                        for (let dz = -1; dz <= 1; dz++) {
                            const neighborKey = `${coords[0] + dx},${coords[1] + dy},${coords[2] + dz}`;
                            const neighborIndices = grid.get(neighborKey);
                            
                            if (neighborIndices) {
                                for (const j of neighborIndices) {
                                    if (j <= i) continue;
                                    
                                    const distance = vertices[i].distanceTo(vertices[j]);
                                    if (distance < PROXIMITY_THRESHOLD && distance > 1e-8) {
                                        candidateNeighbors.push({ index: j, distance });
                                    }
                                }
                            }
                        }
                    }
                }

                candidateNeighbors.sort((a, b) => a.distance - b.distance);
                const connectionsToAdd = Math.min(
                    candidateNeighbors.length,
                    MAX_CONNECTIONS_PER_VERTEX - currentConnections
                );
                for (let k = 0; k < connectionsToAdd; k++) {
                    addEdge(i, candidateNeighbors[k].index);
                }
            }
            
            reportProgress("Building proximity connections", vertices.length, vertices.length);
            const proximityTime = performance.now() - proximityStart;
            console.log(`[Worker] Proximity-based connections completed in ${proximityTime.toFixed(2)}ms`);
        } else {
            console.log("[Worker] Proximity-based connections disabled for performance.");
        }
        
        const nonIndexedTime = performance.now() - nonIndexedStart;
        console.log(`[Worker] Non-indexed geometry processing completed in ${nonIndexedTime.toFixed(2)}ms`);
    }

    console.log("[Worker] Graph construction completed.");

    const totalTime = performance.now() - startTime;
    console.log(`[Worker] Graph construction completed in ${totalTime.toFixed(2)}ms`);
    console.log(`[Worker] Final graph statistics: ${vertices.length} vertices, ${edgeSet.size} edges`);

    const transferableAdjacency: TransferableAdjacency = Array.from(adjacency.entries()).map(([key, value]) => [
        key,
        value.map(n => ({ neighborIndex: n.neighborIndex, weight: n.weight }))
    ]);

    return {
        vertices: vertices,
        adjacency: new Map(transferableAdjacency),
        vertexMapping: vertexMapping
    };
};

// 监听从主线程发来的消息
self.onmessage = (event: MessageEvent) => {
    const { type, geometryData, worldMatrixArray } = event.data;

    if (type === 'BUILD_GRAPH') {
        try {
            const result: BuildMeshGraphWorkerResult = buildMeshGraphWorker(geometryData, worldMatrixArray);

            const serializableVertices = result.vertices.map(v => v.toArray());
            const serializableAdjacency = Array.from(result.adjacency.entries());
            console.log('[Worker] Graph construction completed, starting postMessage');

            self.postMessage({
                type: 'GRAPH_BUILT',
                graph: {
                    vertices: serializableVertices,
                    adjacency: serializableAdjacency
                },
                vertexMapping: result.vertexMapping
            });
        } catch (error: any) {
            console.error("[Worker] Error during graph building:", error);
            self.postMessage({
                type: 'ERROR',
                message: `Failed to build graph in worker: ${error.message}`,
                details: error.stack
            });
        }
    }
};