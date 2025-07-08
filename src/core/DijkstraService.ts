//@ts-ignore
import * as THREE from 'three';
import { MeshGraphData, IDijkstraService, ISceneController, IEventEmitter } from '../types/webgl-marking';
import { MinPriorityQueue } from '../utils/MinPriorityQueue';


/**
 * 提供了在 3D 模型表面进行路径查找的功能。
 * 它构建模型的网格图，并使用 Dijkstra 算法计算最短路径。
 */
export class DijkstraService implements IDijkstraService {
    // 多图存储：每个 partId 对应一个独立的图数据
    private meshGraphs: Map<string, MeshGraphData> = new Map();

    // Worker 管理：每个 partId 可能有自己的 Worker
    private activeWorkers: Map<string, Worker> = new Map();

    // 上下文状态追踪
    private initializingContexts: Set<string> = new Set();

    private eventEmitter: IEventEmitter;

    constructor(eventEmitter: IEventEmitter) {
        this.eventEmitter = eventEmitter;
    }

    /**
     * 为指定部位ID初始化图数据（新方法）
     * @param partId 部位的唯一标识符
     * @param model 对应的3D模型
     * @returns 是否成功启动初始化过程
     */
    public initializeForContext(partId: string, model: THREE.Group): boolean {
        console.log(`[DijkstraService] 开始为部位 ${partId} 初始化图数据...`);

        // 检查是否已经在初始化中
        if (this.initializingContexts.has(partId)) {
            console.warn(`[DijkstraService] 部位 ${partId} 已经在初始化中`);
            return false;
        }

        // 检查是否已经存在图数据
        if (this.meshGraphs.has(partId)) {
            console.warn(`[DijkstraService] 部位 ${partId} 的图数据已存在`);
            return true;
        }

        // 获取模型的几何数据
        const geometryData = this._extractGeometryFromModel(model);
        if (!geometryData) {
            console.error(`[DijkstraService] 无法从模型中提取几何数据: ${partId}`);
            this.eventEmitter.emit('error', {
                message: `DijkstraService: 无法为部位 ${partId} 提取几何数据`
            });
            return false;
        }

        // 将 partId 加入初始化集合
        this.initializingContexts.add(partId);

        try {
            // 创建新的 Web Worker
            const worker = new Worker(
                new URL('../workers/dijkstraGraphBuilder.worker.ts', import.meta.url),
                { type: 'module' }
            );

            // 设置 Worker 消息处理
            worker.onmessage = (event: MessageEvent) => {
                this._handleWorkerMessage(event, partId);
            };

            worker.onerror = (error: ErrorEvent) => {
                this._handleWorkerError(error, partId);
            };

            // 存储 Worker 引用
            this.activeWorkers.set(partId, worker);

            // 发送 BUILD_GRAPH 指令
            worker.postMessage({
                type: 'BUILD_GRAPH',
                partId: partId, // 传递上下文信息
                geometryData: {
                    position: new Float32Array(geometryData.position),
                    index: geometryData.index ?
                        (geometryData.index.BYTES_PER_ELEMENT === 2 ?
                            new Uint16Array(geometryData.index) :
                            new Uint32Array(geometryData.index)
                        ) : undefined
                },
                worldMatrixArray: geometryData.worldMatrixArray
            });

            console.log(`[DijkstraService] 为部位 ${partId} 启动了图构建 Worker`);
            return true;

        } catch (error) {
            this.initializingContexts.delete(partId);
            console.error(`[DijkstraService] 为部位 ${partId} 创建 Worker 失败:`, error);
            this.eventEmitter.emit('error', {
                message: `DijkstraService: 为部位 ${partId} 初始化失败`,
                details: error
            });
            return false;
        }
    }

