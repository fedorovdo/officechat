"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import type { Dictionary } from "../lib/i18n";

const RECENT_EMOJI_KEY = "officechat.emoji.recent";
const RECENT_EMOJI_LIMIT = 20;

type EmojiEntry = {
  emoji: string;
  keywords: string;
};

type EmojiCategory = {
  id: keyof Dictionary["appShell"]["emoji"]["categories"];
  entries: EmojiEntry[];
};

const emojiCategories: EmojiCategory[] = [
  {
    id: "smileys",
    entries: [
      { emoji: "🙂", keywords: "smile happy улыбка радость" },
      { emoji: "😊", keywords: "smile happy blush улыбка радость" },
      { emoji: "😂", keywords: "laugh joy смех смешно" },
      { emoji: "🤔", keywords: "think thinking думаю вопрос" },
      { emoji: "😎", keywords: "cool sunglasses круто очки" },
      { emoji: "😕", keywords: "confused unsure непонятно сомнение" },
      { emoji: "😢", keywords: "sad cry грусть слезы" },
      { emoji: "😡", keywords: "angry mad злость ошибка" }
    ]
  },
  {
    id: "gestures",
    entries: [
      { emoji: "👍", keywords: "yes good like да хорошо согласен" },
      { emoji: "👎", keywords: "no bad dislike нет плохо" },
      { emoji: "👌", keywords: "ok okay готово отлично" },
      { emoji: "👏", keywords: "clap thanks applause спасибо отлично" },
      { emoji: "🙏", keywords: "please thanks request пожалуйста спасибо" },
      { emoji: "🤝", keywords: "handshake agreement deal договорились встреча" }
    ]
  },
  {
    id: "people",
    entries: [
      { emoji: "👤", keywords: "user person пользователь профиль" },
      { emoji: "👥", keywords: "users team group команда группа" },
      { emoji: "🙋", keywords: "raise hand question рука вопрос" },
      { emoji: "👨‍💻", keywords: "developer engineer man разработчик инженер" },
      { emoji: "👩‍💻", keywords: "developer engineer woman разработчик инженер" }
    ]
  },
  {
    id: "hearts",
    entries: [
      { emoji: "❤️", keywords: "heart love red сердце спасибо" },
      { emoji: "💚", keywords: "heart green сердце зеленый" },
      { emoji: "💙", keywords: "heart blue сердце синий" },
      { emoji: "💜", keywords: "heart purple сердце фиолетовый" }
    ]
  },
  {
    id: "objects",
    entries: [
      { emoji: "🛠️", keywords: "tools maintenance инструменты работы" },
      { emoji: "🔧", keywords: "wrench fix repair ключ ремонт" },
      { emoji: "⚙️", keywords: "settings gear настройки конфигурация" },
      { emoji: "💻", keywords: "laptop computer ноутбук компьютер" },
      { emoji: "🖥️", keywords: "monitor desktop монитор сервер" },
      { emoji: "🗄️", keywords: "database storage server база хранилище" },
      { emoji: "🌐", keywords: "network web globe сеть интернет" },
      { emoji: "📡", keywords: "signal antenna monitoring сигнал антенна" },
      { emoji: "🔌", keywords: "plug power connection питание подключение" },
      { emoji: "🔒", keywords: "lock security закрыто безопасность" },
      { emoji: "🔑", keywords: "key access token ключ доступ" },
      { emoji: "📎", keywords: "attachment clip вложение файл" },
      { emoji: "📁", keywords: "folder files папка файлы" },
      { emoji: "📌", keywords: "pin important закрепить важно" },
      { emoji: "📢", keywords: "announcement alert объявление оповещение" },
      { emoji: "🔔", keywords: "notification bell уведомление звонок" },
      { emoji: "🕒", keywords: "time clock время часы" },
      { emoji: "📅", keywords: "calendar date календарь дата" },
      { emoji: "📊", keywords: "chart metrics график метрики" }
    ]
  },
  {
    id: "symbols",
    entries: [
      { emoji: "✅", keywords: "done success check готово успех" },
      { emoji: "❌", keywords: "failed error cross ошибка отказ" },
      { emoji: "⚠️", keywords: "warning attention предупреждение внимание" },
      { emoji: "🚨", keywords: "alert incident high тревога инцидент" },
      { emoji: "🔥", keywords: "fire disaster hot пожар авария" },
      { emoji: "ℹ️", keywords: "information info информация справка" }
    ]
  }
];

type EmojiPickerProps = {
  contextKey: string;
  dictionary: Dictionary;
  disabled?: boolean;
  onAfterInsert?: (textarea: HTMLTextAreaElement) => void;
  onChange: (value: string) => void;
  resetKey: number;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
};

