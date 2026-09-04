import {
  getTask,
  listApprovals,
  listEvents,
  listTasks,
  listUserQuestions,
  type Approval,
  type Task,
  type TaskEvent,
  type UserQuestion,
  type WSMessage,
} from "./client";
import {
  hasSequenceGap,
  highestContiguousSeq,
  mergeEventsBySeq,
} from "../lib/eventStream";

export type TaskListParams = {
  status?: string;
  limit?: number;
  before?: string;
  q?: string;
};

type Resource<T> = {
  data: T;
  loading: boolean;
  error: unknown;
  loaded: boolean;
};

export type TaskDetailResource = Resource<{
  task: Task | null;
  events: TaskEvent[];
  deleted: boolean;
}>;

export type TaskEventReset = {
  taskId: string;
  lease: number;
  revision: number;
  eventEpoch: number;
  speculativeEventEpoch: number;
  events: TaskEvent[];
};

export type LiveResourceState = {
  taskLists: Readonly<Record<string, Resource<Task[]>>>;
  pending: Resource<{
    approvals: Approval[];
    questions: UserQuestion[];
  }>;
  taskDetails: Readonly<Record<string, TaskDetailResource>>;
};

export type LiveResourceAPI = {
  listTasks: typeof listTasks;
  getTask: typeof getTask;
  listEvents: typeof listEvents;
  listApprovals: typeof listApprovals;
  listUserQuestions: typeof listUserQuestions;
};

const EMPTY_TASKS: Task[] = [];
const EMPTY_EVENTS: TaskEvent[] = [];
const EMPTY_PENDING: { approvals: Approval[]; questions: UserQuestion[] } = {
  approvals: [],
  questions: [],
};

const EMPTY_TASK_LIST: Resource<Task[]> = {
  data: EMPTY_TASKS,
  loading: false,
  error: null,
  loaded: false,
};

const EMPTY_TASK_DETAIL: TaskDetailResource = {
  data: { task: null, events: EMPTY_EVENTS, deleted: false },
  loading: false,
  error: null,
  loaded: false,
};

function sortTasks(tasks: Iterable<Task>, limit?: number): Task[] {
  const sorted = Array.from(tasks).sort((a, b) => b.created_at - a.created_at);
  return limit ? sorted.slice(0, limit) : sorted;
}

function taskMatches(task: Task, params: TaskListParams): boolean {
  if (params.status && task.status !== params.status) return false;
  if (params.before && task.id >= params.before) return false;
  const query = params.q?.trim().toLowerCase();
  if (!query) return true;
  return [task.title, task.prompt, task.cwd, task.agent, task.id]
    .filter(Boolean)
    .join("\n")
    .toLowerCase()
    .includes(query);
}

export function taskListKey(params: TaskListParams): string {
  return JSON.stringify({
    status: params.status ?? "",
    limit: params.limit ?? 0,
    before: params.before ?? "",
    q: params.q?.trim() ?? "",
  });
}

function upsertById<T extends { id: string }>(
  items: readonly T[],
  incoming: T,
  include: boolean,
  compare: (a: T, b: T) => number,
): T[] {
  const next = items.filter((item) => item.id !== incoming.id);
  if (include) next.push(incoming);
  return next.sort(compare);
}

export class LiveResourceStore {
  private state: LiveResourceState = {
    taskLists: {},
    pending: {
      data: EMPTY_PENDING,
      loading: false,
      error: null,
      loaded: false,
    },
    taskDetails: {},
  };

  private readonly listeners = new Set<() => void>();
  private readonly api: LiveResourceAPI;
  private revision = 0;
  private readonly taskRevisions = new Map<string, number>();
  private readonly eventRevisions = new Map<string, Map<number, number>>();
  private readonly eventEpochs = new Map<string, number>();
  private readonly speculativeEventResets = new Map<string, TaskEventReset>();
  private readonly approvalRevisions = new Map<string, number>();
  private readonly questionRevisions = new Map<string, number>();
  private readonly tasksById = new Map<string, Task>();
  private readonly deletedTasks = new Set<string>();
  private readonly taskListRegistrations = new Map<
    string,
    { params: TaskListParams; count: number }
  >();
  private readonly taskRegistrations = new Map<
    string,
    { count: number; lease: number }
  >();
  private nextTaskLease = 0;
  private pendingRegistrations = 0;
  private readonly listRequests = new Map<string, Promise<void>>();
  private pendingRequest: Promise<void> | null = null;
  private readonly taskRequests = new Map<
    string,
    { lease: number; promise: Promise<void> }
  >();
  private readonly eventRecoveryRequests = new Map<
    string,
    { lease: number; promise: Promise<void> }
  >();

