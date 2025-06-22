import * as THREE from 'three';
import { ShaderBasedHighlightSystem } from './ShaderBasedHighlight';
import { OptimizedGPUHighlightSystem } from './optimized_gpu_highlight';

/**
 * 增强版智能高亮系统 - 支持超大数据量处理
 * 新增功能：
 * 1. 分批处理大数据量
 * 2. 动态内存管理
 * 3. 渐进式渲染
 * 4. 紧急降级机制
 */
export class EnhancedIntelligentHighlightSystem {
    private renderer: THREE.WebGLRenderer;
    private scene: THREE.Scene;
    private camera: THREE.Camera;
    
    // 三级策略系统
    private lightweightSystem!: ShaderBasedHighlightSystem;
    private mediumSystem!: ShaderBasedHighlightSystem;
    private heavyweightSystem!: OptimizedGPUHighlightSystem;
    
    // 更合理的策略选择阈值
    private readonly THRESHOLDS = {
        LIGHTWEIGHT: 1000,      // < 1000 三角形
        MEDIUM: 50000,          // 1000-50000 三角形
        HEAVYWEIGHT: 100000,    // 50000-100000 三角形 (大幅提升上限)
        ULTRA_HEAVY: 1000000    // > 1000000 三角形 (超大数据量)
    };
    
    // 分批处理配置
    private readonly BATCH_CONFIG = {
        MAX_BATCH_SIZE: 20000,          // 单批最大三角形数
        MAX_CONCURRENT_BATCHES: 3,      // 最大并发批次
        BATCH_DELAY: 16,                // 批次间延迟 (ms) - 约60fps
        MEMORY_CHECK_INTERVAL: 1000,    // 内存检查间隔
        EMERGENCY_THRESHOLD: 0.85       // 内存使用紧急阈值 (85%)
    };
    
    // 当前状态
    private currentStrategy: 'lightweight' | 'medium' | 'heavyweight' | 'ultra-heavy' = 'lightweight';
    private currentTriangleCount: number = 0;
    private isProcessing: boolean = false;
    private processingAborted: boolean = false;
    
    // 分批处理状态
    private batchProcessor = {
        activeBatches: new Map<number, Promise<void>>(),
        completedBatches: new Set<number>(),
        totalBatches: 0,
        processedTriangles: 0,
        startTime: 0
    };
    
    // 增强的性能分析器
    private performanceAnalyzer = {
        updateTimes: [] as number[],
        memoryUsage: [] as number[],
        batchTimes: [] as number[],
        errorCount: 0,
        lastAnalysis: 0,
        adaptiveMode: true,
        emergencyMode: false,
        memoryPressure: 0 // 0-1 表示内存压力程度
    };
    
    // 动态内存管理
    private memoryManager = {
        maxMemoryMB: 512,           // 最大内存限制 (MB)
        currentMemoryMB: 0,
        memoryCheckTimer: null as number | null,
        gcSuggestionCount: 0
    };
    
    // 缓存和预加载
    private highlightCache = new Map<string, unknown>();
    private preloadedSystems = new Set<string>();
    
    constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
        this.renderer = renderer;
        this.scene = scene;
        this.camera = camera;
        
        this.initializeSystems();
        this.setupPerformanceAnalyzer();
        this.startMemoryMonitoring();
        
