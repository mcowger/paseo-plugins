import { defineTool } from "./pi-sdk.js";
import type { PiSessionManagerLike, PiToolDefinition } from "../shared/pi-sdk-types.js";

export const PI_TODO_TOOL_NAME = "todo";

const TODO_PARAMETERS = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["list", "add", "toggle", "clear"],
    },
    text: {
      type: "string",
      description: "Todo text (for add)",
    },
    id: {
      type: "number",
      description: "Todo ID (for toggle)",
    },
  },
  required: ["action"],
  additionalProperties: false,
} as never;

type TodoAction = "list" | "add" | "toggle" | "clear";

interface PiTodo {
  id: number;
  text: string;
  done: boolean;
}

interface TodoDetails {
  action: TodoAction;
  todos: PiTodo[];
  nextId: number;
  error?: string;
}

interface TodoState {
  todos: PiTodo[];
  nextId: number;
}

export interface PiLoadedExtensions {
  extensions: ReadonlyArray<{ tools: ReadonlyMap<string, unknown> }>;
}

export function hasPiTodoExtensionTool(result: PiLoadedExtensions): boolean {
  return result.extensions.some((extension) => extension.tools.has(PI_TODO_TOOL_NAME));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTodoDetails(value: unknown): TodoState | null {
  if (!isRecord(value) || !Array.isArray(value.todos)) {
    return null;
  }

  const todos = value.todos.flatMap((todo): PiTodo[] => {
    if (!isRecord(todo)) return [];
    const id = todo.id;
    const text = todo.text;
    const done = todo.done;
    if (
      typeof id !== "number" ||
      !Number.isInteger(id) ||
      id < 1 ||
      typeof text !== "string" ||
      typeof done !== "boolean"
    ) {
      return [];
    }
    return [{ id, text, done }];
  });
  const highestId = todos.reduce((highest, todo) => Math.max(highest, todo.id), 0);
  const nextId =
    typeof value.nextId === "number" && Number.isInteger(value.nextId) && value.nextId > highestId
      ? value.nextId
      : highestId + 1;
  return { todos, nextId };
}

function reconstructState(sessionManager: PiSessionManagerLike): TodoState {
  let state: TodoState = { todos: [], nextId: 1 };
  for (const entry of sessionManager.getBranch()) {
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) {
      continue;
    }
    const message = entry.message;
    if (message.role !== "toolResult" || message.toolName !== PI_TODO_TOOL_NAME) {
      continue;
    }
    const nextState = readTodoDetails(message.details);
    if (nextState) {
      state = nextState;
    }
  }
  return state;
}

function result(
  text: string,
  action: TodoAction,
  state: TodoState,
  error?: string,
): { content: [{ type: "text"; text: string }]; details: TodoDetails } {
  return {
    content: [{ type: "text", text }],
    details: {
      action,
      todos: state.todos.map((todo) => ({ ...todo })),
      nextId: state.nextId,
      ...(error ? { error } : {}),
    },
  };
}

function createStateTracker(sessionManager: PiSessionManagerLike): {
  current(): TodoState;
  update(state: TodoState): void;
} {
  let state = reconstructState(sessionManager);
  let leafId = sessionManager.getLeafId();
  return {
    current() {
      const currentLeafId = sessionManager.getLeafId();
      if (currentLeafId !== leafId) {
        state = reconstructState(sessionManager);
        leafId = currentLeafId;
      }
      return state;
    },
    update(nextState) {
      state = nextState;
    },
  };
}

export function createPiTodoTool(sessionManager: PiSessionManagerLike): PiToolDefinition {
  const stateTracker = createStateTracker(sessionManager);
  let executionQueue: Promise<unknown> = Promise.resolve();

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = executionQueue.then(operation, operation);
    executionQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const executeTodo = async (rawParams: unknown) => {
    const params = (rawParams ?? {}) as Record<string, unknown>;
    const action = params.action;
    const state = stateTracker.current();

    if (action === "list") {
      return result(
        state.todos.length
          ? state.todos
              .map((todo) => `[${todo.done ? "x" : " "}] #${todo.id}: ${todo.text}`)
              .join("\n")
          : "No todos",
        action,
        state,
      );
    }

    if (action === "add") {
      const text = typeof params.text === "string" ? params.text.trim() : "";
      if (!text) {
        return result("Error: text required for add", action, state, "text required");
      }
      const todo = { id: state.nextId, text, done: false };
      const nextState = {
        todos: [...state.todos, todo],
        nextId: state.nextId + 1,
      };
      stateTracker.update(nextState);
      return result(`Added todo #${todo.id}: ${todo.text}`, action, nextState);
    }

    if (action === "toggle") {
      const id = params.id;
      if (typeof id !== "number" || !Number.isInteger(id)) {
        return result("Error: id required for toggle", action, state, "id required");
      }
      const todo = state.todos.find((candidate) => candidate.id === id);
      if (!todo) {
        const error = `#${id} not found`;
        return result(`Todo #${id} not found`, action, state, error);
      }
      const nextState = {
        todos: state.todos.map((candidate) =>
          candidate.id === id ? { ...candidate, done: !candidate.done } : candidate,
        ),
        nextId: state.nextId,
      };
      stateTracker.update(nextState);
      const nextTodo = nextState.todos.find((candidate) => candidate.id === id)!;
      return result(
        `Todo #${nextTodo.id} ${nextTodo.done ? "completed" : "uncompleted"}`,
        action,
        nextState,
      );
    }

    if (action === "clear") {
      const nextState = { todos: [], nextId: 1 };
      stateTracker.update(nextState);
      return result(`Cleared ${state.todos.length} todos`, action, nextState);
    }

    const error = `unknown action: ${String(action)}`;
    return result(`Unknown action: ${String(action)}`, "list", state, error);
  };

  return defineTool({
    name: PI_TODO_TOOL_NAME,
    label: "Todo",
    description: "Manage a todo list. Actions: list, add (text), toggle (id), clear",
    parameters: TODO_PARAMETERS,
    execute(_toolCallId, rawParams) {
      return enqueue(() => executeTodo(rawParams));
    },
  }) as unknown as PiToolDefinition;
}
