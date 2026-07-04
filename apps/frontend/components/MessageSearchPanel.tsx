"use client";

import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import {
  getStoredAccessToken,
  searchMessages,
  type ChatType,
  type OfficeChatDirectoryUser,
  type OfficeChatMessageSearchResult
} from "../lib/api";
import type { Dictionary, Locale } from "../lib/i18n";
import { UserAvatar } from "./UserAvatar";

type CurrentChat = { chatType: ChatType; chatId: string; title: string };

type MessageSearchPanelProps = {
  currentChat: CurrentChat | null;
  dictionary: Dictionary;
  locale: Locale;
  onClose: () => void;
  onJump: (result: OfficeChatMessageSearchResult) => Promise<void>;
  users: OfficeChatDirectoryUser[];
};

function highlightedText(text: string, query: string) {
  const terms = Array.from(new Set(query.trim().split(/\s+/).filter((term) => term.length >= 2)));
  if (!terms.length) return text;
  const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const expression = new RegExp(`(${escaped.join("|")})`, "giu");
  const foldedTerms = new Set(terms.map((term) => term.toLocaleLowerCase()));
  return text.split(expression).map((part, index) =>
    foldedTerms.has(part.toLocaleLowerCase()) ? <mark key={`${part}-${index}`}>{part}</mark> : <Fragment key={`${part}-${index}`}>{part}</Fragment>
  );
}

