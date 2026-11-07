import { and, eq, isNull } from "drizzle-orm";
import { externalLinkTable, taskTable } from "../../database/schema";
import type { IntegrationDatabase } from "../github/services/integration-task-scope";

const TASK_FOOTER = /<sub>Task: ([^<\s]+)<\/sub>\s*$/;

/**
 * A task's link is saved only after the provider returns the new issue, so the
 * issue's webhook can arrive first. The footer written by formatIssueBody names
 * that task. Once the task has its link, the same footer means a copied body.
 */
export async function isIssueAwaitingTaskLink(
  issueBody: string | null | undefined,
  projectId: string,
  integrationId: string,
  database: IntegrationDatabase,
): Promise<boolean> {
  const taskId = issueBody?.match(TASK_FOOTER)?.[1];
  if (!taskId) return false;

  const [task] = await database
    .select({ id: taskTable.id })
    .from(taskTable)
    .leftJoin(
      externalLinkTable,
      and(
        eq(externalLinkTable.taskId, taskTable.id),
        eq(externalLinkTable.integrationId, integrationId),
        eq(externalLinkTable.resourceType, "issue"),
      ),
    )
    .where(
      and(
        eq(taskTable.id, taskId),
        eq(taskTable.projectId, projectId),
        isNull(externalLinkTable.id),
      ),
    );

  return task !== undefined;
}
