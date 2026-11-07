import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { AuthContext } from "@/components/providers/auth-provider";
import { Form, FormField } from "@/components/ui/form";
import { useUpdateTaskTitle } from "@/hooks/mutations/task/use-update-task-title";
import useGetTask from "@/hooks/queries/task/use-get-task";
import { useAutoGrowTextarea } from "@/hooks/use-auto-grow-textarea";
import { useWorkspacePermission } from "@/hooks/use-workspace-permission";
import { cn } from "@/lib/cn";
import { stripLineBreaks } from "@/lib/strip-line-breaks";
import { taskTitleSaveQueue } from "@/lib/task-title-save-queue";

type TaskTitleProps = {
  taskId: string;
  size?: "md" | "lg";
};

export default function TaskTitle({ taskId, size = "md" }: TaskTitleProps) {
  const { t } = useTranslation();
  const { data: task } = useGetTask(taskId);
  const { mutateAsync: updateTaskTitle } = useUpdateTaskTitle();
  const { canUpdateTasks } = useWorkspacePermission();
  const canEdit = canUpdateTasks();
  const ownerId = useContext(AuthContext).user?.id ?? "";
  const ownerIdRef = useRef(ownerId);
  ownerIdRef.current = ownerId;
  const taskRef = useRef(task);
  const updateTaskRef = useRef(updateTaskTitle);

  useEffect(() => {
    taskRef.current = task;
    updateTaskRef.current = updateTaskTitle;
  }, [task, updateTaskTitle]);

  // A refetch can return an older title than the one still waiting to be saved.
  const unsavedTitle = useSyncExternalStore(
    taskTitleSaveQueue.subscribe,
    () => taskTitleSaveQueue.get(taskId, ownerId)?.value,
  );

  const form = useForm<{
    title: string;
  }>({
    values: {
      title: unsavedTitle ?? task?.title ?? "",
    },
  });

  const title = form.watch("title");
  const textareaRef = useAutoGrowTextarea(title);

  const handleTitleChange = useCallback((value: string) => {
    const editedTask = taskRef.current;
    if (!editedTask) return;

    taskTitleSaveQueue.schedule(
      editedTask.id,
      value,
      (title) =>
        updateTaskRef.current({
          ...(taskRef.current?.id === editedTask.id
            ? taskRef.current
            : editedTask),
          title,
        }),
      ownerIdRef.current,
    );
  }, []);

  return (
    <Form {...form}>
      <FormField
        control={form.control}
        name="title"
        render={({ field }) => (
          <textarea
            {...field}
            data-task-action="title"
            ref={(element) => {
              field.ref(element);
              textareaRef.current = element;
            }}
            rows={1}
            placeholder={t("tasks:detail.titlePlaceholder")}
            readOnly={!canEdit}
            onBlur={() => {
              field.onBlur();
              taskTitleSaveQueue.retry(taskId, ownerId);
            }}
            className={cn(
              "block h-auto w-full resize-none appearance-none overflow-hidden border-0 bg-transparent p-0 font-heading font-semibold text-2xl text-foreground leading-[1.25] tracking-[-0.02em] outline-none placeholder:text-foreground/45",
              size === "lg" && "sm:text-[1.75rem] sm:leading-[1.2]",
            )}
            onKeyDown={(e) => {
              // Titles are single-line; Enter commits instead of adding a break.
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
            onChange={(e) => {
              const value = stripLineBreaks(e.target.value);
              field.onChange(value);
              handleTitleChange(value);
            }}
          />
        )}
      />
    </Form>
  );
}
