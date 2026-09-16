import { z } from 'zod';

// ============================================================
// RepairPlan —— 结构化校验缺口，让 emit-repair 生成可执行补丁
//
// validate* 在硬 throw 全局一致性错误时，把"坏实体 id + 缺口类型 + 期望动作"
// 挂到 thrown error 上；emit-repair 据此生成"已声明 id + 缺口清单"的补丁视图，
// 取代"报错原文让 LLM 二次解析"。
// ============================================================

export type RepairGapType =
  | 'missing-entity'    // 漏实体：condition 无 case、flow 无覆盖、漏 final case
  | 'bad-reference'     // 引用错：dependency 假 ID、ref 引 flow、traceability 漂移
  | 'wrong-value'       // 值非法：conditionType 串味、testLevel 被改、枚举错
  | 'identity-mismatch' // 身份错：condition/requirement 归属错、duplicate id
  ;

export interface RepairGap {
  type: RepairGapType;
  entityId: string;
  field?: string;
  badValue?: string;
  fix: string;
}

export interface RepairPlan {
  mode: 'emit' | 'json';
  emitCount: number;
  layer: 'schema' | 'global';
  gaps: RepairGap[];
}

/** 把单个缺口挂到 thrown 的 ZodError 上，emit-repair 据此生成补丁。 */
export function throwRepairGap(error: z.ZodError, gap: RepairGap): never {
  (error as z.ZodError & { repairGaps?: RepairGap[] }).repairGaps = [gap];
  throw error;
}

/**
 * F2: 把多个缺口一次性挂到 thrown 的 ZodError 上。
 * validateConditionCoverage / validateFlowCaseReferences 用此函数在收集
 * 全部跨字段缺口后一次抛出，而不是在第一个坏实体上 throw —— emit-repair
 * 据此在一轮内补齐所有坏实体，而不是每轮只修 1 个。
 */
export function throwRepairGaps(error: z.ZodError, gaps: RepairGap[]): never {
  (error as z.ZodError & { repairGaps?: RepairGap[] }).repairGaps = gaps;
  throw error;
}

/** 从 thrown error 提取结构化缺口（无则空数组）。 */
export function extractRepairGaps(err: unknown): RepairGap[] {
  const gaps = (err as { repairGaps?: RepairGap[] } | null | undefined)?.repairGaps;
  return Array.isArray(gaps) ? gaps : [];
}

/** 序列化 RepairPlan 为一行结构化归因（用于失败日志）。 */
export function formatRepairPlan(plan: RepairPlan): string {
  const types = [...new Set(plan.gaps.map((g) => g.type))].join(',') || 'none';
  return `mode=${plan.mode} emit=${plan.emitCount} layer=${plan.layer} gaps=${plan.gaps.length}(${types})`;
}