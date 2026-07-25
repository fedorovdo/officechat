CAN_BROADCAST = "can_broadcast"
CAN_PIN_MESSAGES = "can_pin_messages"
CAN_MANAGE_CALENDAR = "can_manage_calendar"
CAN_MANAGE_DIRECTORY = "can_manage_directory"


PERMISSION_CATALOG = {
    CAN_BROADCAST: {
        "category": "communications",
        "description_ru": "Может отправлять объявления всем пользователям или выбранным аудиториям.",
        "description_en": "Can send announcements to all users or selected audiences.",
    },
    CAN_PIN_MESSAGES: {
        "category": "messages",
        "description_ru": "Может закреплять и откреплять сообщения в доступных чатах.",
        "description_en": "Can pin and unpin messages in accessible chats.",
    },
    CAN_MANAGE_CALENDAR: {
        "category": "calendar",
        "description_ru": "Может создавать, изменять, переносить и отменять корпоративные события.",
        "description_en": "Can create, edit, reschedule and cancel corporate events.",
    },
    CAN_MANAGE_DIRECTORY: {
        "category": "directory",
        "description_ru": "Может создавать, изменять, архивировать и восстанавливать записи корпоративного справочника.",
        "description_en": "Can create, edit, archive and restore corporate directory entries.",
    },
}

ALL_PERMISSION_KEYS = frozenset(PERMISSION_CATALOG)
