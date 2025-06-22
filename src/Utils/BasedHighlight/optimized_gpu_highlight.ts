import * as THREE from 'three';

/**
 * 分级GPU高亮系统 - 解决大规模几何体性能问题
 * 1. LOD分级渲染
 * 2. 流式处理防崩溃
 * 3. 多帧分摊计算
 * 4. 内存优化策略
 */
export class OptimizedGPUHighlightSystem {
    private renderer: THREE.WebGLRenderer;
    private scene: THREE.Scene;
    private camera: THREE.Camera;
    
    // 分级渲染系统
    private readonly LOD_LEVELS = {
        HIGH: { textureSize: 1024, maxTriangles: 50000 },
        MEDIUM: { textureSize: 512, maxTriangles: 100000 },
        LOW: { textureSize: 256, maxTriangles: 200000 }
    } as const;
    
    private currentLOD: keyof typeof this.LOD_LEVELS = 'HIGH';
    private adaptiveTextureSize: number = 1024;
    
    // 渲染目标池 - 避免频繁创建销毁
    private renderTargetPool: {
        id: THREE.WebGLRenderTarget[];
        mask: THREE.WebGLRenderTarget[];
        temp: THREE.WebGLRenderTarget[];
    } = { id: [], mask: [], temp: [] };
    
    // 当前使用的渲染目标
    private activeIdTarget!: THREE.WebGLRenderTarget;
    private activeMaskTarget!: THREE.WebGLRenderTarget;
    
    // 材质系统
    private idMaterial!: THREE.ShaderMaterial;
    private selectionMaterial!: THREE.ShaderMaterial;
    private highlightMaterial!: THREE.ShaderMaterial;
    
    // 几何体和网格
    private targetMesh!: THREE.Mesh;
    private highlightMesh!: THREE.Mesh;
    private screenQuad!: THREE.Mesh;
    
    // 套索数据优化
    private lassoPathTexture!: THREE.DataTexture;
    private lassoBuffer!: Float32Array;
    private readonly MAX_LASSO_POINTS = 256; // 减少到256个点
    
    // 流式处理状态
    private processingState = {
        isProcessing: false,
        frameCount: 0,
        maxFramesPerUpdate: 3, // 多帧分摊
        pendingLassoPath: null as number[] | null
    };
    
    // 性能监控
    private performanceMonitor = {
        lastUpdateTime: 0,
        averageUpdateTime: 0,
        frameDrops: 0,
        memoryPressure: 0
    };
    
    constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
        this.renderer = renderer;
        this.scene = scene;
        this.camera = camera;
        
        this.initializeAdaptiveLOD();
        this.initializeRenderTargetPool();
        this.initializeOptimizedShaders();
        this.initializeLassoSystem();
        this.initializeGeometry();
        this.startPerformanceMonitoring();
        
