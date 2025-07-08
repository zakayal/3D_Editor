// Web Worker for area calculation
// This worker performs expensive area calculations in the background

self.onmessage = function(e) {
    const { vertices, triangles, indexCount, taskId } = e.data;
    
    try {
        const area = calculateArea(vertices, triangles, indexCount);
        
        // Send result back to main thread
        self.postMessage({
            taskId,
            success: true,
            area,
            triangleCount: indexCount / 3
        });
    } catch (error) {
        // Send error back to main thread
        self.postMessage({
            taskId,
            success: false,
            error: error.message
        });
    }
};

function calculateArea(vertices, triangles, indexCount) {
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
    
    return area;
} 