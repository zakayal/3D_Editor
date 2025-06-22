
/**
 * 代表优先队列中的一个元素。
 */
interface QueueElement {
    vertex: number;
    distance: number;
}

/**
 * 一个基于最小堆实现的最小优先队列。
 * 用于 Dijkstra 算法以提高效率。
 */
export class MinPriorityQueue {
    private heap: QueueElement[] = [];
    // 映射：顶点索引 -> 在堆数组中的位置。用于高效地 decreaseKey。
    private positions: Map<number, number> = new Map();

    /**
     * 检查队列是否为空。
     */
    public isEmpty(): boolean {
        return this.heap.length === 0;
    }

    /**
     * 获取队列中的元素数量。
     */
    public size(): number {
        return this.heap.length;
    }

    /**
     * 交换堆中两个位置的元素。
     */
    private swap(i: number, j: number): void {
        const temp = this.heap[i];
        this.heap[i] = this.heap[j];
        this.heap[j] = temp;
        // 更新位置映射
        this.positions.set(this.heap[i].vertex, i);
        this.positions.set(this.heap[j].vertex, j);
    }

    /**
     * 上浮操作，维护最小堆性质。
     */
    private siftUp(index: number): void {
        let parentIndex = Math.floor((index - 1) / 2);
        while (index > 0 && this.heap[index].distance < this.heap[parentIndex].distance) {
            this.swap(index, parentIndex);
            index = parentIndex;
            parentIndex = Math.floor((index - 1) / 2);
        }
    }

    /**
     * 下沉操作，维护最小堆性质。
     */
    private siftDown(index: number): void {
        const lastIndex = this.heap.length - 1;
        let leftChildIndex = 2 * index + 1;

        while (leftChildIndex <= lastIndex) {
            let rightChildIndex = 2 * index + 2;
            let smallerChildIndex = leftChildIndex;

            if (rightChildIndex <= lastIndex && this.heap[rightChildIndex].distance < this.heap[leftChildIndex].distance) {
                smallerChildIndex = rightChildIndex;
            }

            if (this.heap[index].distance > this.heap[smallerChildIndex].distance) {
                this.swap(index, smallerChildIndex);
                index = smallerChildIndex;
                leftChildIndex = 2 * index + 1;
            } else {
                break; // 堆性质已满足
            }
        }
    }

    /**
     * 向队列中插入一个新元素。
     */
    public insert(vertex: number, distance: number): void {
        const newElement: QueueElement = { vertex, distance };
        this.heap.push(newElement);
        const newIndex = this.heap.length - 1;
        this.positions.set(vertex, newIndex);
        this.siftUp(newIndex);
    }

    /**
     * 提取并返回队列中距离最小的元素。
     */
    public extractMin(): QueueElement | null {
        if (this.isEmpty()) {
            return null;
        }

        const minElement = this.heap[0];
        const lastElement = this.heap.pop();

        if (this.heap.length > 0 && lastElement) {
            this.heap[0] = lastElement;
            this.positions.set(this.heap[0].vertex, 0);
            this.siftDown(0);
        }

        this.positions.delete(minElement.vertex);
        return minElement;
    }

    /**
     * 降低队列中某个顶点的距离值。
     */
    public decreaseKey(vertex: number, newDistance: number): void {
        const index = this.positions.get(vertex);
        if (index === undefined) {
            // 如果顶点不在队列中（理论上应该在），则插入
            this.insert(vertex, newDistance);
            return;
        }

        if (newDistance < this.heap[index].distance) {
            this.heap[index].distance = newDistance;
            this.siftUp(index);
        }
    }

     /**
     * 检查某个顶点是否在队列中。
     */
    public contains(vertex: number): boolean {
        return this.positions.has(vertex);
    }
}