  constructor(api: LiveResourceAPI) {
    this.api = api;
  }

  getSnapshot = (): LiveResourceState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getTaskList(key: string): Resource<Task[]> {
    return this.state.taskLists[key] ?? EMPTY_TASK_LIST;
  }

  getTaskDetail(taskId: string): TaskDetailResource {
    return this.state.taskDetails[taskId] ?? EMPTY_TASK_DETAIL;
  }

  acquireTaskList(params: TaskListParams): () => void {
    const key = taskListKey(params);
    const registration = this.taskListRegistrations.get(key);
    this.taskListRegistrations.set(key, {
      params,
      count: (registration?.count ?? 0) + 1,
    });
    if (!registration) void this.refreshTaskList(params);
    return () => {
      const current = this.taskListRegistrations.get(key);
      if (!current) return;
      if (current.count <= 1) {
        this.taskListRegistrations.delete(key);
        if (key in this.state.taskLists) {
          const taskLists = { ...this.state.taskLists };
          delete taskLists[key];
          this.state = { ...this.state, taskLists };
          this.emit();
        }
      } else {
        this.taskListRegistrations.set(key, { ...current, count: current.count - 1 });
      }
    };
  }

  acquirePending(): () => void {
    this.pendingRegistrations += 1;
    if (this.pendingRegistrations === 1) void this.refreshPending();
    return () => {
      this.pendingRegistrations = Math.max(0, this.pendingRegistrations - 1);
    };
  }

  acquireTask(taskId: string): () => void {
    const registration = this.taskRegistrations.get(taskId);
    const lease = registration?.lease ?? ++this.nextTaskLease;
    this.taskRegistrations.set(taskId, {
      count: (registration?.count ?? 0) + 1,
      lease,
    });
    if (!registration) void this.refreshTask(taskId);
    return () => {
      const current = this.taskRegistrations.get(taskId);
      if (!current || current.lease !== lease) return;
      if (current.count <= 1) {
        this.taskRegistrations.delete(taskId);
        this.eventRevisions.delete(taskId);
        this.eventEpochs.delete(taskId);
        this.speculativeEventResets.delete(taskId);
        this.taskRequests.delete(taskId);
        this.eventRecoveryRequests.delete(taskId);
        if (taskId in this.state.taskDetails) {
          const taskDetails = { ...this.state.taskDetails };
          delete taskDetails[taskId];
          this.state = { ...this.state, taskDetails };
          this.emit();
        }
      } else {
        this.taskRegistrations.set(taskId, {
          ...current,
          count: current.count - 1,
        });
      }
    };
  }

  async reconnect(): Promise<void> {
    const work: Promise<void>[] = [];
    for (const registration of this.taskListRegistrations.values()) {
      work.push(this.refreshTaskList(registration.params, true));
    }
    if (this.pendingRegistrations > 0) work.push(this.refreshPending(true));
    for (const taskId of this.taskRegistrations.keys()) {
      work.push(this.refreshTask(taskId, true));
    }
    await Promise.allSettled(work);
  }

  applyMessage(message: WSMessage): void {
    const revision = ++this.revision;
    switch (message.kind) {
      case "task_update":
        this.applyTaskUpdate(message.data, revision);
        break;
      case "task_deleted":
        this.applyTaskDeletion(message.data.id, revision);
        break;
      case "event":
        this.applyTaskEvent(message.data, revision);
        break;
      case "approval_update":
        this.applyApprovalUpdate(message.data, revision);
        break;
      case "user_question_update":
        this.applyQuestionUpdate(message.data, revision);
        break;
    }
  }

