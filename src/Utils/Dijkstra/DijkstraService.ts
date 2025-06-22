//@ts-ignore
import * as THREE from 'three';
import { MeshGraphData, IDijkstraService, ISceneController, IEventEmitter } from '../../types/webgl-marking';
import { MinPriorityQueue } from '../MinPriorityQueue/MinPriorityQueue';


/**
 * 提供了在 3D 模型表面进行路径查找的功能。
 * 它构建模型的网格图，并使用 Dijkstra 算法计算最短路径。
 */
export class DijkstraService implements IDijkstraService {
    private meshGraph: MeshGraphData | null = null;
    private graphBuilderWorker: Worker | null = null;
    private eventEmitter: IEventEmitter; // 添加 eventEmitter 引用
    private isInitializing: boolean = false; // 防止重复初始化

    constructor(eventEmitter: IEventEmitter) {
        this.eventEmitter = eventEmitter // 初始化 eventEmitter
    }

    public initialize(sceneController: ISceneController): boolean {
        console.log("[DijkstraService.initialize] Initializing...");
        if (this.isInitializing) {
            console.warn("[DijkstraService.initialize] Already initializing.");
            return false; // 或者根据情况返回当前状态
        }

        if (!sceneController) {
            console.error("[DijkstraService.initialize] SceneController is null or undefined");
            this.eventEmitter.emit('error', { message: "DijkstraService: SceneController not provided." });
            return false;
        }

        const geometry = sceneController.getTargetMeshGeometry();
        const worldMatrix = sceneController.getTargetMeshWorldMatrix();

        if (!geometry || !worldMatrix) {
            console.error("[DijkstraService.initialize] Target mesh geometry or world matrix not available.");
            this.eventEmitter.emit('error', { message: "DijkstraService: Target mesh data not available." });
            return false;
        }
        console.log("[DijkstraService.initialize] Target mesh data found. Starting graph build via worker.");
        this.isInitializing = true;
        this.meshGraph = null; // 清除旧图

        // 终止可能存在的旧 Worker
        if (this.graphBuilderWorker) {
            this.graphBuilderWorker.terminate();
            this.graphBuilderWorker = null;
        }

        try {
            // 路径相对于当前文件或项目的构建输出。
            // 如果使用 Vite 或类似现代构建工具，new URL(..., import.meta.url) 是推荐方式。
            // 对于其他打包器，可能需要查阅其关于 Web Worker 路径的文档。
            this.graphBuilderWorker = new Worker(new URL('../../Workers/dijkstraGraphBuilder.worker.ts', import.meta.url), { type: 'module' });

            this.graphBuilderWorker.onmessage = (event: MessageEvent) => {
                console.log('event data:', event.data);
                
                const { type, graph, vertexMapping: _vertexMapping, message, details, stage, percentage, current, total } = event.data;

                if (type === 'PROGRESS') {
                    // 处理进度更新
                    console.log(`[DijkstraService.worker] Progress: ${stage} ${percentage}% (${current}/${total})`);
                    this.eventEmitter.emit('notification', { 
                        message: `图形构建进度: ${stage} ${percentage}%` 
                    });
                } else if (type === 'GRAPH_BUILT') {
                    this.isInitializing = false; // Worker 完成，结束初始化状态
                    console.log("[DijkstraService.worker] Graph built successfully by worker.");
                    const deserializedVertices = graph.vertices.map((vArray: number[]) => new THREE.Vector3().fromArray(vArray));
                    const deserializedAdjacency = new Map<number, { neighborIndex: number, weight: number }[]>(graph.adjacency);

                    this.meshGraph = {
                        vertices: deserializedVertices,
                        adjacency: deserializedAdjacency,
                        // vertexMapping: vertexMapping // 如果需要在主线程使用 vertexMapping
                    };
                    console.log("[DijkstraService.worker] Mesh graph processed.", {
                        vertices: this.meshGraph.vertices.length,
                        edges: this.countEdges(this.meshGraph.adjacency),
                        // vertexMappingLength: vertexMapping?.length
                    });
                    // 通知 API 图已准备好
                    
                    this.eventEmitter.emit('dijkstraReady', true); // 自定义事件通知API
                } else if (type === 'ERROR') {
                    this.isInitializing = false; // 出错时也要结束初始化状态
                    console.error("[DijkstraService.worker] Error from graph builder worker:", message, details);
                    this.meshGraph = null;
                    this.eventEmitter.emit('error', { message: `Dijkstra Worker Error: ${message}`, details });
                    this.eventEmitter.emit('dijkstraReady', false);
                }
            };

            this.graphBuilderWorker.onerror = (error: ErrorEvent) => {
                this.isInitializing = false;
                console.error("[DijkstraService.worker] Worker error:", error);
                this.meshGraph = null;
                this.eventEmitter.emit('error', { message: "DijkstraService: Worker encountered an error.", details: error.message });
                this.eventEmitter.emit('dijkstraReady', false);
            };

            // 准备发送给 Worker 的数据
            const positionAttribute = geometry.attributes.position as THREE.BufferAttribute;
            const indexAttribute = geometry.index;

            const geometryData = {
                position: positionAttribute.array as Float32Array,
                index: indexAttribute ? (indexAttribute.array as Uint16Array | Uint32Array) : undefined,
            };
            const worldMatrixArray = worldMatrix.toArray();

            // 发送数据到 Worker
            // 注意：Float32Array 和 UintArray 可以作为 Transferable Objects 发送以提高性能，但这里简单发送副本。
            // 如果要转移所有权：this.graphBuilderWorker.postMessage({ type: 'BUILD_GRAPH', geometryData, worldMatrixArray }, [geometryData.position.buffer, geometryData.index?.buffer].filter(Boolean));
            this.graphBuilderWorker.postMessage({
                type: 'BUILD_GRAPH',
                geometryData: { // 发送可序列化的数据副本
                    position: new Float32Array(geometryData.position),
                    index: geometryData.index ? (geometryData.index.BYTES_PER_ELEMENT === 2 ? new Uint16Array(geometryData.index) : new Uint32Array(geometryData.index)) : undefined
                },
                worldMatrixArray
            });

            // initialize 方法现在启动异步过程，可以返回 true 表示"已开始"
            // 真正的"就绪"状态将通过 isReady() 和事件来体现
            return true;

        } catch (error) {
            this.isInitializing = false;
            console.error("[DijkstraService.initialize] Failed to create or communicate with worker.", error);
            this.meshGraph = null;
            this.eventEmitter.emit('error', { message: "DijkstraService: Failed to init worker.", details: error });
            return false;
        }
    }

