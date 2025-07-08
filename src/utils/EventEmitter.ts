import { ApiListeners, EventCallback, IEventEmitter } from '../types/webgl-marking'; 

// 定义内部监听器结构以匹配新的 ApiListeners 接口
type InternalListeners = {
    [K in keyof ApiListeners]: EventCallback<ApiListeners[K]>[];
};

/**
 * 一个简单的事件发布-订阅机制实现。
 * 实现了 IEventEmitter 接口。
 */
export class EventEmitter implements IEventEmitter {
    private listeners: InternalListeners = { 
        annotationAdded: [], 
        annotationRemoved: [], 
        annotationSelected: [], 
        annotationDeselected: [], 
        modeChanged: [], 
        measurementCompleted: [], 
        measurementCancelled: [], // 测量取消事件
        measurementSaved: [], // 测量保存事件
        error: [], 
        notification: [], 
        ready: [], 
        measurementUpdated: [], 
        toolModeChangeRequested: [], 
        dijkstraReady:[],
        areaCalculationStarted: [], // 面积计算开始事件
        areaCalculationCompleted: [], // 面积计算完成事件

        //新增
        partSelected:[],
        partsSelectionChanged:[],

        injuryContextAdded:[],
        injuryDataUpdated:[],
        injuryModelLoaded:[],
        injuryContextRemoved:[],

        viewChanged:[],

        createHighlightAnnotation: [], // 创建高亮标注指令事件

        // 照片事件
        photoToolStateChanged:[],
        photoCaptured:[],
    };

    /**
     * 注册事件监听器。
     * @param eventName - 事件名称。
     * @param callback - 回调函数。
     * @returns 一个用于取消监听的函数。
     */
    public on<T extends keyof ApiListeners>(eventName: T, callback: EventCallback<ApiListeners[T]>): () => void { 
        if (this.listeners[eventName]) { 
            (this.listeners[eventName] as EventCallback<ApiListeners[T]>[]).push(callback); 
            return () => { 
                this.off(eventName, callback); 
            };
        }
        console.warn(`Event "${eventName}" is not supported.`); 
        return () => { }; // 返回一个空函数
    }

    /**
     * 注销事件监听器。
     * @param eventName - 事件名称。
     * @param callback - 要注销的回调函数。
     */
    public off<T extends keyof ApiListeners>(eventName: T, callback: EventCallback<ApiListeners[T]>): void { 
        const callbacksForEvent = this.listeners[eventName]; // 获取当前事件的监听器数组
        if (callbacksForEvent) { 
            // 直接将过滤后的结果断言为 `any[]`，然后重新断言为 `InternalListeners[T]`
            // 这种方法通常可以绕过复杂的泛型推断问题，但会牺牲一部分类型安全性
            this.listeners[eventName] = (callbacksForEvent.filter(cb => cb !== callback) as any) as InternalListeners[T];
        }
    }

    /**
     * 触发一个事件。
     * @param eventName - 事件名称。
     * @param data - 传递给回调函数的数据。
     */
    public emit<T extends keyof ApiListeners>(eventName: T, data: ApiListeners[T]): void { 
        if (this.listeners[eventName] && this.listeners[eventName].length > 0) { 
            
            const callbacks = this.listeners[eventName] as EventCallback<ApiListeners[T]>[]; 
            callbacks.forEach(cb => { 
                try { 
                    cb(data); 
                } catch (error) { 
                    console.error(`Error in event listener for "${eventName}":`, error); 
                    if (eventName !== 'error') { 
                        this.emit('error', { message: `Event listener error: ${eventName}`, details: error }); 
                    }
                }
            });
        } else {
            console.log(`No listeners registered for event "${eventName}"`);
        }
    }
}