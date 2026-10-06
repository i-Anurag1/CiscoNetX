from __future__ import annotations

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "CiscoNetX"
    app_version: str = "7.0.0"
    environment: str = Field(default="development", validation_alias="APP_ENV")
    database_url: str = "sqlite:///./cisconetx.db"
    cors_origins: str = Field(default="http://localhost:5173", validation_alias="CORS_ORIGINS")
    secret_key: str = Field(default="", validation_alias="SECRET_KEY")
    simulation_max_events: int = Field(default=100000, ge=1000, le=1000000)
    rate_limit_per_minute: int = Field(default=120, ge=10, le=10000)
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=False)

    @property
    def cors_origin_list(self) -> list[str]:
        return [item.strip() for item in self.cors_origins.split(",") if item.strip()]

    @property
    def is_production(self) -> bool:
        return self.environment.lower() == "production"


settings = Settings()
