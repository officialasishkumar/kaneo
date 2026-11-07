import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { taskTitleSaveQueue } from "@/lib/task-title-save-queue";
import TaskTitle from "./task-title";

const mocks = vi.hoisted(() => ({
  getTask: vi.fn(),
  updateTaskTitle: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/fetchers/task/get-task", () => ({ default: mocks.getTask }));
vi.mock("@/fetchers/task/update-task-title", () => ({
  default: mocks.updateTaskTitle,
}));
vi.mock("@/hooks/use-workspace-permission", () => ({
  useWorkspacePermission: () => ({ canUpdateTasks: () => true }),
}));
vi.mock("@/hooks/use-auto-grow-textarea", () => ({
  useAutoGrowTextarea: () => ({ current: null }),
}));
vi.mock("@/components/providers/auth-provider", async () => {
  const { createContext } = await import("react");
  return { AuthContext: createContext({ user: { id: "user-1" } }) };
});

const baseTask = { id: "task-1", projectId: "project-1", title: "Original" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function renderTitle() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TaskTitle taskId="task-1" />
    </QueryClientProvider>,
  );
  await act(() => vi.advanceTimersByTimeAsync(0));
  return {
    client,
    input: screen.getByPlaceholderText<HTMLTextAreaElement>(
      "tasks:detail.titlePlaceholder",
    ),
  };
}

const settle = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));

describe("TaskTitle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.getTask.mockReset().mockResolvedValue(baseTask);
    mocks.updateTaskTitle.mockReset();
  });

  afterEach(() => {
    cleanup();
    taskTitleSaveQueue.clear();
    vi.useRealTimers();
  });

  it("keeps newer typing when an earlier save and its refetch finish", async () => {
    const first = deferred<typeof baseTask>();
    const second = deferred<typeof baseTask>();
    mocks.updateTaskTitle
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { input } = await renderTitle();

    fireEvent.change(input, { target: { value: "Saved" } });
    await settle(800);
    expect(mocks.updateTaskTitle).toHaveBeenCalledTimes(1);

    fireEvent.change(input, { target: { value: "Saved and more" } });
    input.setSelectionRange(5, 5);
    mocks.getTask.mockResolvedValue({ ...baseTask, title: "Saved" });
    first.resolve({ ...baseTask, title: "Saved" });
    await settle();

    expect(mocks.getTask).toHaveBeenCalledTimes(2);
    expect(input.value).toBe("Saved and more");
    expect(input.selectionStart).toBe(5);

    mocks.getTask.mockResolvedValue({ ...baseTask, title: "Saved and more" });
    second.resolve({ ...baseTask, title: "Saved and more" });
    await settle();

    expect(input.value).toBe("Saved and more");
  });

  it("sends one save at a time, ending with the latest title", async () => {
    const first = deferred<typeof baseTask>();
    const second = deferred<typeof baseTask>();
    mocks.updateTaskTitle
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { input } = await renderTitle();

    fireEvent.change(input, { target: { value: "One" } });
    await settle(800);
    fireEvent.change(input, { target: { value: "One two" } });
    await settle(800);
    fireEvent.change(input, { target: { value: "One two three" } });
    await settle(800);
    expect(mocks.updateTaskTitle).toHaveBeenCalledTimes(1);

    mocks.getTask.mockResolvedValue({ ...baseTask, title: "One two three" });
    first.resolve({ ...baseTask, title: "One" });
    await settle();

    expect(mocks.updateTaskTitle).toHaveBeenCalledTimes(2);
    expect(mocks.updateTaskTitle.mock.calls[1]?.[1]).toMatchObject({
      title: "One two three",
    });

    second.resolve({ ...baseTask, title: "One two three" });
    await settle();
    expect(input.value).toBe("One two three");
  });

  it("keeps the saved title when the cached task is still stale", async () => {
    const refetch = deferred<typeof baseTask>();
    mocks.updateTaskTitle.mockResolvedValue({ ...baseTask, title: "Renamed" });
    const { input } = await renderTitle();

    mocks.getTask.mockReturnValue(refetch.promise);
    fireEvent.change(input, { target: { value: "Renamed" } });
    await settle(800);

    expect(input.value).toBe("Renamed");
    refetch.resolve({ ...baseTask, title: "Renamed" });
    await settle();
    expect(input.value).toBe("Renamed");
  });

  it("shows a title changed elsewhere when no edit is waiting", async () => {
    const { client, input } = await renderTitle();

    mocks.getTask.mockResolvedValue({ ...baseTask, title: "From a teammate" });
    await act(() => client.invalidateQueries({ queryKey: ["task", "task-1"] }));
    await settle();

    expect(input.value).toBe("From a teammate");
  });

  it("keeps a failed title and saves it again on blur", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.updateTaskTitle.mockRejectedValueOnce(new Error("offline"));
    const { input } = await renderTitle();

    fireEvent.change(input, { target: { value: "Unsaved" } });
    await settle(800);
    expect(input.value).toBe("Unsaved");

    mocks.getTask.mockResolvedValue({ ...baseTask, title: "Unsaved" });
    mocks.updateTaskTitle.mockResolvedValueOnce({
      ...baseTask,
      title: "Unsaved",
    });
    fireEvent.blur(input);
    await settle();

    expect(mocks.updateTaskTitle).toHaveBeenCalledTimes(2);
    expect(input.value).toBe("Unsaved");
  });
});
