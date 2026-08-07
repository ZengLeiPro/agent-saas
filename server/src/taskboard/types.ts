import type {
  TaskBoard,
  TaskBoardComment,
  TaskBoardCommentCreateInput,
  TaskBoardCreateInput,
  TaskBoardPatchInput,
  TaskBoardPriority,
  TaskBoardStatus,
  TaskBoardTask,
  TaskBoardTaskCreateInput,
  TaskBoardTaskMoveInput,
  TaskBoardTaskPatchInput,
} from '../../../shared/src/types/taskboard.js';

export interface TaskboardIdentity {
  tenantId: string;
  ownerUserId: string;
  username: string;
}

export interface TaskboardTaskListFilter {
  includeArchived?: boolean;
  search?: string;
  statuses?: TaskBoardStatus[];
  priorities?: TaskBoardPriority[];
}

export interface TaskboardExpectedVersionInput {
  expectedVersion: number;
}

export interface TaskboardService {
  listBoards(identity: TaskboardIdentity, includeArchived?: boolean): Promise<TaskBoard[]>;
  createBoard(identity: TaskboardIdentity, input: TaskBoardCreateInput): Promise<TaskBoard>;
  updateBoard(identity: TaskboardIdentity, boardId: string, input: TaskBoardPatchInput): Promise<TaskBoard>;
  archiveBoard(identity: TaskboardIdentity, boardId: string, input: TaskboardExpectedVersionInput): Promise<TaskBoard>;
  restoreBoard(identity: TaskboardIdentity, boardId: string, input: TaskboardExpectedVersionInput): Promise<TaskBoard>;

  listTasks(identity: TaskboardIdentity, boardId: string, filter?: TaskboardTaskListFilter): Promise<TaskBoardTask[]>;
  createTask(identity: TaskboardIdentity, boardId: string, input: TaskBoardTaskCreateInput): Promise<TaskBoardTask>;
  getTask(identity: TaskboardIdentity, taskId: string): Promise<TaskBoardTask>;
  updateTask(identity: TaskboardIdentity, taskId: string, input: TaskBoardTaskPatchInput): Promise<TaskBoardTask>;
  moveTask(identity: TaskboardIdentity, taskId: string, input: TaskBoardTaskMoveInput): Promise<TaskBoardTask>;
  archiveTask(identity: TaskboardIdentity, taskId: string, input: TaskboardExpectedVersionInput): Promise<TaskBoardTask>;
  restoreTask(identity: TaskboardIdentity, taskId: string, input: TaskboardExpectedVersionInput): Promise<TaskBoardTask>;

  listComments(identity: TaskboardIdentity, taskId: string): Promise<TaskBoardComment[]>;
  createComment(identity: TaskboardIdentity, taskId: string, input: TaskBoardCommentCreateInput): Promise<TaskBoardComment>;
}

export class TaskboardNotFoundError extends Error {
  readonly code = 'TASKBOARD_NOT_FOUND';

  constructor(message = 'Resource not found') {
    super(message);
  }
}

export class TaskboardValidationError extends Error {
  readonly code: string;

  constructor(message: string, code = 'TASKBOARD_VALIDATION_ERROR') {
    super(message);
    this.code = code;
  }
}

export class TaskboardConflictError<T extends TaskBoard | TaskBoardTask> extends Error {
  readonly code = 'TASKBOARD_VERSION_CONFLICT';
  readonly current: T;

  constructor(current: T) {
    super('Version conflict');
    this.current = current;
  }
}