    /** 检查服务是否已准备好（图已构建） */
    public isReady(): boolean {
        return this.meshGraph !== null;
    }


    /** 计算边数 (用于日志) */
    private countEdges(adjacency: Map<number, { neighborIndex: number; weight: number; }[]>): number {
        let count = 0;
        adjacency.forEach(neighbors => count += neighbors.length);
        return count / 2; // Each edge is counted twice
    }

    /**
     * 查找距离给定世界坐标点最近的网格顶点索引。
     */
    public getClosestVertexIndex(pointInWorld: THREE.Vector3): number | null {
        if (!this.isReady() || !this.meshGraph || this.meshGraph.vertices.length === 0) { // 确保 isReady() 检查
            console.warn("[DijkstraService.getClosestVertexIndex] Mesh graph not ready or no vertices.");
            return null;
        }

        let closestIndex = -1;
        let minDistanceSq = Infinity;

        this.meshGraph.vertices.forEach((vertex: THREE.Vector3, index: number) => {
            const distanceSq = vertex.distanceToSquared(pointInWorld);
            if (distanceSq < minDistanceSq) {
                minDistanceSq = distanceSq;
                closestIndex = index;
            }
        });

        return closestIndex === -1 ? null : closestIndex;
    }

    /**
     * 查找距离给定交点最近的图顶点索引。
     */
    public getClosestGraphVertexNearIntersection(intersection: THREE.Intersection): number | null {
        if (!this.isReady() || !this.meshGraph) {
            console.warn("[DijkstraService.getClosestGraphVertexNearIntersection] Graph not ready. Using fallback.");
            return this.getClosestVertexIndex(intersection.point);
        }
        if (!intersection.face) {
            console.warn("[DijkstraService.getClosestGraphVertexNearIntersection] Intersection has no face data. Using fallback.");
            return this.getClosestVertexIndex(intersection.point);
        }

        return this.getClosestVertexIndex(intersection.point);
    }


