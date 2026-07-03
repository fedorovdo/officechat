import logging
import re
from collections.abc import Mapping

SENSITIVE_QUERY_PARAMETER = re.compile(
    r"([?&](?:token|access_token|authorization|ticket)=)[^&\s\"']+",
    flags=re.IGNORECASE,
)
BOT_WEBHOOK_TOKEN = re.compile(r"(/api/bots/incoming/)[^/?&\s\"']+", flags=re.IGNORECASE)


def redact_sensitive_query_parameters(value: str) -> str:
    value = SENSITIVE_QUERY_PARAMETER.sub(r"\1[REDACTED]", value)
    return BOT_WEBHOOK_TOKEN.sub(r"\1[REDACTED]", value)


def _sanitize(value: object) -> object:
    if isinstance(value, str):
        return redact_sensitive_query_parameters(value)
    if isinstance(value, tuple):
        return tuple(_sanitize(item) for item in value)
    if isinstance(value, list):
        return [_sanitize(item) for item in value]
    if isinstance(value, Mapping):
        return {key: _sanitize(item) for key, item in value.items()}
    return value


class SensitiveDataFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = _sanitize(record.msg)
        record.args = _sanitize(record.args)
        return True


def configure_sensitive_log_redaction() -> None:
    for logger_name in ("uvicorn.access", "uvicorn.error"):
        logger = logging.getLogger(logger_name)
        if not any(isinstance(item, SensitiveDataFilter) for item in logger.filters):
            logger.addFilter(SensitiveDataFilter())
        for handler in logger.handlers:
            if not any(isinstance(item, SensitiveDataFilter) for item in handler.filters):
                handler.addFilter(SensitiveDataFilter())
