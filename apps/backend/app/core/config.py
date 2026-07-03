import json
from functools import lru_cache
from typing import Annotated

from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

DEFAULT_ALLOWED_UPLOAD_EXTENSIONS = [
    "txt", "log", "csv", "md", "json", "xml", "yaml", "yml", "ini", "conf",
    "pdf", "doc", "docx", "xls", "xlsx", "png", "jpg", "jpeg", "webp", "zip",
]
BLOCKED_UPLOAD_EXTENSIONS = {
    "exe", "com", "bat", "cmd", "ps1", "msi", "dll", "scr", "js", "vbs", "jar", "sh", "apk",
}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "OfficeChat"
    app_version: str = "0.1.0"
    environment: str = "development"
    self_registration_enabled: bool = False
    app_secret_key: str = "change-me-in-production"
    access_token_expire_minutes: int = 1440
    message_max_length: int = 4000
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
    db_pool_size: int = 10
    db_max_overflow: int = 20
    db_pool_recycle_seconds: int = 1800

    valkey_host: str = "valkey"
    valkey_port: int = 6379
    valkey_db: int = 0

    backend_cors_origins: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["http://localhost:3100"]
    )
    uploads_dir: str = "/data/uploads"

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

            return [origin.strip() for origin in stripped_value.split(",") if origin.strip()]

        if isinstance(value, list):
            return [str(origin).strip() for origin in value if str(origin).strip()]

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
