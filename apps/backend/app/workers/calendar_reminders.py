import asyncio
import logging

from app.core.logging import configure_sensitive_log_redaction
from app.core.config import settings
from app.db.session import AsyncSessionLocal
from app.services.calendar_events import deliver_due_reminders

logger = logging.getLogger("uvicorn.error")


async def run_worker() -> None:
    configure_sensitive_log_redaction()
    logger.info("OfficeChat calendar reminder worker started")
    while True:
        try:
            async with AsyncSessionLocal() as session:
                delivered = await deliver_due_reminders(session)
                if delivered:
                    logger.info("Calendar reminder worker delivered %s reminders", delivered)
        except Exception:
            logger.exception("Calendar reminder worker iteration failed")
        await asyncio.sleep(settings.calendar_reminder_poll_seconds)


def main() -> None:
    asyncio.run(run_worker())


if __name__ == "__main__":
    main()