export function MessageSearchPanel({
  currentChat,
  dictionary,
  locale,
  onClose,
  onJump,
  users
}: MessageSearchPanelProps) {
  const search = dictionary.messageSearch;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"all" | "current">("all");
  const [senderId, setSenderId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [hasAttachment, setHasAttachment] = useState(false);
  const [items, setItems] = useState<OfficeChatMessageSearchResult[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isJumping, setIsJumping] = useState(false);
  const [error, setError] = useState("");

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }),
    [locale]
  );

  function buildFilters(cursor?: string) {
    const currentScope = scope === "current" ? currentChat : null;
    return {
      q: query.trim(),
      chat_type: currentScope?.chatType,
      chat_id: currentScope?.chatId,
      sender_id: senderId || undefined,
      date_from: dateFrom ? new Date(`${dateFrom}T00:00:00`).toISOString() : undefined,
      date_to: dateTo ? new Date(`${dateTo}T23:59:59.999`).toISOString() : undefined,
      has_attachment: hasAttachment || undefined,
      cursor
    };
  }

  useEffect(() => {
    inputRef.current?.focus();
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (scope === "current" && !currentChat) setScope("all");
  }, [currentChat, scope]);

  useEffect(() => {
    const normalized = query.trim();
    abortRef.current?.abort();
    if (normalized.length < 2) {
      setItems([]);
      setNextCursor(null);
      setError("");
      setIsLoading(false);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    const timer = window.setTimeout(async () => {
      const token = getStoredAccessToken();
      if (!token) return;
      setIsLoading(true);
      setError("");
      try {
        const page = await searchMessages(token, buildFilters(), controller.signal);
        setItems(page.items);
        setNextCursor(page.next_cursor);
        setSelectedIndex(0);
      } catch (caughtError) {
        if (caughtError instanceof DOMException && caughtError.name === "AbortError") return;
        setError(caughtError instanceof Error ? caughtError.message : search.loadError);
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    }, 350);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [currentChat?.chatId, dateFrom, dateTo, hasAttachment, query, scope, search.loadError, senderId]);

  async function loadMore() {
    if (!nextCursor || isLoading) return;
    const token = getStoredAccessToken();
    if (!token) return;
    setIsLoading(true);
    setError("");
    try {
      const page = await searchMessages(token, buildFilters(nextCursor));
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.next_cursor);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : search.loadError);
    } finally {
      setIsLoading(false);
    }
  }

  async function jumpTo(result: OfficeChatMessageSearchResult) {
    if (isJumping) return;
    setIsJumping(true);
    setError("");
    try {
      await onJump(result);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : search.jumpError);
      setIsJumping(false);
    }
  }

  function handleKeyboard(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown" && items.length) {
      event.preventDefault();
      setSelectedIndex((current) => Math.min(items.length - 1, current + 1));
    } else if (event.key === "ArrowUp" && items.length) {
      event.preventDefault();
      setSelectedIndex((current) => Math.max(0, current - 1));
    } else if (event.key === "Enter" && items[selectedIndex]) {
      event.preventDefault();
      void jumpTo(items[selectedIndex]);
    }
  }

  return (
    <div className="message-search-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()} role="presentation">
      <section
        aria-label={search.title}
        aria-modal="true"
        className="message-search-panel"
        onKeyDown={handleKeyboard}
        role="dialog"
      >
        <header className="message-search-header">
          <div><p className="eyebrow">OfficeChat</p><h2>{search.title}</h2></div>
          <button aria-label={dictionary.appShell.close} className="icon-button" onClick={onClose} type="button">×</button>
        </header>
        <input
          aria-label={search.inputLabel}
          className="field-input message-search-input"
          maxLength={200}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={search.placeholder}
          ref={inputRef}
          type="search"
          value={query}
        />
        <div className="message-search-scope" role="group" aria-label={search.scope}>
          <button className={scope === "all" ? "is-active" : ""} onClick={() => setScope("all")} type="button">{search.allChats}</button>
          <button
            className={scope === "current" ? "is-active" : ""}
            disabled={!currentChat}
            onClick={() => setScope("current")}
            title={!currentChat ? search.currentUnavailable : currentChat.title}
            type="button"
          >{search.currentChat}</button>
        </div>
        {scope === "current" && currentChat ? <p className="message-search-current">{currentChat.title}</p> : null}
        <div className="message-search-filters">
          <label><span>{search.sender}</span><select className="field-input" onChange={(event) => setSenderId(event.target.value)} value={senderId}><option value="">{search.anySender}</option>{users.filter((user) => user.is_active).map((user) => <option key={user.id} value={user.id}>{user.display_name} (@{user.username})</option>)}</select></label>
          <label><span>{search.dateFrom}</span><input className="field-input" onChange={(event) => setDateFrom(event.target.value)} type="date" value={dateFrom} /></label>
          <label><span>{search.dateTo}</span><input className="field-input" onChange={(event) => setDateTo(event.target.value)} type="date" value={dateTo} /></label>
          <label className="checkbox-field message-search-attachment"><input checked={hasAttachment} onChange={(event) => setHasAttachment(event.target.checked)} type="checkbox" /><span>{search.withAttachments}</span></label>
        </div>
        <p aria-live="polite" className="visually-hidden">{isLoading ? search.loading : search.resultCount.replace("{count}", String(items.length))}</p>
        {error ? <p className="form-error">{error}</p> : null}
        <div aria-label={search.results} className="message-search-results" role="listbox">
          {items.map((result, index) => (
            <button
              aria-label={`${search.jump}: ${result.chat_title}, ${result.sender.display_name}`}
              aria-selected={selectedIndex === index}
              className={`message-search-result ${selectedIndex === index ? "is-selected" : ""}`}
              key={`${result.chat_type}:${result.message_id}`}
              onClick={() => void jumpTo(result)}
              onMouseEnter={() => setSelectedIndex(index)}
              role="option"
              type="button"
            >
              <UserAvatar size={32} user={result.sender} />
              <span className="message-search-result-content">
                <span className="message-search-result-meta"><strong>{result.chat_title}</strong><span>{search.chatTypes[result.chat_type]}</span><span>{result.sender.display_name}</span><time>{dateFormatter.format(new Date(result.created_at))}</time></span>
                <span className="message-search-excerpt">{highlightedText(result.excerpt, query)}</span>
                {result.matched_attachment_names.length ? <span className="message-search-files">{search.attachments}: {result.matched_attachment_names.join(", ")}</span> : null}
                {result.is_edited ? <span className="message-search-edited">{search.edited}</span> : null}
              </span>
            </button>
          ))}
          {!isLoading && query.trim().length >= 2 && !items.length && !error ? <p className="message-search-empty">{search.empty}</p> : null}
          {query.trim().length < 2 ? <p className="message-search-empty">{search.minimumQuery}</p> : null}
        </div>
        {nextCursor ? <button className="secondary-link message-search-more" disabled={isLoading} onClick={() => void loadMore()} type="button">{search.loadMore}</button> : null}
      </section>
    </div>
  );
}