        console.log('EnhancedIntelligentHighlightSystem: 增强版智能系统初始化完成');
        console.log('策略阈值:', this.THRESHOLDS);
        console.log('分批配置:', this.BATCH_CONFIG);
    }
    
    /**
     * 初始化系统
     */
    private initializeSystems(): void {
        this.lightweightSystem = new ShaderBasedHighlightSystem(this.renderer, this.scene, this.camera);
        this.preloadedSystems.add('lightweight');
        console.log('EnhancedIntelligentHighlightSystem: 轻量级系统已加载');
    }
    
    /**
     * 启动内存监控
     */
    private startMemoryMonitoring(): void {
        this.memoryManager.memoryCheckTimer = setInterval(() => {
            this.checkMemoryUsage();
        }, this.BATCH_CONFIG.MEMORY_CHECK_INTERVAL);
    }
    
    /**
     * 检查内存使用情况
     */
    private checkMemoryUsage(): void {
        const memoryStats = this.getMemoryStats();
        this.memoryManager.currentMemoryMB = memoryStats.totalMemoryMB;
        
        // 计算内存压力
        this.performanceAnalyzer.memoryPressure = 
            this.memoryManager.currentMemoryMB / this.memoryManager.maxMemoryMB;
        
        // 紧急内存管理
        if (this.performanceAnalyzer.memoryPressure > this.BATCH_CONFIG.EMERGENCY_THRESHOLD) {
            this.handleMemoryPressure();
        }
    }
    
    /**
     * 处理内存压力
     */
    private handleMemoryPressure(): void {
        if (!this.performanceAnalyzer.emergencyMode) {
            console.warn(`EnhancedIntelligentHighlightSystem: 进入紧急模式 (内存使用: ${(this.performanceAnalyzer.memoryPressure * 100).toFixed(1)}%)`);
            this.performanceAnalyzer.emergencyMode = true;
        }
        
        // 中止当前处理
        if (this.isProcessing) {
            this.processingAborted = true;
            console.log('EnhancedIntelligentHighlightSystem: 因内存压力中止当前处理');
        }
        
        // 清理缓存
        this.highlightCache.clear();
        
        // 建议垃圾回收
        this.memoryManager.gcSuggestionCount++;
        if (this.memoryManager.gcSuggestionCount > 3 && (window as any).gc) {
            (window as any).gc();
            this.memoryManager.gcSuggestionCount = 0;
        }
        
        // 降级策略
        if (this.currentStrategy === 'ultra-heavy') {
            this.currentStrategy = 'heavyweight';
        } else if (this.currentStrategy === 'heavyweight') {
            this.currentStrategy = 'medium';
        }
    }
    
    /**
     * 智能策略选择 - 增强版
     */
    private selectOptimalStrategy(
        triangleCount: number, 
        operationType: 'array' | 'lasso'
    ): 'lightweight' | 'medium' | 'heavyweight' | 'ultra-heavy' {
        // 紧急模式下强制降级
        if (this.performanceAnalyzer.emergencyMode) {
            if (triangleCount < this.THRESHOLDS.LIGHTWEIGHT) return 'lightweight';
            if (triangleCount < this.THRESHOLDS.MEDIUM) return 'medium';
            return 'heavyweight'; // 紧急模式下最高使用heavyweight
        }
        
        // 基础策略选择
        let baseStrategy: 'lightweight' | 'medium' | 'heavyweight' | 'ultra-heavy';
        
        if (triangleCount < this.THRESHOLDS.LIGHTWEIGHT) {
            baseStrategy = 'lightweight';
        } else if (triangleCount < this.THRESHOLDS.MEDIUM) {
            baseStrategy = 'medium';
        } else if (triangleCount < this.THRESHOLDS.HEAVYWEIGHT) {
            baseStrategy = 'heavyweight';
        } else if (triangleCount <= this.THRESHOLDS.ULTRA_HEAVY) {
            baseStrategy = 'ultra-heavy';
        } else {
            console.warn(`EnhancedIntelligentHighlightSystem: 三角形数量 ${triangleCount} 极大，将使用分批处理`);
            baseStrategy = 'ultra-heavy';
        }
        
        // 根据内存压力调整
        const memoryPressure = this.performanceAnalyzer.memoryPressure;
        if (memoryPressure > 0.7) { // 70%以上内存使用时降级
            if (baseStrategy === 'ultra-heavy') baseStrategy = 'heavyweight';
            if (baseStrategy === 'heavyweight') baseStrategy = 'medium';
        }
        
        // 套索操作优化
        if (operationType === 'lasso') {
            if (baseStrategy === 'lightweight' && triangleCount > 500) {
                baseStrategy = 'medium';
            }
            if (triangleCount > 20000) {
                // 限制套索操作最高使用heavyweight策略
                const strategies = ['lightweight', 'medium', 'heavyweight', 'ultra-heavy'] as const;
                const currentIndex = strategies.indexOf(baseStrategy);
                const heavyweightIndex = strategies.indexOf('heavyweight');
                if (currentIndex > heavyweightIndex) {
                baseStrategy = 'heavyweight';
                }
            }
        }
        
        return baseStrategy;
    }
    
    /**
     * 分批处理大数据量高亮更新
     */
    async updateHighlightBatched(selectedTriangles: number[]): Promise<void> {
        const triangleCount = selectedTriangles.length;
        console.log(`EnhancedIntelligentHighlightSystem: 开始分批处理 ${triangleCount} 个三角形`);
        
        if (triangleCount <= this.BATCH_CONFIG.MAX_BATCH_SIZE) {
            // 小数据量直接处理
            return this.updateHighlight(selectedTriangles);
        }
        
        this.isProcessing = true;
        this.processingAborted = false;
        
        const startTime = performance.now();
        this.batchProcessor.startTime = startTime;
        this.batchProcessor.totalBatches = Math.ceil(triangleCount / this.BATCH_CONFIG.MAX_BATCH_SIZE);
        this.batchProcessor.processedTriangles = 0;
        this.batchProcessor.activeBatches.clear();
        this.batchProcessor.completedBatches.clear();
        
        try {
            // 选择策略
            const strategy = this.selectOptimalStrategy(triangleCount, 'array');
            console.log(`EnhancedIntelligentHighlightSystem: 使用 ${strategy} 策略分批处理`);
            
            // 确保系统已加载
            if (strategy !== 'lightweight') {
                await this.ensureSystemLoaded(strategy);
            }
            
            // 清除其他系统
            this.clearOtherSystems(strategy);
            
            // 分批处理
            await this.processBatches(selectedTriangles, strategy);
            
            this.currentStrategy = strategy;
            this.recordPerformance(startTime);
            
            console.log(`EnhancedIntelligentHighlightSystem: 分批处理完成，耗时 ${(performance.now() - startTime).toFixed(1)}ms`);
        } catch (error) {
            console.error('EnhancedIntelligentHighlightSystem: 分批处理失败:', error);
            throw error;
        } finally {
            this.isProcessing = false;
            this.processingAborted = false;
        }
    }
    
    /**
     * 执行分批处理
     */
    private async processBatches(selectedTriangles: number[], strategy: string): Promise<void> {
        const batchSize = this.BATCH_CONFIG.MAX_BATCH_SIZE;
        const totalBatches = Math.ceil(selectedTriangles.length / batchSize);
        
        for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
            // 检查是否需要中止
            if (this.processingAborted) {
                console.log('EnhancedIntelligentHighlightSystem: 分批处理被中止');
                break;
            }
            
            // 控制并发批次数量
            while (this.batchProcessor.activeBatches.size >= this.BATCH_CONFIG.MAX_CONCURRENT_BATCHES) {
                await Promise.race(this.batchProcessor.activeBatches.values());
            }
            
            // 检查内存压力
            if (this.performanceAnalyzer.memoryPressure > 0.8) {
                console.log('EnhancedIntelligentHighlightSystem: 内存压力过高，暂停分批处理');
                await this.waitForMemoryRelief();
            }
            
            // 创建批次
            const startIdx = batchIndex * batchSize;
            const endIdx = Math.min(startIdx + batchSize, selectedTriangles.length);
            const batch = selectedTriangles.slice(startIdx, endIdx);
            
            // 处理批次
            const batchPromise = this.processSingleBatch(batch, batchIndex, strategy);
            this.batchProcessor.activeBatches.set(batchIndex, batchPromise);
            
            // 批次完成后清理
            batchPromise.finally(() => {
                this.batchProcessor.activeBatches.delete(batchIndex);
                this.batchProcessor.completedBatches.add(batchIndex);
                this.batchProcessor.processedTriangles += batch.length;
                
                // 报告进度
                const progress = (this.batchProcessor.processedTriangles / selectedTriangles.length * 100).toFixed(1);
                console.log(`EnhancedIntelligentHighlightSystem: 批次 ${batchIndex + 1}/${totalBatches} 完成 (${progress}%)`);
            });
            
            // 批次间延迟，避免阻塞渲染
            if (batchIndex < totalBatches - 1) {
                await this.sleep(this.BATCH_CONFIG.BATCH_DELAY);
            }
        }
        
        // 等待所有批次完成
        await Promise.all(this.batchProcessor.activeBatches.values());
    }
    
    /**
     * 处理单个批次
     */
    private async processSingleBatch(batch: number[], batchIndex: number, strategy: string): Promise<void> {
        const batchStartTime = performance.now();
        
        try {
            await this.executeUpdate(strategy as any, 'array', batch);
            
            const batchTime = performance.now() - batchStartTime;
            this.performanceAnalyzer.batchTimes.push(batchTime);
            
            // 保持最近20个批次的时间记录
            if (this.performanceAnalyzer.batchTimes.length > 20) {
                this.performanceAnalyzer.batchTimes.shift();
            }
        } catch (error) {
            console.error(`EnhancedIntelligentHighlightSystem: 批次 ${batchIndex} 处理失败:`, error);
            this.performanceAnalyzer.errorCount++;
            throw error;
        }
    }
    
    /**
     * 等待内存压力缓解
     */
    private async waitForMemoryRelief(): Promise<void> {
        const maxWaitTime = 5000; // 最大等待5秒
        const checkInterval = 100;
        let waitedTime = 0;
        
        while (this.performanceAnalyzer.memoryPressure > 0.7 && waitedTime < maxWaitTime) {
            await this.sleep(checkInterval);
            waitedTime += checkInterval;
            this.checkMemoryUsage();
        }
        
        if (waitedTime >= maxWaitTime) {
            console.warn('EnhancedIntelligentHighlightSystem: 内存压力等待超时，继续处理');
        }
    }
    
    /**
     * 休眠函数
     */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    /**
     * 按需加载系统 - 增强版
     */
    private async ensureSystemLoaded(strategy: 'medium' | 'heavyweight' | 'ultra-heavy'): Promise<void> {
        if (this.preloadedSystems.has(strategy)) return;
        
        try {
            if (strategy === 'medium' && !this.mediumSystem) {
                console.log('EnhancedIntelligentHighlightSystem: 加载中等级系统...');
                this.mediumSystem = new ShaderBasedHighlightSystem(this.renderer, this.scene, this.camera);
                this.preloadedSystems.add('medium');
                
            } else if ((strategy === 'heavyweight' || strategy === 'ultra-heavy') && !this.heavyweightSystem) {
                console.log('EnhancedIntelligentHighlightSystem: 加载重量级/超重量级系统...');
                this.heavyweightSystem = new OptimizedGPUHighlightSystem(this.renderer, this.scene, this.camera);
                this.preloadedSystems.add('heavyweight');
                this.preloadedSystems.add('ultra-heavy'); // 超重量级复用重量级系统
            }
        } catch (error) {
            console.error(`EnhancedIntelligentHighlightSystem: 加载${strategy}系统失败:`, error);
            this.performanceAnalyzer.errorCount++;
            throw error;
        }
    }
    
    /**
     * 传统数组方式更新高亮 - 增强版
     */
    async updateHighlight(selectedTriangles: number[]): Promise<void> {
        const triangleCount = selectedTriangles.length;
        
        // 超大数据量自动使用分批处理
        if (triangleCount > this.BATCH_CONFIG.MAX_BATCH_SIZE * 2) {
            return this.updateHighlightBatched(selectedTriangles);
        }
        
        const startTime = performance.now();
        const strategy = this.selectOptimalStrategy(triangleCount, 'array');
        
        try {
            if (strategy !== 'lightweight') {
                await this.ensureSystemLoaded(strategy as any);
            }
            
            this.clearOtherSystems(strategy as any);
            await this.executeUpdate(strategy as any, 'array', selectedTriangles);
            
            this.currentStrategy = strategy as any;
            this.recordPerformance(startTime);
            
            console.log(`EnhancedIntelligentHighlightSystem: 使用 ${strategy} 策略处理 ${triangleCount} 个三角形`);
        } catch (error) {
            console.error(`EnhancedIntelligentHighlightSystem: ${strategy} 策略失败:`, error);
            await this.handleStrategyFailure(strategy as any, 'array', selectedTriangles);
        }
    }
    
    /**
     * 执行更新操作 - 增强版
     */
    private async executeUpdate(
        strategy: 'lightweight' | 'medium' | 'heavyweight' | 'ultra-heavy',
        type: 'array' | 'lasso',
        data: number[]
    ): Promise<void> {
        switch (strategy) {
            case 'lightweight':
                if (type === 'array') {
                    this.lightweightSystem.updateHighlight(data, { useTexture: false, animated: true });
                }
                break;
            
            case 'medium':
                if (type === 'array') {
                    this.mediumSystem.updateHighlight(data, { useTexture: true, animated: true });
                }
                break;
            
            case 'heavyweight':
            case 'ultra-heavy': // 超重量级复用重量级系统，但可能使用不同参数
                if (type === 'array') {
                    // 对于超重量级，可以传递特殊的优化参数
                    const options = strategy === 'ultra-heavy' ? 
                        { maxBatchSize: this.BATCH_CONFIG.MAX_BATCH_SIZE, useStreamProcessing: true } : 
                        {};
                    
                    if (this.heavyweightSystem.updateHighlightOptimized) {
                        this.heavyweightSystem.updateHighlightOptimized(data, options);
                    } else {
                        // 降级到普通方法
                        console.log('EnhancedIntelligentHighlightSystem: 降级到普通重量级方法');
                    }
                } else {
                    this.heavyweightSystem.updateHighlightWithLassoPath(data);
                }
                break;
        }
    }
    
    /**
     * 处理策略失败 - 增强版
     */
    private async handleStrategyFailure(
        failedStrategy: 'lightweight' | 'medium' | 'heavyweight' | 'ultra-heavy',
        type: 'array' | 'lasso',
        data: number[]
    ): Promise<void> {
        this.performanceAnalyzer.errorCount++;
        
        // 降级策略
        let fallbackStrategy: 'lightweight' | 'medium' | 'heavyweight' | 'ultra-heavy';
        
        if (failedStrategy === 'ultra-heavy') {
            fallbackStrategy = 'heavyweight';
        } else if (failedStrategy === 'heavyweight') {
            fallbackStrategy = 'medium';
        } else if (failedStrategy === 'medium') {
            fallbackStrategy = 'lightweight';
        } else {
            console.error('EnhancedIntelligentHighlightSystem: 所有策略都失败了');
            return;
        }
        
        try {
            console.log(`EnhancedIntelligentHighlightSystem: 降级到 ${fallbackStrategy} 策略`);
            
            // 如果数据量太大，尝试分批处理
            if (data.length > this.BATCH_CONFIG.MAX_BATCH_SIZE && fallbackStrategy !== 'lightweight') {
                return this.updateHighlightBatched(data);
            }
            
            if (fallbackStrategy !== 'lightweight') {
                await this.ensureSystemLoaded(fallbackStrategy as any);
            }
            
            this.clearOtherSystems(fallbackStrategy as any);
            await this.executeUpdate(fallbackStrategy as any, type, data);
            this.currentStrategy = fallbackStrategy as any;
        } catch (error) {
            console.error(`EnhancedIntelligentHighlightSystem: 降级策略 ${fallbackStrategy} 也失败了`, error);
            if (fallbackStrategy !== 'lightweight') {
                await this.handleStrategyFailure(fallbackStrategy, type, data);
            }
        }
    }
    
    /**
     * 清除其他系统的高亮
     */
    private clearOtherSystems(activeStrategy: 'lightweight' | 'medium' | 'heavyweight' | 'ultra-heavy'): void {
        if (activeStrategy !== 'lightweight') {
            this.lightweightSystem.clearHighlight();
        }
        if (activeStrategy !== 'medium' && this.mediumSystem) {
            this.mediumSystem.clearHighlight();
        }
        if (activeStrategy !== 'heavyweight' && activeStrategy !== 'ultra-heavy' && this.heavyweightSystem) {
            this.heavyweightSystem.clearHighlight();
        }
    }
    
    /**
     * 记录性能数据 - 增强版
     */
    private recordPerformance(startTime: number): void {
        const updateTime = performance.now() - startTime;
        
        this.performanceAnalyzer.updateTimes.push(updateTime);
        if (this.performanceAnalyzer.updateTimes.length > 20) {
            this.performanceAnalyzer.updateTimes.shift();
        }
        
        const memoryStats = this.getMemoryStats();
        this.performanceAnalyzer.memoryUsage.push(memoryStats.totalMemoryMB);
        if (this.performanceAnalyzer.memoryUsage.length > 10) {
            this.performanceAnalyzer.memoryUsage.shift();
        }
        
        // 检查是否退出紧急模式
        if (this.performanceAnalyzer.emergencyMode && this.performanceAnalyzer.memoryPressure < 0.6) {
            this.performanceAnalyzer.emergencyMode = false;
            console.log('EnhancedIntelligentHighlightSystem: 退出紧急模式');
        }
    }
    
    /**
     * 设置目标网格 - 增强版
     */
    async setTargetMesh(mesh: THREE.Mesh): Promise<void> {
        this.currentTriangleCount = this.getTriangleCount(mesh.geometry);
        console.log(`EnhancedIntelligentHighlightSystem: 目标网格三角形数量 = ${this.currentTriangleCount.toLocaleString()}`);
        
        // 预估内存需求
        const estimatedMemoryMB = this.estimateMemoryRequirement(this.currentTriangleCount);
        console.log(`EnhancedIntelligentHighlightSystem: 预估内存需求 = ${estimatedMemoryMB.toFixed(1)}MB`);
        
        // 调整内存限制
        if (estimatedMemoryMB > this.memoryManager.maxMemoryMB) {
            this.memoryManager.maxMemoryMB = Math.min(estimatedMemoryMB * 1.5, 1024); // 最大1GB
            console.log(`EnhancedIntelligentHighlightSystem: 调整内存限制到 ${this.memoryManager.maxMemoryMB}MB`);
        }
        
        const anticipatedStrategy = this.selectOptimalStrategy(this.currentTriangleCount, 'array');
        
        try {
            if (anticipatedStrategy !== 'lightweight') {
                await this.ensureSystemLoaded(anticipatedStrategy as any);
            }
            
            // 为所有已加载的系统设置目标网格
            this.lightweightSystem.setTargetMesh(mesh);
            if (this.mediumSystem) this.mediumSystem.setTargetMesh(mesh);
            if (this.heavyweightSystem) this.heavyweightSystem.setTargetMesh(mesh);
            
            console.log(`EnhancedIntelligentHighlightSystem: 预期使用 ${anticipatedStrategy} 策略`);
        } catch (error) {
            console.error('EnhancedIntelligentHighlightSystem: 设置目标网格失败:', error);
            this.lightweightSystem.setTargetMesh(mesh);
        }
    }
    
    /**
     * 预估内存需求
     */
    private estimateMemoryRequirement(triangleCount: number): number {
        // 简单的内存预估公式 (基于经验值)
        const baseMemoryMB = 50; // 基础内存
        const memoryPerTriangle = 0.001; // 每个三角形约1KB
        
        return baseMemoryMB + (triangleCount * memoryPerTriangle);
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
     * 设置性能分析器
     */
    private setupPerformanceAnalyzer(): void {
        // 定期清理错误计数
        setInterval(() => {
            this.performanceAnalyzer.errorCount = Math.max(0, this.performanceAnalyzer.errorCount - 1);
        }, 30000);
    }
    
    /**
     * 获取内存统计 - 基础版本
     */
    private getMemoryStats(): { totalMemoryMB: number; breakdown: any } {
        // 这里需要根据实际的系统接口来获取内存统计
        // 暂时返回模拟数据
        return {
            totalMemoryMB: this.memoryManager.currentMemoryMB,
            breakdown: {
                lightweight: 10,
                medium: this.mediumSystem ? 50 : 0,
                heavyweight: this.heavyweightSystem ? 100 : 0
            }
        };
    }
    
    /**
     * 中止当前处理
     */
    abortProcessing(): void {
        if (this.isProcessing) {
            this.processingAborted = true;
            console.log('EnhancedIntelligentHighlightSystem: 用户中止处理');
        }
    }
    
    /**
     * 获取处理进度
     */
    getProcessingProgress(): { 
        isProcessing: boolean; 
        progress: number; 
        completedBatches: number; 
        totalBatches: number; 
        processedTriangles: number;
        estimatedTimeLeft: number;
    } {
        if (!this.isProcessing) {
            return {
                isProcessing: false,
                progress: 0,
                completedBatches: 0,
                totalBatches: 0,
                processedTriangles: 0,
                estimatedTimeLeft: 0
            };
        }
        
        const progress = this.batchProcessor.totalBatches > 0 ? 
            this.batchProcessor.completedBatches.size / this.batchProcessor.totalBatches : 0;
        
        // 估算剩余时间
        const elapsedTime = performance.now() - this.batchProcessor.startTime;
        const avgBatchTime = this.performanceAnalyzer.batchTimes.length > 0 ? 
            this.performanceAnalyzer.batchTimes.reduce((a, b) => a + b, 0) / this.performanceAnalyzer.batchTimes.length : 0;
        const remainingBatches = this.batchProcessor.totalBatches - this.batchProcessor.completedBatches.size;
        const estimatedTimeLeft = remainingBatches * avgBatchTime;
        
        return {
            isProcessing: true,
            progress: progress * 100,
            completedBatches: this.batchProcessor.completedBatches.size,
            totalBatches: this.batchProcessor.totalBatches,
            processedTriangles: this.batchProcessor.processedTriangles,
            estimatedTimeLeft
        };
    }
    
    /**
     * 套索路径方式更新高亮 - 增强版
     */
    async updateHighlightWithLassoPath(lassoPath: number[]): Promise<void> {
        const startTime = performance.now();
        const pointCount = Math.floor(lassoPath.length / 3);
        
        const strategy = this.selectOptimalStrategy(this.currentTriangleCount, 'lasso');
        
        try {
            if (strategy !== 'lightweight') {
                await this.ensureSystemLoaded(strategy as any);
            }
            
            this.clearOtherSystems(strategy as any);
            await this.executeUpdate(strategy as any, 'lasso', lassoPath);
            
            this.currentStrategy = strategy as any;
            this.recordPerformance(startTime);
            
            console.log(`EnhancedIntelligentHighlightSystem: 使用 ${strategy} 策略处理套索路径 (${pointCount} 个点)`);
        } catch (error) {
            console.error(`EnhancedIntelligentHighlightSystem: ${strategy} 策略失败:`, error);
            await this.handleStrategyFailure(strategy as any, 'lasso', lassoPath);
        }
    }
    
    /**
     * 清除所有高亮
     */
    clearHighlight(): void {
        // 中止正在进行的处理
        this.abortProcessing();
        
        this.lightweightSystem.clearHighlight();
        if (this.mediumSystem) this.mediumSystem.clearHighlight();
        if (this.heavyweightSystem) this.heavyweightSystem.clearHighlight();
        
        this.currentStrategy = 'lightweight';
        
        // 清理批处理状态
        this.batchProcessor.activeBatches.clear();
        this.batchProcessor.completedBatches.clear();
        this.batchProcessor.totalBatches = 0;
        this.batchProcessor.processedTriangles = 0;
    }
    
    /**
     * 获取综合性能统计 - 增强版
     */
    getPerformanceStats(): {
        currentStrategy: string;
        triangleCount: number;
        memoryStats: any;
        performanceAnalysis: any;
        systemStatus: any;
        batchProcessing: any;
        memoryManagement: any;
    } {
        const memoryStats = this.getMemoryStats();
        
        return {
            currentStrategy: this.currentStrategy,
            triangleCount: this.currentTriangleCount,
            memoryStats,
            performanceAnalysis: {
                averageUpdateTime: this.performanceAnalyzer.updateTimes.length > 0 ?
                    this.performanceAnalyzer.updateTimes.reduce((a, b) => a + b, 0) / this.performanceAnalyzer.updateTimes.length : 0,
                averageBatchTime: this.performanceAnalyzer.batchTimes.length > 0 ?
                    this.performanceAnalyzer.batchTimes.reduce((a, b) => a + b, 0) / this.performanceAnalyzer.batchTimes.length : 0,
                errorCount: this.performanceAnalyzer.errorCount,
                adaptiveMode: this.performanceAnalyzer.adaptiveMode,
                emergencyMode: this.performanceAnalyzer.emergencyMode,
                memoryPressure: this.performanceAnalyzer.memoryPressure
            },
            systemStatus: {
                loadedSystems: Array.from(this.preloadedSystems),
                thresholds: this.THRESHOLDS
            },
            batchProcessing: {
                isProcessing: this.isProcessing,
                batchConfig: this.BATCH_CONFIG,
                currentProgress: this.getProcessingProgress()
            },
            memoryManagement: {
                maxMemoryMB: this.memoryManager.maxMemoryMB,
                currentMemoryMB: this.memoryManager.currentMemoryMB,
                memoryPressure: this.performanceAnalyzer.memoryPressure,
                gcSuggestionCount: this.memoryManager.gcSuggestionCount
            }
        };
    }
    
    /**
     * 启用/禁用性能自适应模式
     */
    setAdaptiveMode(enabled: boolean): void {
        this.performanceAnalyzer.adaptiveMode = enabled;
        console.log(`EnhancedIntelligentHighlightSystem: 性能自适应模式 ${enabled ? '启用' : '禁用'}`);
    }
    
    /**
     * 手动设置策略阈值
     */
    setThresholds(thresholds: Partial<typeof this.THRESHOLDS>): void {
        Object.assign(this.THRESHOLDS, thresholds);
        console.log('EnhancedIntelligentHighlightSystem: 策略阈值已更新:', this.THRESHOLDS);
    }
    
    /**
     * 设置分批处理配置
     */
    setBatchConfig(config: Partial<typeof this.BATCH_CONFIG>): void {
        Object.assign(this.BATCH_CONFIG, config);
        console.log('EnhancedIntelligentHighlightSystem: 分批配置已更新:', this.BATCH_CONFIG);
    }
    
    /**
     * 设置内存限制
     */
    setMemoryLimit(maxMemoryMB: number): void {
        this.memoryManager.maxMemoryMB = maxMemoryMB;
        console.log(`EnhancedIntelligentHighlightSystem: 内存限制设置为 ${maxMemoryMB}MB`);
    }
    
    /**
     * 预热系统 - 增强版
     */
    async warmupSystems(): Promise<void> {
        console.log('EnhancedIntelligentHighlightSystem: 开始预热所有系统...');
        
        try {
            await this.ensureSystemLoaded('medium');
            await this.ensureSystemLoaded('heavyweight');
            // ultra-heavy 复用 heavyweight，无需单独加载
            console.log('EnhancedIntelligentHighlightSystem: 所有系统预热完成');
        } catch (error) {
            console.error('EnhancedIntelligentHighlightSystem: 系统预热失败:', error);
        }
    }
    
    /**
     * 强制垃圾回收（如果可用）
     */
    forceGarbageCollection(): void {
        if ((window as any).gc) {
            (window as any).gc();
            console.log('EnhancedIntelligentHighlightSystem: 执行强制垃圾回收');
        } else {
            console.warn('EnhancedIntelligentHighlightSystem: 垃圾回收接口不可用');
        }
        
        // 清理内部缓存
        this.highlightCache.clear();
        this.memoryManager.gcSuggestionCount = 0;
    }
    
    /**
     * 优化建议
     */
    getOptimizationSuggestions(): string[] {
        const suggestions: string[] = [];
        const stats = this.getPerformanceStats();
        
        // 基于性能数据给出建议
        if (stats.performanceAnalysis.averageUpdateTime > 100) {
            suggestions.push('更新时间较长，建议增加分批大小或减少三角形数量');
        }
        
        if (stats.memoryManagement.memoryPressure > 0.8) {
            suggestions.push('内存压力较高，建议减少同时处理的数据量或增加内存限制');
        }
        
        if (stats.performanceAnalysis.errorCount > 5) {
            suggestions.push('错误次数较多，建议检查数据质量或降低处理复杂度');
        }
        
        if (stats.batchProcessing.batchConfig.MAX_BATCH_SIZE > 100000 && this.currentTriangleCount > 500000) {
            suggestions.push('超大数据量处理，建议减小批次大小以提高响应性');
        }
        
        if (!stats.performanceAnalysis.adaptiveMode) {
            suggestions.push('建议启用自适应模式以获得更好的性能表现');
        }
        
        return suggestions;
    }
    
    /**
     * 导出性能报告
     */
    exportPerformanceReport(): any {
        const stats = this.getPerformanceStats();
        const suggestions = this.getOptimizationSuggestions();
        
        return {
            timestamp: new Date().toISOString(),
            system: 'EnhancedIntelligentHighlightSystem',
            version: '2.0.0',
            configuration: {
                thresholds: this.THRESHOLDS,
                batchConfig: this.BATCH_CONFIG,
                memoryLimit: this.memoryManager.maxMemoryMB
            },
            currentStatus: stats,
            optimizationSuggestions: suggestions,
            summary: {
                recommendedStrategy: this.selectOptimalStrategy(this.currentTriangleCount, 'array'),
                estimatedMemoryRequirement: this.estimateMemoryRequirement(this.currentTriangleCount),
                isOptimal: suggestions.length === 0
            }
        };
    }
    
    /**
     * 释放资源 - 增强版
     */
    dispose(): void {
        // 中止正在进行的处理
        this.abortProcessing();
        
        // 停止内存监控
        if (this.memoryManager.memoryCheckTimer) {
            clearInterval(this.memoryManager.memoryCheckTimer);
            this.memoryManager.memoryCheckTimer = null;
        }
        
        // 释放所有系统
        this.lightweightSystem.dispose();
        if (this.mediumSystem) this.mediumSystem.dispose();
        if (this.heavyweightSystem) this.heavyweightSystem.dispose();
        
        // 清理缓存和状态
        this.highlightCache.clear();
        this.preloadedSystems.clear();
        this.batchProcessor.activeBatches.clear();
        this.batchProcessor.completedBatches.clear();
        
        // 重置性能分析器
        this.performanceAnalyzer.updateTimes = [];
        this.performanceAnalyzer.memoryUsage = [];
        this.performanceAnalyzer.batchTimes = [];
        this.performanceAnalyzer.errorCount = 0;
        this.performanceAnalyzer.emergencyMode = false;
        this.performanceAnalyzer.memoryPressure = 0;
        
        // 重置内存管理器
        this.memoryManager.currentMemoryMB = 0;
        this.memoryManager.gcSuggestionCount = 0;
        
        console.log('EnhancedIntelligentHighlightSystem: 所有资源已释放');
    }
}