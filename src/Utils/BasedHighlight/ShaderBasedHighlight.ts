//@ts-ignore
import * as THREE from 'three'

/**
 * 基于着色器的高亮系统
 * 在顶点着色器中处理高亮逻辑，实现最高性能的高亮效果
 */
export class ShaderBasedHighlightSystem {
    private renderer: THREE.WebGLRenderer
    private scene: THREE.Scene
    private camera: THREE.Camera

    // 材质和着色器
    private highlightMaterial!: THREE.ShaderMaterial
    private originalMaterial!: THREE.Material

    // 着色器uniform数据
    private highlightUniforms!: {
        highlightTriangles: { value: Float32Array }
        highlightCount: { value: number }
        highlightColor: { value: THREE.Color }
        highlightIntensity: { value: number }
        time: { value: number }
        fadeDistance: { value: number }
        pulseSpeed: { value: number }
        selectionTexture: { value: THREE.DataTexture | null }
        useTextureMask: { value: boolean }
    }

    // 几何体和网格
    private targetMesh!: THREE.Mesh

    // 选择纹理数据
    private selectionTexture!: THREE.DataTexture
    private selectionData!: Uint8Array

    // 性能配置
    private readonly MAX_HIGHLIGHT_TRIANGLES = 10000
    private readonly TEXTURE_SIZE = Math.ceil(Math.sqrt(this.MAX_HIGHLIGHT_TRIANGLES))

    // 动画和效果
    private animationId: number | null = null
    private isAnimating = false

    constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
        this.renderer = renderer
        this.scene = scene
        this.camera = camera

