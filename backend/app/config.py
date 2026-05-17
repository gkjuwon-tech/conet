from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, PostgresDsn, RedisDsn, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        env_prefix="EM_",
        extra="ignore",
        case_sensitive=False,
    )

    env: Literal["dev", "staging", "prod", "test"] = "dev"
    service_name: str = "electromesh-api"
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"

    api_host: str = "0.0.0.0"
    api_port: int = 8080
    api_root_path: str = ""
    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:3000"])

    database_url: PostgresDsn = Field(
        default="postgresql+psycopg://em:em@localhost:5432/electromesh"  # type: ignore[arg-type]
    )
    database_pool_size: int = 20
    database_max_overflow: int = 10
    database_pool_recycle: int = 300

    redis_url: RedisDsn = Field(default="redis://localhost:6379/0")  # type: ignore[arg-type]
    redis_jobs_db: int = 1
    redis_locks_db: int = 2

    jwt_secret: SecretStr = SecretStr("change-me-in-prod-or-die")
    jwt_alg: str = "HS256"
    jwt_user_ttl_seconds: int = 60 * 60 * 12
    jwt_device_ttl_seconds: int = 60 * 60 * 24 * 30
    jwt_enterprise_ttl_seconds: int = 60 * 60 * 8

    bundling_size: int = 64
    bundling_max_age_seconds: int = 90
    bundling_min_score: float = 0.35

    pricing_h100_baseline_usd_hour: float = 2.30
    pricing_platform_fee_bps: int = 1500
    pricing_min_cluster_usd_hour: float = 0.05
    pricing_redundancy_factor: float = 1.18

    settlement_min_payout_cents: int = 100
    settlement_payout_cron: str = "0 7 * * 1"
    settlement_pool_holdback_bps: int = 500

    workunit_default_timeout_seconds: int = 120
    workunit_redundancy: int = 2
    workunit_attempt_cap: int = 4

    fraud_max_devices_per_lan: int = 12
    fraud_min_heartbeat_interval_seconds: int = 5
    fraud_consensus_threshold: float = 0.66

    lan_claim_otp_ttl_seconds: int = 600
    lan_claim_otp_max_attempts: int = 5
    lan_claim_grace_seconds: int = 60 * 60 * 24
    lan_claim_max_per_user: int = 5
    lan_claim_account_min_age_seconds: int = 60 * 60 * 24
    # Convenience flag for local/demo: also include the OTP in the API response
    # body. NEVER enable in prod.
    lan_claim_dev_show_otp: bool = True

    economics_safety_margin_pct: float = 0.30
    economics_min_margin_cents_per_hour: float = 0.005
    economics_thermal_warn_c: float = 78.0
    economics_thermal_cutoff_c: float = 88.0
    economics_battery_floor_pct: float = 40.0
    economics_require_charging: bool = True
    economics_global_default_rate_usd_kwh: float = 0.20

    stripe_publishable_key: SecretStr = SecretStr("")
    stripe_topup_min_cents: int = 1000
    stripe_topup_max_cents: int = 1_000_000
    stripe_currency: str = "usd"

    shell_session_default_ttl_seconds: int = 3600
    shell_session_max_ttl_seconds: int = 6 * 3600
    shell_session_idle_timeout_seconds: int = 300
    shell_session_max_concurrent_per_enterprise: int = 4

    isolation_allowed_workload_kinds: list[str] = Field(
        default_factory=lambda: [
            "hashcrack.range",
            "hashcrack.dict",
            "fhe.share",
            "mpc.share",
            "ml.embed.public",
            "render.tile",
        ]
    )

    stripe_secret_key: SecretStr = SecretStr("")
    stripe_webhook_secret: SecretStr = SecretStr("")
    stripe_payout_account_prefix: str = "acct_"

    metrics_path: str = "/metrics"
    metrics_enabled: bool = True

    sentry_dsn: SecretStr | None = None

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _coerce_cors(cls, v: object) -> object:
        if isinstance(v, str):
            if v == "*":
                return ["*"]
            if v.startswith("[") and v.endswith("]"):
                import json
                try:
                    return json.loads(v)
                except:
                    pass
            return [s.strip() for s in v.split(",") if s.strip()]
        return v

    @property
    def is_prod(self) -> bool:
        return self.env == "prod"

    @property
    def db_sync_url(self) -> str:
        # psycopg (v3) supports both sync and async, so reuse the same URL.
        # Stripping the driver suffix would force SQLAlchemy to import psycopg2.
        return str(self.database_url)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
