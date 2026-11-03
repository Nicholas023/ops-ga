import { assert, save } from '../src/common.mjs';

// Billing/inference and Docker grading are independent stages. A known model
// receipt is never discarded or made unknown just because grading failed.
export async function gradeInference(run, { instanceId, prediction, runId, directory, benchmark }, grade) {
  try {
    const graded = await grade();
    const report = graded.result;
    assert(Array.isArray(report.resolved_ids) && Array.isArray(report.unresolved_ids), 'Unsupported official SWE-bench report');
    assert(![...(report.infra_failure_ids ?? []), ...(report.error_ids ?? []), ...(report.incomplete_ids ?? []), ...(report.ambiguous_failure_ids ?? [])].includes(instanceId), 'SWE grading infrastructure/incomplete result');
    const resolved = report.resolved_ids.includes(instanceId), unresolved = report.unresolved_ids.includes(instanceId);
    assert(resolved !== unresolved, 'SWE report must contain exactly one task outcome');
    return { ...run, success: run.success && resolved, agentCompleted: run.success, gradingOutcome: resolved ? 'resolved' : 'unresolved', report: graded.report, prediction, benchmark, synthetic: false };
  } catch (error) {
    await save(`${directory}/grading-failure.json`, { version: 1, runId, prediction, usageKnown: true, failureCode: error.failureCode ?? 'grading.report_or_harness_failure' });
    return { ...run, success: false, selectionEligible: false, gradingOutcome: 'infrastructure_failed', agentCompleted: run.success, prediction, benchmark, synthetic: false };
  }
}
