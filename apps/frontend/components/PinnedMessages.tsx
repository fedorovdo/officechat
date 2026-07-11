import type { FormEvent } from "react";

import type { OfficeChatPinnedMessage } from "../lib/api";
import type { Dictionary, Locale } from "../lib/i18n";

type PinnedMessagesProps = {
  canPin: boolean;
  dictionary: Dictionary;
  isOpen: boolean;
  locale: Locale;
  onClose: () => void;
  onJump: (messageId: string) => void;
  onOpen: () => void;
  onUpdateNote: (pinId: string, note: string) => void | Promise<void>;
  onUnpin: (pinId: string) => void | Promise<void>;
  pins: OfficeChatPinnedMessage[];
};

function pinPreview(pin: OfficeChatPinnedMessage, dictionary: Dictionary) {
  if (pin.message.is_deleted) return dictionary.messages.deletedMessage;
  if (pin.message.is_archived) return dictionary.pins.archivedMessage;
  if (pin.message.body_preview) return pin.message.body_preview;
  if (pin.message.attachment_count > 0) {
    return dictionary.messages.replyAttachments.replace("{count}", String(pin.message.attachment_count));
  }
  return dictionary.messages.replyPreviewUnavailable;
}

export function PinnedMessages({
  canPin,
  dictionary,
  isOpen,
  locale,
  onClose,
  onJump,
  onOpen,
  onUpdateNote,
  onUnpin,
  pins
}: PinnedMessagesProps) {
  if (!pins.length) return null;
  const dateFormatter = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const newestPin = pins[0];
  const moreCount = pins.length - 1;

  function handleNoteSubmit(event: FormEvent<HTMLFormElement>, pin: OfficeChatPinnedMessage) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    void onUpdateNote(pin.id, String(formData.get("note") ?? ""));
  }

  return (
    <section className="pinned-strip" aria-label={dictionary.pins.title}>
      <button className="pinned-strip-main" onClick={() => onJump(newestPin.message_id)} type="button">
        <span className="pin-icon" aria-hidden="true">{dictionary.pins.pinIcon}</span>
        <span>
          <strong>{dictionary.pins.pinned}</strong>
          <span>{pinPreview(newestPin, dictionary)}</span>
        </span>
      </button>
      <button className="table-action" onClick={onOpen} type="button">
        {moreCount > 0 ? dictionary.pins.more.replace("{count}", String(moreCount)) : dictionary.pins.openList}
      </button>

      {isOpen ? (
        <div className="pinned-list-panel">
          <div className="dashboard-header">
            <h3 className="compact-title">{dictionary.pins.title}</h3>
            <button className="table-action" onClick={onClose} type="button">{dictionary.appShell.close}</button>
          </div>
          <div className="pinned-list">
            {pins.map((pin) => (
              <article className="pinned-list-item" key={pin.id}>
                <div>
                  <strong>{pin.message.sender.display_name}</strong>
                  <p>{pinPreview(pin, dictionary)}</p>
                  {pin.note ? <p className="pin-note">{pin.note}</p> : null}
                  <small>
                    {dictionary.pins.pinnedBy
                      .replace("{name}", pin.pinned_by.display_name)
                      .replace("{time}", dateFormatter.format(new Date(pin.pinned_at)))}
                  </small>
                </div>
                <div className="pinned-list-actions">
                  <button className="table-action" onClick={() => onJump(pin.message_id)} type="button">
                    {dictionary.pins.jump}
                  </button>
                  {canPin ? (
                    <>
                      <form className="pin-note-form" onSubmit={(event) => handleNoteSubmit(event, pin)}>
                        <input
                          className="field-input"
                          defaultValue={pin.note ?? ""}
                          maxLength={300}
                          name="note"
                          placeholder={dictionary.pins.notePlaceholder}
                        />
                        <button className="table-action" type="submit">{dictionary.pins.saveNote}</button>
                      </form>
                      <button className="table-action" onClick={() => void onUnpin(pin.id)} type="button">
                        {dictionary.pins.unpin}
                      </button>
                    </>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