  currentRevision(): number {
    return this.revision;
  }

  applyTaskSnapshot(task: Task, requestRevision: number): void {
    if ((this.taskRevisions.get(task.id) ?? 0) > requestRevision) return;
    this.applyTaskUpdate(task, ++this.revision);
  }

  patchTask(taskId: string, patch: Partial<Task>): void {
    const current =
      this.state.taskDetails[taskId]?.data.task ?? this.tasksById.get(taskId);
    if (!current) return;
    this.applyTaskUpdate({ ...current, ...patch }, ++this.revision);
  }

  resetTaskEvents(taskId: string): TaskEventReset {
    const revision = ++this.revision;
    const detail = this.getTaskDetail(taskId);
    const eventEpoch = this.eventEpochs.get(taskId) ?? 0;
    const speculativeEventEpoch = eventEpoch + 1;
    const reset = {
      taskId,
      lease: this.taskRegistrations.get(taskId)?.lease ?? 0,
      revision,
      eventEpoch,
      speculativeEventEpoch,
      events: detail.data.events,
    };
    this.eventEpochs.set(taskId, speculativeEventEpoch);
    this.speculativeEventResets.set(taskId, reset);
    this.eventRevisions.delete(taskId);
    this.eventRecoveryRequests.delete(taskId);
    this.taskRequests.delete(taskId);
    this.setTaskDetail(taskId, {
      ...detail,
      data: { ...detail.data, events: [] },
    });
    return reset;
  }

  restoreTaskEvents(reset: TaskEventReset): boolean {
    const detail = this.state.taskDetails[reset.taskId];
    if (
      !detail ||
      !this.isCurrentTaskLease(reset.taskId, reset.lease) ||
      (this.eventEpochs.get(reset.taskId) ?? 0) !==
        reset.speculativeEventEpoch ||
      (this.taskRevisions.get(reset.taskId) ?? 0) > reset.revision ||
      (this.eventRevisions.get(reset.taskId)?.size ?? 0) > 0 ||
      detail.data.events.length > 0
    ) {
      return false;
    }
    this.eventEpochs.set(reset.taskId, reset.eventEpoch);
    this.speculativeEventResets.delete(reset.taskId);
    this.eventRevisions.set(
      reset.taskId,
      new Map(reset.events.map((event) => [event.seq, reset.revision])),
    );
    this.setTaskDetail(reset.taskId, {
      ...detail,
      data: {
        ...detail.data,
        events: reset.events,
      },
    });
    return true;
  }

