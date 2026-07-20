type MessageWithPrivateDeleteData = {
  id: string;
  attachments: unknown[];
  body: string;
  is_deleted: boolean;
  mentions?: unknown[];
  reactions?: unknown[];
  reply_to?: unknown;
  reply_to_message_id?: string | null;
};

export function sanitizeDeletedMessage<T extends MessageWithPrivateDeleteData>(message: T): T {
  if (!message.is_deleted) return message;

  const tombstone: MessageWithPrivateDeleteData = {
    ...message,
    attachments: [],
    body: ""
  };
  if ("mentions" in message) tombstone.mentions = [];
  if ("reactions" in message) tombstone.reactions = [];
  if ("reply_to" in message) tombstone.reply_to = null;
  if ("reply_to_message_id" in message) tombstone.reply_to_message_id = null;
  return tombstone as T;
}

export function applyDeletedMessageEvent<T extends MessageWithPrivateDeleteData>(
  messages: T[],
  deletedMessage: T,
): T[] {
  const tombstone = sanitizeDeletedMessage(deletedMessage);
  return messages.map((message) => (message.id === tombstone.id ? tombstone : message));
}
