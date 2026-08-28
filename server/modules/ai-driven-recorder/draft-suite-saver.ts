/**
 * Draft Suite Saver
 *
 * 将 AI 录制产出的 refined steps 保存为独立的 draft suite，
 * 通过 NlTestCase.generatedSuiteId 关联。
 *
 * 架构参考：docs/05-AIDrivenRecordingEngine.md §1.2 (Server 职责) 和 §5 (产物落地)
 *
 * 流程：
 *   1. 创建一个 draft TestSuite（name 标注来源为 AI 录制）
 *   2. 创建一个 TestCase，包含 refined steps
 *   3. 通过 SuiteRepository.save 持久化
 *   4. 通过 NlCaseRepository 更新 generatedSuiteId
 */

import type { TestSuite, TestCase, TestStep } from '../../../shared/contracts/index.ts';
import { saveSuite } from '../suites/repository.ts';
import { nlCaseRepo } from '../nl-cases/repository.ts';
import { randomId } from '../../shared/utils/index.ts';

export interface RefinedStepPayload {
  steps: TestStep[];
  /** 可选：用于命名 suite/case 的标题 */
  caseTitle?: string;
}

export interface DraftSuiteSaveResult {
  suiteId: string;
  caseId: string;
}

/**
 * 将 refined steps 保存为 draft suite。
 *
 * @param projectId 项目 ID
 * @param nlCaseId 关联的 NlTestCase ID（用于回填 generatedSuiteId）
 * @param payload refined steps
 * @returns suiteId + caseId
 */
export function saveDraftSuite(
  projectId: string,
  nlCaseId: string,
  payload: RefinedStepPayload,
): DraftSuiteSaveResult {
  const suiteId = randomId('ai-draft-suite');
  const caseId = randomId('ai-draft-case');
  const nlCase = nlCaseRepo.get(nlCaseId);
  const caseTitle = payload.caseTitle ?? nlCase?.title ?? `AI Recorded Case (${nlCaseId})`;

  const testCase: TestCase = {
    id: caseId,
    name: caseTitle,
    description: `AI 驱动录制生成，关联 NlCase: ${nlCaseId}`,
    steps: payload.steps,
  };

  const suite: TestSuite = {
    id: suiteId,
    projectId,
    name: `[AI Draft] ${caseTitle}`,
    description: `AI 驱动录制生成的草稿套件，来源 NlCase: ${nlCaseId}`,
    cases: [testCase],
    position: 0,
    // 将 NL 用例的 testData 转为套件变量（${key} 模板在运行期由执行引擎解析）。
    // 按 key 去重（ai-test-gen 跨 condition 合并时可能产生重复 key），后者覆盖前者。
    // id 必须全局唯一（suite_variables.id 是主键）——用 randomId，不能用 var-${key}。
    variables: [...new Map(
      (nlCase?.testData ?? [])
        .filter((td: any) => td && td.key)
        .map((td: any) => [td.key, td]),
    ).values()].map((td: any) => ({
      id: randomId('var'),
      key: td.key,
      value: td.value,
    })),
  };

  saveSuite(suite);

  // 回填 NlTestCase.generatedSuiteId
  if (nlCase) {
    nlCaseRepo.save({ ...nlCase, generatedSuiteId: suiteId });
  }

  return { suiteId, caseId };
}