    /**
     * 处理 Worker 消息（根据流程图实现）
     */
    private _handleWorkerMessage(event: MessageEvent, partId: string): void {
        const { type, graph, message, details, stage, percentage } = event.data;

        switch (type) {
            case 'PROGRESS':
                // 处理进度信息
                this.eventEmitter.emit('notification', {
                    message: `部位 ${partId} 图构建进度: ${stage} ${percentage}%`
                });
                break;

            case 'GRAPH_BUILT':
                // 反序列化图数据
                const deserializedVertices = graph.vertices.map((vArray: number[]) =>
                    new THREE.Vector3().fromArray(vArray)
                );
                const deserializedAdjacency = new Map<number, { neighborIndex: number, weight: number }[]>(
                    graph.adjacency
                );

                const meshGraphData: MeshGraphData = {
                    vertices: deserializedVertices,
                    adjacency: deserializedAdjacency,
                };

                // 存入 meshGraphs Map
                this.meshGraphs.set(partId, meshGraphData);

                // 移除 partId 从 initializingContexts
                this.initializingContexts.delete(partId);

                // 清理 Worker
                const worker = this.activeWorkers.get(partId);
                if (worker) {
                    worker.terminate();
                    this.activeWorkers.delete(partId);
                }

                console.log(`[DijkstraService] 部位 ${partId} 的图数据构建完成`);

                // 发出 dijkstraReady 事件
                this.eventEmitter.emit('dijkstraReady', true);
                break;

            case 'ERROR':
                this._handleWorkerError(new ErrorEvent('worker', {
                    message: message,
                    error: details
                }), partId);
                break;

            default:
                console.warn(`[DijkstraService] 未知的 Worker 消息类型: ${type}`);
        }
    }

    /**
     * 处理 Worker 错误
     */
    private _handleWorkerError(error: ErrorEvent, partId: string): void {
        console.error(`[DijkstraService] 部位 ${partId} 的 Worker 错误:`, error);

        // 移除初始化状态
        this.initializingContexts.delete(partId);

        // 清理 Worker
        const worker = this.activeWorkers.get(partId);
        if (worker) {
            worker.terminate();
            this.activeWorkers.delete(partId);
        }

        this.eventEmitter.emit('error', {
            message: `DijkstraService: 部位 ${partId} 图构建失败`,
            details: error.message
        });
        this.eventEmitter.emit('dijkstraReady', false);
    }

    /**
     * 从3D模型中提取几何数据
     */
    private _extractGeometryFromModel(model: THREE.Group): {
        position: Float32Array;
        index?: Uint16Array | Uint32Array;
        worldMatrixArray: number[];
    } | null {

        const targetMesh = this.findFirstMeshInModel(model)

        if (!targetMesh) {
            console.error('[DijkstraService] 在模型中未找到有效的网格');
            return null;
        }

        const geometry = targetMesh.geometry as THREE.BufferGeometry;
        const positionAttribute = geometry.attributes.position as THREE.BufferAttribute;
        const indexAttribute = geometry.index;

        return {
            position: positionAttribute.array as Float32Array,
            index: indexAttribute ? (indexAttribute.array as Uint16Array | Uint32Array) : undefined,
            worldMatrixArray: targetMesh.matrixWorld.toArray()
        };
    }

    /**
     * 检查特定上下文是否准备就绪
     */
    public isContextReady(partId: string): boolean {
        return this.meshGraphs.has(partId) && !this.initializingContexts.has(partId);
    }

    /**
     * 检查是否有任何图数据可用
     */
    public isReady(): boolean {
        return this.meshGraphs.size > 0;
    }

    /**
     * 上下文感知的最近顶点查找
     */
    public getClosestVertexIndex(pointInWorld: THREE.Vector3, partId: string): number | null {
        const meshGraph = this.meshGraphs.get(partId);
        if (!meshGraph || meshGraph.vertices.length === 0) {
            console.warn(`[DijkstraService] 部位 ${partId} 的图数据未准备好或无顶点`);
            return null;
        }

        let closestIndex = -1;
        let minDistanceSq = Infinity;

        meshGraph.vertices.forEach((vertex: THREE.Vector3, index: number) => {
            const distanceSq = vertex.distanceToSquared(pointInWorld);
            if (distanceSq < minDistanceSq) {
                minDistanceSq = distanceSq;
                closestIndex = index;
            }
        });

        return closestIndex === -1 ? null : closestIndex;
    }

