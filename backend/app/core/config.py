from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    app_name: str = 'CiscoNetX'
    database_url: str = 'sqlite:///./cisconetx.db'
    cors_origins: str = 'http://localhost:5173'
    secret_key: str = 'change-me-in-production'
    simulation_max_events: int = 100000
    model_config = SettingsConfigDict(env_file='.env', extra='ignore')

settings = Settings()
