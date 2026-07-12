import json
from functools import lru_cache
from typing import Annotated
from urllib.parse import urlparse

from pydantic import AliasChoices, Field, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

DEFAULT_ALLOWED_UPLOAD_EXTENSIONS = [
    "txt", "log", "csv", "md", "json", "xml", "yaml", "yml", "ini", "conf",
    "pdf", "doc", "docx", "xls", "xlsx", "png", "jpg", "jpeg", "webp", "zip",
]
BLOCKED_UPLOAD_EXTENSIONS = {
    "exe", "com", "bat", "cmd", "ps1", "msi", "dll", "scr", "js", "vbs", "jar", "sh", "apk",
}
WEAK_SECRET_VALUES = {
    "",
    "change-me",
    "change-me-in-production",
    "development",
    "officechat",
    "secret",
    "test",
}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "OfficeChat"
    app_version: str = Field(default="0.1.0-rc1", validation_alias=AliasChoices("APP_VERSION", "OFFICECHAT_VERSION"))
    environment: str = "development"
    public_frontend_url: str | None = Field(default=None, validation_alias=AliasChoices("PUBLIC_FRONTEND_URL", "FRONTEND_URL"))
    public_backend_url: str | None = Field(default=None, validation_alias=AliasChoices("PUBLIC_BACKEND_URL", "BACKEND_PUBLIC_URL"))
    self_registration_enabled: bool = False
    app_secret_key: str = Field(
        default="change-me-in-production",
        validation_alias=AliasChoices("APP_SECRET_KEY", "JWT_SECRET"),
    )
    access_token_expire_minutes: int = 1440
    audit_retention_days: int = 365
    audit_max_export_rows: int = 10000
    message_max_length: int = 4000
    pinned_messages_max_per_chat: int = Field(default=20, ge=1, le=100)
    broadcast_title_max_length: int = Field(default=160, ge=1, le=300)
    broadcast_body_max_length: int = Field(default=10000, ge=1, le=50000)
    broadcast_max_recipients: int = Field(default=10000, ge=1, le=100000)
    broadcast_max_per_hour: int = Field(default=10, ge=1, le=1000)
    broadcast_preview_ttl_seconds: int = Field(default=300, ge=30, le=3600)
    broadcast_retention_days: int = Field(default=365, ge=1, le=3650)
    notification_retention_days: int = Field(default=90, ge=1, le=3650)
    notification_max_per_user: int = Field(default=5000, ge=100, le=100000)
    calendar_title_max_length: int = Field(default=200, ge=1, le=500)
    calendar_description_max_length: int = Field(default=10000, ge=0, le=50000)
    calendar_location_max_length: int = Field(default=500, ge=0, le=2000)
    calendar_max_recipients: int = Field(default=10000, ge=1, le=100000)
    calendar_default_timezone: str = "Europe/Moscow"
    calendar_max_reminders: int = Field(default=5, ge=0, le=10)
    calendar_max_duration_days: int = Field(default=30, ge=1, le=366)
    calendar_reminder_poll_seconds: int = Field(default=30, ge=5, le=3600)
    calendar_reminder_batch_size: int = Field(default=100, ge=1, le=1000)
    attachment_max_upload_size_mb: int = Field(
        default=25,
        validation_alias=AliasChoices("ATTACHMENT_MAX_UPLOAD_SIZE_MB", "MAX_UPLOAD_SIZE_MB"),
    )
    attachment_max_files_per_message: int = 10
    attachment_max_total_size_mb: int = 50
    allowed_upload_extensions: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: list(DEFAULT_ALLOWED_UPLOAD_EXTENSIONS)
    )
    avatar_max_upload_size_mb: int = 5
    allowed_avatar_extensions: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["png", "jpg", "jpeg", "webp"]
    )
    bootstrap_superadmin_username: str = "admin"
    bootstrap_superadmin_password: str = "admin12345"
    bootstrap_superadmin_display_name: str = "OfficeChat Admin"

    postgres_db: str = "officechat"
    postgres_user: str = "officechat"
    postgres_password: str = "officechat_dev_password"
    postgres_host: str = "postgres"
    postgres_port: int = 5432
    database_url_override: str | None = Field(default=None, validation_alias="DATABASE_URL")
    db_pool_size: int = 10
    db_max_overflow: int = 20
    db_pool_recycle_seconds: int = 1800

    valkey_host: str = "valkey"
    valkey_port: int = 6379
    valkey_db: int = 0
    presence_connection_ttl_seconds: int = Field(default=90, ge=30, le=600)
    presence_heartbeat_seconds: int = Field(default=25, ge=10, le=120)
    presence_offline_grace_seconds: int = Field(default=15, ge=0, le=120)
    typing_ttl_seconds: int = Field(default=5, ge=2, le=30)

    backend_cors_origins: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["http://localhost:3100"]
    )
    uploads_dir: str = "/data/uploads"

    @model_validator(mode="after")
    def require_persistent_production_secret(self) -> "Settings":
        if self.environment.lower() == "production":
            if not self.database_url_override:
                raise ValueError("DATABASE_URL must be explicitly configured in production")
            if self.app_secret_key.strip().lower() in WEAK_SECRET_VALUES or len(self.app_secret_key) < 32:
                raise ValueError("APP_SECRET_KEY/JWT_SECRET must be a strong production secret with at least 32 characters")
            if not self.public_frontend_url or not self.public_backend_url:
                raise ValueError("PUBLIC_FRONTEND_URL and PUBLIC_BACKEND_URL must be configured in production")
            self._validate_http_url(self.public_frontend_url, "PUBLIC_FRONTEND_URL")
            self._validate_http_url(self.public_backend_url, "PUBLIC_BACKEND_URL")
            if self.public_frontend_url.rstrip("/") not in [origin.rstrip("/") for origin in self.backend_cors_origins]:
                raise ValueError("BACKEND_CORS_ORIGINS must include PUBLIC_FRONTEND_URL in production")
            if any(origin == "*" for origin in self.backend_cors_origins):
                raise ValueError("BACKEND_CORS_ORIGINS must not contain '*' in production")
        if self.presence_heartbeat_seconds >= self.presence_connection_ttl_seconds:
            raise ValueError("PRESENCE_HEARTBEAT_SECONDS must be lower than PRESENCE_CONNECTION_TTL_SECONDS")
        if self.attachment_max_upload_size_mb <= 0 or self.attachment_max_total_size_mb <= 0:
            raise ValueError("Attachment size limits must be positive")
        if self.attachment_max_total_size_mb < self.attachment_max_upload_size_mb:
            raise ValueError("ATTACHMENT_MAX_TOTAL_SIZE_MB must be greater than or equal to ATTACHMENT_MAX_UPLOAD_SIZE_MB")
        self._validate_timezone(self.calendar_default_timezone, "CALENDAR_DEFAULT_TIMEZONE")
        return self

    @staticmethod
    def _validate_http_url(value: str, field_name: str) -> None:
        parsed = urlparse(value)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError(f"{field_name} must be an absolute http(s) URL")

    @staticmethod
    def _validate_timezone(value: str, field_name: str) -> None:
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

        try:
            ZoneInfo(value)
        except ZoneInfoNotFoundError as exc:
            raise ValueError(f"{field_name} must be an IANA timezone name") from exc

    @field_validator("backend_cors_origins", mode="before")
    @classmethod
    def parse_cors_origins(cls, value: object) -> list[str]:
        if isinstance(value, str):
            stripped_value = value.strip()
            if stripped_value.startswith("["):
                parsed_value = json.loads(stripped_value)
                if not isinstance(parsed_value, list):
                    raise ValueError("BACKEND_CORS_ORIGINS JSON value must be a list")
                return [str(origin).strip() for origin in parsed_value if str(origin).strip()]

            origins = [origin.strip() for origin in stripped_value.split(",") if origin.strip()]
            for origin in origins:
                if origin != "*":
                    cls._validate_http_url(origin, "BACKEND_CORS_ORIGINS")
            return origins

        if isinstance(value, list):
            origins = [str(origin).strip() for origin in value if str(origin).strip()]
            for origin in origins:
                if origin != "*":
                    cls._validate_http_url(origin, "BACKEND_CORS_ORIGINS")
            return origins

        raise ValueError("BACKEND_CORS_ORIGINS must be a list or comma-separated string")

    @field_validator("allowed_upload_extensions", mode="before")
    @classmethod
    def parse_upload_extensions(cls, value: object) -> list[str]:
        if isinstance(value, str):
            extensions = [extension.strip().lower().lstrip(".") for extension in value.split(",") if extension.strip()]
        elif isinstance(value, list):
            extensions = [str(extension).strip().lower().lstrip(".") for extension in value if str(extension).strip()]
        else:
            raise ValueError("ALLOWED_UPLOAD_EXTENSIONS must be a list or comma-separated string")

        blocked_extensions = sorted(set(extensions) & BLOCKED_UPLOAD_EXTENSIONS)
        if blocked_extensions:
            raise ValueError(
                "ALLOWED_UPLOAD_EXTENSIONS contains blocked executable or script types: "
                + ", ".join(blocked_extensions)
            )
        return list(dict.fromkeys(extensions))

    @field_validator("allowed_avatar_extensions", mode="before")
    @classmethod
    def parse_avatar_extensions(cls, value: object) -> list[str]:
        if isinstance(value, str):
            return [extension.strip().lower().lstrip(".") for extension in value.split(",") if extension.strip()]

        if isinstance(value, list):
            return [str(extension).strip().lower().lstrip(".") for extension in value if str(extension).strip()]

        raise ValueError("ALLOWED_AVATAR_EXTENSIONS must be a list or comma-separated string")

    @property
    def max_upload_size_bytes(self) -> int:
        return self.attachment_max_upload_size_mb * 1024 * 1024

    @property
    def attachment_max_total_size_bytes(self) -> int:
        return self.attachment_max_total_size_mb * 1024 * 1024

    @property
    def avatar_max_upload_size_bytes(self) -> int:
        return self.avatar_max_upload_size_mb * 1024 * 1024

    @property
    def database_url(self) -> str:
        if self.database_url_override:
            return self.database_url_override
        return (
            f"postgresql://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )

    @property
    def valkey_url(self) -> str:
        return f"redis://{self.valkey_host}:{self.valkey_port}/{self.valkey_db}"


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