        this.initializeUniforms()
        this.initializeShader()
        this.initializeSelectionTexture()
    }

    /**
     * 初始化着色器uniform变量
     */
    private initializeUniforms(): void {
        // 使用安全的数组大小，避免GPU限制
        const SAFE_ARRAY_SIZE = 512; // 大幅减少数组大小
        
        this.highlightUniforms = {
            // 三角形ID数组 - 使用较小的安全大小
            highlightTriangles: { 
                value: new Float32Array(SAFE_ARRAY_SIZE) 
            },
            // 当前高亮三角形数量
            highlightCount: { value: 0 },
            // 高亮颜色
            highlightColor: { value: new THREE.Color(0xff0000) },
            // 高亮强度
            highlightIntensity: { value: 0.8 },
            // 时间uniform用于动画
            time: { value: 0.0 },
            // 渐变距离
            fadeDistance: { value: 100.0 },
            // 脉冲速度
            pulseSpeed: { value: 2.0 },
            // 选择纹理
            selectionTexture: { value: null },
            // 是否使用纹理蒙版
            useTextureMask: { value: false }
        }
    }

    /**
     * 初始化高性能着色器
     */
    private initializeShader(): void {
        // 使用安全的数组大小以避免着色器编译错误
        const SAFE_ARRAY_SIZE = 512;
        
        this.highlightMaterial = new THREE.ShaderMaterial({
            uniforms: this.highlightUniforms,
            vertexShader: `
                // 顶点属性
                attribute float triangleId;
                
                // Uniform变量
                uniform float highlightTriangles[${SAFE_ARRAY_SIZE}];
                uniform int highlightCount;
                uniform float time;
                uniform float fadeDistance;
                uniform float pulseSpeed;
                uniform bool useTextureMask;
                uniform sampler2D selectionTexture;
                
                // 传递给片段着色器的变量
                varying vec3 vPosition;
                varying vec3 vNormal;
                varying vec2 vUv;
                varying float vHighlightFactor;
                varying float vDistance;
                varying float vTriangleId;
                
                // 简化的三角形ID查找
                bool isTriangleHighlighted(float currentTriangleId) {
                    // 使用简单的线性查找，避免复杂循环
                    for (int i = 0; i < ${SAFE_ARRAY_SIZE}; i++) {
                        if (i >= highlightCount) break;
                        if (abs(highlightTriangles[i] - currentTriangleId) < 0.1) {
                            return true;
                        }
                    }
                    return false;
                }
                
                // 纹理查找版本
                bool isTriangleHighlightedTexture(float currentTriangleId) {
                    // 将三角形ID映射到纹理坐标
                    float texSize = float(${this.TEXTURE_SIZE});
                    float texX = mod(currentTriangleId, texSize) / texSize;
                    float texY = floor(currentTriangleId / texSize) / texSize;
                    
                    vec4 texel = texture2D(selectionTexture, vec2(texX, texY));
                    return texel.r > 0.5;
                }
                
                void main() {
                    vPosition = position;
                    vNormal = normal;
                    vUv = uv;
                    vTriangleId = triangleId;
                    
                    // 计算相机距离
                    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
                    vec4 viewPosition = viewMatrix * worldPosition;
                    vDistance = length(viewPosition.xyz);
                    
                    // 检查是否应该高亮
                    bool shouldHighlight;
                    if (useTextureMask) {
                        shouldHighlight = isTriangleHighlightedTexture(triangleId);
                    } else {
                        shouldHighlight = isTriangleHighlighted(triangleId);
                    }
                    
                    // 计算高亮因子
                    if (shouldHighlight) {
                        // 基于距离的渐变效果
                        float distanceFactor = 1.0 - clamp(vDistance / fadeDistance, 0.0, 1.0);
                        
                        // 脉冲动画
                        float pulse = (sin(time * pulseSpeed) + 1.0) * 0.5;
                        
                        // 综合高亮因子
                        vHighlightFactor = distanceFactor * (0.7 + 0.3 * pulse);
                    } else {
                        vHighlightFactor = 0.0;
                    }
                    
                    // 基于高亮状态的顶点位移（可选的膨胀效果）
                    vec3 finalPosition = position;
                    if (vHighlightFactor > 0.0) {
                        finalPosition += normal * 0.001 * vHighlightFactor;
                    }
                    
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(finalPosition, 1.0);
                }
            `,
            fragmentShader: `
                precision highp float;
                
                // Uniform变量
                uniform vec3 highlightColor;
                uniform float highlightIntensity;
                uniform float time;
                
                // 从顶点着色器传递的变量
                varying vec3 vPosition;
                varying vec3 vNormal;
                varying vec2 vUv;
                varying float vHighlightFactor;
                varying float vDistance;
                varying float vTriangleId;
                
                // 高级照明计算
                vec3 calculateLighting(vec3 normal, vec3 viewDirection) {
                    // 简化的Lambert照明
                    vec3 lightDirection = normalize(vec3(1.0, 1.0, 1.0));
                    float NdotL = max(dot(normal, lightDirection), 0.0);
                    
                    // 环境光
                    vec3 ambient = vec3(0.3);
                    
                    // 漫反射
                    vec3 diffuse = vec3(0.7) * NdotL;
                    
                    return ambient + diffuse;
                }
                
                void main() {
                    vec3 normal = normalize(vNormal);
                    vec3 viewDirection = normalize(cameraPosition - vPosition);
                    
                    // 基础照明
                    vec3 baseColor = calculateLighting(normal, viewDirection);
                    
                    if (vHighlightFactor > 0.0) {
                        // 高亮模式
                        vec3 highlight = highlightColor * highlightIntensity;
                        
                        // 边缘增强效果
                        float fresnel = 1.0 - abs(dot(normal, viewDirection));
                        fresnel = pow(fresnel, 2.0);
                        
                        // 混合基础颜色和高亮
                        vec3 finalColor = mix(baseColor, highlight, vHighlightFactor);
                        finalColor += highlight * fresnel * 0.3;
                        
                        // 透明度处理
                        float alpha = 0.9 + 0.1 * vHighlightFactor;
                        
                        gl_FragColor = vec4(finalColor, alpha);
                    } else {
                        // 非高亮模式 - 保持原始外观
                        gl_FragColor = vec4(baseColor, 1.0);
                    }
                }
            `,
            transparent: true,
            depthWrite: true,
            side: THREE.DoubleSide,
            // 优化设置
            vertexColors: false,
            fog: false,
            lights: false
        })
    }

    /**
     * 初始化选择纹理
     */
    private initializeSelectionTexture(): void {
        const size = this.TEXTURE_SIZE
        this.selectionData = new Uint8Array(size * size * 4)

        this.selectionTexture = new THREE.DataTexture(
            this.selectionData,
            size,
            size,
            THREE.RGBAFormat,
            THREE.UnsignedByteType
        )

        this.selectionTexture.minFilter = THREE.NearestFilter
        this.selectionTexture.magFilter = THREE.NearestFilter
        this.selectionTexture.needsUpdate = true

        this.highlightUniforms.selectionTexture.value = this.selectionTexture
    }

    /**
     * 设置目标网格
     */
    setTargetMesh(mesh: THREE.Mesh): void {
        this.targetMesh = mesh
        this.originalMaterial = mesh.material as THREE.Material

        // 为几何体添加三角形ID属性
        this.addTriangleIdAttribute(mesh.geometry)

        // 预编译着色器
        this.precompileShader()
    }

    /**
     * 添加三角形ID属性到几何体
     */
    private addTriangleIdAttribute(geometry: THREE.BufferGeometry): void {
        const positionCount = geometry.attributes.position.count
        const triangleIds = new Float32Array(positionCount)

        if (geometry.index) {
            // 索引几何体
            const indices = geometry.index.array
            for (let i = 0; i < indices.length; i += 3) {
                const triangleId = Math.floor(i / 3)
                triangleIds[indices[i]] = triangleId
                triangleIds[indices[i + 1]] = triangleId
                triangleIds[indices[i + 2]] = triangleId
            }
        } else {
            // 非索引几何体
            for (let i = 0; i < positionCount; i += 3) {
                const triangleId = Math.floor(i / 3)
                triangleIds[i] = triangleId
                triangleIds[i + 1] = triangleId
                triangleIds[i + 2] = triangleId
            }
        }

        geometry.setAttribute('triangleId', new THREE.BufferAttribute(triangleIds, 1))
    }

    /**
     * 预编译着色器
     */
    private precompileShader(): void {
        if (!this.targetMesh) return

        // 创建临时渲染目标进行预编译
        const tempTarget = new THREE.WebGLRenderTarget(1, 1)
        const tempMaterial = this.targetMesh.material

        this.targetMesh.material = this.highlightMaterial

        this.renderer.setRenderTarget(tempTarget)
        this.renderer.render(this.scene, this.camera)
        this.renderer.setRenderTarget(null)

        this.targetMesh.material = tempMaterial
        tempTarget.dispose()

        console.log('ShaderBasedHighlightSystem: Shader precompiled successfully')
    }

    /**
     * 超高性能的高亮更新 - 只更新uniform数组
     */
    updateHighlight(triangleIds: number[], options: {
        useTexture?: boolean
        animated?: boolean
        color?: THREE.Color
        intensity?: number
    } = {}): void {
        const {
            useTexture = false,
            animated = true,
            color = new THREE.Color(0xff0000),
            intensity = 0.8
        } = options

        if (useTexture) {
            this.updateHighlightTexture(triangleIds)
        } else {
            this.updateHighlightArray(triangleIds)
        }

        // 更新其他uniform
        this.highlightUniforms.highlightColor.value.copy(color)
        this.highlightUniforms.highlightIntensity.value = intensity
        this.highlightUniforms.useTextureMask.value = useTexture

        // 启用或禁用动画
        if (animated && !this.isAnimating) {
            this.startAnimation()
        } else if (!animated && this.isAnimating) {
            this.stopAnimation()
        }

        // 应用材质
        this.applyShaderMaterial()
    }

    /**
     * 使用数组更新高亮（适合小量数据）
     */
    private updateHighlightArray(triangleIds: number[]): void {
        const SAFE_ARRAY_SIZE = 512; // 与着色器中的数组大小保持一致
        const highlightArray = this.highlightUniforms.highlightTriangles.value;

        // 清空数组
        highlightArray.fill(0);

        // 如果三角形数量超过安全限制，自动切换到纹理模式
        if (triangleIds.length > SAFE_ARRAY_SIZE) {
            console.warn(`ShaderBasedHighlight: 三角形数量 ${triangleIds.length} 超过数组限制 ${SAFE_ARRAY_SIZE}，自动切换到纹理模式`);
            this.highlightUniforms.useTextureMask.value = true;
            this.updateHighlightTexture(triangleIds);
            return;
        }

        // 复制三角形ID到数组
        for (let i = 0; i < Math.min(triangleIds.length, SAFE_ARRAY_SIZE); i++) {
            highlightArray[i] = triangleIds[i];
        }

        this.highlightUniforms.highlightCount.value = Math.min(triangleIds.length, SAFE_ARRAY_SIZE);
        this.highlightUniforms.useTextureMask.value = false;
    }

    /**
     * 使用纹理更新高亮（适合大量数据）
     */
    private updateHighlightTexture(triangleIds: number[]): void {
        // 清空纹理数据
        this.selectionData.fill(0)

        // 标记选中的三角形
        for (const triangleId of triangleIds) {
            if (triangleId < this.TEXTURE_SIZE * this.TEXTURE_SIZE) {
                const index = triangleId * 4
                this.selectionData[index] = 255     // R通道标记选中
                this.selectionData[index + 1] = 0   // G通道
                this.selectionData[index + 2] = 0   // B通道
                this.selectionData[index + 3] = 255 // A通道
            }
        }

        // 更新纹理
        this.selectionTexture.needsUpdate = true
    }

    /**
     * 应用着色器材质
     */
    private applyShaderMaterial(): void {
        if (this.targetMesh && this.targetMesh.material !== this.highlightMaterial) {
            this.targetMesh.material = this.highlightMaterial
        }
    }

    /**
     * 恢复原始材质
     */
    restoreOriginalMaterial(): void {
        if (this.targetMesh && this.originalMaterial) {
            this.targetMesh.material = this.originalMaterial
        }
        this.stopAnimation()
    }

    /**
     * 开始动画
     */
    private startAnimation(): void {
        if (this.isAnimating) return

        this.isAnimating = true



        const animate = () => {
            if (!this.isAnimating) return

            const currentTime = performance.now()
            this.highlightUniforms.time.value = currentTime * 0.001

            this.animationId = requestAnimationFrame(animate)
        }

        animate()
    }

    /**
     * 停止动画
     */
    private stopAnimation(): void {
        this.isAnimating = false
        if (this.animationId !== null) {
            cancelAnimationFrame(this.animationId)
            this.animationId = null
        }
    }

    /**
     * 使用套索路径更新高亮（兼容性方法 - 转换为三角形数组）
     */
    updateHighlightWithLassoPath(_lassoPath: number[]): void {
        console.warn('ShaderBasedHighlightSystem: 套索路径方法在轻骑兵模式下不支持，跳过处理');
        // 轻骑兵系统不支持套索路径，这里可以实现简单的降级处理
        // 或者直接跳过，等待重装主力处理
    }

    /**
     * 清除高亮
     */
    clearHighlight(): void {
        this.highlightUniforms.highlightCount.value = 0
        this.highlightUniforms.highlightTriangles.value.fill(-1)
        this.selectionData.fill(0)
        this.selectionTexture.needsUpdate = true
        this.highlightMaterial.uniformsNeedUpdate = true

        this.restoreOriginalMaterial()
    }

    /**
     * 性能监控
     */
    getPerformanceStats(): {
        highlightCount: number
        useTexture: boolean
        isAnimating: boolean
        memoryUsage: number
        shaderComplexity: number
    } {
        return {
            highlightCount: this.highlightUniforms.highlightCount.value,
            useTexture: this.highlightUniforms.useTextureMask.value,
            isAnimating: this.isAnimating,
            memoryUsage: this.calculateMemoryUsage(),
            shaderComplexity: this.calculateShaderComplexity()
        }
    }

    /**
     * 计算内存使用量
     */
    private calculateMemoryUsage(): number {
        const arraySize = this.highlightUniforms.highlightTriangles.value.byteLength
        const textureSize = this.selectionData.byteLength
        return arraySize + textureSize
    }

    /**
     * 计算着色器复杂度
     */
    private calculateShaderComplexity(): number {
        // 简化的复杂度评估
        const baseComplexity = 100
        const triangleComplexity = this.highlightUniforms.highlightCount.value * 2
        const textureComplexity = this.highlightUniforms.useTextureMask.value ? 50 : 0
        const animationComplexity = this.isAnimating ? 30 : 0

        return baseComplexity + triangleComplexity + textureComplexity + animationComplexity
    }

    /**
     * 优化设置
     */
    setOptimizationLevel(level: 'low' | 'medium' | 'high'): void {
        switch (level) {
            case 'low':
                this.highlightUniforms.pulseSpeed.value = 0.5
                this.highlightUniforms.fadeDistance.value = 50.0
                break
            case 'medium':
                this.highlightUniforms.pulseSpeed.value = 1.0
                this.highlightUniforms.fadeDistance.value = 100.0
                break
            case 'high':
                this.highlightUniforms.pulseSpeed.value = 2.0
                this.highlightUniforms.fadeDistance.value = 200.0
                break
        }

        this.highlightMaterial.uniformsNeedUpdate = true
    }

    /**
     * 释放资源
     */
    dispose(): void {
        this.stopAnimation()

        this.highlightMaterial?.dispose()
        this.selectionTexture?.dispose()

        if (this.targetMesh) {
            this.restoreOriginalMaterial()
        }
    }
}