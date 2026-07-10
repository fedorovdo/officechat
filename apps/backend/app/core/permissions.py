CAN_BROADCAST = "can_broadcast"
CAN_PIN_MESSAGES = "can_pin_messages"


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
}

ALL_PERMISSION_KEYS = frozenset(PERMISSION_CATALOG)