  replaceTaskEvents(
    taskId: string,
    events: TaskEvent[],
    requestRevision = this.revision,
    expectedEpoch = this.eventEpochs.get(taskId) ?? 0,
  ): void {
    if ((this.eventEpochs.get(taskId) ?? 0) !== expectedEpoch) return;
    const currentEvents = events.filter(
      (event) => event.event_epoch === expectedEpoch,
    );
    const detail = this.getTaskDetail(taskId);
    const bySeq = new Map(currentEvents.map((event) => [event.seq, event]));
    const revisions = this.eventRevisions.get(taskId);
    for (const event of detail.data.events) {
      if ((revisions?.get(event.seq) ?? 0) > requestRevision) {
        bySeq.set(event.seq, event);
      }
    }
    this.setTaskDetail(taskId, {
      ...detail,
      data: {
        ...detail.data,
        events: Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq),
      },
    });
  }

  async refreshTaskList(
    params: TaskListParams,
    forceAfterInflight = false,
  ): Promise<void> {
    const key = taskListKey(params);
    const existing = this.listRequests.get(key);
    if (existing) {
      if (!forceAfterInflight) return existing;
      await existing;
      return this.refreshTaskList(params);
    }
    const requiresRegistration = this.taskListRegistrations.has(key);
    const startedAt = this.revision;
    this.setTaskList(key, { ...this.getTaskList(key), loading: true, error: null });
    const request = this.api
      .listTasks(params)
      .then((snapshot) => {
        if (requiresRegistration && !this.taskListRegistrations.has(key)) return;
        const next = new Map(snapshot.map((task) => [task.id, task]));
        for (const task of snapshot) {
          const previousEpoch = this.currentTaskEpoch(task.id);
          if ((this.taskRevisions.get(task.id) ?? 0) <= startedAt && this.acceptTaskEpoch(task)) {
            this.tasksById.set(task.id, task);
            this.deletedTasks.delete(task.id);
            if (
              (task.event_epoch ?? 0) > previousEpoch &&
              this.taskRegistrations.has(task.id)
            ) {
              void this.refreshTask(task.id, true);
            }
          }
        }
        for (const [id, changedAt] of this.taskRevisions) {
          if (changedAt <= startedAt) continue;
          const current = this.tasksById.get(id);
          if (!current || this.deletedTasks.has(id) || !taskMatches(current, params)) {
            next.delete(id);
          } else {
            next.set(id, current);
          }
        }
        this.setTaskList(key, {
          data: sortTasks(next.values(), params.limit),
          loading: false,
          error: null,
          loaded: true,
        });
      })
      .catch((error: unknown) => {
        if (requiresRegistration && !this.taskListRegistrations.has(key)) return;
        this.setTaskList(key, {
          ...this.getTaskList(key),
          loading: false,
          error,
          loaded: true,
        });
      })
      .finally(() => {
        this.listRequests.delete(key);
      });
    this.listRequests.set(key, request);
    return request;
  }

  async refreshPending(forceAfterInflight = false): Promise<void> {
    if (this.pendingRequest) {
      if (!forceAfterInflight) return this.pendingRequest;
      await this.pendingRequest;
      return this.refreshPending();
    }
    const startedAt = this.revision;
    this.setPending({ ...this.state.pending, loading: true, error: null });
    const request = Promise.allSettled([
      this.api.listApprovals("pending"),
      this.api.listUserQuestions("pending"),
    ])
      .then(([approvalResult, questionResult]) => {
        const current = this.state.pending.data;
        const approvalMap = new Map(
          (approvalResult.status === "fulfilled"
            ? approvalResult.value
            : current.approvals
          ).map((item) => [item.id, item]),
        );
        const questionMap = new Map(
          (questionResult.status === "fulfilled"
            ? questionResult.value
            : current.questions
          ).map((item) => [item.id, item]),
        );
        for (const [id, changedAt] of this.approvalRevisions) {
          if (changedAt <= startedAt) continue;
          const current = this.state.pending.data.approvals.find((item) => item.id === id);
          if (current?.decision === "pending") approvalMap.set(id, current);
          else approvalMap.delete(id);
        }
        for (const [id, changedAt] of this.questionRevisions) {
          if (changedAt <= startedAt) continue;
          const current = this.state.pending.data.questions.find((item) => item.id === id);
          if (current?.status === "pending") questionMap.set(id, current);
          else questionMap.delete(id);
        }
        this.setPending({
          data: {
            approvals: Array.from(approvalMap.values()).sort(
              (a, b) => b.created_at - a.created_at,
            ),
            questions: Array.from(questionMap.values()).sort(
              (a, b) => a.created_at - b.created_at,
            ),
          },
          loading: false,
          error:
            approvalResult.status === "rejected"
              ? approvalResult.reason
              : questionResult.status === "rejected"
                ? questionResult.reason
                : null,
          loaded: true,
        });
      })
      .finally(() => {
        this.pendingRequest = null;
      });
    this.pendingRequest = request;
    return request;
  }

  async refreshTask(taskId: string, forceAfterInflight = false): Promise<void> {
    const lease = this.taskRegistrations.get(taskId)?.lease;
    if (lease === undefined) return;
    const existing = this.taskRequests.get(taskId);
    if (existing?.lease === lease) {
      if (!forceAfterInflight) return existing.promise;
      await existing.promise;
      if (!this.isCurrentTaskLease(taskId, lease)) return;
      return this.refreshTask(taskId);
    }
    if (existing) this.taskRequests.delete(taskId);
    const startedAt = this.revision;
    const eventEpoch = this.eventEpochs.get(taskId) ?? 0;
    const current = this.getTaskDetail(taskId);
    const cursor = highestContiguousSeq(current.data.events);
    this.setTaskDetail(taskId, { ...current, loading: true, error: null });
    const request = (async () => {
      let task = await this.api.getTask(taskId);
      let snapshotEpoch = task.event_epoch ?? 0;
      let events = await this.api.listEvents(
        taskId,
        snapshotEpoch === eventEpoch ? cursor : 0,
      );
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const confirmed = await this.api.getTask(taskId);
        const confirmedEpoch = confirmed.event_epoch ?? 0;
        task = confirmed;
        if (confirmedEpoch === snapshotEpoch) {
          return { task, events };
        }
        snapshotEpoch = confirmedEpoch;
        events = await this.api.listEvents(taskId, 0);
      }
      if (events.some((event) => event.event_epoch !== snapshotEpoch)) {
        throw new Error("task events changed epoch during refresh");
      }
      throw new Error("task event epoch changed during refresh");
    })()
      .then(({ task, events }) => {
        if (!this.isCurrentTaskLease(taskId, lease)) return;
        const incomingEpoch = task.event_epoch ?? 0;
        const currentEpoch = this.eventEpochs.get(taskId) ?? 0;
        const speculativeReset = this.speculativeEventResets.get(taskId);
        if (
          speculativeReset &&
          incomingEpoch >= speculativeReset.speculativeEventEpoch
        ) {
          this.speculativeEventResets.delete(taskId);
        }
        if (incomingEpoch < currentEpoch) {
          const reset = this.speculativeEventResets.get(taskId);
          const canRejectSpeculation =
            reset?.lease === lease &&
            startedAt >= reset.revision &&
            reset.eventEpoch === incomingEpoch &&
            reset.speculativeEventEpoch === currentEpoch &&
            (this.taskRevisions.get(taskId) ?? 0) <= reset.revision &&
            (this.eventRevisions.get(taskId)?.size ?? 0) === 0;
          if (!canRejectSpeculation) return;
          this.eventEpochs.set(taskId, incomingEpoch);
          this.eventRevisions.delete(taskId);
          this.speculativeEventResets.delete(taskId);
        }
        if (
          !this.isCurrentTaskLease(taskId, lease) ||
          incomingEpoch < (this.eventEpochs.get(taskId) ?? 0) ||
          !this.acceptTaskEpoch(task)
        ) {
          return;
        }
        const latest = this.getTaskDetail(taskId);
        const taskChanged = (this.taskRevisions.get(taskId) ?? 0) > startedAt;
        this.setTaskDetail(taskId, {
          data: {
            task: taskChanged ? latest.data.task : task,
            events: mergeEventsBySeq(latest.data.events, events),
            deleted: taskChanged ? latest.data.deleted : false,
          },
          loading: false,
          error: null,
          loaded: true,
        });
        if (!taskChanged) {
          this.tasksById.set(taskId, task);
          this.deletedTasks.delete(taskId);
        }
      })
      .catch((error: unknown) => {
        if (
          !this.isCurrentTaskLease(taskId, lease) ||
          (this.eventEpochs.get(taskId) ?? 0) !== eventEpoch
        ) {
          return;
        }
        this.setTaskDetail(taskId, {
          ...this.getTaskDetail(taskId),
          loading: false,
          error,
          loaded: true,
        });
      })
      .finally(() => {
        if (this.taskRequests.get(taskId)?.promise === request) {
          this.taskRequests.delete(taskId);
        }
      });
    this.taskRequests.set(taskId, { lease, promise: request });
    return request;
  }

  private isCurrentTaskLease(taskId: string, lease: number): boolean {
    return this.taskRegistrations.get(taskId)?.lease === lease;
  }

  private applyTaskUpdate(task: Task, revision: number): void {
    const previousEpoch = this.currentTaskEpoch(task.id);
    if (!this.acceptTaskEpoch(task)) return;
    const reset = this.speculativeEventResets.get(task.id);
    if (reset && (task.event_epoch ?? 0) >= reset.speculativeEventEpoch) {
      this.speculativeEventResets.delete(task.id);
    }
    this.taskRevisions.set(task.id, revision);
    this.tasksById.set(task.id, task);
    this.deletedTasks.delete(task.id);
    const lists = { ...this.state.taskLists };
    for (const [key, resource] of Object.entries(lists)) {
      const params = this.taskListRegistrations.get(key)?.params;
      if (!params) continue;
      lists[key] = {
        ...resource,
        data: sortTasks(
          upsertById(resource.data, task, taskMatches(task, params), () => 0),
          params.limit,
        ),
      };
    }
    const detail = this.state.taskDetails[task.id];
    this.state = {
      ...this.state,
      taskLists: lists,
      taskDetails: detail
        ? {
            ...this.state.taskDetails,
            [task.id]: {
              ...detail,
              data: { ...detail.data, task, deleted: false },
            },
          }
        : this.state.taskDetails,
    };
    this.emit();
    if (
      (task.event_epoch ?? 0) > previousEpoch &&
      this.taskRegistrations.has(task.id)
    ) {
      void this.refreshTask(task.id, true);
    }
  }

  private currentTaskEpoch(taskId: string): number {
    return (
      this.eventEpochs.get(taskId) ??
      this.state.taskDetails[taskId]?.data.task?.event_epoch ??
      this.tasksById.get(taskId)?.event_epoch ??
      0
    );
  }

  private acceptTaskEpoch(task: Task): boolean {
    const incoming = task.event_epoch ?? 0;
    const current = this.currentTaskEpoch(task.id);
    if (incoming < current) return false;
    if (incoming === current) {
      if (!this.eventEpochs.has(task.id)) this.eventEpochs.set(task.id, incoming);
      return true;
    }
    this.eventEpochs.set(task.id, incoming);
    this.eventRevisions.delete(task.id);
    this.eventRecoveryRequests.delete(task.id);
    const detail = this.state.taskDetails[task.id];
    if (detail) {
      this.state = {
        ...this.state,
        taskDetails: {
          ...this.state.taskDetails,
          [task.id]: {
            ...detail,
            data: { ...detail.data, events: [] },
          },
        },
      };
    }
    return true;
  }

  private applyTaskDeletion(taskId: string, revision: number): void {
    this.taskRevisions.set(taskId, revision);
    this.tasksById.delete(taskId);
    this.deletedTasks.add(taskId);
    const lists = Object.fromEntries(
      Object.entries(this.state.taskLists).map(([key, resource]) => [
        key,
        { ...resource, data: resource.data.filter((task) => task.id !== taskId) },
      ]),
    );
    const detail = this.state.taskDetails[taskId];
    this.state = {
      ...this.state,
      taskLists: lists,
      taskDetails: detail
        ? {
            ...this.state.taskDetails,
            [taskId]: {
              ...detail,
              data: { ...detail.data, task: null, deleted: true },
            },
          }
        : this.state.taskDetails,
    };
    this.emit();
  }

  private applyTaskEvent(event: TaskEvent, revision: number): void {
    let detail = this.state.taskDetails[event.task_id];
    if (!detail || !this.taskRegistrations.has(event.task_id)) return;
    const currentEpoch = this.eventEpochs.get(event.task_id) ?? 0;
    if (event.event_epoch < currentEpoch) return;
    if (event.event_epoch > currentEpoch) {
      this.eventEpochs.set(event.task_id, event.event_epoch);
      this.eventRevisions.delete(event.task_id);
      this.eventRecoveryRequests.delete(event.task_id);
      detail = {
        ...detail,
        data: { ...detail.data, events: [] },
      };
      this.setTaskDetail(event.task_id, detail);
    }
    const reset = this.speculativeEventResets.get(event.task_id);
    if (reset && event.event_epoch >= reset.speculativeEventEpoch) {
      this.speculativeEventResets.delete(event.task_id);
    }
    let revisions = this.eventRevisions.get(event.task_id);
    if (!revisions) {
      revisions = new Map();
      this.eventRevisions.set(event.task_id, revisions);
    }
    if (revisions.has(event.seq)) return;
    revisions.set(event.seq, revision);
    const cursor = highestContiguousSeq(detail.data.events);
    const nextEvents = mergeEventsBySeq(detail.data.events, [event]);
    this.setTaskDetail(event.task_id, {
      ...detail,
      data: { ...detail.data, events: nextEvents },
    });
    if (hasSequenceGap(cursor, event.seq)) {
      const lease = this.taskRegistrations.get(event.task_id)?.lease;
      if (lease !== undefined) {
        void this.recoverEvents(event.task_id, cursor, lease);
      }
    }
  }

  private async recoverEvents(
    taskId: string,
    cursor: number,
    lease: number,
    attempt = 0,
  ): Promise<void> {
    const existing = this.eventRecoveryRequests.get(taskId);
    if (existing?.lease === lease) return existing.promise;
    if (existing) this.eventRecoveryRequests.delete(taskId);
    if (!this.isCurrentTaskLease(taskId, lease)) return;
    const epoch = this.eventEpochs.get(taskId) ?? 0;
    const request = this.api
      .listEvents(taskId, cursor)
      .then((events) => {
        if (
          !this.isCurrentTaskLease(taskId, lease) ||
          (this.eventEpochs.get(taskId) ?? 0) !== epoch
        ) {
          return;
        }
        const detail = this.getTaskDetail(taskId);
        const currentEvents = events.filter(
          (event) => event.event_epoch === epoch,
        );
        this.setTaskDetail(taskId, {
          ...detail,
          error: null,
          data: {
            ...detail.data,
            events: mergeEventsBySeq(detail.data.events, currentEvents),
          },
        });
      })
      .catch((error: unknown) => {
        if (
          attempt >= 2 &&
          this.isCurrentTaskLease(taskId, lease) &&
          (this.eventEpochs.get(taskId) ?? 0) === epoch
        ) {
          this.setTaskDetail(taskId, {
            ...this.getTaskDetail(taskId),
            error,
          });
        }
      })
      .finally(() => {
        if (this.eventRecoveryRequests.get(taskId)?.promise === request) {
          this.eventRecoveryRequests.delete(taskId);
        }
        const detail = this.state.taskDetails[taskId];
        if (
          !detail ||
          !this.isCurrentTaskLease(taskId, lease) ||
          (this.eventEpochs.get(taskId) ?? 0) !== epoch ||
          attempt >= 2
        ) {
          return;
        }
        const contiguous = highestContiguousSeq(detail.data.events);
        const highest = detail.data.events.at(-1)?.seq ?? 0;
        if (highest > contiguous) {
          globalThis.setTimeout(() => {
            if (this.isCurrentTaskLease(taskId, lease)) {
              void this.recoverEvents(taskId, contiguous, lease, attempt + 1);
            }
          }, 250 * 2 ** attempt);
        }
      });
    this.eventRecoveryRequests.set(taskId, { lease, promise: request });
    return request;
  }

  private applyApprovalUpdate(approval: Approval, revision: number): void {
    this.approvalRevisions.set(approval.id, revision);
    this.setPending({
      ...this.state.pending,
      data: {
        ...this.state.pending.data,
        approvals: upsertById(
          this.state.pending.data.approvals,
          approval,
          approval.decision === "pending",
          (a, b) => b.created_at - a.created_at,
        ),
      },
    });
  }

  private applyQuestionUpdate(question: UserQuestion, revision: number): void {
    this.questionRevisions.set(question.id, revision);
    this.setPending({
      ...this.state.pending,
      data: {
        ...this.state.pending.data,
        questions: upsertById(
          this.state.pending.data.questions,
          question,
          question.status === "pending",
          (a, b) => a.created_at - b.created_at,
        ),
      },
    });
  }

  private setTaskList(key: string, resource: Resource<Task[]>): void {
    this.state = {
      ...this.state,
      taskLists: { ...this.state.taskLists, [key]: resource },
    };
    this.emit();
  }

  private setPending(resource: LiveResourceState["pending"]): void {
    this.state = { ...this.state, pending: resource };
    this.emit();
  }

  private setTaskDetail(taskId: string, resource: TaskDetailResource): void {
    this.state = {
      ...this.state,
      taskDetails: { ...this.state.taskDetails, [taskId]: resource },
    };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const liveResources = new LiveResourceStore({
  listTasks,
  getTask,
  listEvents,
  listApprovals,
  listUserQuestions,
});
