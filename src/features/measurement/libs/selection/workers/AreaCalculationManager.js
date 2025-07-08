/**
 * Area calculation manager using Web Workers
 * Provides a clean async interface for expensive area calculations
 */
export class AreaCalculationManager {
    constructor() {
        this.worker = null;
        this.pendingTasks = new Map();
        this.taskIdCounter = 0;
        this.isInitialized = false;
    }

    /**
     * Initialize the worker
     */
    initialize() {
        if (this.isInitialized) return;

        try {
            // Create worker from the worker file
            const workerPath = new URL('./areaCalculationWorker.js', import.meta.url);
            this.worker = new Worker(workerPath);
            
            // Handle messages from worker
            this.worker.onmessage = (e) => {
                const { taskId, success, area, triangleCount, error } = e.data;
                
                const task = this.pendingTasks.get(taskId);
                if (task) {
                    this.pendingTasks.delete(taskId);
                    
                    if (success) {
                        task.resolve({ area, triangleCount });
                    } else {
                        task.reject(new Error(error));
                    }
                }
            };

            // Handle worker errors
            this.worker.onerror = (error) => {
                console.error('Area calculation worker error:', error);
                // Reject all pending tasks
                for (const [taskId, task] of this.pendingTasks) {
                    task.reject(new Error('Worker error: ' + error.message));
                }
                this.pendingTasks.clear();
            };

            this.isInitialized = true;
            console.log('Area calculation worker initialized');
        } catch (error) {
            console.error('Failed to initialize area calculation worker:', error);
            throw error;
        }
    }

    /**
     * Calculate area using Web Worker (async)
     * @param {Float32Array} vertices - Geometry vertices
     * @param {Uint32Array} triangles - Triangle indices
     * @param {number} indexCount - Number of indices to process
     * @returns {Promise<{area: number, triangleCount: number}>}
     */
    async calculateAreaAsync(vertices, triangles, indexCount) {
        if (!this.isInitialized) {
            this.initialize();
        }

        const taskId = ++this.taskIdCounter;
        
        return new Promise((resolve, reject) => {
            // Store the task for later resolution
            this.pendingTasks.set(taskId, { resolve, reject });

            // Send data to worker
            this.worker.postMessage({
                taskId,
                vertices: Array.from(vertices), // Convert to regular array for transfer
                triangles: Array.from(triangles),
                indexCount
            });
        });
    }

    /**
     * Calculate area synchronously (fallback for small datasets)
     * @param {Float32Array} vertices - Geometry vertices
     * @param {Uint32Array} triangles - Triangle indices
     * @param {number} indexCount - Number of indices to process
     * @returns {{area: number, triangleCount: number}}
     */
    calculateAreaSync(vertices, triangles, indexCount) {
        let area = 0;
        
        // 只遍历实际高亮的三角形
        for (let i = 0; i < indexCount; i += 3) {
            // 获取三角形的三个顶点索引
            const idx1 = triangles[i];
            const idx2 = triangles[i + 1];
            const idx3 = triangles[i + 2];
            
            // 获取顶点坐标
            const p1x = vertices[idx1 * 3];
            const p1y = vertices[idx1 * 3 + 1];
            const p1z = vertices[idx1 * 3 + 2];
            
            const p2x = vertices[idx2 * 3];
            const p2y = vertices[idx2 * 3 + 1];
            const p2z = vertices[idx2 * 3 + 2];
            
            const p3x = vertices[idx3 * 3];
            const p3y = vertices[idx3 * 3 + 1];
            const p3z = vertices[idx3 * 3 + 2];
            
            // 计算两个边向量
            const v1x = p2x - p1x;
            const v1y = p2y - p1y;
            const v1z = p2z - p1z;
            
            const v2x = p3x - p1x;
            const v2y = p3y - p1y;
            const v2z = p3z - p1z;
            
            // 计算叉积
            const crossX = v1y * v2z - v1z * v2y;
            const crossY = v1z * v2x - v1x * v2z;
            const crossZ = v1x * v2y - v1y * v2x;
            
            // 计算叉积的长度（即三角形面积的2倍）
            const crossLength = Math.sqrt(crossX * crossX + crossY * crossY + crossZ * crossZ);
            
            // 三角形面积
            const triangleArea = crossLength / 2;
            
            area += triangleArea;
        }
        
        return { 
            area, 
            triangleCount: indexCount / 3 
        };
    }

    /**
     * Smart calculation method that chooses between sync and async based on data size
     * @param {Float32Array} vertices - Geometry vertices
     * @param {Uint32Array} triangles - Triangle indices
     * @param {number} indexCount - Number of indices to process
     * @param {number} threshold - Threshold for switching to async (default: 3000 triangles)
     * @returns {Promise<{area: number, triangleCount: number}>}
     */
    async calculateArea(vertices, triangles, indexCount, threshold = 9000) {
        const triangleCount = indexCount / 3;
        
        if (triangleCount <= threshold) {
            // For small datasets, use synchronous calculation
            return this.calculateAreaSync(vertices, triangles, indexCount);
        } else {
            // For large datasets, use Web Worker
            return this.calculateAreaAsync(vertices, triangles, indexCount);
        }
    }

    /**
     * Clean up resources
     */
    dispose() {
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
        }
        
        // Reject all pending tasks
        for (const [taskId, task] of this.pendingTasks) {
            task.reject(new Error('Area calculation manager disposed'));
        }
        this.pendingTasks.clear();
        
        this.isInitialized = false;
    }
}

// Singleton instance
let instance = null;

/**
 * Get singleton instance of AreaCalculationManager
 * @returns {AreaCalculationManager}
 */
export function getAreaCalculationManager() {
    if (!instance) {
        instance = new AreaCalculationManager();
    }
    return instance;
} 