export function EmojiPicker({
  contextKey,
  dictionary,
  disabled = false,
  onAfterInsert,
  onChange,
  resetKey,
  textareaRef,
  value
}: EmojiPickerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const selectionRef = useRef({ start: value.length, end: value.length });
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [recentEmojis, setRecentEmojis] = useState<string[]>([]);

  useEffect(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem(RECENT_EMOJI_KEY) ?? "[]");
      if (Array.isArray(stored)) {
        setRecentEmojis(stored.filter((item): item is string => typeof item === "string").slice(0, RECENT_EMOJI_LIMIT));
      }
    } catch {
      setRecentEmojis([]);
    }
  }, []);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const captureSelection = () => {
      selectionRef.current = { start: textarea.selectionStart, end: textarea.selectionEnd };
    };
    textarea.addEventListener("click", captureSelection);
    textarea.addEventListener("input", captureSelection);
    textarea.addEventListener("keyup", captureSelection);
    textarea.addEventListener("select", captureSelection);
    return () => {
      textarea.removeEventListener("click", captureSelection);
      textarea.removeEventListener("input", captureSelection);
      textarea.removeEventListener("keyup", captureSelection);
      textarea.removeEventListener("select", captureSelection);
    };
  }, [textareaRef]);

  useEffect(() => {
    setIsOpen(false);
    setQuery("");
  }, [contextKey, resetKey]);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      const composer = rootRef.current?.closest("form");
      if (!rootRef.current?.contains(target) && !composer?.contains(target)) setIsOpen(false);
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setIsOpen(false);
        textareaRef.current?.focus({ preventScroll: true });
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, textareaRef]);

  const visibleCategories = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return emojiCategories;
    return emojiCategories
      .map((category) => ({
        ...category,
        entries: category.entries.filter((entry) => entry.keywords.toLocaleLowerCase().includes(normalizedQuery))
      }))
      .filter((category) => category.entries.length > 0);
  }, [query]);

  function rememberSelection() {
    const textarea = textareaRef.current;
    selectionRef.current = textarea
      ? { start: textarea.selectionStart, end: textarea.selectionEnd }
      : { start: value.length, end: value.length };
  }

  function togglePicker() {
    if (!isOpen) rememberSelection();
    setIsOpen((current) => !current);
    setQuery("");
  }

  function insertEmoji(emoji: string) {
    const { start, end } = selectionRef.current;
    const nextValue = `${value.slice(0, start)}${emoji}${value.slice(end)}`;
    const nextCursor = start + emoji.length;

    onChange(nextValue);
    setRecentEmojis((current) => {
      const nextRecent = [emoji, ...current.filter((item) => item !== emoji)].slice(0, RECENT_EMOJI_LIMIT);
      try {
        window.localStorage.setItem(RECENT_EMOJI_KEY, JSON.stringify(nextRecent));
      } catch {
        // Emoji insertion remains available if browser storage is unavailable.
      }
      return nextRecent;
    });
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(nextCursor, nextCursor);
      selectionRef.current = { start: nextCursor, end: nextCursor };
      onAfterInsert?.(textarea);
    });
  }

  function renderEmojiButton(emoji: string, keywords?: string) {
    return (
      <button
        aria-label={keywords ? `${emoji} ${keywords.split(" ")[0]}` : emoji}
        className="emoji-picker-item"
        key={emoji}
        onClick={() => insertEmoji(emoji)}
        type="button"
      >
        {emoji}
      </button>
    );
  }

  return (
    <div className="emoji-picker-anchor" ref={rootRef}>
      <button
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-label={dictionary.appShell.emoji.label}
        className="composer-icon-button emoji-picker-trigger"
        disabled={disabled}
        onClick={togglePicker}
        onPointerDown={rememberSelection}
        title={dictionary.appShell.emoji.label}
        type="button"
      >
        🙂
      </button>
      {isOpen ? (
        <div aria-label={dictionary.appShell.emoji.label} className="emoji-picker" role="dialog">
          <input
            aria-label={dictionary.appShell.emoji.search}
            className="field-input emoji-picker-search"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={dictionary.appShell.emoji.searchPlaceholder}
            ref={searchInputRef}
            type="search"
            value={query}
          />
          <div className="emoji-picker-content">
            {!query && recentEmojis.length > 0 ? (
              <section className="emoji-picker-section">
                <h3>{dictionary.appShell.emoji.categories.recent}</h3>
                <div className="emoji-picker-grid">{recentEmojis.map((emoji) => renderEmojiButton(emoji))}</div>
              </section>
            ) : null}
            {visibleCategories.map((category) => (
              <section className="emoji-picker-section" key={category.id}>
                <h3>{dictionary.appShell.emoji.categories[category.id]}</h3>
                <div className="emoji-picker-grid">
                  {category.entries.map((entry) => renderEmojiButton(entry.emoji, entry.keywords))}
                </div>
              </section>
            ))}
            {visibleCategories.length === 0 ? <p className="emoji-picker-empty">{dictionary.appShell.emoji.noResults}</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