    /**
     * 上下文感知的交点最近顶点查找
     */
    public getClosestGraphVertexNearIntersection(
        intersection: THREE.Intersection,
        partId: string
    ): number | null {
        if (!this.isContextReady(partId)) {
            console.warn(`[DijkstraService] 部位 ${partId} 图数据未准备好，使用回退方法`);
            return this.getClosestVertexIndex(intersection.point, partId);
        }

        if (!intersection.face) {
            console.warn(`[DijkstraService] 交点无面数据，使用回退方法`);
            return this.getClosestVertexIndex(intersection.point, partId);
        }

        return this.getClosestVertexIndex(intersection.point, partId);
    }

    /**
     * 上下文感知的最短路径查找
     */
    public findShortestPath(
        startVertexIndex: number,
        endVertexIndex: number,
        partId: string
    ): THREE.Vector3[] | null {
        const meshGraph = this.meshGraphs.get(partId);
        if (!meshGraph) {
            console.warn(`[DijkstraService] 部位 ${partId} 图数据未准备好`);
            return null;
        }

        if (startVertexIndex < 0 || startVertexIndex >= meshGraph.vertices.length ||
            endVertexIndex < 0 || endVertexIndex >= meshGraph.vertices.length) {
            console.warn(`[DijkstraService] 无效的起始/结束节点索引`);
            return null;
        }

        if (startVertexIndex === endVertexIndex) {
            return [meshGraph.vertices[startVertexIndex].clone()];
        }

        const numVertices = meshGraph.vertices.length;
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
                break;
            }

            const neighbors = meshGraph.adjacency.get(u) || [];
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
            console.warn(`[DijkstraService] 未找到从 ${startVertexIndex} 到 ${endVertexIndex} 的路径`);
            return null;
        }

        const path: THREE.Vector3[] = [];
        let currentIdx: number | null = endVertexIndex;
        while (currentIdx !== null) {
            path.unshift(meshGraph.vertices[currentIdx].clone());
            currentIdx = predecessors[currentIdx];
        }

        return path.length > 0 ? path : null;
    }

    /**
     * 获取指定上下文的图数据
     */
    public getGraphData(partId: string): MeshGraphData | null {
        return this.meshGraphs.get(partId) || null;
    }

    /**
     * 清理指定上下文的资源
     */
    public disposeContext(partId: string): void {
        // 终止相关的 Worker
        const worker = this.activeWorkers.get(partId);
        if (worker) {
            worker.terminate();
            this.activeWorkers.delete(partId);
        }

        // 移除图数据
        this.meshGraphs.delete(partId);

        // 移除初始化状态
        this.initializingContexts.delete(partId);

        console.log(`[DijkstraService] 已清理部位 ${partId} 的资源`);
    }

    /**
     * 获取所有已管理的上下文ID
     */
    public getAllContexts(): string[] {
        return Array.from(this.meshGraphs.keys());
    }

    private findFirstMeshInModel(model: THREE.Object3D): THREE.Mesh | null {
        let foundMesh: THREE.Mesh | null = null;
        model.traverse((child: THREE.Object3D) => {
            if (foundMesh) { // Optimization: stop searching once found
                return;
            }
            if ((child as THREE.Mesh).isMesh && (child as THREE.Mesh).geometry) {
                foundMesh = child as THREE.Mesh;
            }
        });
        return foundMesh;
    }

    /**
     * 清理所有资源
     */
    public dispose(): void {
        // 终止所有 Worker
        this.activeWorkers.forEach((worker, partId) => {
            worker.terminate();
            console.log(`[DijkstraService] 终止了部位 ${partId} 的 Worker`);
        });
        this.activeWorkers.clear();

        // 清理所有图数据
        this.meshGraphs.clear();

        // 清理初始化状态
        this.initializingContexts.clear();

        console.log("[DijkstraService] 已清理所有资源");
    }
}