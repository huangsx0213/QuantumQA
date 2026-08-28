/**
 * 兼容层：断言求值引擎已迁至 shared/execution-core（server 运行期与 agent 编译期双端同源）。
 * 存量引用保持不变，请勿在此新增实现。
 */
export * from '../../../shared/execution-core/assertions.ts';