    /**
     * 使用 Dijkstra 算法查找最短路径。
     */
    public findShortestPath(startVertexIndex: number, endVertexIndex: number): THREE.Vector3[] | null {
        if (!this.isReady() || !this.meshGraph) { // 确保 isReady() 检查
            console.warn(`[DijkstraService.findShortestPath] Graph not ready. Start: ${startVertexIndex}, End: ${endVertexIndex}`);
            return null;
        }

        if (startVertexIndex < 0 || startVertexIndex >= this.meshGraph.vertices.length ||
            endVertexIndex < 0 || endVertexIndex >= this.meshGraph.vertices.length) {
            console.warn(`[DijkstraService.findShortestPath] Invalid start/end node. Start: ${startVertexIndex}, End: ${endVertexIndex}, Vertices: ${this.meshGraph.vertices.length}`);
            return null;
        }

        if (startVertexIndex === endVertexIndex) {
            console.log("[DijkstraService.findShortestPath] Start and end vertex are the same:", startVertexIndex);
            return [this.meshGraph.vertices[startVertexIndex].clone()];
        }

        const numVertices = this.meshGraph.vertices.length;
        const distances: number[] = new Array(numVertices).fill(Infinity);
        const predecessors: (number | null)[] = new Array(numVertices).fill(null);
        const pq = new MinPriorityQueue();

        distances[startVertexIndex] = 0;
        pq.insert(startVertexIndex, 0);

        while (!pq.isEmpty()) {
            const current = pq.extractMin();
            if (!current) break;

            const { vertex: u, distance: uDistance } = current;

            if (uDistance > distances[u]) {
                continue;
            }

            if (u === endVertexIndex) {
                break; // Path found
            }

            const neighbors = this.meshGraph.adjacency.get(u) || [];
            for (const { neighborIndex: v, weight } of neighbors) {
                const altDistance = uDistance + weight;
                if (altDistance < distances[v]) {
                    distances[v] = altDistance;
                    predecessors[v] = u;
                    if (pq.contains(v)) {
                        pq.decreaseKey(v, altDistance);
                    } else {
                        pq.insert(v, altDistance);
                    }
                }
            }
        }

        if (predecessors[endVertexIndex] === null && startVertexIndex !== endVertexIndex) {
            console.warn(`[DijkstraService.findShortestPath] No path found from ${startVertexIndex} to ${endVertexIndex}. Predecessor for end is null.`);
            return null;
        }

        const path: THREE.Vector3[] = [];
        let currentIdx: number | null = endVertexIndex;
        while (currentIdx !== null) {
            path.unshift(this.meshGraph.vertices[currentIdx].clone());
            currentIdx = predecessors[currentIdx];
        }

        return path.length > 0 ? path : null;
    }

    /** 获取网格数据，主要用于 SurfaceMeasurementTool */
    public getGraphData(): MeshGraphData | null {
        return this.meshGraph;
    }
    public dispose(): void {
        if (this.graphBuilderWorker) {
            this.graphBuilderWorker.terminate();
            this.graphBuilderWorker = null;
        }
        this.meshGraph = null;
        this.isInitializing = false;
        console.log("[DijkstraService] Disposed.");
    }
}