const INITIAL_MESSAGE_PAGE_SIZE = 50;
const INITIAL_MESSAGE_MAX_PAGES = 8;

type MessageWithId = {
  id: string;
};

type InitialMessageWindow<T extends MessageWithId> = {
  messages: T[];
  targetFound: boolean;
};

export async function loadInitialMessageWindow<T extends MessageWithId>(
  loadPage: (limit: number, before?: string) => Promise<T[]>,
  targetMessageId: string | null | undefined,
  signal?: AbortSignal
): Promise<InitialMessageWindow<T>> {
  signal?.throwIfAborted();
  const latestPage = await loadPage(INITIAL_MESSAGE_PAGE_SIZE);
  signal?.throwIfAborted();
  if (!targetMessageId) {
    return { messages: latestPage, targetFound: false };
  }
  if (latestPage.some((message) => message.id === targetMessageId)) {
    return { messages: latestPage, targetFound: true };
  }

  let currentPage = latestPage;
  let collected = latestPage;
  const loadedCursors = new Set<string>();
  for (
    let pageNumber = 1;
    pageNumber < INITIAL_MESSAGE_MAX_PAGES && currentPage.length === INITIAL_MESSAGE_PAGE_SIZE;
    pageNumber += 1
  ) {
    const before = currentPage[0]?.id;
    if (!before || loadedCursors.has(before)) break;
    loadedCursors.add(before);
    signal?.throwIfAborted();
    currentPage = await loadPage(INITIAL_MESSAGE_PAGE_SIZE, before);
    signal?.throwIfAborted();
    if (currentPage.length === 0) break;
    const knownIds = new Set(collected.map((message) => message.id));
    collected = [
      ...currentPage.filter((message) => !knownIds.has(message.id)),
      ...collected
    ];
    if (currentPage.some((message) => message.id === targetMessageId)) {
      return { messages: collected, targetFound: true };
    }
  }

  // Keep the normal latest page as the safe fallback. Rendering an arbitrary
  // older partial window would make a failed lookup look like a jump to history.
  return { messages: latestPage, targetFound: false };
}

export function mergeMessageWindow<T extends MessageWithId>(current: T[], latest: T[]) {
  if (current.length === 0) return latest;
  const latestById = new Map(latest.map((message) => [message.id, message]));
  const currentIds = new Set(current.map((message) => message.id));
  return [
    ...current.map((message) => latestById.get(message.id) ?? message),
    ...latest.filter((message) => !currentIds.has(message.id))
  ];
}