        console.log('OptimizedGPUHighlightSystem: 分级系统初始化完成');
    }
    
    /**
     * 初始化自适应LOD系统
     */
    private initializeAdaptiveLOD(): void {
        // 根据设备性能自动选择初始LOD
        const gl = this.renderer.getContext();
        const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        
        if (maxTextureSize < 2048) {
            this.currentLOD = 'LOW';
        } else if (maxTextureSize < 4096) {
            this.currentLOD = 'MEDIUM';
        } else {
            this.currentLOD = 'HIGH';
        }
        
        this.adaptiveTextureSize = this.LOD_LEVELS[this.currentLOD].textureSize;
        console.log(`OptimizedGPUHighlightSystem: 自适应LOD = ${this.currentLOD}, 纹理尺寸 = ${this.adaptiveTextureSize}`);
    }
    
    /**
     * 初始化渲染目标池
     */
    private initializeRenderTargetPool(): void {
        const createRenderTarget = (size: number): THREE.WebGLRenderTarget => new THREE.WebGLRenderTarget(size, size, {
            minFilter: THREE.NearestFilter,
            magFilter: THREE.NearestFilter,
            format: THREE.RGBAFormat,
            type: THREE.UnsignedByteType,
            generateMipmaps: false,
            depthBuffer: false,
            stencilBuffer: false
        });
        
        // 为每个LOD级别预创建渲染目标
        Object.values(this.LOD_LEVELS).forEach(level => {
            this.renderTargetPool.id.push(createRenderTarget(level.textureSize));
            this.renderTargetPool.mask.push(createRenderTarget(level.textureSize));
            this.renderTargetPool.temp.push(createRenderTarget(level.textureSize));
        });
        
        // 设置当前活动目标
        this.activeIdTarget = this.renderTargetPool.id[0];
        this.activeMaskTarget = this.renderTargetPool.mask[0];
    }
    
    /**
     * 初始化优化的着色器
     */
    private initializeOptimizedShaders(): void {
        // 简化的ID材质 - 减少计算复杂度
        this.idMaterial = new THREE.ShaderMaterial({
            vertexShader: `
                attribute float triangleId;
                varying float vTriangleId;
                
                void main() {
                    vTriangleId = triangleId;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                varying float vTriangleId;
                
                // 简化的ID编码 - 支持65536个三角形
                vec4 encodeId(float id) {
                    float r = mod(id, 256.0);
                    float g = floor(id / 256.0);
                    return vec4(r / 255.0, g / 255.0, 0.0, 1.0);
                }
                
                void main() {
                    gl_FragColor = encodeId(vTriangleId);
                }
            `,
            side: THREE.DoubleSide
        });
        
        // 优化的选择材质 - 减少循环复杂度
        this.selectionMaterial = new THREE.ShaderMaterial({
            uniforms: {
                idTexture: { value: null },
                lassoPath: { value: null },
                lassoPointCount: { value: 0 },
                screenSize: { value: new THREE.Vector2() },
                triangleSelectionTexture: { value: null },
                selectionTextureSize: { value: 0 },
                useTriangleSelection: { value: false }
            },
            vertexShader: `
                void main() {
                    gl_Position = vec4(position.xy, 0.0, 1.0);
                }
            `,
            fragmentShader: `
                uniform sampler2D idTexture;
                uniform sampler2D lassoPath;
                uniform sampler2D triangleSelectionTexture;
                uniform int lassoPointCount;
                uniform vec2 screenSize;
                uniform float selectionTextureSize;
                uniform bool useTriangleSelection;
                
                float decodeId(vec4 encoded) {
                    return encoded.r * 255.0 + encoded.g * 255.0 * 256.0;
                }
                
                // 检查三角形是否被选中（通过选择纹理）
                bool isTriangleSelected(float triangleId) {
                    if (!useTriangleSelection || selectionTextureSize < 1.0) return false;
                    
                    float x = mod(triangleId, selectionTextureSize);
                    float y = floor(triangleId / selectionTextureSize);
                    vec2 selectionUV = vec2(x / selectionTextureSize, y / selectionTextureSize);
                    
                    vec4 selectionColor = texture2D(triangleSelectionTexture, selectionUV);
                    return selectionColor.r > 0.5;
                }
                
                // 优化的点在多边形内测试 - 限制最大迭代次数
                bool fastPointInPolygon(vec2 point) {
                    if (lassoPointCount < 3) return false;
                    
                    bool inside = false;
                    int maxIterations = min(lassoPointCount, ${this.MAX_LASSO_POINTS});
                    
                    for (int i = 0; i < ${this.MAX_LASSO_POINTS}; i++) {
                        if (i >= maxIterations) break;
                        
                        int j = (i == 0) ? maxIterations - 1 : i - 1;
                        
                        vec2 vi = texture2D(lassoPath, vec2(float(i) / float(${this.MAX_LASSO_POINTS}), 0.0)).xy;
                        vec2 vj = texture2D(lassoPath, vec2(float(j) / float(${this.MAX_LASSO_POINTS}), 0.0)).xy;
                        
                        if (((vi.y > point.y) != (vj.y > point.y)) &&
                            (point.x < (vj.x - vi.x) * (point.y - vi.y) / (vj.y - vi.y) + vi.x)) {
                            inside = !inside;
                        }
                    }
                    
                    return inside;
                }
                
                void main() {
                    vec2 uv = gl_FragCoord.xy / screenSize;
                    vec4 idColor = texture2D(idTexture, uv);
                    float triangleId = decodeId(idColor);
                    
                    if (triangleId < 0.5) {
                        gl_FragColor = vec4(0.0);
                        return;
                    }
                    
                    bool isSelected = false;
                    
                    // 优先使用三角形选择纹理（updateHighlightOptimized方法）
                    if (useTriangleSelection) {
                        isSelected = isTriangleSelected(triangleId);
                    } else {
                        // 使用套索选择（updateHighlightWithLassoPath方法）
                        vec2 screenPos = uv * 2.0 - 1.0;
                        isSelected = fastPointInPolygon(screenPos);
                    }
                    
                    gl_FragColor = vec4(isSelected ? 1.0 : 0.0, 0.0, 0.0, 1.0);
                }
            `
        });
        
        // 简化的高亮材质 - 减少动画复杂度
        this.highlightMaterial = new THREE.ShaderMaterial({
            uniforms: {
                maskTexture: { value: null },
                highlightColor: { value: new THREE.Color(0xff4444) },
                intensity: { value: 0.8 }
            },
            vertexShader: `
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform sampler2D maskTexture;
                uniform vec3 highlightColor;
                uniform float intensity;
                varying vec2 vUv;
                
                void main() {
                    float mask = texture2D(maskTexture, vUv).r;
                    if (mask < 0.1) discard;
                    
                    gl_FragColor = vec4(highlightColor * intensity, 0.6);
                }
            `,
            transparent: true,
            depthWrite: false,
            blending: 2 // THREE.AdditiveBlending
        });
    }
    
    /**
     * 初始化套索系统
     */
    private initializeLassoSystem(): void {
        this.lassoBuffer = new Float32Array(this.MAX_LASSO_POINTS * 4);
        this.lassoPathTexture = new THREE.DataTexture(
            this.lassoBuffer,
            this.MAX_LASSO_POINTS,
            1,
            THREE.RGBAFormat,
            THREE.UnsignedByteType
        );
        this.lassoPathTexture.minFilter = THREE.NearestFilter;
        this.lassoPathTexture.magFilter = THREE.NearestFilter;
        this.lassoPathTexture.needsUpdate = true;
        
        this.selectionMaterial.uniforms.lassoPath.value = this.lassoPathTexture;
    }
    
    /**
     * 初始化几何体
     */
    private initializeGeometry(): void {
        const screenGeometry = new THREE.PlaneGeometry(2, 2);
        this.screenQuad = new THREE.Mesh(screenGeometry, this.selectionMaterial);
    }
    
    /**
     * 设置目标网格 - 添加三角形数量检查
     */
    setTargetMesh(mesh: THREE.Mesh): void {
        this.targetMesh = mesh;
        
        // 获取三角形数量
        const triangleCount = this.getTriangleCount(mesh.geometry);
        console.log(`OptimizedGPUHighlightSystem: 目标网格三角形数量 = ${triangleCount}`);
        
        // 根据三角形数量调整LOD
        this.adjustLODForGeometry(triangleCount);
        
        // 添加三角形ID属性
        this.addTriangleIdAttribute(mesh.geometry);
        
        // 创建高亮网格
        this.createHighlightMesh(mesh);
    }
    
    /**
     * 获取三角形数量
     */
    private getTriangleCount(geometry: THREE.BufferGeometry): number {
        if (geometry.index) {
            return geometry.index.count / 3;
        } else {
            return geometry.attributes.position.count / 3;
        }
    }
    
    /**
     * 根据几何体复杂度调整LOD
     */
    private adjustLODForGeometry(triangleCount: number): void {
        let newLOD: keyof typeof this.LOD_LEVELS;
        
        if (triangleCount <= this.LOD_LEVELS.HIGH.maxTriangles) {
            newLOD = 'HIGH';
        } else if (triangleCount <= this.LOD_LEVELS.MEDIUM.maxTriangles) {
            newLOD = 'MEDIUM';
        } else {
            newLOD = 'LOW';
        }
        
        if (newLOD !== this.currentLOD) {
            console.log(`OptimizedGPUHighlightSystem: LOD调整 ${String(this.currentLOD)} -> ${String(newLOD)}`);
            this.currentLOD = newLOD;
            this.adaptiveTextureSize = this.LOD_LEVELS[newLOD].textureSize;
            this.updateRenderTargets();
        }
    }
    
    /**
     * 更新渲染目标
     */
    private updateRenderTargets(): void {
        const lodLevels = Object.keys(this.LOD_LEVELS) as Array<keyof typeof this.LOD_LEVELS>;
        const lodIndex = lodLevels.indexOf(this.currentLOD);
        this.activeIdTarget = this.renderTargetPool.id[lodIndex];
        this.activeMaskTarget = this.renderTargetPool.mask[lodIndex];
        
        // 更新材质中的引用
        this.selectionMaterial.uniforms.idTexture.value = this.activeIdTarget.texture;
        this.selectionMaterial.uniforms.screenSize.value.set(this.adaptiveTextureSize, this.adaptiveTextureSize);
        this.highlightMaterial.uniforms.maskTexture.value = this.activeMaskTarget.texture;
    }
    
    /**
     * 添加三角形ID属性 - 优化版本
     */
    private addTriangleIdAttribute(geometry: THREE.BufferGeometry): void {
        if (geometry.attributes.triangleId) return;
        
        const positionCount = geometry.attributes.position.count;
        const triangleIds = new Float32Array(positionCount);
        
        // 使用更高效的循环
        if (geometry.index) {
            const indices = geometry.index.array;
            for (let i = 0; i < indices.length; i += 3) {
                const triangleId = Math.floor(i / 3);
                const i0 = indices[i];
                const i1 = indices[i + 1];
                const i2 = indices[i + 2];
                triangleIds[i0] = triangleId;
                triangleIds[i1] = triangleId;
                triangleIds[i2] = triangleId;
            }
        } else {
            for (let i = 0; i < positionCount; i += 3) {
                const triangleId = Math.floor(i / 3);
                triangleIds[i] = triangleId;
                triangleIds[i + 1] = triangleId;
                triangleIds[i + 2] = triangleId;
            }
        }
        
        geometry.setAttribute('triangleId', new THREE.BufferAttribute(triangleIds, 1));
    }
    
    /**
     * 创建高亮网格
     */
    private createHighlightMesh(mesh: THREE.Mesh): void {
        this.highlightMesh = new THREE.Mesh(mesh.geometry, this.highlightMaterial);
        this.highlightMesh.position.copy(mesh.position);
        this.highlightMesh.rotation.copy(mesh.rotation);
        this.highlightMesh.scale.copy(mesh.scale);
        this.highlightMesh.renderOrder = mesh.renderOrder + 1;
        this.highlightMesh.visible = false;
    }

    /**
     * 流式套索路径更新 - 多帧分摊处理
     */
    updateHighlightWithLassoPath(lassoPath: number[]): void {
        if (!this.targetMesh || lassoPath.length < 6) return;
        
        // 如果正在处理，缓存新的路径
        if (this.processingState.isProcessing) {
            this.processingState.pendingLassoPath = lassoPath;
            return;
        }
        
        // 开始多帧处理
        this.startStreamingProcess(lassoPath);
    }

    /**
     * 优化的三角形高亮更新 - 支持大规模数据集
     * @param triangleIds 要高亮的三角形ID数组
     * @param options 处理选项
     */
    updateHighlightOptimized(triangleIds: number[], options: {
        maxBatchSize?: number;           // 默认50000，来自BATCH_CONFIG
        useStreamProcessing?: boolean;   // true用于超重策略，false用于重型策略
    } = {}): void {
        if (!this.targetMesh || triangleIds.length === 0) {
            this.clearHighlight();
            return;
        }

        const startTime = performance.now();
        const { maxBatchSize = 50000, useStreamProcessing = false } = options;

        try {
            // 根据数据大小和选项自动选择处理策略
            if (triangleIds.length <= 1000) {
                // 小数据集：直接处理
                this.processTrianglesDirect(triangleIds, startTime);
            } else if (!useStreamProcessing) {
                // 中型数据集：标准批处理（同步）
                this.processTrianglesBatched(triangleIds, maxBatchSize, startTime);
            } else {
                // 大型数据集：流式批处理（异步）
                this.processTrianglesStreaming(triangleIds, maxBatchSize, startTime);
            }
        } catch (error) {
            console.error('OptimizedGPUHighlightSystem: updateHighlightOptimized 失败', error);
            this.handleProcessingError();
        }
    }

    /**
     * 直接处理小数据集
     */
    private processTrianglesDirect(triangleIds: number[], startTime: number): void {
        // 创建三角形选择纹理
        const selectionTexture = this.createTriangleSelectionTexture(triangleIds);
        
        // 应用到GPU管道
        this.applyTriangleSelection(selectionTexture);
        
        // 应用高亮效果
        this.applyHighlightEffect();
        
        // 更新性能统计
        this.updatePerformanceStats(performance.now() - startTime);
        
        console.log(`OptimizedGPUHighlightSystem: 直接处理完成，${triangleIds.length} 个三角形，耗时 ${(performance.now() - startTime).toFixed(2)}ms`);
    }

    /**
     * 标准批处理（同步）
     */
    private processTrianglesBatched(triangleIds: number[], maxBatchSize: number, startTime: number): void {
        const totalBatches = Math.ceil(triangleIds.length / maxBatchSize);
        let processedTriangles = 0;

        for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
            const batchStart = batchIndex * maxBatchSize;
            const batchEnd = Math.min(batchStart + maxBatchSize, triangleIds.length);
            const batch = triangleIds.slice(batchStart, batchEnd);

            // 处理当前批次
            const selectionTexture = this.createTriangleSelectionTexture(batch);
            
            if (batchIndex === 0) {
                // 首批：直接应用
                this.applyTriangleSelection(selectionTexture);
            } else {
                // 后续批次：累加到现有选择
                this.accumulateTriangleSelection(selectionTexture);
            }

            processedTriangles += batch.length;
            
            // 内存压力检查
            if (this.performanceMonitor.memoryPressure > 80) {
                console.warn('OptimizedGPUHighlightSystem: 内存压力过高，暂停批处理');
                break;
            }
        }

        // 应用最终高亮效果
        this.applyHighlightEffect();
        
        // 更新性能统计
        this.updatePerformanceStats(performance.now() - startTime);
        
        console.log(`OptimizedGPUHighlightSystem: 批处理完成，${processedTriangles}/${triangleIds.length} 个三角形，耗时 ${(performance.now() - startTime).toFixed(2)}ms`);
    }

    /**
     * 流式批处理（异步）
     */
    private processTrianglesStreaming(triangleIds: number[], maxBatchSize: number, startTime: number): void {
        if (this.processingState.isProcessing) {
            console.warn('OptimizedGPUHighlightSystem: 正在进行流式处理，跳过新请求');
            return;
        }

        this.processingState.isProcessing = true;
        this.processingState.frameCount = 0;

        const totalBatches = Math.ceil(triangleIds.length / maxBatchSize);
        let currentBatch = 0;
        let processedTriangles = 0;

        const processNextBatch = () => {
            try {
                if (currentBatch >= totalBatches) {
                    // 所有批次处理完成
                    this.finishStreamingTriangleProcess(startTime, processedTriangles, triangleIds.length);
                    return;
                }

                const batchStart = currentBatch * maxBatchSize;
                const batchEnd = Math.min(batchStart + maxBatchSize, triangleIds.length);
                const batch = triangleIds.slice(batchStart, batchEnd);

                // 处理当前批次
                const selectionTexture = this.createTriangleSelectionTexture(batch);
                
                if (currentBatch === 0) {
                    // 首批：直接应用
                    this.applyTriangleSelection(selectionTexture);
                } else {
                    // 后续批次：累加到现有选择
                    this.accumulateTriangleSelection(selectionTexture);
                }

                processedTriangles += batch.length;
                currentBatch++;

                // 内存和性能检查
                if (this.performanceMonitor.memoryPressure > 85) {
                    console.warn('OptimizedGPUHighlightSystem: 内存压力过高，终止流式处理');
                    this.finishStreamingTriangleProcess(startTime, processedTriangles, triangleIds.length);
                    return;
                }

                // 保持60fps响应性
                if (performance.now() - startTime > 16) {
                    requestAnimationFrame(processNextBatch);
                } else {
                    processNextBatch(); // 同步继续
                }

            } catch (error) {
                console.error('OptimizedGPUHighlightSystem: 流式批处理错误', error);
                this.handleProcessingError();
            }
        };

        // 开始流式处理
        requestAnimationFrame(processNextBatch);
    }

    /**
     * 创建三角形选择纹理
     */
    private createTriangleSelectionTexture(triangleIds: number[]): THREE.DataTexture {
        // 计算所需的纹理尺寸
        const maxTriangleId = Math.max(...triangleIds);
        const textureSize = Math.ceil(Math.sqrt(maxTriangleId + 1));
        const textureData = new Uint8Array(textureSize * textureSize * 4);

        // 填充选择数据
        triangleIds.forEach(triangleId => {
            const x = triangleId % textureSize;
            const y = Math.floor(triangleId / textureSize);
            const index = (y * textureSize + x) * 4;
            
            if (index < textureData.length) {
                textureData[index] = 255;     // R: 选中标记
                textureData[index + 1] = 0;   // G
                textureData[index + 2] = 0;   // B
                textureData[index + 3] = 255; // A
            }
        });

        const texture = new THREE.DataTexture(
            textureData,
            textureSize,
            textureSize,
            THREE.RGBAFormat,
            THREE.UnsignedByteType
        );
        texture.minFilter = THREE.NearestFilter;
        texture.magFilter = THREE.NearestFilter;
        texture.needsUpdate = true;

        return texture;
    }

    /**
     * 应用三角形选择到GPU管道
     */
    private applyTriangleSelection(selectionTexture: THREE.DataTexture): void {
        // 更新选择材质的uniform
        this.selectionMaterial.uniforms.triangleSelectionTexture.value = selectionTexture;
        this.selectionMaterial.uniforms.selectionTextureSize.value = selectionTexture.image.width;
        this.selectionMaterial.uniforms.useTriangleSelection.value = true;
        
        // 渲染选择蒙版
        this.generateTriangleSelectionMask();
    }

    /**
     * 累加三角形选择（用于批处理）
     */
    private accumulateTriangleSelection(selectionTexture: THREE.DataTexture): void {
        // 这里可以实现将新的选择累加到现有选择上的逻辑
        // 为简化实现，当前直接替换
        this.applyTriangleSelection(selectionTexture);
    }

    /**
     * 生成三角形选择蒙版
     */
    private generateTriangleSelectionMask(): void {
        try {
            const originalRenderTarget = this.renderer.getRenderTarget();
            
            // 首先渲染三角形ID
            this.renderTriangleIds();
            
            // 然后生成选择蒙版
            this.renderer.setRenderTarget(this.activeMaskTarget);
            this.renderer.clear();
            this.renderer.render(this.screenQuad, this.camera);
            this.renderer.setRenderTarget(originalRenderTarget);
        } catch (error) {
            console.error('OptimizedGPUHighlightSystem: 三角形选择蒙版生成失败', error);
            throw error;
        }
    }

    /**
     * 完成流式三角形处理
     */
    private finishStreamingTriangleProcess(startTime: number, processed: number, total: number): void {
        const updateTime = performance.now() - startTime;
        this.updatePerformanceStats(updateTime);
        
        this.processingState.isProcessing = false;
        
        // 应用最终高亮效果
        this.applyHighlightEffect();
        
        console.log(`OptimizedGPUHighlightSystem: 流式三角形处理完成，${processed}/${total} 个三角形，耗时 ${updateTime.toFixed(2)}ms`);
    }
    
    /**
     * 开始流式处理
     */
    private startStreamingProcess(lassoPath: number[]): void {
        const startTime = performance.now();
        
        this.processingState.isProcessing = true;
        this.processingState.frameCount = 0;
        
        // 第一帧：预处理套索路径
        this.preprocessLassoPath(lassoPath);
        
        // 后续帧：分步执行GPU渲染
        const processNextFrame = () => {
            this.processingState.frameCount++;
            
            try {
                if (this.processingState.frameCount === 1) {
                    // 第二帧：渲染ID
                    this.renderTriangleIds();
                } else if (this.processingState.frameCount === 2) {
                    // 第三帧：生成蒙版和应用高亮
                    this.generateSelectionMask();
                    this.applyHighlightEffect();
                    
                    // 处理完成
                    this.finishStreamingProcess(startTime);
                    return;
                }
                
                // 检查是否需要继续
                if (this.processingState.frameCount < this.processingState.maxFramesPerUpdate) {
                    requestAnimationFrame(processNextFrame);
                } else {
                    this.finishStreamingProcess(startTime);
                }
            } catch (error) {
                console.error('OptimizedGPUHighlightSystem: 流式处理错误', error);
                this.handleProcessingError();
            }
        };
        
        requestAnimationFrame(processNextFrame);
    }
    
    /**
     * 预处理套索路径
     */
    private preprocessLassoPath(lassoPath: number[]): void {
        // 简化套索路径 - 减少点数量
        const simplifiedPath = this.simplifyLassoPath(lassoPath);
        
        // 更新纹理数据
        this.updateLassoPathTexture(simplifiedPath);
    }
    
    /**
     * 简化套索路径 - Douglas-Peucker算法的简化版
     */
    private simplifyLassoPath(path: number[], tolerance: number = 0.01): number[] {
        if (path.length <= this.MAX_LASSO_POINTS * 3) {
            return path;
        }
        
        const simplified: number[] = [];
        const step = Math.ceil(path.length / 3 / this.MAX_LASSO_POINTS);
        
        for (let i = 0; i < path.length; i += step * 3) {
            simplified.push(path[i], path[i + 1], path[i + 2] || 0);
        }
        
        return simplified;
    }
    
    /**
     * 更新套索路径纹理
     */
    private updateLassoPathTexture(lassoPath: number[]): void {
        this.lassoBuffer.fill(0);
        
        const pointCount = Math.min(Math.floor(lassoPath.length / 3), this.MAX_LASSO_POINTS);
        
        for (let i = 0; i < pointCount; i++) {
            const srcIndex = i * 3;
            const dstIndex = i * 4;
            
            this.lassoBuffer[dstIndex] = lassoPath[srcIndex];
            this.lassoBuffer[dstIndex + 1] = lassoPath[srcIndex + 1];
            this.lassoBuffer[dstIndex + 2] = 0;
            this.lassoBuffer[dstIndex + 3] = 1;
        }
        
        this.lassoPathTexture.needsUpdate = true;
        this.selectionMaterial.uniforms.lassoPointCount.value = pointCount;
    }
    
    /**
     * 渲染三角形ID - 添加错误处理
     */
    private renderTriangleIds(): void {
        try {
            const originalMaterial = this.targetMesh.material;
            const originalRenderTarget = this.renderer.getRenderTarget();
            
            this.targetMesh.material = this.idMaterial;
            this.renderer.setRenderTarget(this.activeIdTarget);
            this.renderer.clear();
            this.renderer.render(this.scene, this.camera);
            
            this.renderer.setRenderTarget(originalRenderTarget);
            this.targetMesh.material = originalMaterial;
            
            // 更新材质引用
            this.selectionMaterial.uniforms.idTexture.value = this.activeIdTarget.texture;
        } catch (error) {
            console.error('OptimizedGPUHighlightSystem: ID渲染失败', error);
            throw error;
        }
    }
    
    /**
     * 生成选择蒙版
     */
    private generateSelectionMask(): void {
        try {
            const originalRenderTarget = this.renderer.getRenderTarget();
            
            this.renderer.setRenderTarget(this.activeMaskTarget);
            this.renderer.clear();
            this.renderer.render(this.screenQuad, this.camera);
            this.renderer.setRenderTarget(originalRenderTarget);
        } catch (error) {
            console.error('OptimizedGPUHighlightSystem: 蒙版生成失败', error);
            throw error;
        }
    }
    
    /**
     * 应用高亮效果
     */
    private applyHighlightEffect(): void {
        this.highlightMesh.visible = true;
        if (!this.scene.children.includes(this.highlightMesh)) {
            this.scene.add(this.highlightMesh);
        }
    }
    
    /**
     * 完成流式处理
     */
    private finishStreamingProcess(startTime: number): void {
        const updateTime = performance.now() - startTime;
        this.updatePerformanceStats(updateTime);
        
        this.processingState.isProcessing = false;
        
        // 处理待处理的路径
        if (this.processingState.pendingLassoPath) {
            const pendingPath = this.processingState.pendingLassoPath;
            this.processingState.pendingLassoPath = null;
            this.updateHighlightWithLassoPath(pendingPath);
        }
        
        console.log(`OptimizedGPUHighlightSystem: 流式处理完成，耗时 ${updateTime.toFixed(2)}ms`);
    }
    
    /**
     * 处理处理错误
     */
    private handleProcessingError(): void {
        this.processingState.isProcessing = false;
        this.processingState.pendingLassoPath = null;
        this.performanceMonitor.frameDrops++;
        
        // 尝试降级LOD
        if (this.currentLOD !== 'LOW') {
            console.warn('OptimizedGPUHighlightSystem: 检测到错误，降级LOD');
            this.downgradeLOD();
        }
    }
    
    /**
     * 降级LOD
     */
    private downgradeLOD(): void {
        const lodLevels = Object.keys(this.LOD_LEVELS) as (keyof typeof this.LOD_LEVELS)[]
        const currentIndex = lodLevels.indexOf(this.currentLOD)
        
        if (currentIndex < lodLevels.length - 1) {
            this.currentLOD = lodLevels[currentIndex + 1]
            this.adaptiveTextureSize = this.LOD_LEVELS[this.currentLOD].textureSize
            this.updateRenderTargets()
            console.log(`OptimizedGPUHighlightSystem: LOD已降级至 ${String(this.currentLOD)}`)
        }
    }
    
    /**
     * 开始性能监控
     */
    private startPerformanceMonitoring(): void {
        const monitor = () => {
            // 检查内存压力
            const stats = this.getPerformanceStats();
            this.performanceMonitor.memoryPressure = stats.memoryMB;
            
            // 如果内存压力过大，自动降级
            if (this.performanceMonitor.memoryPressure > 100 && this.currentLOD !== 'LOW') {
                console.warn('OptimizedGPUHighlightSystem: 内存压力过大，自动降级LOD');
                this.downgradeLOD();
            }
            
            setTimeout(monitor, 5000); // 每5秒监控一次
        };
        
        monitor();
    }
    
    /**
     * 更新性能统计
     */
    private updatePerformanceStats(updateTime: number): void {
        this.performanceMonitor.lastUpdateTime = updateTime;
        this.performanceMonitor.averageUpdateTime = 
            (this.performanceMonitor.averageUpdateTime * 0.9) + (updateTime * 0.1);
    }
    
    /**
     * 清除高亮
     */
    clearHighlight(): void {
        if (this.highlightMesh) {
            this.highlightMesh.visible = false;
        }
        
        // 清除处理状态
        this.processingState.isProcessing = false;
        this.processingState.pendingLassoPath = null;
        
        // 重置选择状态
        this.selectionMaterial.uniforms.lassoPointCount.value = 0;
        this.selectionMaterial.uniforms.useTriangleSelection.value = false;
        this.selectionMaterial.uniforms.triangleSelectionTexture.value = null;
        this.selectionMaterial.uniforms.selectionTextureSize.value = 0;
    }
    
    /**
     * 获取性能统计
     */
    getPerformanceStats() {
        const textureMemory = this.adaptiveTextureSize * this.adaptiveTextureSize * 4 * 3; // 3个渲染目标
        const bufferMemory = this.lassoBuffer.byteLength;
        
        // 计算选择纹理内存使用
        const selectionTexture = this.selectionMaterial.uniforms.triangleSelectionTexture.value;
        const selectionTextureMemory = selectionTexture ? 
            selectionTexture.image.width * selectionTexture.image.height * 4 : 0;
        
        return {
            currentLOD: this.currentLOD,
            textureSize: this.adaptiveTextureSize,
            memoryMB: (textureMemory + bufferMemory + selectionTextureMemory) / (1024 * 1024),
            lastUpdateTime: this.performanceMonitor.lastUpdateTime,
            averageUpdateTime: this.performanceMonitor.averageUpdateTime,
            frameDrops: this.performanceMonitor.frameDrops,
            memoryPressure: this.performanceMonitor.memoryPressure,
            isProcessing: this.processingState.isProcessing,
            usingTriangleSelection: this.selectionMaterial.uniforms.useTriangleSelection.value,
            selectionTextureSize: this.selectionMaterial.uniforms.selectionTextureSize.value
        };
    }
    
    /**
     * 释放资源
     */
    dispose(): void {
        // 停止所有处理
        this.processingState.isProcessing = false;
        
        // 释放渲染目标池
        Object.values(this.renderTargetPool).forEach(pool => {
            pool.forEach(target => target.dispose());
        });
        
        // 释放材质
        this.idMaterial?.dispose();
        this.selectionMaterial?.dispose();
        this.highlightMaterial?.dispose();
        
        // 释放纹理
        this.lassoPathTexture?.dispose();
        
        // 移除高亮网格
        if (this.highlightMesh && this.scene.children.includes(this.highlightMesh)) {
            this.scene.remove(this.highlightMesh);
        }
        
        console.log('OptimizedGPUHighlightSystem: 资源已释放');
    }
}