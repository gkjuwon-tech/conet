from __future__ import annotations

from prometheus_client import (
    CONTENT_TYPE_LATEST,
    Counter,
    Gauge,
    Histogram,
    generate_latest,
)


REQUEST_COUNT = Counter(
    "electromesh_http_requests_total",
    "Total HTTP requests",
    labelnames=("method", "path", "status"),
)
REQUEST_LATENCY = Histogram(
    "electromesh_http_request_duration_seconds",
    "HTTP request latency",
    labelnames=("method", "path"),
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0),
)

WORKUNITS_DISPATCHED = Counter(
    "electromesh_workunits_dispatched_total",
    "Workunits dispatched",
    labelnames=("kind",),
)
WORKUNITS_SUCCEEDED = Counter(
    "electromesh_workunits_succeeded_total",
    "Workunits accepted via consensus",
    labelnames=("kind",),
)
WORKUNITS_REJECTED = Counter(
    "electromesh_workunits_rejected_total",
    "Workunits rejected",
    labelnames=("kind", "reason"),
)
CLUSTERS_AVAILABLE = Gauge(
    "electromesh_clusters_available",
    "Clusters currently available",
)
CLUSTERS_LEASED = Gauge(
    "electromesh_clusters_leased",
    "Clusters currently leased",
)
H100_EQUIVALENT_ACTIVE = Gauge(
    "electromesh_h100_equivalent_active",
    "Sum of H100-equivalent compute online",
)
PAYOUTS_TOTAL_CENTS = Counter(
    "electromesh_payouts_paid_cents_total",
    "Total cents paid to users",
)


def render_metrics() -> tuple[bytes, str]:
    return generate_latest(), CONTENT_TYPE_LATEST
