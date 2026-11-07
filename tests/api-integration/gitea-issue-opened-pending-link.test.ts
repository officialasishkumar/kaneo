import { eq } from "drizzle-orm";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import * as events from "../../apps/api/src/events";
import { handleGiteaIssueOpened } from "../../apps/api/src/plugins/gitea/webhooks/issue-opened";
import { formatIssueBody } from "../../apps/api/src/plugins/github/utils/format";
import { claimTaskNumber } from "../../apps/api/src/task/controllers/claim-task-numbers";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

vi.mock("../../apps/api/src/plugins/gitea/utils/gitea-api", () => ({
  createGiteaClient: () => ({
    createIssueComment: async () => ({ id: 1 }),
  }),
}));

beforeEach(async () => {
  await resetTestDatabase();
  vi.restoreAllMocks();
  vi.spyOn(events, "publishEvent").mockResolvedValue(undefined);
});

async function createTask(projectId: string, title: string) {
  return db.transaction(async (tx) => {
    const [task] = await tx
      .insert(schema.taskTable)
      .values({
        projectId,
        title,
        status: "to-do",
        number: await claimTaskNumber(projectId, tx),
      })
      .returning();
    return task!;
  });
}

async function createFixture() {
  const { workspace } = await createWorkspaceMember();
  const { project } = await createProjectFixture({ workspaceId: workspace.id });
  const [integration] = await db
    .insert(schema.integrationTable)
    .values({
      projectId: project.id,
      type: "gitea",
      isActive: true,
      config: JSON.stringify({
        baseUrl: "https://gitea.example",
        repositoryOwner: "team",
        repositoryName: "repo",
        accessToken: "test-only",
        commentTaskLinkOnGiteaIssue: false,
      }),
    })
    .returning();
  const task = await createTask(project.id, "Created in Kaneo");
  return { workspace, project, integration: integration!, task };
}

function webhook(number: number, body: string | null) {
  return {
    action: "opened",
    issue: {
      number,
      title: "Created in Kaneo",
      body,
      html_url: `https://gitea.example/team/repo/issues/${number}`,
      labels: [],
      user: { login: "kaneo" },
    },
    repository: {
      owner: { login: "team" },
      name: "repo",
      html_url: "https://gitea.example/team/repo",
    },
  };
}

async function projectTasks(projectId: string) {
  return db.query.taskTable.findMany({
    where: eq(schema.taskTable.projectId, projectId),
  });
}

it("does not import an issue whose webhook beats its task's link", async () => {
  const { project, integration, task } = await createFixture();

  for (const description of [null, "Some details"])
    await handleGiteaIssueOpened(
      webhook(1, formatIssueBody(description, task.id)),
      integration.id,
    );

  expect(await projectTasks(project.id)).toHaveLength(1);
  expect(await db.query.externalLinkTable.findMany()).toHaveLength(0);
  expect(events.publishEvent).not.toHaveBeenCalled();
});

it("imports a new issue whose body was copied from a linked task's issue", async () => {
  const { project, integration, task } = await createFixture();
  await db.insert(schema.externalLinkTable).values({
    taskId: task.id,
    integrationId: integration.id,
    resourceType: "issue",
    externalId: "1",
    url: "https://gitea.example/team/repo/issues/1",
  });

  await handleGiteaIssueOpened(
    webhook(2, formatIssueBody("Copied", task.id)),
    integration.id,
  );

  expect(await projectTasks(project.id)).toHaveLength(2);
});

it("imports an issue whose footer names a task from another project", async () => {
  const { workspace, project, integration } = await createFixture();
  const { project: otherProject } = await createProjectFixture({
    workspaceId: workspace.id,
  });
  const otherTask = await createTask(otherProject.id, "Elsewhere");

  await handleGiteaIssueOpened(
    webhook(1, formatIssueBody(null, otherTask.id)),
    integration.id,
  );

  expect(await projectTasks(project.id)).toHaveLength(2);
});

it.each([
  ["no footer", "Steps to reproduce"],
  ["an empty body", null],
  ["an unknown task id", "<sub>Task: missing</sub>"],
])("imports an issue with %s", async (_case, body) => {
  const { project, integration } = await createFixture();

  await handleGiteaIssueOpened(webhook(1, body), integration.id);

  expect(await projectTasks(project.id)).toHaveLength(2);
});

it("imports an issue that only mentions a footer before its own text", async () => {
  const { project, integration, task } = await createFixture();

  await handleGiteaIssueOpened(
    webhook(1, `${formatIssueBody(null, task.id)}\n\nSame problem here`),
    integration.id,
  );

  expect(await projectTasks(project.id)).toHaveLength(2);
});
