import re

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.group import GroupMember
from app.models.mention import MessageMention
from app.models.message import Message
from app.models.user import User

MENTION_USERNAME_PATTERN = re.compile(r"(?<![\w@])@([\w-]+(?:\.[\w-]+)*)", re.UNICODE)


def detect_mentioned_usernames(body: str) -> set[str]:
    return {match.group(1).lower() for match in MENTION_USERNAME_PATTERN.finditer(body)}


async def sync_message_mentions(session: AsyncSession, message: Message) -> None:
    await session.execute(delete(MessageMention).where(MessageMention.message_id == message.id))

    usernames = detect_mentioned_usernames(message.body)
    if not usernames:
        return

    result = await session.execute(
        select(User)
        .join(GroupMember, GroupMember.user_id == User.id)
        .where(
            GroupMember.group_id == message.group_id,
            User.username.in_(usernames),
            User.is_active.is_(True),
            User.role != "bot",
        )
        .order_by(User.username.asc())
    )
    session.add_all(
        [
            MessageMention(
                message_id=message.id,
                group_id=message.group_id,
                mentioned_user_id=user.id,
            )
            for user in result.scalars().all()
        ]
    )
